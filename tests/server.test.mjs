// 서버(lib/server.js)를 가짜 Firebase로 돌려 보는 테스트. 실행: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/js/logic.js';
import { createServer } from '../lib/server.js';
import { fakeFirestore, fakeAuth, fakeMessaging } from './fake-firebase.mjs';

const DAY = '2026-09-23';
const T = h => L.at(DAY, h);

function setup() {
  const db = fakeFirestore(), auth = fakeAuth(), messaging = fakeMessaging();
  let now = T('09:20');
  const calls = [];
  const fetchFn = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ items: [
      { summary: '국정감사 대비 간부회의', start: { dateTime: `${DAY}T10:30:00+09:00` }, end: { dateTime: `${DAY}T11:30:00+09:00` } },
      { summary: '실국장 만찬', start: { date: DAY }, end: { date: '2026-09-24' } },
      { summary: '취소된 회의', status: 'cancelled', start: { dateTime: `${DAY}T15:00:00+09:00` }, end: { dateTime: `${DAY}T16:00:00+09:00` } },
    ] }) };
  };
  const srv = createServer({ db, auth, messaging, env: { ADMIN_EMAILS: 'Boss@korea.kr', ACCESS_CODE: '2580' }, fetchFn, googleToken: async () => 'gtoken', now: () => now });
  auth.login('tAdm', { uid: 'adm', email: 'boss@korea.kr', email_verified: true });
  for (const u of ['a', 'b', 'c', 'x']) auth.login('t' + u, { uid: u });
  const op = (tok, o) => srv.handleOp(tok, o);
  const tickets = () => [...db.store].filter(([p]) => p.startsWith('tickets/')).map(([p, d]) => ({ id: p.split('/')[1], ...d }));
  const byNo = n => tickets().find(t => t.no === n);
  async function ready(u, token = 'tok-' + u) {
    await op('t' + u, { op: 'join', code: '2580' });
    await op('t' + u, { op: 'registerDevice', token });
    await op('t' + u, { op: 'testPush' });
    const nonce = messaging.sent.at(-1).data.nonce;
    await op('t' + u, { op: 'confirmPush', nonce });
  }
  return { db, auth, messaging, srv, op, tickets, byNo, ready, calls, setNow: t => (now = t), getNow: () => now };
}
const kinds = (m, from = 0) => m.sent.slice(from).map(x => `${x.token}:${x.data.kind}`);

test('로그인·접수 코드·알림 테스트를 거쳐야 번호표를 받을 수 있음', async () => {
  const { op, ready, messaging } = setup();
  await assert.rejects(op(null, { op: 'me' }), { code: 'unauthenticated' });
  await assert.rejects(op('bad', { op: 'me' }), { code: 'unauthenticated' });
  assert.equal((await op('ta', { op: 'me' })).member, false);
  await assert.rejects(op('ta', { op: 'issue', name: '김민수', dept: '기획' }), { code: 'permission-denied' });
  await assert.rejects(op('ta', { op: 'join', code: '0000' }), { code: 'permission-denied', message: /접수 코드/ });
  await op('ta', { op: 'join', code: '2580' });
  assert.equal((await op('ta', { op: 'me' })).member, true);
  await assert.rejects(op('ta', { op: 'issue', name: '김민수', dept: '기획' }), { code: 'failed-precondition', message: /알림/ });
  await op('ta', { op: 'registerDevice', token: 'tok-a' });
  await op('ta', { op: 'testPush' });
  assert.equal(messaging.sent.at(-1).data.kind, 'test');
  await assert.rejects(op('ta', { op: 'confirmPush', nonce: 'wrong' }), { code: 'failed-precondition' });
  await ready('a');
  assert.equal((await op('ta', { op: 'me' })).verified, true);
});

