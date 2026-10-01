// logic.js — 보고 대기 번호표의 모든 규칙.
// 앱(브라우저)과 서버(Vercel의 lib/server.js)가 이 파일 하나를 함께 씁니다.
// 시간은 모두 밀리초(ms), 날짜·시각 계산은 한국 표준시(KST, UTC+9) 기준입니다.

export const MIN = 60000;
const KST = 9 * 3600000;
// 지정 시각이 되어 대기열로 들어온 번호표는 일반 대기자보다 앞에 서도록 순서값을 크게 당깁니다.
export const APPT_BASE = -1e13;
export const ACTIVE = ['called', 'in_progress'];
export const OPEN = ['held', 'waiting', 'called', 'in_progress'];

export const DEFAULTS = {
  officeName: '국장실',
  workStart: '07:00',
  workEnd: '24:00',       // 24:00 = 자정까지
  lunch: true,
  calendarId: 'rdarndpolicy@gmail.com',
  icalUrl: '',           // 비우면 calendarId의 공개 iCal 주소 사용. 비공개 캘린더는 '비밀 주소(iCal 형식)'를 넣습니다.
  soonAhead: 2,          // '곧 차례': 앞 대기 N명 이하
  soonMin: 20,           // 그리고 예상 대기 N분 이내
  startLimitMin: 5,      // 호출 후 N분 안에 '보고 시작'이 없으면 자동 취소
  remindMin: 3,          // 호출 후 N분에 재알림
  resumeBufferMin: 5,    // 캘린더 일정이 끝나고 N분 뒤부터 호출
  appointEnabled: true,  // 시간 지정 번호표 허용
  appointLeadMin: 30,    // 지금부터 N분 이후 시각만 지정 가능
  requirePush: true,     // 알림 테스트를 통과해야 번호표 발급
  defaultMin: 10,        // 보고 기록이 없을 때 쓰는 1인 보고 시간
  avgMs: 0,              // 실제 보고 시간 평균(서버가 갱신)
  presence: { mode: 'auto', until: null, note: '' },
};

export function withDefaults(s) {
  s = s || {};
  return { ...DEFAULTS, ...s, presence: { ...DEFAULTS.presence, ...(s.presence || {}) } };
}

// ---------- 시간 도우미 ----------
export function dayKey(ms) { return new Date(ms + KST).toISOString().slice(0, 10); }
export function at(day, hhmm) {
  if (hhmm === '24:00') return Date.parse(`${day}T00:00:00+09:00`) + 86400000; // 자정
  return Date.parse(`${day}T${hhmm}:00+09:00`);
}
export function hm(ms) { return new Date(ms + KST).toISOString().slice(11, 16); }
export function pad(no) { return String(no ?? 0).padStart(3, '0'); }
export function validHM(v) { return v === '24:00' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v || ''); }
export function maskName(n) {
  n = String(n || '').trim();
  if (n.length <= 1) return n;
  if (n.length === 2) return n[0] + '*';
  return n[0] + '*'.repeat(n.length - 2) + n[n.length - 1];
}
// 실제 보고 기록 평균(최소 3분). 기록이 없으면 설정의 기본값.
export function avgDur(s) { return s.avgMs > 0 ? Math.max(3 * MIN, s.avgMs) : s.defaultMin * MIN; }
export function workRange(s, day) { return [at(day, s.workStart), at(day, s.workEnd)]; }
// 서버가 '열린 번호표'만 골라 읽을 수 있도록 상태가 바뀔 때 open 표시를 함께 바꿉니다(무료 사용량 절약).
export function withOpen(patch) { return 'status' in patch ? { ...patch, open: OPEN.includes(patch.status) } : patch; }
export function byOrder(a, b) { return (a.order - b.order) || (a.createdAt - b.createdAt); }

// ---------- 국장님 상태 ----------
// auto: 캘린더대로 / absent: 부재(호출 중단) / present: 재실(지금 걸린 일정을 무시하고 재개, until까지)
export function presenceMode(s, now) {
  const p = s.presence || {};
  if (p.mode === 'absent') return 'absent';
  if (p.mode === 'present' && (!p.until || p.until > now)) return 'present';
  return 'auto';
}

