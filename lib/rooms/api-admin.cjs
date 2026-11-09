// 회의실 관리자용 API: /api/room-admin?action=...  (줄안서와 같은 주소에서 운영)
const route = require('./route.cjs');
const svc = require('./service.cjs');
const { httpError, safeEqual, signToken, str, kstNow } = require('./util.cjs');

const actor = (user) => (user && user.name ? `관리자(${user.name})` : '관리자');

module.exports = route(
  {
    'POST login': async ({ body }) => {
      // 회의실 관리자 비밀번호는 줄안서(비서실)와 따로 둡니다. ROOM_ADMIN_PASSWORD가 없으면 예전 이름도 확인합니다.
      const pw = process.env.ROOM_ADMIN_PASSWORD;
      if (!pw) throw httpError(503, '회의실 관리자 비밀번호(ROOM_ADMIN_PASSWORD)가 설정되지 않았습니다.');
      if (!safeEqual(String(body.password || ''), pw)) {
        await new Promise((r) => setTimeout(r, 700)); // 무차별 대입 완화
        throw httpError(401, '관리자 비밀번호가 맞지 않습니다.');
      }
      const name = str(body.name, 20);
      return { token: signToken({ role: 'admin', name, exp: Date.now() + 12 * 3600e3 }), name };
    },
    'GET list': ({ query }) => svc.adminList(query),
    'GET logs': ({ query }) => svc.adminLogs({ bookingId: query.bookingId, limit: query.limit, offset: query.offset }),
    'GET stats': ({ query }) => svc.adminStats({ month: query.month }),
    'GET export': async ({ query, res }) => {
      const csv = await svc.adminExport(query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="meeting-room_${query.from}_${query.to}.csv"`);
      res.status(200).send(csv);
    },
    'POST create': ({ body, user }) => svc.createBooking(body, { admin: true, actor: actor(user) }),
    'POST update': ({ body, user }) => svc.updateBooking(body.id, body, { admin: true, actor: actor(user) }),
    'POST cancel': ({ body, user }) =>
      svc.cancelBooking(body.id, { admin: true, actor: actor(user), scope: body.scope, reason: body.reason }),
    'POST restore': ({ body, user }) => svc.restoreBooking(body.id, { actor: actor(user) }),
    'POST swap': ({ body, user }) => svc.swapBookings(body.a, body.b, { actor: actor(user) }),
    'GET ping': () => ({ ok: true, now: kstNow() }),
  },
  { admin: true, adminOpen: ['POST login'] }
);
