// 서버(lib/server.js)를 가짜 Redis(메모리) + 가짜 푸시 서버 + 가짜 캘린더로 돌려 보는 테스트. 실행: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as L from '../public/js/logic.js';
import { createServer } from '../lib/server.js';
import { memoryRedis } from '../lib/redis.js';

const DAY = '2026-09-30';
const T = h => L.at(DAY, h);
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const b64u = b => Buffer.from(b).toString('base64url');

// 휴대폰(브라우저) 흉내: 구독 키를 만들고, 받은 푸시를 실제로 복호화해서 읽음
function phone(name) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/' + name, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
  function decrypt(body) {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ecdhSecret = ecdh.computeSecret(asPublic);
    const prkKey = hmac(auth, ecdhSecret);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString());
  }
  return { name, sub, decrypt };
}

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260930T103000', 'DTEND;TZID=Asia/Seoul:20260930T113000', 'UID:e1', 'SUMMARY:국정감사 대비 간부회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260930T140000', 'DTEND;TZID=Asia/Seoul:20260930T150000', 'UID:e3', 'SUMMARY:농식품부 협의', 'LOCATION:정부세종청사', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001', 'UID:e2', 'SUMMARY:실국장 만찬', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function setup({ calStatus = 200 } = {}) {
  let now = T('09:20');
  const redis = memoryRedis(() => now);
  const phones = {}, inbox = [], calls = [];
  let goneEndpoints = new Set();
  const fetchFn = async (url, opt = {}) => {
    url = String(url); calls.push(url);
    if (url.includes('calendar')) return { ok: calStatus === 200, status: calStatus, text: async () => ICS };
    const p = Object.values(phones).find(x => x.sub.endpoint === url);
    assert.match(opt.headers.Authorization, /^vapid t=.+, k=.+/);
    assert.equal(opt.headers['Content-Encoding'], 'aes128gcm');
    if (goneEndpoints.has(url)) return { status: 410 };
    inbox.push({ to: p.name, ...p.decrypt(opt.body) });
    return { status: 201 };
  };
  const srv = createServer({ redis, env: { ACCESS_CODE: '2580', ADMIN_PASSWORD: 'pw-secret' }, fetchFn, now: () => now });
  const tok = {};
  const op = (who, o) => srv.handleOp(tok[who], o);
  async function join(who) { tok[who] = (await srv.handleOp(tok[who], { op: 'join', code: '2580' })).token; }
  async function ready(who) {
    if (!tok[who]) await join(who);
    phones[who] = phone(who);
    await op(who, { op: 'registerPush', sub: phones[who].sub });
    await op(who, { op: 'testPush' });
    const m = inbox.at(-1);
    assert.equal(m.kind, 'test'); assert.equal(m.to, who);
    await op(who, { op: 'confirmPush', nonce: m.nonce });
  }
  async function admin() { tok.adm = (await srv.handleOp(null, { op: 'adminLogin', password: 'pw-secret' })).token; }
  const day = () => JSON.parse(redis.store.get('bq:day:' + DAY)?.v || '{}');
  const byNo = n => day().tickets.find(t => t.no === n);
  const got = (from = 0) => inbox.slice(from).map(m => `${m.to}:${m.kind}`);
  return { srv, redis, op, join, ready, admin, day, byNo, inbox, got, calls, tok, setNow: t => (now = t), gone: u => goneEndpoints.add('https://push.example/' + u) };
}