// 호출할 수 없는 시간대 목록(점심, 캘린더 일정+여유, 부재)
export function blocks(s, dayDoc, day, now) {
  let list = [];
  if (s.lunch) list.push({ s: at(day, '12:00'), e: at(day, '13:00'), kind: 'lunch' });
  for (const b of (dayDoc && dayDoc.busy) || []) {
    list.push({ s: b.s, e: b.e + s.resumeBufferMin * MIN, kind: 'busy', raw: b });
  }
  const pm = presenceMode(s, now);
  if (pm === 'present') {
    const until = s.presence.until || now;
    list = list.map(b => (b.s < until ? { ...b, s: Math.max(b.s, until) } : b)).filter(b => b.s < b.e);
  }
  if (pm === 'absent') list.push({ s: now, e: Infinity, kind: 'absent' });
  return list.sort((a, b) => a.s - b.s);
}

// t 이후, [시작, 시작+dur)이 막힌 시간과 겹치지 않고 보고 시간 안에서 시작할 수 있는 가장 이른 시각
export function nextFree(t, dur, ctx) {
  const [ws, we] = workRange(ctx.s, ctx.day);
  let x = Math.max(t, ws);
  for (let i = 0; i < 200; i++) {
    if (!isFinite(x) || x >= we) return null;
    const hit = ctx.bl.find(b => x < b.e && x + dur > b.s);
    if (!hit) return x;
    x = hit.e;
  }
  return null;
}

export function context(sIn, dayDoc, now) {
  const s = withDefaults(sIn);
  const day = dayKey(now);
  return { s, day, dayDoc: dayDoc || {}, bl: blocks(s, dayDoc, day, now), avg: avgDur(s), now };
}

// 지금 호출할 수 있는지
export function availability(sIn, dayDoc, now) {
  const c = context(sIn, dayDoc, now);
  const [ws, we] = workRange(c.s, c.day);
  if (now < ws) return { ok: false, why: 'before', until: nextFree(ws, c.avg, c) };
  if (now >= we) return { ok: false, why: 'closed', until: null };
  const cur = c.bl.find(b => now >= b.s && now < b.e);
  if (cur) return { ok: false, why: cur.kind, block: cur, until: nextFree(cur.e, c.avg, c) };
  const f = nextFree(now, c.avg, c);
  if (f !== now) {
    const nb = c.bl.find(b => b.s > now);
    return { ok: false, why: 'tooShort', block: nb, until: f };
  }
  return { ok: true, next: c.bl.find(b => b.s > now) || null };
}

export function whyText(av) {
  const k = av.why;
  if (k === 'before') return '보고 시작 전';
  if (k === 'closed') return '오늘 보고 마감';
  if (k === 'lunch') return '점심시간';
  if (k === 'absent') return '국장님 부재';
  if (k === 'busy') return `국장님 일정 ${hm(av.block.raw ? av.block.raw.s : av.block.s)}~${hm(av.block.raw ? av.block.raw.e : av.block.e)}`;
  if (k === 'tooShort') return '곧 일정이 있어 대기';
  return '';
}

// ---------- 대기열과 예상 시각 ----------
// 호출·보고 중인 사람 → (지정 시각이 된 지정 번호표 우선) → 일반 대기 순서로 빈 시간을 채웁니다.
export function computeQueue(tickets, sIn, dayDoc, now) {
  const c = context(sIn, dayDoc, now);
  const today = tickets.filter(t => t.day === c.day);
  const active = today.filter(t => ACTIVE.includes(t.status)).sort((a, b) => (a.calledAt || 0) - (b.calledAt || 0));
  const waiting = today.filter(t => t.status === 'waiting').sort(byOrder);
  const held = today.filter(t => t.status === 'held').sort((a, b) => (a.appointAt - b.appointAt) || (a.createdAt - b.createdAt));
  const eta = {}, ahead = {};
  let t = now;
  for (const a of active) {
    eta[a.id] = a.calledAt || now;
    const end = a.status === 'in_progress' ? Math.max(a.startedAt + c.avg, now + MIN) : now + c.avg;
    t = Math.max(t, end);
  }
  const q = [...waiting], pend = [...held], order = [];
  let idx = active.length;
  while (q.length || pend.length) {
    let s0 = nextFree(t, c.avg, c);
    let x;
    if (pend.length && s0 != null && pend[0].appointAt <= s0) x = pend.shift();
    else if (q.length) x = q.shift();
    else { x = pend.shift(); s0 = nextFree(Math.max(t, x.appointAt), c.avg, c); }
    eta[x.id] = s0;
    ahead[x.id] = idx++;
    order.push(x);
    t = s0 == null ? Infinity : s0 + c.avg;
  }
  return { day: c.day, avg: c.avg, bl: c.bl, active, waiting, held, order, eta, ahead, nextAt: nextFree(t, c.avg, c) };
}

