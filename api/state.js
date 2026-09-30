// 공개 현황: GET /api/state — 여러 사람이 동시에 봐도 10초에 한 번만 실제로 계산합니다(Vercel 캐시).
// 계산할 때마다 호출·알림 판단과 캘린더 확인도 함께 해서 '1분 타이머' 역할을 겸합니다.
import { server, fail } from './_srv.js';

export default async function handler(req, res) {
  try {
    const st = await server().publicState();
    res.setHeader('Cache-Control', st.configured ? 'public, max-age=0, s-maxage=10, stale-while-revalidate=5' : 'no-store');
    res.status(200).json(st);
  } catch (e) { res.setHeader('Cache-Control', 'no-store'); fail(res, e); }
}
