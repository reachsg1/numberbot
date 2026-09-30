// 서버 하나를 만들어 여러 요청이 같이 씁니다.
import { createServer } from '../lib/server.js';
import { redisFromEnv } from '../lib/redis.js';

let srv = null;
export function server() {
  if (!srv) srv = createServer({ redis: redisFromEnv(process.env), env: process.env });
  return srv;
}
export function fail(res, e) {
  const code = e?.code || 'internal';
  const status = { unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 412, 'invalid-argument': 400, 'resource-exhausted': 429, unavailable: 503 }[code] || 500;
  if (status === 500) console.error(e);
  res.status(status).json({ error: { code, message: status === 500 ? '서버 오류가 났습니다. 잠시 후 다시 시도해 주세요.' : e.message } });
}