// 시간 지정으로 고를 수 있는 시각(10분 단위)
export function appointSlots(tickets, sIn, dayDoc, now) {
  const c = context(sIn, dayDoc, now);
  const [, we] = workRange(c.s, c.day);
  const from = now + c.s.appointLeadMin * MIN;
  let x = Math.ceil(from / (10 * MIN)) * 10 * MIN;
  const out = [];
  const counts = {};
  for (const t of tickets) if (t.day === c.day && t.status === 'held') counts[t.appointAt] = (counts[t.appointAt] || 0) + 1;
  for (; x < we; x += 10 * MIN) {
    if (nextFree(x, c.avg, c) === x) out.push({ at: x, count: counts[x] || 0 });
  }
  return out;
}

// ---------- 알림 문구 ----------
export function noticeText(kind, t, sIn, extra = {}) {
  const s = withDefaults(sIn);
  const no = pad(t.no), o = s.officeName;
  switch (kind) {
    case 'call': return { title: `${no}번, 지금 입실해 주세요`, body: `${o}에 들어가며 '보고 시작'을 눌러 주세요. ${s.startLimitMin}분 안에 누르지 않으면 자동 취소됩니다.` };
    case 'next': return { title: '바로 다음 차례입니다', body: `앞 분이 보고를 시작했습니다. ${o} 문 앞에서 기다려 주세요. 앞 보고가 끝나면 바로 호출됩니다.` };
    case 'soon': return { title: '곧 차례입니다', body: `앞 대기 ${extra.ahead ?? '-'}명, ${extra.etaAt ? hm(extra.etaAt) + '경' : '곧'} 호출 예상입니다. ${o} 근처로 와 주세요.` };
    case 'remind': return { title: "'보고 시작'을 눌러 주세요", body: `${s.startLimitMin - s.remindMin}분 안에 누르지 않으면 번호표가 자동 취소됩니다.` };
    case 'timeout': return { title: '번호표가 취소되었습니다', body: `${s.startLimitMin}분 안에 '보고 시작'이 없어 다음 분을 호출했습니다. 사정이 있었다면 비서실에 말씀해 주세요.` };
    case 'overdue': return { title: '보고가 끝나셨나요?', body: "끝나셨으면 '보고 완료'를 눌러 주세요. 다음 분이 기다리고 있습니다." };
    case 'appt': return { title: '곧 보고 시각입니다', body: `지정하신 ${hm(t.appointAt)}까지 10분 남았습니다. ${o} 근처로 와 주세요.` };
    case 'expired': return { title: '오늘 보고가 마감되었습니다', body: '내일 다시 번호표를 받아 주세요.' };
    case 'uncall': return { title: '호출이 잠시 취소되었습니다', body: '앞 보고가 계속되고 있습니다. 순서는 그대로입니다.' };
    case 'test': return { title: '알림 테스트', body: '이 알림이 보이면 준비가 끝났습니다.' };
    default: return { title: '보고 대기', body: '' };
  }
}

