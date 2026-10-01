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

test('엔진: 자동 호출 → 1분마다 재알림 → 3분 지나면 자동 취소 → 다음 사람 호출', () => {
  let ts = [tk({ id: 'A' }), tk({ id: 'B' }), tk({ id: 'C' })];
  let r = L.tick(ts, S, {}, T('09:30'));
  ts = apply(ts, r);
  assert.equal(ts.find(t => t.id === 'A').status, 'called');
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['A:call', 'B:soon', 'C:soon'], '호출 단계에서는 다음 사람에게 곧 차례만');
  r = L.tick(ts, S, {}, T('09:30') + 30000); ts = apply(ts, r);
  assert.equal(r.notices.length, 0, '1분 전에는 재알림 없음');
  r = L.tick(ts, S, {}, T('09:31')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind + ':' + n.extra.left), ['A:remind:2']);
  r = L.tick(ts, S, {}, T('09:31') + 40000); ts = apply(ts, r);
  assert.equal(r.notices.length, 0, '같은 분에 두 번 보내지 않음');
  r = L.tick(ts, S, {}, T('09:32')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind + ':' + n.extra.left), ['A:remind:1']);
  r = L.tick(ts, S, {}, T('09:33')); ts = apply(ts, r);
  assert.equal(ts.find(t => t.id === 'A').status, 'timeout');
  assert.equal(ts.find(t => t.id === 'B').status, 'called');
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['A:timeout', 'B:call']);
  // B가 '보고 시작'을 누르면 바로 다음 C에게 문 앞 대기 알림
  ts = ts.map(t => t.id === 'B' ? { ...t, status: 'in_progress', startedAt: T('09:34') } : t);
  r = L.tick(ts, S, {}, T('09:34')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.id + ':' + n.kind), ['C:next']);
  r = L.tick(ts, S, {}, T('09:35'));
  assert.equal(r.notices.length, 0);
});

test('엔진: 예상 시간이 지나도 완료가 없으면 1분마다 확인 알림, 자동 취소는 안 함', () => {
  let ts = [tk({ id: 'A', status: 'in_progress', calledAt: T('10:00'), startedAt: T('10:00'), refMin: 7 })];
  let r = L.tick(ts, S, {}, T('10:06')); ts = apply(ts, r);
  assert.equal(r.notices.length, 0, '예상 7분 전에는 없음');
  r = L.tick(ts, S, {}, T('10:07')); ts = apply(ts, r);
  assert.deepEqual(r.notices.map(n => n.kind + ':' + n.extra.expMin), ['overdue:7']);
  r = L.tick(ts, S, {}, T('10:07') + 50000); ts = apply(ts, r);
  assert.equal(r.notices.length, 0);
  for (const h of ['10:08', '10:09', '10:30']) { r = L.tick(ts, S, {}, T(h)); ts = apply(ts, r); assert.deepEqual(r.notices.map(n => n.kind), ['overdue'], h); }
  assert.equal(ts[0].status, 'in_progress', '오래 걸려도 자동 취소하지 않음');
  // 예상 시간을 입력하지 않으면 평균(기본 10분)
  let t2 = [tk({ id: 'B', status: 'in_progress', calledAt: T('11:00'), startedAt: T('11:00') })];
  assert.equal(L.tick(t2, S, {}, T('11:09')).notices.length, 0);
  assert.equal(L.tick(t2, S, {}, T('11:10')).notices[0].kind, 'overdue');
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
  const ap = L.actIssue({ name: '홍', dept: '기', appointAt: T('14:00') }, { uid: 'b' }, [], S, dayDoc, now);
  assert.equal(ap.ticket.status, 'waiting', '시간 지정은 없어짐(선착순)');
  assert.equal(ap.ticket.appointAt, null);
  assert.throws(() => L.actIssue({ name: '홍', dept: '기', proxy: true }, { uid: 'b' }, [], S, {}, now), /관리자/);
  assert.equal(L.actIssue({ name: '홍', dept: '기', proxy: true }, { uid: 'adm', isAdmin: true }, [], { requirePush: true }, {}, now).ticket.uid, null);
});

