// 앱이 부르는 모든 기능: POST /api/op  { op: '...', ... }   (Authorization: Bearer <출입증>)
import { server, fail } from './_srv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: { code: 'method', message: 'POST만 받습니다.' } });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    res.status(200).json(await server().handleOp(token, body));
  } catch (e) { fail(res, e); }
}