// ---------- 1분마다 도는 판단(엔진) ----------
// 입력 상태는 바꾸지 않고, 바꿀 내용(updates)과 보낼 알림(notices)을 돌려줍니다.
export function tick(ticketsIn, sIn, dayDoc, now) {
  const s = withDefaults(sIn);
  const day = dayKey(now);
  const [, we] = workRange(s, day);
  const T = ticketsIn.filter(t => t.day === day).map(t => ({ ...t, flags: { ...(t.flags || {}) } }));
  const changed = new Map();
  const notices = [];
  const set = (t, patch) => { Object.assign(t, patch); changed.set(t.id, { ...(changed.get(t.id) || {}), ...patch }); };
  const flag = (t, ...keys) => { for (const k of keys) t.flags[k] = true; set(t, { flags: { ...t.flags } }); };
  const note = (t, kind, extra) => notices.push({ id: t.id, kind, extra: extra || {} });

  // 1) 보고 시간이 끝나면 남은 대기 마감
  if (now >= we) {
    for (const t of T) if (t.status === 'waiting' || t.status === 'held') { set(t, { status: 'expired', doneAt: now }); note(t, 'expired'); }
  }
  // 2) 지정 시각이 된 번호표를 대기열 맨 앞으로
  for (const t of T) if (t.status === 'held' && t.appointAt <= now) set(t, { status: 'waiting', order: APPT_BASE + t.appointAt });
  // 3) 호출 후 재알림 · 시간 초과 취소
  for (const t of T) {
    if (t.status !== 'called') continue;
    const el = now - t.calledAt;
    if (el >= s.startLimitMin * MIN) { set(t, { status: 'timeout', doneAt: now }); note(t, 'timeout'); }
    else if (el >= s.remindMin * MIN && !t.flags.remind) { flag(t, 'remind'); note(t, 'remind'); }
  }
  // 4) 보고가 너무 길어지면 본인에게 한 번 확인
  const avg = avgDur(s);
  for (const t of T) {
    if (t.status === 'in_progress' && now - t.startedAt >= avg + 10 * MIN && !t.flags.overdue) { flag(t, 'overdue'); note(t, 'overdue'); }
  }
  // 5) 아무도 호출·보고 중이 아니고 보고 가능 시간이면 다음 사람 자동 호출
  if (!T.some(t => ACTIVE.includes(t.status)) && now < we && availability(s, dayDoc, now).ok) {
    const w = T.filter(t => t.status === 'waiting').sort(byOrder)[0];
    if (w) {
      set(w, { status: 'called', calledAt: now });
      w.flags.remind = false;
      flag(w, 'call', 'soon', 'next');
      note(w, 'call');
    }
  }
  // 6) 바로 다음 차례(앞 사람 보고 시작 시) · 곧 차례 · 지정 시각 10분 전
  const q = computeQueue(T, s, dayDoc, now);
  for (const t of q.waiting) {
    const e = q.eta[t.id];
    const mins = e == null ? Infinity : (e - now) / MIN;
    const a = q.ahead[t.id];
    // 앞 사람이 '보고 시작'을 누르면(보고 중) 바로 다음 사람에게 '문 앞 대기' 알림 — 예상 시간과 관계없이
    if (a === 1 && q.active.some(x => x.status === 'in_progress') && !t.flags.next) { flag(t, 'next', 'soon'); note(t, 'next'); }
    else if (a <= s.soonAhead && mins <= s.soonMin && !t.flags.soon && !t.flags.next) { flag(t, 'soon'); note(t, 'soon', { ahead: a, etaAt: e }); }
  }
  for (const t of q.held) {
    if (t.appointAt - now <= 10 * MIN && !t.flags.appt) { flag(t, 'appt'); note(t, 'appt'); }
  }
  return { updates: [...changed].map(([id, patch]) => ({ id, patch })), notices };
}

// ---------- 사용자 동작(검증 + 바꿀 내용) ----------
export class RuleError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, msg) => { throw new RuleError(code, msg); };
const isOwner = (t, ctx) => !!t.uid && t.uid === ctx.uid;

