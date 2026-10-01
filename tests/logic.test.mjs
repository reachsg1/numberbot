// 실행: node --test tests/logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/js/logic.js';

const DAY = '2026-09-23';
const T = hhmm => L.at(DAY, hhmm);
const M = L.MIN;
const S = { requirePush: false, workStart: '09:00', workEnd: '18:00' };
const dayDoc = { busy: [{ s: T('10:30'), e: T('11:30') }] };
let seq = 0;
function tk(o) { seq++; return { id: 't' + seq, day: DAY, no: seq, status: 'waiting', order: seq, createdAt: seq, flags: {}, uid: 'u' + seq, ...o }; }
function apply(tickets, r) { const m = new Map(tickets.map(t => [t.id, { ...t }])); for (const u of r.updates) Object.assign(m.get(u.id), u.patch); return [...m.values()]; }

test('시간 도우미: KST 날짜와 시각', () => {
  assert.equal(L.dayKey(T('00:30')), DAY);
  assert.equal(L.hm(T('13:05')), '13:05');
  assert.equal(L.maskName('김민수'), '김*수');
  assert.equal(L.maskName('남궁민수'), '남**수');
  assert.equal(L.maskName('이서'), '이*');
});

test('보고 가능 여부: 일정 + 5분 여유, 점심, 부재, 재실', () => {
  assert.equal(L.availability(S, dayDoc, T('10:00')).ok, true);
  assert.equal(L.availability(S, dayDoc, T('10:25')).ok, false, '10분 보고가 10:30 회의에 걸림');
  assert.equal(L.availability(S, dayDoc, T('10:45')).why, 'busy');
  assert.equal(L.availability(S, dayDoc, T('11:32')).why, 'busy', '회의 끝 + 5분 여유');
  assert.equal(L.availability(S, dayDoc, T('11:35')).ok, true);
  assert.equal(L.availability(S, dayDoc, T('12:10')).why, 'lunch');
  assert.equal(L.availability(S, dayDoc, T('08:50')).why, 'before');
  assert.equal(L.availability(S, dayDoc, T('18:00')).why, 'closed');
  const absent = { ...S, presence: { mode: 'absent' } };
  assert.equal(L.availability(absent, dayDoc, T('15:00')).why, 'absent');
  const p = L.presencePatch('present', '', S, dayDoc, T('10:45'));
  assert.equal(p.until, T('11:35'), '재실은 지금 걸린 일정(+여유)이 끝날 때까지');
  assert.equal(L.availability({ ...S, presence: p }, dayDoc, T('10:45')).ok, true);
  assert.equal(L.presencePatch('present', '', S, dayDoc, T('15:00')).mode, 'auto', '걸린 일정이 없으면 자동으로 둠');
});

test('예상 시각: 평균 10분, 회의·점심을 피해 배정 (설계 문서 3장 예시)', () => {
  const ts = ['A', 'B', 'C', 'D'].map((n, i) => tk({ id: n, order: i }));
  const q = L.computeQueue(ts, S, { busy: [{ s: T('10:30'), e: T('11:25') }] }, T('10:45'));
  assert.deepEqual(['A', 'B', 'C', 'D'].map(n => L.hm(q.eta[n])), ['11:30', '11:40', '11:50', '13:00']);
});

test('예상 시각: 시간 지정 번호표를 고정점으로 넣음 (설계 문서 6장 예시)', () => {
  const now = T('13:52');
  const ts = [
    tk({ id: 'B', status: 'in_progress', calledAt: T('13:50'), startedAt: T('13:52') }),
    tk({ id: 'X', status: 'held', appointAt: T('14:00') }),
    tk({ id: 'C', order: 50 }),
  ];
  const q = L.computeQueue(ts, { ...S, lunch: false }, {}, now);
  assert.equal(L.hm(q.eta.X), '14:02', 'B가 끝나는 대로 X');
  assert.equal(L.hm(q.eta.C), '14:12', 'C는 X 다음');
});

