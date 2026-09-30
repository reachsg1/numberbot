// 예약 작업용: GET /api/tick  (Vercel 매일 예약 · cron-job.org 1분마다 · 선택)
// 환경 변수 CRON_SECRET을 정했다면 ?key=값 또는 Authorization: Bearer 값이 맞아야 합니다.
import { server, fail } from './_srv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const want = process.env.CRON_SECRET;
  if (want) {
    const got = String(req.query?.key || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (got !== want) return res.status(401).json({ error: { code: 'unauthenticated', message: 'key가 맞지 않습니다.' } });
  }
  try { res.status(200).json(await server().runTick()); } catch (e) { fail(res, e); }
}