test('접수 코드 → 알림 테스트(실제 암호화 푸시 복호화) → 번호표', async () => {
  const { srv, op, join, ready, inbox } = setup();
  await assert.rejects(srv.handleOp(null, { op: 'me' }), { code: 'unauthenticated' });
  await assert.rejects(srv.handleOp('abc.def', { op: 'me' }), { code: 'unauthenticated' });
  await assert.rejects(srv.handleOp(null, { op: 'join', code: '0000' }), { code: 'permission-denied', message: /접수 코드/ });
  await join('a');
  const me = await op('a', { op: 'me' });
  assert.equal(me.member, true); assert.equal(me.isAdmin, false); assert.equal(me.verified, false);
  await assert.rejects(op('a', { op: 'issue', name: '김민수', dept: '기획' }), { code: 'failed-precondition', message: /알림/ });
  await assert.rejects(op('a', { op: 'confirmPush', nonce: 'x' }), { code: 'failed-precondition' });
  await ready('a');
  assert.equal((await op('a', { op: 'me' })).verified, true);
  assert.equal(inbox.at(-1).title.length > 0, true);
  const r = await op('a', { op: 'issue', name: '김민수', dept: '기획조정과', topic: '국감 자료' });
  assert.equal(r.no, 1);
  // 공개 상태에는 실명·건명·기기ID가 없음
  const pub = JSON.stringify(r.state);
  assert.doesNotMatch(pub, /김민수|국감 자료/);
  assert.equal(r.state.tickets[0].uid, me.uid, '본인 표식으로 내 번호표를 찾을 수 있음');
  assert.equal(r.admin, undefined);
  await assert.rejects(op('a', { op: 'move', ticketId: r.id, dir: 1 }), { code: 'permission-denied' });
});

test('하루 흐름: 자동 호출 → 시작·완료 → 다음 호출·문 앞 알림 → 3분 초과 취소 → 캘린더 → 밤 정리', async () => {
  const { srv, op, ready, admin, byNo, day, got, setNow, calls, inbox } = setup();
  for (const u of ['a', 'b', 'c']) await ready(u);
  await admin();
  await srv.publicState(); // 앱이 현황을 볼 때 캘린더도 읽힘
  let from = inbox.length;
  setNow(T('09:21'));
  const r1 = await op('a', { op: 'issue', name: '김민수', dept: '기획' });
  assert.equal(byNo(1).status, 'called', '발급과 동시에 자동 호출');
  await op('b', { op: 'issue', name: '이서연', dept: '총괄' });
  await op('c', { op: 'issue', name: '박준호', dept: '운영' });
  assert.deepEqual(got(from), ['a:call', 'b:soon', 'c:soon']);
  // 캘린더는 상태 확인 때 읽힘
  assert.ok(calls.some(u => u.includes('calendar.google.com/calendar/ical/rdarndpolicy%40gmail.com/public/basic.ics')));
  assert.deepEqual(day().busy.map(b => L.hm(b.s) + '-' + L.hm(b.e) + (b.ext ? ' 대외' : '')), ['10:30-11:30', '14:00-15:00 대외']);
  assert.equal(day().allDayCount, 1);

  // 남의 번호표는 못 누름
  await assert.rejects(op('b', { op: 'start', ticketId: r1.id }), { code: 'permission-denied' });
  setNow(T('09:22')); from = inbox.length; await op('a', { op: 'start', ticketId: r1.id });
  assert.equal(byNo(1).status, 'in_progress');
  assert.deepEqual(got(from), ['b:next'], '보고 시작을 누르면 다음 사람에게 문 앞 대기 알림');
  assert.match(inbox.at(-1).body, /앞 분이 보고를 시작/);
  setNow(T('09:34')); from = inbox.length;
  await op('a', { op: 'complete', ticketId: r1.id });
  assert.equal(byNo(1).status, 'done'); assert.equal(byNo(2).status, 'called');
  assert.deepEqual(got(from), ['b:call']);

  // B는 입실하지 않음 → 1분마다 재알림 → 3분 지나면 자동 취소 → C 호출 (상태 조회만으로 진행)
  setNow(T('09:35')); from = inbox.length; await srv.publicState();
  assert.deepEqual(got(from), ['b:remind']);
  setNow(T('09:36')); from = inbox.length; await srv.publicState();
  assert.deepEqual(got(from), ['b:remind']);
  assert.match(inbox.at(-1).body, /1분 안에/);
  setNow(T('09:37')); from = inbox.length; await srv.publicState();
  assert.equal(byNo(2).status, 'timeout'); assert.equal(byNo(3).status, 'called');
  assert.deepEqual(got(from), ['b:timeout', 'c:call']);

  // 관리자: 복귀, 실명 보기, 알림 기록
  const ad = await op('adm', { op: 'restore', ticketId: byNo(2).id });
  assert.equal(byNo(2).status, 'waiting');
  assert.equal(Object.values(ad.admin.priv).map(p => p.name).sort().join(), '김민수,박준호,이서연');
  assert.equal(ad.admin.dayPrivate.busy[0].title, '국정감사 대비 간부회의');
  assert.ok(ad.admin.logs.some(l => l.kind === 'timeout' && l.ok));
  assert.equal(ad.state.settings.icalUrl, undefined, '공개 설정에는 iCal 주소 없음');

  // 10:30~11:30 회의(+5분 여유) 동안에는 호출하지 않음
  setNow(T('10:20')); await op('c', { op: 'start', ticketId: byNo(3).id });
  setNow(T('10:31')); await op('c', { op: 'complete', ticketId: byNo(3).id });
  assert.equal(byNo(2).status, 'waiting');
  setNow(T('11:36')); await srv.publicState();
  assert.equal(byNo(2).status, 'called');

  // 자정이 지나면 전날 정리
  setNow(L.at('2026-10-01', '00:10')); await srv.publicState();
  const d = day();
  assert.ok(d.cleanedAt); assert.equal(byNo(2).status, 'expired');
  assert.deepEqual(d.priv, {}); assert.deepEqual(d.logs, []); assert.deepEqual(d.busyTitled, []);
  assert.ok(d.busy.length && d.busy.every(b => !b.title), '자정 지나면 일정 제목도 지움');
  assert.equal(byNo(1).maskedName, '김*수', '가린 이름만 남음');
});

