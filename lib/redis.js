// 저장소 연결 — Vercel Storage에서 붙인 Redis를 자동으로 찾습니다.
//  · Upstash for Redis → KV_REST_API_URL / KV_REST_API_TOKEN (웹 방식)
//  · Redis(Redis Cloud) 등 → REDIS_URL (redis:// 또는 rediss://, 일반 방식)
import net from 'node:net';
import tls from 'node:tls';

export function redisFromEnv(env = process.env) {
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // 연결할 때 앞에 다른 이름(예: STORAGE_)을 붙였어도 찾아냅니다.
    for (const k of Object.keys(env)) {
      const m = k.match(/^(.*)(KV_REST_API_URL|REDIS_REST_URL)$/);
      if (!m || !env[k]) continue;
      const t = env[m[1] + m[2].replace('URL', 'TOKEN')];
      if (t) { url = env[k]; token = t; break; }
    }
  }
  if (url && token) return restRedis(url.replace(/\/$/, ''), token);
  let tcp = env.REDIS_URL || env.KV_URL;
  if (!tcp) for (const k of Object.keys(env)) if (/(^|_)REDIS_URL$/.test(k) && /^rediss?:\/\//.test(env[k] || '')) { tcp = env[k]; break; }
  if (tcp && /^rediss?:\/\//.test(tcp)) return tcpRedis(tcp);
  return null;
}

// 일반 Redis(TCP) — 외부 패키지 없이 RESP 프로토콜로 직접 대화합니다. 요청마다 연결해 서버리스에서도 안전합니다.
function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const a of args) { const b = Buffer.from(String(a)); out += '$' + b.length + '\r\n' + b.toString('binary') + '\r\n'; }
  return Buffer.from(out, 'binary');
}
function parseOne(buf, i) { // → [value, nextIndex] 또는 null(데이터 부족)
  if (i >= buf.length) return null;
  const end = buf.indexOf('\r\n', i);
  if (end < 0) return null;
  const t = String.fromCharCode(buf[i]), line = buf.toString('utf8', i + 1, end);
  if (t === '+') return [line, end + 2];
  if (t === '-') return [{ __err: line }, end + 2];
  if (t === ':') return [Number(line), end + 2];
  if (t === '$') {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    if (buf.length < end + 2 + n + 2) return null;
    return [buf.toString('utf8', end + 2, end + 2 + n), end + 2 + n + 2];
  }
  if (t === '*') {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    const arr = []; let j = end + 2;
    for (let k = 0; k < n; k++) { const r = parseOne(buf, j); if (!r) return null; arr.push(r[0]); j = r[1]; }
    return [arr, j];
  }
  throw new Error('알 수 없는 응답 형식');
}
export function tcpRedis(urlStr, timeoutMs = 8000) {
  const u = new URL(urlStr);
  const secure = u.protocol === 'rediss:';
  const host = u.hostname, port = Number(u.port || 6379);
  const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
  const db = Number((u.pathname || '').replace('/', '') || 0);
  const fail = msg => Object.assign(new Error('저장소 연결 오류(' + msg + ')'), { code: 'unavailable' });
  function pipeline(cmds) {
    const pre = [];
    if (pass) pre.push(user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]);
    if (db) pre.push(['SELECT', db]);
    const all = [...pre, ...cmds];
    return new Promise((resolve, reject) => {
      const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      let buf = Buffer.alloc(0); const replies = []; let done = false;
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(tm); sock.destroy(); err ? reject(err) : resolve(val); };
      const tm = setTimeout(() => finish(fail('시간 초과')), timeoutMs);
      sock.on(secure ? 'secureConnect' : 'connect', () => sock.write(Buffer.concat(all.map(encode))));
      sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        let i = 0;
        try {
          for (;;) { const r = parseOne(buf, i); if (!r) break; replies.push(r[0]); i = r[1]; }
        } catch (e) { return finish(fail(e.message)); }
        buf = buf.subarray(i);
        if (replies.length < all.length) return;
        for (let k = 0; k < pre.length; k++) if (replies[k] && replies[k].__err) return finish(fail('인증 실패'));
        const out = replies.slice(pre.length);
        const bad = out.find(x => x && x.__err);
        if (bad) return finish(Object.assign(new Error('저장소 오류: ' + bad.__err), { code: 'unavailable' }));
        finish(null, out);
      });
      sock.on('error', e => finish(fail(e.code || e.message)));
      sock.on('close', () => finish(fail('연결 끊김')));
    });
  }
  return { pipeline, cmd: async (...c) => (await pipeline([c]))[0] };
}

export function restRedis(url, token, fetchFn = fetch) {
  async function pipeline(cmds) {
    const r = await fetchFn(url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) throw Object.assign(new Error('저장소 연결 오류(' + r.status + ')'), { code: 'unavailable' });
    const out = await r.json();
    return out.map(x => { if (x.error) throw Object.assign(new Error('저장소 오류: ' + x.error), { code: 'unavailable' }); return x.result; });
  }
  return { pipeline, cmd: async (...c) => (await pipeline([c]))[0] };
}

// 테스트용 가짜 Redis (메모리). 명령 수를 세어 무료 한도 계산에 씁니다.
export function memoryRedis(clock = () => Date.now()) {
  const m = new Map(); // key -> { v, exp }
  let commands = 0;
  const live = k => { const x = m.get(k); if (x && x.exp && x.exp <= clock()) { m.delete(k); return null; } return x || null; };
  function run([c, ...a]) {
    commands++;
    switch (String(c).toUpperCase()) {
      case 'GET': return live(a[0])?.v ?? null;
      case 'MGET': return a.map(k => live(k)?.v ?? null);
      case 'DEL': return a.reduce((n, k) => n + (m.delete(k) ? 1 : 0), 0);
      case 'SET': {
        const [k, v, ...opt] = a;
        let exp = null, nx = false;
        for (let i = 0; i < opt.length; i++) {
          const o = String(opt[i]).toUpperCase();
          if (o === 'NX') nx = true;
          if (o === 'PX') exp = clock() + Number(opt[++i]);
          if (o === 'EX') exp = clock() + Number(opt[++i]) * 1000;
        }
        if (nx && live(k)) return null;
        m.set(k, { v: String(v), exp });
        return 'OK';
      }
      case 'INCR': { const x = live(a[0]); const v = Number(x?.v || 0) + 1; m.set(a[0], { v: String(v), exp: x?.exp || null }); return v; }
      case 'EXPIRE': { const x = live(a[0]); if (!x) return 0; x.exp = clock() + Number(a[1]) * 1000; return 1; }
      default: throw new Error('unsupported ' + c);
    }
  }
  return {
    store: m, get commands() { return commands; },
    async pipeline(cmds) { return cmds.map(run); },
    async cmd(...c) { return run(c); },
  };
}