export function actIssue(input, ctx, tickets, sIn, dayDoc, now) {
  const s = withDefaults(sIn);
  const day = dayKey(now);
  const [, we] = workRange(s, day);
  const name = String(input.name || '').trim(), dept = String(input.dept || '').trim(), topic = String(input.topic || '').trim();
  const proxy = !!input.proxy;
  if (proxy && !ctx.isAdmin) fail('permission-denied', '대리 접수는 관리자만 할 수 있습니다.');
  if (!name || name.length > 20) fail('invalid-argument', '이름을 20자 이내로 입력해 주세요.');
  if (!dept || dept.length > 30) fail('invalid-argument', '부서를 30자 이내로 입력해 주세요.');
  if (topic.length > 60) fail('invalid-argument', '보고 건명은 60자 이내로 입력해 주세요.');
  let refMin = input.refMin == null || input.refMin === '' ? null : Number(input.refMin);
  if (refMin != null && !(refMin >= 1 && refMin <= 120)) refMin = null;
  if (now >= we) fail('failed-precondition', '오늘 보고 시간이 끝났습니다. 내일 다시 받아 주세요.');
  if (!proxy) {
    if (s.requirePush && !ctx.deviceVerified) fail('failed-precondition', '먼저 알림을 켜고 테스트 알림을 받아 주세요.');
    const mine = tickets.find(t => t.day === day && t.uid === ctx.uid && OPEN.includes(t.status));
    if (mine) fail('already-exists', `이미 ${pad(mine.no)}번 번호표가 있습니다. 새로 받으려면 먼저 취소해 주세요.`);
  }
  let appointAt = input.appointAt == null || input.appointAt === '' ? null : Number(input.appointAt);
  if (appointAt != null) {
    if (!s.appointEnabled && !ctx.isAdmin) fail('failed-precondition', '지금은 시간 지정 접수를 받지 않습니다.');
    if (appointAt % (10 * MIN) !== 0 || dayKey(appointAt) !== day) fail('invalid-argument', '시각은 오늘, 10분 단위로 골라 주세요.');
    if (!ctx.isAdmin && appointAt < now + s.appointLeadMin * MIN) fail('invalid-argument', `지금부터 ${s.appointLeadMin}분 이후 시각만 지정할 수 있습니다.`);
    const c = context(s, dayDoc, now);
    if (nextFree(appointAt, c.avg, c) !== appointAt) fail('invalid-argument', '그 시각은 국장님 일정이 있거나 보고 시간이 아닙니다. 다른 시각을 골라 주세요.');
  }
  return {
    ticket: {
      day, no: null, maskedName: maskName(name), dept, refMin, appointAt,
      status: appointAt ? 'held' : 'waiting', order: now, createdAt: now,
      calledAt: null, startedAt: null, doneAt: null,
      uid: proxy ? null : ctx.uid, proxy, urgent: false, flags: {}, open: true,
    },
    priv: { day, name, topic, uid: proxy ? null : ctx.uid },
  };
}

export function actStart(t, ctx, now) {
  if (!(isOwner(t, ctx) || ctx.isAdmin)) fail('permission-denied', '본인 번호표만 시작할 수 있습니다.');
  if (t.status !== 'called') fail('failed-precondition', '호출된 번호표만 보고를 시작할 수 있습니다.');
  return { status: 'in_progress', startedAt: now };
}

export function actComplete(t, ctx, now) {
  const owner = isOwner(t, ctx);
  if (!(owner || ctx.isAdmin)) fail('permission-denied', '본인 번호표만 완료할 수 있습니다.');
  if (t.status === 'called' && ctx.isAdmin) return { patch: { status: 'done', doneAt: now, startedAt: t.startedAt || now }, dur: null };
  if (t.status !== 'in_progress') fail('failed-precondition', '보고 중인 번호표만 완료할 수 있습니다.');
  if (!ctx.isAdmin && now - t.startedAt < MIN) fail('failed-precondition', "'보고 시작' 후 1분이 지나야 완료할 수 있습니다.");
  const dur = now - t.startedAt;
  return { patch: { status: 'done', doneAt: now }, dur: dur >= MIN && dur <= 60 * MIN ? dur : null };
}

// 새 보고 시간을 평균에 조금씩 반영(한 번의 짧은·긴 보고로 크게 흔들리지 않게)
export function nextAvg(s, dur) {
  if (!dur) return s.avgMs || 0;
  const base = s.avgMs > 0 ? s.avgMs : (s.defaultMin || DEFAULTS.defaultMin) * MIN;
  return Math.round(base * 0.7 + dur * 0.3);
}

export function actUndo(t, ctx, tickets, now) {
  if (!isOwner(t, ctx) && !ctx.isAdmin) fail('permission-denied', '본인 번호표만 되돌릴 수 있습니다.');
  if (t.status !== 'done' || now - t.doneAt > MIN) fail('failed-precondition', '완료 후 1분 안에만 되돌릴 수 있습니다.');
  const updates = [{ id: t.id, patch: { status: 'in_progress', doneAt: null } }];
  const notices = [];
  for (const o of tickets) {
    if (o.id !== t.id && o.day === t.day && o.status === 'called' && o.calledAt >= t.doneAt) {
      const flags = { ...(o.flags || {}), call: false, remind: false };
      updates.push({ id: o.id, patch: { status: 'waiting', calledAt: null, flags } });
      notices.push({ id: o.id, kind: 'uncall', extra: {} });
    }
  }
  return { updates, notices };
}

export function actCancel(t, ctx, now) {
  if (isOwner(t, ctx) && ['held', 'waiting'].includes(t.status)) return { status: 'cancelled', doneAt: now };
  if (ctx.isAdmin && OPEN.includes(t.status)) return { status: 'cancelled', doneAt: now };
  fail('failed-precondition', '대기 중인 번호표만 취소할 수 있습니다.');
}

