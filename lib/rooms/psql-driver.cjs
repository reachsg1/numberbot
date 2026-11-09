// 로컬 테스트 전용 DB 드라이버(psql 명령 사용). 배포 환경에서는 쓰이지 않습니다.
const { spawn } = require('child_process');

const lit = (v) =>
  "'" + String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, wasQuoted = false, i = 0;
  const push = () => { row.push(wasQuoted ? field : field === '' ? null : field); field = ''; wasQuoted = false; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; wasQuoted = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\n') { push(); rows.push(row); row = []; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  if (!rows.length) return [];
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, j) => [h, r[j]])));
}

function query(text, params = []) {
  let script = '\\set VERBOSITY verbose\n';
  if (params.length) script += text.trim().replace(/;$/, '') + '\n\\bind ' + params.map(lit).join(' ') + ' \\g\n';
  else script += text + '\n';
  return new Promise((resolve, reject) => {
    const p = spawn('psql', ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', process.env.DATABASE_URL]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) {
        const e = new Error(err.trim());
        const m = err.match(/ERROR:\s+([0-9A-Z]{5}):/);
        if (m) e.code = m[1];
        return reject(e);
      }
      resolve(params.length || /^\s*(SELECT|WITH)/i.test(text) ? parseCsv(out) : []);
    });
    p.stdin.end(script);
  });
}

module.exports = { query };