test('관리자: 비밀번호 로그인 · 부재 · 설정(접수 코드·iCal 주소) · 대리 접수', async () => {
  const { srv, op, admin, ready, byNo, setNow, calls } = setup();
  await assert.rejects(srv.handleOp(null, { op: 'adminLogin', password: 'nope' }), { code: 'permission-denied' });
  await admin();
  const me = await op('adm', { op: 'me' });
  assert.equal(me.isAdmin, true);
  await op('adm', { op: 'presence', mode: 'absent', note: '외부 회의' });
  await ready('a');
  await op('a', { op: 'issue', name: '김민수', dept: '기획' });
  assert.equal(byNo(1).status, 'waiting', '부재 중에는 호출 안 함');
  const p = await op('adm', { op: 'issue', proxy: true, name: '홍길동', dept: '감사' });
  assert.equal(p.no, 2); assert.equal(byNo(2).uid, null);
  await op('adm', { op: 'presence', mode: 'auto' });
  assert.equal(byNo(1).status, 'called');
  await assert.rejects(op('adm', { op: 'move', ticketId: byNo(2).id, dir: -1 }), { code: 'failed-precondition' });

  await assert.rejects(op('adm', { op: 'settings', values: { icalUrl: 'http://x' } }), { code: 'invalid-argument' });
  const n = calls.length;
  const r = await op('adm', { op: 'settings', values: { icalUrl: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', workEnd: '24:00' }, accessCode: 'NEW99' });
  assert.equal(r.admin.settings.icalUrl, 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics');
  assert.ok(calls.slice(n).some(u => u.includes('private-abc')), '주소를 바꾸면 바로 다시 읽음');
  assert.equal((await op('adm', { op: 'getSecret' })).accessCode, 'NEW99');
  await assert.rejects(srv.handleOp(null, { op: 'join', code: '2580' }), { code: 'permission-denied' });
  assert.ok((await srv.handleOp(null, { op: 'join', code: 'NEW99' })).token);
  await assert.rejects(op('a', { op: 'settings', values: {} }), { code: 'permission-denied' });
});

test('캘린더를 못 읽으면 오류를 남기고, 끊긴 푸시 구독은 지움', async () => {
  const { srv, op, ready, day, gone, redis, byNo } = setup({ calStatus: 404 });
  await srv.publicState();
  assert.match(day().calendarError, /공개|비밀 주소/);
  await ready('a');
  gone('a');
  await op('a', { op: 'issue', name: '김민수', dept: '기획' });
  assert.equal(byNo(1).flags.pushFail, true);
  const devKey = [...redis.store.keys()].find(k => k.startsWith('bq:dev:'));
  assert.equal(JSON.parse(redis.store.get(devKey).v).sub, null);
  assert.equal((await op('a', { op: 'me' })).verified, false);
});

test('무료 한도: 한가할 때 상태 조회 1회 = Redis 명령 1개', async () => {
  const { srv, redis, setNow } = setup();
  await srv.publicState(); // 첫 조회: 비밀값 생성 + 캘린더 읽기
  setNow(T('09:22'));
  const c0 = redis.commands;
  await srv.publicState();
  assert.equal(redis.commands - c0, 1);
  // 하루(06:30~24:00, 10초마다 계속 조회된다고 가정) 명령 수 추정
  setNow(T('07:00'));
  const c1 = redis.commands;
  for (let t = T('07:00'); t < T('23:59'); t += 10000) { setNow(t); await srv.publicState(); }
  const perDay = redis.commands - c1;
  assert.ok(perDay < 12000, '하루 ' + perDay + '개');
  console.log(`  하루 종일 10초마다 조회해도 Redis 명령 약 ${perDay}개/일 (무료 50만/월)`);
});

test('대외 일정: 자동 판단, 관리자가 바꾸기, 공개 화면 일정 제목은 설정에 따라', async () => {
  const { srv, op, admin, setNow } = setup();
  await admin();
  const r = await op('adm', { op: 'syncCalendar' });
  const ev = r.admin.dayPrivate.busy;
  assert.deepEqual(ev.map(b => b.title + ':' + b.ext), ['국정감사 대비 간부회의:false', '농식품부 협의:true']);
  assert.deepEqual(r.state.dayDoc.busy.map(b => !!b.ext), [false, true]);
  assert.deepEqual(r.state.dayDoc.busy.map(b => b.title), ['국정감사 대비 간부회의', '농식품부 협의'], '기본: 신청자 화면에도 일정 제목');
  assert.doesNotMatch(JSON.stringify(r.state), /정부세종청사/, '장소는 보내지 않음');
  const hid = await op('adm', { op: 'settings', values: { showEventTitles: false } });
  assert.doesNotMatch(JSON.stringify(hid.state), /농식품부|간부회의/, '끄면 제목 숨김');
  await op('adm', { op: 'settings', values: { showEventTitles: true } });
  // 정부세종청사(120km) → 복귀 80분 → 15:00 종료 후 16:20부터 보고 가능
  assert.equal(r.state.dayDoc.busy[1].ret, 80);
  assert.equal(ev[1].place, '정부세종청사');
  setNow(T('15:30')); let pub = await srv.publicState();
  assert.equal(L.availability(pub.settings, pub.dayDoc, T('16:10')).ok, false);
  assert.equal(L.availability(pub.settings, pub.dayDoc, T('16:20')).ok, true);
  // 관리자가 '내부'로 바꾸면 여유 5분만
  const r2 = await op('adm', { op: 'eventExt', key: ev[1].key, ext: false });
  assert.equal(r2.state.dayDoc.busy[1].ext, undefined);
  assert.equal(L.availability(r2.state.settings, r2.state.dayDoc, T('15:30')).ok, true);
  // 다시 읽어도 관리자가 바꾼 값 유지
  const r3 = await op('adm', { op: 'syncCalendar' });
  assert.equal(r3.admin.dayPrivate.busy[1].ext, false);
  await op('adm', { op: 'eventExt', key: ev[1].key, ext: null });
  setNow(T('15:31')); pub = await srv.publicState();
  assert.equal(pub.dayDoc.busy[1].ext, true, '자동 판단으로 되돌림');
});
