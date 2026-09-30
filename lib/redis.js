// Upstash Redis(REST) 연결 — Vercel 화면에서 "Upstash for Redis"를 붙이면 환경 변수가 자동으로 들어옵니다.
export function redisFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return restRedis(url.replace(/\/$/, ''), token);
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