test('엔진: 자동 호출 → 다음 차례 알림 → 재알림 → 5분 시간 초과 → 다음 사람 호출', () => {
  let ts = [tk({ id: 'A' }), tk({ id: 'B' }), tk({ id: 'C' })];
  let r = L.tick(ts, S, {}, T('09:30'));
  ts = apply(ts, r);
  assert.equal(ts.find(t => t.id === 'A').status, 'called');
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['A:call', 'B:soon', 'C:soon'], '호출 단계에서는 다음 사람에게 곧 차례만');
  r = L.tick(ts, S, {}, T('09:31')); ts = apply(ts, r);
  assert.equal(r.notices.length, 0, '같은 알림을 두 번 보내지 않음');
  r = L.tick(ts, S, {}, T('09:33')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['A:remind']);
  r = L.tick(ts, S, {}, T('09:35')); ts = apply(ts, r);
  assert.equal(ts.find(t => t.id === 'A').status, 'timeout');
  assert.equal(ts.find(t => t.id === 'B').status, 'called');
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['A:timeout', 'B:call']);
  // B가 '보고 시작'을 누르면 바로 다음 C에게 문 앞 대기 알림
  ts = ts.map(t => t.id === 'B' ? { ...t, status: 'in_progress', startedAt: T('09:36') } : t);
  r = L.tick(ts, S, {}, T('09:36')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['C:next']);
  r = L.tick(ts, S, {}, T('09:37'));
  assert.equal(r.notices.length, 0);
});

test('엔진: 보고 시작 후 완료 → 즉시 다음 호출, 회의 중에는 보류 후 회의+5분에 호출', () => {
  let ts = [tk({ id: 'A', status: 'in_progress', calledAt: T('10:10'), startedAt: T('10:11') }), tk({ id: 'B' })];
  const done = L.actComplete(ts[0], { uid: ts[0].uid }, T('10:20'));
  assert.equal(done.dur, 9 * M);
  ts[0] = { ...ts[0], ...done.patch };
  let r = L.tick(ts, S, dayDoc, T('10:20')); ts = apply(ts, r);
  assert.equal(ts[1].status, 'called', '10:20에는 10분 보고가 10:30 전에 끝나므로 호출');
  ts = [tk({ id: 'A', status: 'done' }), tk({ id: 'B' })];
  r = L.tick(ts, S, dayDoc, T('10:40')); ts = apply(ts, r);
  assert.equal(ts[1].status, 'waiting', '회의 중 보류');
  r = L.tick(ts, S, dayDoc, T('11:34')); ts = apply(ts, r);
  assert.equal(ts[1].status, 'waiting', '회의 끝+5분 전');
  r = L.tick(ts, S, dayDoc, T('11:35')); ts = apply(ts, r);
  assert.equal(ts[1].status, 'called');
});

test('엔진: 지정 번호표 10분 전 알림, 지정 시각에 대기열 맨 앞으로', () => {
  let ts = [
    tk({ id: 'A', status: 'in_progress', calledAt: T('13:50'), startedAt: T('13:52') }),
    tk({ id: 'C', order: 5 }),
    tk({ id: 'X', status: 'held', appointAt: T('14:00'), order: 9 }),
  ];
  let r = L.tick(ts, S, {}, T('13:50')); ts = apply(ts, r);
  assert.ok(r.notices.some(n => n.id === 'X' && n.kind === 'appt'));
  r = L.tick(ts, S, {}, T('14:00')); ts = apply(ts, r);
  const x = ts.find(t => t.id === 'X');
  assert.equal(x.status, 'waiting');
  ts = ts.map(t => (t.id === 'A' ? { ...t, status: 'done' } : t));
  r = L.tick(ts, S, {}, T('14:03')); ts = apply(ts, r);
  assert.equal(ts.find(t => t.id === 'X').status, 'called', '지정 번호표가 C보다 먼저');
  assert.equal(ts.find(t => t.id === 'C').status, 'waiting');
});

test('엔진: 보고 종료 시각에 남은 대기 마감', () => {
  let ts = [tk({ id: 'A' }), tk({ id: 'X', status: 'held', appointAt: T('17:50') })];
  const r = L.tick(ts, S, {}, T('18:00'));
  assert.deepEqual(r.notices.map(n => n.kind).sort(), ['expired', 'expired']);
});

test('동작: 번호표 발급 검증', () => {
  const now = T('10:00');
  assert.throws(() => L.actIssue({ name: '', dept: 'x' }, { uid: 'a' }, [], S, {}, now), /이름/);
  assert.throws(() => L.actIssue({ name: '홍길동', dept: '기획' }, { uid: 'a' }, [], { ...S, requirePush: true }, {}, now), /알림/);
  const ok = L.actIssue({ name: '홍길동', dept: '기획', refMin: 15 }, { uid: 'a' }, [], S, {}, now);
  assert.equal(ok.ticket.maskedName, '홍*동');
  assert.equal(ok.ticket.status, 'waiting');
  assert.equal(ok.priv.name, '홍길동');
  assert.throws(() => L.actIssue({ name: '홍길동', dept: '기획' }, { uid: 'a' }, [{ ...ok.ticket, id: 'z', no: 1 }], S, {}, now), /이미 001번/);
  assert.throws(() => L.actIssue({ name: '홍', dept: '기', appointAt: T('10:20') }, { uid: 'b' }, [], S, dayDoc, now), /30분 이후/);
  assert.throws(() => L.actIssue({ name: '홍', dept: '기', appointAt: T('10:40') }, { uid: 'b' }, [], S, dayDoc, T('10:00') - 60 * M), /일정/);
  const ap = L.actIssue({ name: '홍', dept: '기', appointAt: T('14:00') }, { uid: 'b' }, [], S, dayDoc, now);
  assert.equal(ap.ticket.status, 'held');
  assert.throws(() => L.actIssue({ name: '홍', dept: '기', appointAt: T('14:00') }, { uid: 'b' }, [], { ...S, appointEnabled: false }, dayDoc, now), /시간 지정/);
  assert.throws(() => L.actIssue({ name: '홍', dept: '기', proxy: true }, { uid: 'b' }, [], S, {}, now), /관리자/);
  assert.equal(L.actIssue({ name: '홍', dept: '기', proxy: true }, { uid: 'adm', isAdmin: true }, [], { requirePush: true }, {}, now).ticket.uid, null);
});

