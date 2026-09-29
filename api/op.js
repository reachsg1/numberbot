// 앱의 모든 요청 창구: POST /api/op  (Authorization: Bearer <Firebase 로그인 토큰>)
import { getServer } from '../lib/firebase.js';

const STATUS = { unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'invalid-argument': 400, 'failed-precondition': 409, 'already-exists': 409, unavailable: 503 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { code: 'method', message: 'POST 요청만 받습니다.' } });
  try {
    const h = req.headers.authorization || '';
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await getServer().handleOp(h.startsWith('Bearer ') ? h.slice(7) : null, body);
    res.status(200).json(out);
  } catch (e) {
    const status = STATUS[e.code] || (e.code === 'config' ? 500 : 500);
    if (!STATUS[e.code]) console.error(e);
    res.status(status).json({ error: { code: e.code || 'internal', message: STATUS[e.code] || e.code === 'config' ? e.message : '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' } });
  }
}
