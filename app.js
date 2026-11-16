const $ = (id) => document.getElementById(id);

fetch('/api/config')
  .then((r) => r.json())
  .then((c) => {
    if (c.needPassword) $('pwBox').classList.remove('hidden');
  })
  .catch(() => {});

$('tests').addEventListener('change', () => {
  const n = $('tests').files.length;
  $('testsInfo').textContent = n ? `Đã chọn ${n} file` : '';
});

function reset() {
  $('rows').innerHTML = '';
  $('ceLog').classList.add('hidden');
  $('ceLog').textContent = '';
  $('table').classList.add('hidden');
  $('barFill').style.width = '0';
  $('score').textContent = '–';
  $('score').className = 'score';
  $('status').textContent = '';
}

function addRow(t) {
  const tr = document.createElement('tr');

  const tdName = document.createElement('td');
  tdName.textContent = t.test;

  const tdV = document.createElement('td');
  const span = document.createElement('span');
  span.className = `v ${t.verdict}`;
  span.textContent = (t.verdict === 'AC' ? '✅ ' : '❌ ') + t.verdict;
  tdV.appendChild(span);

  const tdT = document.createElement('td');
  tdT.textContent = `${(t.ms / 1000).toFixed(3)}s`;

  const tdD = document.createElement('td');
  tdD.className = 'detail';
  tdD.textContent = t.detail || '';

  tr.append(tdName, tdV, tdT, tdD);
  $('rows').appendChild(tr);
}

$('btnRun').addEventListener('click', async () => {
  const code = $('code').files[0];
  const tests = Array.from($('tests').files);
  if (!code) return alert('Hãy chọn file code .cpp');
  if (!tests.length) return alert('Hãy chọn folder test');

  reset();
  $('result').classList.remove('hidden');
  $('status').textContent = 'Đang upload và chấm bài ...';
  $('btnRun').disabled = true;

  const fd = new FormData();
  fd.append('timeLimit', $('timeLimit').value);
  fd.append('memMB', $('memMB').value);
  fd.append('code', code);
  for (const f of tests) {
    fd.append('paths', f.webkitRelativePath || f.name);
    fd.append('tests', f);
  }

  try {
    const res = await fetch('/api/judge', {
      method: 'POST',
      headers: { 'x-password': $('password').value },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      $('status').textContent = `Lỗi: ${data.error || res.status}`;
      return;
    }

    if (data.compileError) {
      $('score').textContent = 'CE';
      $('score').classList.add('has-bad');
      $('status').textContent = 'Lỗi biên dịch (Compile Error)';
      $('ceLog').textContent = data.log;
      $('ceLog').classList.remove('hidden');
      return;
    }

    $('score').textContent = `${data.ac}/${data.total} test AC`;
    $('score').classList.add(data.ac === data.total ? 'all-ok' : 'has-bad');
    $('barFill').style.width = data.total ? `${(data.ac / data.total) * 100}%` : '0';
    $('status').textContent = `Bài ${data.name}`;
    $('table').classList.remove('hidden');
    data.tests.forEach(addRow);
  } catch (e) {
    $('status').textContent = `Lỗi kết nối: ${e.message}`;
  } finally {
    $('btnRun').disabled = false;
  }
});
