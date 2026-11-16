const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SIGNAL_MSG = {
  SIGSEGV: 'Segmentation fault (truy cập sai bộ nhớ / tràn stack)',
  SIGFPE: 'Floating point exception (chia cho 0)',
  SIGABRT: 'Aborted (assert / exception / bad_alloc)',
  SIGKILL: 'Killed (có thể do hết bộ nhớ)',
  SIGBUS: 'Bus error',
  SIGILL: 'Illegal instruction',
};

// Mã lỗi Windows
const WIN_MSG = {
  3221225477: 'Access violation (truy cập sai bộ nhớ)',
  3221225620: 'Chia cho 0',
  3221225725: 'Stack overflow (đệ quy quá sâu)',
  3221226505: 'Stack buffer overrun / abort',
  3221226356: 'Heap corruption',
};

const MAX_STDOUT = 64 * 1024 * 1024;

const short = (s, n = 60) => (s.length <= n ? s : s.slice(0, n) + '...');

function findFile(dir, name, ext) {
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const target = `${name}.${ext}`.toLowerCase();
  let f = files.find((x) => x.toLowerCase() === target);
  // dự phòng: lấy file bất kỳ có đuôi tương ứng
  if (!f) f = files.find((x) => x.toLowerCase().endsWith('.' + ext));
  return f ? path.join(dir, f) : null;
}

function normalize(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function compare(expected, actual) {
  const e = normalize(expected);
  const a = normalize(actual);
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) {
    if (e[i] !== a[i]) {
      if (e[i] === undefined) return `Dòng ${i + 1}: thừa dòng, in ra '${short(a[i])}'`;
      if (a[i] === undefined) return `Dòng ${i + 1}: thiếu dòng, cần '${short(e[i])}'`;
      return `Dòng ${i + 1}: cần '${short(e[i])}', in ra '${short(a[i])}'`;
    }
  }
  return null;
}

function compile(src, exe) {
  return new Promise((resolve) => {
    execFile(
      'g++',
      ['-O2', '-std=c++17', '-o', exe, src],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, _so, se) => {
        if (err && err.code === 'ENOENT') {
          return resolve({
            ok: false,
            log: 'Không tìm thấy g++. Hãy cài g++ (MinGW/MSYS2 trên Windows, build-essential trên Linux, Xcode CLT trên macOS) và thêm vào PATH.',
          });
        }
        resolve({ ok: !err, log: se || (err ? String(err.message) : '') });
      }
    );
  });
}

function runExe(exe, inp, cwd, timeLimit, memMB) {
  return new Promise((resolve) => {
    let cmd = exe;
    let args = [];
    if (process.platform === 'linux' && memMB) {
      cmd = 'sh';
      args = [
        '-c',
        `ulimit -v ${memMB * 1024}; ulimit -s ${memMB * 1024} 2>/dev/null; exec "$0"`,
        exe,
      ];
    }

    const start = Date.now();
    let timedOut = false;
    let done = false;
    const out = [];
    let outSize = 0;
    let err = '';

    const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeLimit * 1000);

    p.on('error', (e) => finish({ spawnError: e.message }));
    p.stdin.on('error', () => {});
    fs.createReadStream(inp).pipe(p.stdin);

    p.stdout.on('data', (d) => {
      outSize += d.length;
      if (outSize <= MAX_STDOUT) out.push(d);
    });
    p.stderr.on('data', (d) => {
      if (err.length < 65536) err += d.toString();
    });

    p.on('close', (code, signal) => {
      finish({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: err.trim(),
        ms: Date.now() - start,
      });
    });
  });
}

async function runTest(exe, name, testDir, timeLimit, memMB) {
  const inp = findFile(testDir, name, 'inp');
  const outF = findFile(testDir, name, 'out');
  if (!inp || !outF) {
    return { verdict: 'ERR', ms: 0, detail: `Thiếu file ${!inp ? name + '.INP' : name + '.out'} trong test` };
  }
  const expected = fs.readFileSync(outF, 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chambai-run-'));

  try {
    // hỗ trợ chương trình đọc file (freopen) lẫn đọc stdin
    for (const fname of new Set([`${name}.INP`, `${name}.inp`])) {
      fs.copyFileSync(inp, path.join(tmp, fname));
    }

    const r = await runExe(exe, inp, tmp, timeLimit, memMB);
    if (r.spawnError) return { verdict: 'RE', ms: 0, detail: r.spawnError };
    if (r.timedOut) return { verdict: 'TLE', ms: timeLimit * 1000, detail: `Quá ${timeLimit}s` };

    if (r.code !== 0) {
      if (/bad_alloc/.test(r.stderr)) {
        return { verdict: 'MLE', ms: r.ms, detail: `Vượt ${memMB}MB (bad_alloc)` };
      }
      let msg;
      if (r.signal) msg = SIGNAL_MSG[r.signal] || r.signal;
      else if (WIN_MSG[r.code >>> 0]) msg = WIN_MSG[r.code >>> 0];
      else msg = `Thoát với mã ${r.code}`;
      if (r.stderr) msg += ` | ${short(r.stderr.split('\n').pop(), 80)}`;
      return { verdict: 'RE', ms: r.ms, detail: msg };
    }

    // ưu tiên file name.out do chương trình tự ghi, không có thì lấy stdout
    const written = fs.readdirSync(tmp).find((f) => f.toLowerCase() === `${name}.out`.toLowerCase());
    const actual = written ? fs.readFileSync(path.join(tmp, written), 'utf8') : r.stdout;

    const diff = compare(expected, actual);
    return diff === null
      ? { verdict: 'AC', ms: r.ms, detail: '' }
      : { verdict: 'WA', ms: r.ms, detail: diff };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {{cppPath:string, testsDir:string, timeLimit:number, memMB:number}} opts
 * @param {(ev:object)=>void} emit
 */
async function judge(opts, emit) {
  const { cppPath, testsDir } = opts;
  const timeLimit = Number(opts.timeLimit) || 2;
  const memMB = Number(opts.memMB) || 256;
  const name = path.basename(cppPath, path.extname(cppPath));

  const tests = fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chambai-'));
  const exe = path.join(work, process.platform === 'win32' ? `${name}.exe` : name);

  try {
    emit({ type: 'compiling', name });
    const c = await compile(cppPath, exe);
    if (!c.ok) {
      emit({ type: 'ce', log: c.log });
      return { name, ac: 0, total: tests.length, compileError: true };
    }

    emit({ type: 'start', name, total: tests.length });
    let ac = 0;
    for (const t of tests) {
      const r = await runTest(exe, name, path.join(testsDir, t), timeLimit, memMB);
      if (r.verdict === 'AC') ac++;
      emit({ type: 'test', test: t, ...r });
    }
    emit({ type: 'done', name, ac, total: tests.length });
    return { name, ac, total: tests.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { judge };