test('동작: 보고 시작·완료(바로 가능)·되돌리기 권한과 1분 규칙', () => {
  const t = tk({ id: 'A', status: 'called', calledAt: T('10:00') });
  assert.throws(() => L.actStart(t, { uid: 'other' }, T('10:01')), /본인/);
  const st = L.actStart(t, { uid: t.uid }, T('10:01'));
  const t2 = { ...t, ...st };
  assert.throws(() => L.actComplete(t2, { uid: 'other' }, T('10:02')), /본인/);
  const quick = L.actComplete(t2, { uid: t.uid }, T('10:01') + 20000);
  assert.equal(quick.patch.status, 'done', '시작 직후에도 바로 완료할 수 있음');
  assert.equal(quick.dur, null, '20초 보고는 평균에 넣지 않음');
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

test('대외 일정: 판단 규칙과 복귀 시간 반영', () => {
  const ext = (title, loc = '', desc = '') => L.isExternal({ title, loc, desc }, {});
  assert.equal(ext('국정감사', '국회 본관'), true);
  assert.equal(ext('농식품부 업무협의', '정부세종청사 5동'), true);
  assert.equal(ext('(국) 기관장협의회 *농과원 생물부 5층'), false);
  assert.equal(ext('RDA 인사이트데이', '오디토리움'), false);
  assert.equal(ext('농식품부 화상회의'), false, '화상회의는 내부');
  assert.equal(ext('간담회', '서울 aT센터 3층'), true);
  assert.equal(ext('간담회 (내부)', '서울'), false, '제목 표시가 우선');
  assert.equal(ext('[대외] 현장 점검'), true);
  assert.equal(ext('주간업무점검회의', '본청 5층 대회의실'), false);
  // 대외 일정 10:00~11:00 → 복귀 60분 → 12:00까지 막힘(그다음은 점심)
  const D = { busy: [{ s: T('10:00'), e: T('11:00'), ext: true }] };
  const S2 = { ...S, lunch: false };
  const av = L.availability(S2, D, T('11:30'));
  assert.equal(av.ok, false);
  assert.match(L.whyText(av), /대외 일정 · 12:00경 복귀/);
  assert.equal(L.availability(S2, D, T('12:00')).ok, true);
  // 내부 일정은 5분 여유만
  assert.equal(L.availability(S2, { busy: [{ s: T('10:00'), e: T('11:00') }] }, T('11:05')).ok, true);
});

test('대외 일정 복귀 시간: 거리 ÷ 90km/시, 10분 단위 올림 · 전주·완주는 내부 · 재실로 바로 해제', () => {
  const x = (title, loc = '') => L.extInfo({ title, loc }, {});
  assert.deepEqual(x('국정감사', '국회 본관'), { ext: true, place: '국회', km: 230, ret: 160 }, '230km → 2시간 33분 → 2시간 40분');
  assert.equal(x('업무협의', '정부세종청사').ret, 80, '120km → 1시간 20분');
  assert.equal(x('간담회', '대전 컨벤션센터').ret, 70, '95km → 63분 → 70분');
  assert.equal(x('간부회의', '1회의실').ext, false, '전주(회의실)는 내부');
  assert.equal(x('협의', '완주군청').ext, false, '완주는 내부');
  assert.equal(x('서울 출장 후 세종 들름').place, '서울', '여러 곳이면 가장 먼 곳 기준');
  assert.equal(x('간담회', '서울 aT센터 3층').place, '서울', '지역 이름이 있으면 층·회의실보다 우선');
  assert.equal(x('현장 점검').ret, 60, '지역 없는 대외 일정 → 기본 60분');
  assert.equal(x('제주 출장').ret, 300);
  assert.equal(x('해외 출장').ret, 1440);
  assert.equal(x('국회의원 내방', '').ext, false, '내방은 내부');
  assert.equal(L.extInfo({ title: '서울 출장' }, { returnKmPerHour: 115 }).ret, 120, '속도 설정 반영');
  // 서울 10:00~12:00 → 14:40 복귀. 그 전에는 호출 안 함, 비서실이 '재실'을 누르면 바로 가능
  const S2 = { ...S, lunch: false };
  const D = { busy: [{ s: T('10:00'), e: T('12:00'), ext: true, ret: 160 }] };
  assert.match(L.whyText(L.availability(S2, D, T('13:00'))), /14:40경 복귀/);
  assert.equal(L.availability(S2, D, T('14:40')).ok, true);
  const p = L.presencePatch('present', '', S2, D, T('13:00'));
  assert.equal(L.hm(p.until), '14:40');
  assert.equal(L.availability({ ...S2, presence: p }, D, T('13:00')).ok, true);
  // 해외(종일): 오늘 복귀 어려움
  assert.match(L.whyText(L.availability(S2, { busy: [{ s: T('09:00'), e: T('10:00'), ext: true, ret: 1440 }] }, T('11:00'))), /오늘 복귀 어려움/);
  assert.throws(() => L.cleanSettings({ places: '서울=이백' }), /형식/);
});
