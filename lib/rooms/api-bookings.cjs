// 회의실 일반 사용자용 API: /api/room-bookings?action=...  (줄안서와 같은 주소에서 운영)
const route = require('./route.cjs');
const svc = require('./service.cjs');

module.exports = route(
  {
    'GET config': () => svc.getConfig(),
    'GET list': ({ query }) => svc.listBookings(query.from, query.to),
    'GET mine': ({ query }) => svc.findByApplicant(query.name),
    'POST create': ({ body }) => svc.createBooking(body, { admin: false }),
    'POST update': ({ body }) => svc.updateBooking(body.id, body, { admin: false, pin: body.pin }),
    'POST cancel': ({ body }) => svc.cancelBooking(body.id, { admin: false, pin: body.pin, scope: body.scope }),
  },
  { open: ['GET config'] }
);
