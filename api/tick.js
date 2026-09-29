// 1분마다 불리는 판단 창구: GET /api/tick?key=<CRON_SECRET>
// cron-job.org가 1분마다 부르고, Vercel 자체 예약(하루 1번)도 밤 정리용으로 부릅니다.
import { getServer } from '../lib/firebase.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = req.query?.key || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!secret) return res.status(500).json({ error: 'Vercel 환경 변수 CRON_SECRET이 없습니다.' });
  if (given !== secret) return res.status(401).json({ error: '키가 맞지 않습니다.' });
  try {
    const out = await getServer().runTick();
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