// 관리자: 순서 조정 · 긴급 · 복귀
export function actMove(t, dir, tickets) {
  const w = tickets.filter(x => x.day === t.day && x.status === 'waiting').sort(byOrder);
  const i = w.findIndex(x => x.id === t.id), j = i + dir;
  if (i < 0 || j < 0 || j >= w.length) fail('failed-precondition', '더 옮길 수 없습니다.');
  const a = w[i], b = w[j];
  if (a.order === b.order) return [{ id: a.id, patch: { order: b.order + dir * 0.5 } }]; // 같은 순서값이면 반 칸 옮김
  return [{ id: a.id, patch: { order: b.order } }, { id: b.id, patch: { order: a.order } }];
}
export function actUrgent(t, tickets) {
  if (t.status !== 'waiting' && t.status !== 'held') fail('failed-precondition', '대기 중인 번호표만 앞으로 옮길 수 있습니다.');
  const w = tickets.filter(x => x.day === t.day && x.status === 'waiting');
  const min = w.length ? Math.min(...w.map(x => x.order)) : APPT_BASE;
  return { status: 'waiting', order: Math.min(min, APPT_BASE) - 1, urgent: true };
}
export function actRestore(t, now) {
  if (!['timeout', 'cancelled', 'expired'].includes(t.status)) fail('failed-precondition', '취소·시간 초과된 번호표만 복귀할 수 있습니다.');
  if (dayKey(now) !== t.day) fail('failed-precondition', '오늘 번호표만 복귀할 수 있습니다.');
  return { status: 'waiting', order: now, calledAt: null, startedAt: null, doneAt: null, flags: {} };
}
export function presencePatch(mode, note, sIn, dayDoc, now) {
  const s = withDefaults(sIn);
  if (!['auto', 'absent', 'present'].includes(mode)) fail('invalid-argument', '상태 값이 올바르지 않습니다.');
  let until = null;
  if (mode === 'present') {
    // 지금 걸려 있는 일정(연달아 이어지는 일정 포함)이 끝날 때까지만 '재실'로 봅니다.
    const c = context({ ...s, presence: { mode: 'auto' } }, dayDoc, now);
    let x = now;
    for (let i = 0; i < 50; i++) { const b = c.bl.find(b => b.kind === 'busy' && x >= b.s && x < b.e); if (!b) break; x = b.e; }
    until = x > now ? x : null;
    if (!until) mode = 'auto';
  }
  return { mode, until, note: String(note || '').slice(0, 60) };
}

// 설정 값 검사(관리자 설정 저장)
export function cleanSettings(input) {
  const o = {};
  const num = (k, lo, hi) => { if (input[k] != null) { const v = Number(input[k]); if (!(v >= lo && v <= hi)) fail('invalid-argument', `${k} 값이 범위를 벗어났습니다.`); o[k] = v; } };
  if (input.officeName != null) o.officeName = String(input.officeName).trim().slice(0, 20) || '국장실';
  for (const k of ['workStart', 'workEnd']) if (input[k] != null) { if (!validHM(input[k])) fail('invalid-argument', '시각은 07:00처럼 입력해 주세요(자정은 24:00).'); o[k] = input[k]; }
  if ((o.workStart || '00:00') >= (o.workEnd || '99:99')) fail('invalid-argument', '보고 시작 시각이 종료 시각보다 빨라야 합니다.');
  for (const k of ['lunch', 'appointEnabled', 'requirePush']) if (input[k] != null) o[k] = !!input[k];
  if (input.calendarId != null) o.calendarId = String(input.calendarId).trim().slice(0, 200);
  if (input.icalUrl != null) {
    const u = String(input.icalUrl).trim();
    if (u && !/^https:\/\/\S+$/.test(u)) fail('invalid-argument', 'iCal 주소는 https://로 시작해야 합니다.');
    o.icalUrl = u.slice(0, 500);
  }
  num('soonAhead', 1, 10); num('soonMin', 5, 120); num('startLimitMin', 2, 30); num('remindMin', 1, 29);
  num('resumeBufferMin', 0, 30); num('appointLeadMin', 0, 240); num('defaultMin', 3, 60);
  if (o.remindMin != null && o.startLimitMin != null && o.remindMin >= o.startLimitMin) fail('invalid-argument', '재알림은 자동 취소보다 먼저여야 합니다.');
  return o;
}