test('동작: 보고 시작·완료·되돌리기 권한과 1분 규칙', () => {
  const t = tk({ id: 'A', status: 'called', calledAt: T('10:00') });
  assert.throws(() => L.actStart(t, { uid: 'other' }, T('10:01')), /본인/);
  const st = L.actStart(t, { uid: t.uid }, T('10:01'));
  const t2 = { ...t, ...st };
  assert.throws(() => L.actComplete(t2, { uid: t.uid }, T('10:01') + 30000), /1분/);
  const c = L.actComplete(t2, { uid: t.uid }, T('10:12'));
  const t3 = { ...t2, ...c.patch };
  const nxt = tk({ id: 'B', status: 'called', calledAt: T('10:12') });
  const u = L.actUndo(t3, { uid: t.uid }, [t3, nxt], T('10:12') + 30000);
  assert.deepEqual(u.updates.map(x => x.id + ':' + x.patch.status), ['A:in_progress', 'B:waiting']);
  assert.equal(u.notices[0].kind, 'uncall');
  assert.throws(() => L.actUndo(t3, { uid: t.uid }, [t3], T('10:14')), /1분/);
});

test('관리자: 순서 조정·긴급·복귀', () => {
  const ts = [tk({ id: 'A', order: 1 }), tk({ id: 'B', order: 2 }), tk({ id: 'C', order: 3 })];
  const mv = L.actMove(ts[2], -1, ts);
  assert.deepEqual(mv.map(m => m.id + ':' + m.patch.order), ['C:2', 'B:3']);
  const ur = L.actUrgent(ts[2], ts);
  assert.ok(ur.order < 1);
  const re = L.actRestore({ ...ts[0], status: 'timeout' }, T('10:00'));
  assert.equal(re.status, 'waiting');
});

test('평균 보고 시간 갱신', () => {
  assert.equal(L.nextAvg({ avgMs: 0, defaultMin: 10 }, 8 * M), 9.4 * M);
  assert.equal(L.nextAvg({ avgMs: 10 * M }, 20 * M), 13 * M);
});

test('시간 지정 가능 시각: 30분 이후, 일정·점심 제외, 지정 인원 표시', () => {
  const slots = L.appointSlots([tk({ status: 'held', appointAt: T('11:40') })], S, dayDoc, T('10:00'));
  const hs = slots.map(x => L.hm(x.at));
  assert.equal(hs[0], '11:40');
  assert.ok(!hs.includes('10:40') && !hs.includes('11:30') && hs.includes('11:40') && !hs.includes('12:00'));
  assert.ok(hs.includes('11:50') && !hs.includes('11:55'));
  assert.equal(slots.find(x => L.hm(x.at) === '11:40').count, 1);
});


test('보고 가능 시간 기본값 07:00~24:00, 자정(24:00) 처리', () => {
  const D = {};
  assert.equal(L.availability({}, D, T('06:59')).why, 'before');
  assert.equal(L.availability({}, D, T('07:00')).ok, true);
  assert.equal(L.availability({}, D, T('18:30')).ok, true, '18시 이후에도 보고 가능');
  assert.equal(L.availability({}, D, T('23:45')).ok, true);
  assert.equal(L.availability({}, D, L.at(DAY, '24:00')).why, 'before', '자정이 되면 다음 날로 넘어감');
  assert.equal(L.at(DAY, '24:00'), L.at('2026-09-24', '00:00'));
  assert.ok(L.validHM('24:00') && !L.validHM('24:30'));
  assert.deepEqual(L.cleanSettings({ workStart: '07:00', workEnd: '24:00' }), { workStart: '07:00', workEnd: '24:00' });
});
