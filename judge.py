#!/usr/bin/env python3
"""
Hệ thống chấm bài tự động chạy trên GitHub Actions.

Cấu trúc repo:
    [name].cpp
    [name]/Test01/[name].INP, [name].out
    [name]/Test02/[name].INP, [name].out
    ...

Dùng:
    python3 judge.py            # chấm tất cả file .cpp ở thư mục gốc
    python3 judge.py bai1 bai2  # chỉ chấm các bài chỉ định

Biến môi trường (tuỳ chọn):
    TIME_LIMIT    giới hạn thời gian mỗi test, giây (mặc định 2)
    MEM_LIMIT_MB  giới hạn bộ nhớ, MB (mặc định 256)
"""
import glob
import itertools
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TIME_LIMIT = float(os.environ.get("TIME_LIMIT", "2"))
MEM_LIMIT_MB = int(os.environ.get("MEM_LIMIT_MB", "256"))

SIGNAL_MSG = {
    signal.SIGSEGV: "Segmentation fault (truy cập sai bộ nhớ / tràn stack)",
    signal.SIGFPE: "Floating point exception (chia cho 0)",
    signal.SIGABRT: "Aborted (assert / exception / bad_alloc)",
    signal.SIGKILL: "Killed (có thể do hết bộ nhớ)",
    signal.SIGBUS: "Bus error",
    signal.SIGILL: "Illegal instruction",
}


def find_file(folder, name, ext):
    """Tìm file name.ext không phân biệt hoa thường."""
    target = f"{name}.{ext}".lower()
    for f in os.listdir(folder):
        if f.lower() == target:
            return os.path.join(folder, f)
    return None


def normalize(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [l.rstrip() for l in lines]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def short(s, n=60):
    return s if len(s) <= n else s[:n] + "..."


def compare(expected, actual):
    """Trả về None nếu giống nhau, ngược lại là mô tả chỗ sai đầu tiên."""
    exp, act = normalize(expected), normalize(actual)
    for i, (e, a) in enumerate(itertools.zip_longest(exp, act), start=1):
        if e != a:
            if e is None:
                return f"Dòng {i}: thừa dòng, in ra '{short(a)}'"
            if a is None:
                return f"Dòng {i}: thiếu dòng, cần '{short(e)}'"
            return f"Dòng {i}: cần '{short(e)}', in ra '{short(a)}'"
    return None


def limits():
    mem = MEM_LIMIT_MB * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_STACK, (mem, mem))
    except (ValueError, OSError):
        pass


def compile_cpp(src, exe):
    r = subprocess.run(
        ["g++", "-O2", "-std=c++17", "-o", exe, src],
        capture_output=True, text=True,
    )
    return r.returncode == 0, r.stderr


def run_test(exe, name, test_dir):
    """Trả về (verdict, seconds, detail)."""
    inp = find_file(test_dir, name, "inp")
    out = find_file(test_dir, name, "out")
    if not inp or not out:
        miss = f"{name}.INP" if not inp else f"{name}.out"
        return "ERR", 0.0, f"Thiếu file {miss} trong test"

    with open(out, encoding="utf-8", errors="replace") as f:
        expected = f.read()

    with tempfile.TemporaryDirectory() as tmp:
        # Hỗ trợ cả đọc file (freopen) lẫn đọc stdin
        for fname in {f"{name}.INP", f"{name}.inp"}:
            shutil.copy(inp, os.path.join(tmp, fname))

        start = time.time()
        try:
            with open(inp, "rb") as fin:
                r = subprocess.run(
                    [exe], stdin=fin, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, cwd=tmp,
                    timeout=TIME_LIMIT, preexec_fn=limits,
                )
        except subprocess.TimeoutExpired:
            return "TLE", TIME_LIMIT, f"Quá {TIME_LIMIT:g}s"
        elapsed = time.time() - start

        err = r.stderr.decode(errors="replace").strip()
        if r.returncode != 0:
            if "bad_alloc" in err:
                return "MLE", elapsed, f"Vượt {MEM_LIMIT_MB}MB (bad_alloc)"
            if r.returncode < 0:
                sig = signal.Signals(-r.returncode)
                msg = SIGNAL_MSG.get(sig, sig.name)
            else:
                msg = f"Thoát với mã {r.returncode}"
            if err:
                msg += f" | {short(err.splitlines()[-1], 80)}"
            return "RE", elapsed, msg

        # Ưu tiên file name.out do chương trình tự ghi, nếu không có thì lấy stdout
        out_written = find_file(tmp, name, "out")
        if out_written:
            with open(out_written, encoding="utf-8", errors="replace") as f:
                actual = f.read()
        else:
            actual = r.stdout.decode(errors="replace")

        diff = compare(expected, actual)
        if diff is None:
            return "AC", elapsed, ""
        return "WA", elapsed, diff


def md_escape(s):
    return s.replace("|", "\\|").replace("\n", " ")


def judge_problem(name):
    lines = []  # markdown
    src = f"{name}.cpp"
    print(f"\n{'=' * 50}\nBÀI: {name}\n{'=' * 50}")
    lines.append(f"## Bài `{name}`\n")

    if not os.path.isdir(name):
        msg = f"Không tìm thấy folder test `{name}/`"
        print(f"[SKIP] {msg}")
        lines.append(f"⚠️ {msg}\n")
        return 0, 0, lines

    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, name)
        ok, err = compile_cpp(src, exe)
        if not ok:
            print("[CE] Lỗi biên dịch:\n" + err)
            lines.append("❌ **Compile Error**\n")
            lines.append("```\n" + err[:3000] + "\n```\n")
            tests = [d for d in os.listdir(name) if os.path.isdir(os.path.join(name, d))]
            return 0, len(tests), lines

        tests = sorted(
            d for d in os.listdir(name) if os.path.isdir(os.path.join(name, d))
        )
        total, ac = len(tests), 0
        rows = []
        for t in tests:
            verdict, sec, detail = run_test(exe, name, os.path.join(name, t))
            if verdict == "AC":
                ac += 1
            icon = "✅" if verdict == "AC" else "❌"
            print(f"{icon} {t:<10} {verdict:<4} {sec:6.3f}s  {detail}")
            rows.append(f"| {t} | {icon} {verdict} | {sec:.3f}s | {md_escape(detail)} |")

    print(f"--> Kết quả: {ac}/{total} test AC")
    lines.append(f"**Kết quả: {ac}/{total} test AC**\n")
    lines.append("| Test | Kết quả | Thời gian | Chi tiết |")
    lines.append("|---|---|---|---|")
    lines.extend(rows)
    lines.append("")
    return ac, total, lines


def main():
    names = sys.argv[1:] or sorted(
        os.path.splitext(f)[0] for f in glob.glob("*.cpp")
    )
    if not names:
        print("Không có file .cpp nào ở thư mục gốc.")
        sys.exit(1)

    md = ["# 📝 Kết quả chấm bài\n"]
    all_pass = True
    summary = []
    for name in names:
        if not os.path.isfile(f"{name}.cpp"):
            print(f"Không có file {name}.cpp")
            all_pass = False
            continue
        ac, total, lines = judge_problem(name)
        md.extend(lines)
        summary.append((name, ac, total))
        if total == 0 or ac != total:
            all_pass = False

    print(f"\n{'=' * 50}\nTỔNG KẾT\n{'=' * 50}")
    md.insert(1, "| Bài | AC / Tổng |\n|---|---|\n" + "\n".join(
        f"| {n} | {a}/{t} |" for n, a, t in summary) + "\n")
    for n, a, t in summary:
        print(f"{n}: {a}/{t}")

    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write("\n".join(md))

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