test('하루 흐름: 발급 → 자동 호출 → 보고 시작·완료 → 다음 호출 → 5분 시간 초과 → 캘린더 반영', async () => {
  const { op, srv, ready, byNo, messaging, setNow, db, calls } = setup();
  for (const u of ['a', 'b', 'c']) await ready(u);
  const m0 = messaging.sent.length;
  setNow(T('09:30'));
  const r1 = await op('ta', { op: 'issue', name: '김민수', dept: '기획예산과', topic: '국감 답변', refMin: 15 });
  assert.equal(r1.no, 1);
  assert.equal(byNo(1).status, 'called', '대기자가 없으니 바로 호출');
  assert.equal(byNo(1).maskedName, '김*수');
  assert.equal(db.store.get('private/' + r1.id).name, '김민수', '실명은 비공개 문서에만');
  await op('tb', { op: 'issue', name: '이서연', dept: '정책총괄과' });
  assert.equal(byNo(2).status, 'waiting');
  assert.deepEqual(kinds(messaging, m0), ['tok-a:call', 'tok-b:next']);
  await assert.rejects(op('tb', { op: 'issue', name: '이서연', dept: '정책총괄과' }), { code: 'already-exists' });
  await assert.rejects(op('tb', { op: 'start', ticketId: r1.id }), { code: 'permission-denied' });

  setNow(T('09:31'));
  await op('ta', { op: 'start', ticketId: r1.id });
  assert.equal(byNo(1).status, 'in_progress');
  setNow(T('09:31') + 30000);
  await assert.rejects(op('ta', { op: 'complete', ticketId: r1.id }), { message: /1분/ });
  setNow(T('09:43'));
  await op('ta', { op: 'complete', ticketId: r1.id });
  assert.equal(byNo(1).status, 'done');
  assert.equal(byNo(1).open, false, '끝난 번호표는 open=false');
  assert.equal(byNo(2).status, 'called', '완료 즉시 다음 사람 호출');
  assert.equal(db.store.get('settings/public').avgMs, Math.round(10 * L.MIN * 0.7 + 12 * L.MIN * 0.3));

  setNow(T('09:44'));
  await op('tc', { op: 'issue', name: '박준호', dept: '운영지원과' });
  setNow(T('09:46'));
  let out = await srv.runTick();
  assert.equal(out.calendar.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(db.store.get('days/' + DAY).busy, [{ s: T('10:30'), e: T('11:30') }], '취소된 일정은 빼고, 종일 일정은 막지 않음');
  assert.equal(db.store.get('dayPrivate/' + DAY).busy[0].title, '국정감사 대비 간부회의');
  assert.deepEqual(db.store.get('dayPrivate/' + DAY).allDay, ['실국장 만찬']);
  assert.equal(byNo(2).flags.remind, true, '3분 재알림');

  setNow(T('09:48'));
  out = await srv.runTick();
  assert.equal(out.calendar, undefined, '캘린더는 5분마다만');
  assert.equal(byNo(2).status, 'timeout', '5분 안에 보고 시작 없음');
  assert.equal(byNo(3).status, 'called', '다음 사람 자동 호출');
  assert.ok(kinds(messaging).includes('tok-b:timeout'));
  assert.ok(kinds(messaging).includes('tok-c:call'));

  // 회의 시간에는 호출하지 않음
  await op('ta', { op: 'issue', name: '김민수', dept: '기획예산과' });
  setNow(T('09:49'));
  await op('tc', { op: 'start', ticketId: byNo(3).id });
  setNow(T('10:25'));
  await op('tc', { op: 'complete', ticketId: byNo(3).id });
  assert.equal(byNo(4).status, 'waiting', '10:30 회의에 걸려 보류');
  setNow(T('11:34')); await srv.runTick();
  assert.equal(byNo(4).status, 'waiting', '회의 끝 + 5분 전');
  setNow(T('11:35')); await srv.runTick();
  assert.equal(byNo(4).status, 'called');
});

test('관리자: 부트스트랩, 부재·재실, 순서 조정, 복귀, 설정, 관리자 목록', async () => {
  const { op, srv, ready, byNo, setNow, db } = setup();
  const me = await op('tAdm', { op: 'me' });
  assert.equal(me.isAdmin, true);
  assert.ok(db.store.has('admins/boss@korea.kr'), '환경 변수 관리자는 첫 접속 때 등록');
  await assert.rejects(op('ta', { op: 'presence', mode: 'absent' }), { code: 'permission-denied' });
  for (const u of ['a', 'b', 'c']) await ready(u);
  setNow(T('09:30'));
  await op('tAdm', { op: 'presence', mode: 'absent', note: '외부 일정' });
  for (const u of ['a', 'b', 'c']) await op('t' + u, { op: 'issue', name: '홍길동' + u, dept: '과' + u });
  assert.equal(byNo(1).status, 'waiting', '부재 중에는 호출 안 함');
  await op('tAdm', { op: 'urgent', ticketId: byNo(3).id });
  await op('tAdm', { op: 'move', ticketId: byNo(1).id, dir: 1 });
  await assert.rejects(op('ta', { op: 'move', ticketId: byNo(1).id, dir: 1 }), { code: 'permission-denied' });
  await op('tAdm', { op: 'presence', mode: 'auto' });
  assert.equal(byNo(3).status, 'called', '긴급 번호표가 먼저 호출');
  await op('tAdm', { op: 'cancel', ticketId: byNo(3).id });
  assert.equal(byNo(3).status, 'cancelled');
  assert.equal(byNo(2).status, 'called', '▼로 1번이 2번 뒤로 갔으므로 2번 호출');
  await op('tAdm', { op: 'restore', ticketId: byNo(3).id });
  assert.equal(byNo(3).status, 'waiting');
  // 대리 접수는 관리자가 시작·완료
  const px = await op('tAdm', { op: 'issue', proxy: true, name: '최유진', dept: '감사담당관실' });
  assert.equal(byNo(px.no).uid, null);
  // 설정
  await assert.rejects(op('tAdm', { op: 'settings', values: { remindMin: 5, startLimitMin: 5 } }), { code: 'invalid-argument' });
  await assert.rejects(op('tAdm', { op: 'settings', values: {}, accessCode: '1' }), { code: 'invalid-argument' });
  await op('tAdm', { op: 'settings', values: { soonMin: 15, appointEnabled: false }, accessCode: '9999' });
  assert.equal((await op('tAdm', { op: 'getSecret' })).accessCode, '9999');
  await assert.rejects(op('tx', { op: 'join', code: '2580' }), { code: 'permission-denied' });
  await op('tx', { op: 'join', code: '9999' });
  // 관리자 목록
  await op('tAdm', { op: 'admins', action: 'add', email: 'Secretary@korea.kr' });
  assert.deepEqual((await op('tAdm', { op: 'admins', action: 'list' })).admins, ['boss@korea.kr', 'secretary@korea.kr']);
  await assert.rejects(op('tAdm', { op: 'admins', action: 'remove', email: 'boss@korea.kr' }), { code: 'failed-precondition' });
  await op('tAdm', { op: 'admins', action: 'remove', email: 'secretary@korea.kr' });
  // 캘린더 수동 새로고침
  assert.equal((await op('tAdm', { op: 'syncCalendar' })).ok, true);
});

test('시간 지정 번호표: 보류 → 10분 전 알림 → 지정 시각에 맨 앞', async () => {
  const { op, srv, ready, byNo, setNow, messaging } = setup();
  for (const u of ['a', 'b', 'c']) await ready(u);
  setNow(T('13:00'));
  await op('ta', { op: 'issue', name: '가', dept: '가과' });                           // 1 → 호출
  await op('tb', { op: 'issue', name: '나', dept: '나과' });                           // 2 대기
  await assert.rejects(op('tc', { op: 'issue', name: '다', dept: '다과', appointAt: T('13:20') }), { message: /30분 이후/ });
  await op('tc', { op: 'issue', name: '다', dept: '다과', appointAt: T('13:40') });  // 3 지정
  assert.equal(byNo(3).status, 'held');
  await op('ta', { op: 'start', ticketId: byNo(1).id });
  setNow(T('13:30')); await srv.runTick();
  assert.ok(kinds(messaging).includes('tok-c:appt'));
  setNow(T('13:40')); await srv.runTick();
  assert.equal(byNo(3).status, 'waiting');
  setNow(T('13:41'));
  await op('ta', { op: 'complete', ticketId: byNo(1).id });
  assert.equal(byNo(3).status, 'called', '지정 번호표가 일반 대기(2번)보다 먼저');
  assert.equal(byNo(2).status, 'waiting');
});

test('되돌리기, 끊긴 알림 토큰 정리, 밤 정리', async () => {
  const { op, srv, ready, byNo, setNow, messaging, db } = setup();
  await ready('a'); await ready('b');
  db.store.get('devices/b').token = 'dead'; // 휴대폰에서 앱을 지운 상황
  setNow(T('14:10'));
  await op('ta', { op: 'issue', name: '가', dept: '가과' });
  await op('tb', { op: 'issue', name: '나', dept: '나과' });
  await op('ta', { op: 'start', ticketId: byNo(1).id });
  setNow(T('14:20'));
  await op('ta', { op: 'complete', ticketId: byNo(1).id });
  assert.equal(byNo(2).status, 'called');
  assert.equal(db.store.get('devices/b').token, null, '끊긴 토큰은 지움');
  assert.equal(byNo(2).flags.pushFail, true, '관리 화면에 알림 실패 표시');
  setNow(T('14:20') + 40000);
  await op('ta', { op: 'undo', ticketId: byNo(1).id });
  assert.equal(byNo(1).status, 'in_progress');
  assert.equal(byNo(2).status, 'waiting', '방금 호출된 사람은 대기로');
  const logs = [...db.store].filter(([p]) => p.startsWith('logs/')).map(([, d]) => d);
  assert.ok(logs.some(l => !l.ok && l.kind === 'call'));
  // 밤 정리
  setNow(T('22:10'));
  assert.equal((await srv.runTick()).skipped, true);
  setNow(T('23:31'));
  const r = await srv.runTick();
  assert.ok(r.cleaned >= 2);
  assert.equal([...db.store.keys()].filter(p => p.startsWith('private/')).length, 0, '실명·건명 삭제');
  assert.equal((await srv.runTick()).skipped, true, '하루 한 번만');
  // 자정을 넘겨 처음 불려도 전날 것을 정리
  const { srv: s2, op: op2, ready: r2, setNow: n2, db: db2 } = setup();
  await r2('a'); n2(T('15:00')); await op2('ta', { op: 'issue', name: '가', dept: '가과' });
  n2(T('23:59') + 2 * 60000);
  const r3 = await s2.runTick();
  assert.ok(r3.cleaned >= 1);
  assert.ok(db2.store.get('days/' + DAY).cleanedAt);
});
