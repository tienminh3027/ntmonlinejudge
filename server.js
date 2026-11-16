const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { judge } = require('./judge');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || ''; // đặt để chỉ người có mật khẩu mới chấm được
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL) || 2;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 600 },
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- hàng đợi: tối đa MAX_PARALLEL bài chấm cùng lúc ----
let running = 0;
const waiters = [];
async function acquire() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise((r) => waiters.push(r));
}
function release() {
  const w = waiters.shift();
  if (w) w();
  else running--;
}

app.get('/api/config', (_req, res) => res.json({ needPassword: !!PASSWORD }));

app.post(
  '/api/judge',
  upload.fields([
    { name: 'code', maxCount: 1 },
    { name: 'tests', maxCount: 600 },
  ]),
  async (req, res) => {
    if (PASSWORD && req.get('x-password') !== PASSWORD) {
      return res.status(401).json({ error: 'Sai mật khẩu' });
    }

    const code = req.files && req.files.code && req.files.code[0];
    const tests = (req.files && req.files.tests) || [];
    let paths = req.body.paths || [];
    if (!Array.isArray(paths)) paths = [paths];

    if (!code) return res.status(400).json({ error: 'Chưa có file code (.cpp)' });
    if (!tests.length) return res.status(400).json({ error: 'Chưa có folder test' });
    if (paths.length !== tests.length) return res.status(400).json({ error: 'Dữ liệu upload không khớp' });

    const name =
      path.basename(code.originalname).replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '_') || 'main';
    const timeLimit = Math.min(Math.max(parseFloat(req.body.timeLimit) || 2, 0.1), 10);
    const memMB = Math.min(Math.max(parseInt(req.body.memMB, 10) || 256, 16), 512);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    await acquire();
    try {
      const cppPath = path.join(work, `${name}.cpp`);
      fs.writeFileSync(cppPath, code.buffer);

      // Lưu test: bỏ tên folder gốc, giữ lại Test01/xxx.INP, Test01/xxx.out ...
      const testsDir = path.join(work, 'tests');
      fs.mkdirSync(testsDir);
      tests.forEach((f, i) => {
        const parts = String(paths[i]).split('/').filter((p) => p && p !== '.' && p !== '..');
        parts.shift();
        if (parts.length < 2) return; // cần dạng Test01/file
        const dest = path.join(testsDir, ...parts);
        if (!dest.startsWith(testsDir + path.sep)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.buffer);
      });

      const hasTests = fs.readdirSync(testsDir, { withFileTypes: true }).some((d) => d.isDirectory());
      if (!hasTests) {
        return res.status(400).json({
          error: 'Không thấy folder con Test01, Test02, ... Hãy chọn đúng folder [name] chứa các folder Test.',
        });
      }

      const out = { name, ac: 0, total: 0, compileError: false, log: '', tests: [] };
      const r = await judge({ cppPath, testsDir, timeLimit, memMB }, (ev) => {
        if (ev.type === 'ce') {
          out.compileError = true;
          out.log = ev.log;
        } else if (ev.type === 'test') {
          out.tests.push({ test: ev.test, verdict: ev.verdict, ms: ev.ms, detail: ev.detail });
        }
      });
      out.ac = r.ac;
      out.total = r.total;
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    } finally {
      release();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
);

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Lỗi upload' });
});

app.listen(PORT, () => console.log(`Chạy tại http://localhost:${PORT}`));
