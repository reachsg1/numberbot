// 회의실 예약(줄안서에 합친 부분) 확인 — 실제 Postgres가 있을 때만 돌아갑니다.
// 실행 예: ROOMS_TEST_DB=postgresql://pg@localhost:54329/rooms npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const DB = process.env.ROOMS_TEST_DB;
const skip = !DB && '회의실 테스트용 DB(ROOMS_TEST_DB)가 없어 건너뜀';

function call(handler, { method = 'GET', action, query = {}, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {}, headersSent: false, writableEnded: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      json(o) { this.writableEnded = true; resolve({ status: this.statusCode, body: o }); },
      send(s) { this.writableEnded = true; resolve({ status: this.statusCode, body: s }); },
    };
    handler({ method, query: { action, ...query }, body: body || {}, headers }, res).catch(reject);
  });
}

test('회의실: 접속 코드 · 예약 · 겹침 차단 · 관리자 비밀번호 분리', { skip }, async () => {
  Object.assign(process.env, {
    DB_DRIVER: 'psql', DATABASE_URL: DB,
    ROOM_ACCESS_CODE: '1234', ROOM_ADMIN_PASSWORD: 'room-pw', ROOM_APP_SECRET: 'room-secret-for-test',
    ADMIN_PASSWORD: 'jul-an-seo-pw', // 줄안서(비서실) 비밀번호 — 회의실 관리자 로그인에는 쓰이지 않아야 함
  });
  const { default: bookings } = await import('../api/room-bookings.js');
  const { default: admin } = await import('../api/room-admin.js');
  const code = { 'x-access-code': '1234' };

  // 설정은 코드 없이 열림, 목록은 코드 필요
  const cfg = await call(bookings, { action: 'config' });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.accessRequired, true);
  assert.equal(cfg.body.config.roomPhoto, '/rooms/img/room.jpg');
  const kst = new Date(Date.now() + 9 * 3600e3);
  kst.setUTCDate(kst.getUTCDate() + 3);
  const day = kst.toISOString().slice(0, 10);
  assert.equal((await call(bookings, { action: 'list', query: { from: day, to: day } })).status, 401);

  // 예약 → 같은 시간 두 번째는 409
  const b = { date: day, start: '10:00', end: '11:00', title: '테스트 회의', applicant: '홍길동', dept: '연구정책과', pin: '1111' };
  const r1 = await call(bookings, { method: 'POST', action: 'create', body: b, headers: code });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await call(bookings, { method: 'POST', action: 'create', body: { ...b, start: '10:30', end: '11:30', applicant: '김철수' }, headers: code });
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /이미 예약된 시간/);
  const list = await call(bookings, { action: 'list', query: { from: day, to: day }, headers: code });
  assert.ok(list.body.bookings.some(x => x.title === '테스트 회의' && x.start === '10:00'));

  // 관리자: 줄안서 비밀번호로는 안 되고, 회의실 비밀번호로만 로그인
  assert.equal((await call(admin, { method: 'POST', action: 'login', body: { password: 'jul-an-seo-pw' }, headers: code })).status, 401);
  const lg = await call(admin, { method: 'POST', action: 'login', body: { password: 'room-pw', name: '담당' }, headers: code });
  assert.equal(lg.status, 200);
  const st = await call(admin, { action: 'stats', query: { month: day.slice(0, 7) }, headers: { ...code, authorization: 'Bearer ' + lg.body.token } });
  assert.equal(st.status, 200);
  // 비밀번호(4자리)로 본인 취소
  const id = r1.body.created[0].id;
  assert.equal((await call(bookings, { method: 'POST', action: 'cancel', body: { id, pin: '0000' }, headers: code })).status, 403);
  assert.equal((await call(bookings, { method: 'POST', action: 'cancel', body: { id, pin: '1111' }, headers: code })).status, 200);
});
