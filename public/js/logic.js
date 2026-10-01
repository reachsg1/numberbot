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
  callLimitMin: 3,       // 호출 후 N분 안에 '보고 시작'이 없으면 자동 취소
  remindEveryMin: 1,     // 호출 후 N분마다 '보고 시작을 눌러 주세요' 재알림
  overdueEveryMin: 1,    // 예상 시간이 지나도 '보고 완료'가 없으면 N분마다 확인 알림(자동 취소 없음)
  resumeBufferMin: 5,    // 캘린더 일정이 끝나고 N분 뒤부터 호출
  returnMin: 60,         // 대외 일정인데 장소(거리)를 알 수 없을 때 쓰는 복귀 시간(분)
  returnKmPerHour: 90,   // 복귀 시간 계산: 거리 ÷ 이 속도(휴게소 휴식 포함, km/시)
  // 출장 지역과 전주 혁신도시에서의 도로 거리(km, 추정). '분'은 고정 시간, '종일'은 그날 복귀 어려움.
  places: [
    '서울=230', '국회=230', '여의도=230', '광화문=230', '정부서울청사=230', '용산=230', '대통령실=230', 'aT센터=225', '양재=225', '강남=225', '과천=215', '정부과천청사=215',
    '세종=120', '정부세종청사=120', '농식품부=120', '농림축산식품부=120', '기재부=120', '기획재정부=120', '오송=135',
    '대전=95', '청주=140', '천안=155', '아산=150', '평택=180', '수원=200', '화성=200', '인천=255', '경기=210',
    '춘천=300', '원주=255', '강릉=380', '강원=300', '충북=140', '충남=120', '공주=85', '논산=60', '부여=80',
    '익산=25', '군산=50', '김제=20', '정읍=50', '남원=60', '부안=50', '고창=75', '무주=80', '장수=60', '진안=40', '임실=35', '순창=55',
    '광주=105', '나주=110', '목포=165', '순천=150', '여수=180', '전남=150',
    '대구=200', '구미=190', '안동=260', '포항=280', '경북=230', '부산=270', '울산=300', '창원=230', '진주=170', '경남=220',
    '제주=300분', '해외=종일', '국외=종일',
  ].join(', '),
  // 장소·지역은 없지만 밖에서 하는 일정임을 알리는 낱말 → 위 '거리를 알 수 없을 때' 시간을 씀
  extKeywords: '출장,외부,대외,현장,공항,KTX,SRT,방송,언론',
  // 전주·완주(내부)로 보는 장소 낱말: 장소에 있으면 대외로 보지 않습니다. (지역 이름이 함께 있으면 지역이 우선)
  localKeywords: '전주,완주,혁신도시,농촌진흥청,농진청,본청,농과원,식량원,원예원,축산원,농업과학원,식량과학원,원예특작,축산과학원,인재개발센터,회의실,강당,오디토리움,국장실,청장실,차장실,집무실,층',
  requirePush: true,     // 알림 테스트를 통과해야 번호표 발급
  showEventTitles: true, // 신청자 화면(대기 현황)에도 국장님 일정 제목 표시
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
// 이 사람의 예상 보고 시간: 본인이 입력한 시간, 없으면 평균
export function expectedMs(t, s) { return t.refMin > 0 ? t.refMin * MIN : avgDur(withDefaults(s)); }
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
    // 대외 일정은 끝난 뒤 복귀 시간만큼, 내부 일정은 여유 시간만큼 더 막습니다.
    list.push({ s: b.s, e: b.e + (b.ext ? retMinOf(b, s) : s.resumeBufferMin) * MIN, kind: 'busy', ext: !!b.ext, raw: b });
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
  if (k === 'busy' && av.block.ext) return av.until == null ? '대외 일정 · 오늘 복귀 어려움' : `대외 일정 · ${hm(av.block.e)}경 복귀`;
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
    const end = a.status === 'in_progress' ? Math.max(a.startedAt + expectedMs(a, c.s), now + MIN) : now + expectedMs(a, c.s);
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
    t = s0 == null ? Infinity : s0 + expectedMs(x, c.s);
  }
  return { day: c.day, avg: c.avg, bl: c.bl, active, waiting, held, order, eta, ahead, nextAt: nextFree(t, c.avg, c) };
}

// ---------- 알림 문구 ----------
export function noticeText(kind, t, sIn, extra = {}) {
  const s = withDefaults(sIn);
  const no = pad(t.no), o = s.officeName;
  switch (kind) {
    case 'call': return { title: `${no}번, 지금 입실해 주세요`, body: `${o}에 들어가며 '보고 시작'을 눌러 주세요. ${s.callLimitMin}분 안에 누르지 않으면 자동 취소됩니다.` };
    case 'next': return { title: '바로 다음 차례입니다', body: `앞 분이 보고를 시작했습니다. ${o} 문 앞에서 기다려 주세요. 앞 보고가 끝나면 바로 호출됩니다.` };
    case 'soon': return { title: '곧 차례입니다', body: `앞 대기 ${extra.ahead ?? '-'}명, ${extra.etaAt ? hm(extra.etaAt) + '경' : '곧'} 호출 예상입니다. ${o} 근처로 와 주세요.` };
    case 'remind': return { title: `${no}번, '보고 시작'을 눌러 주세요`, body: `호출되었습니다. ${extra.left ?? 1}분 안에 누르지 않으면 번호표가 자동 취소되고 다음 분이 호출됩니다.` };
    case 'timeout': return { title: '번호표가 취소되었습니다', body: `호출 후 ${s.callLimitMin}분 안에 '보고 시작'이 없어 다음 분을 호출했습니다. 사정이 있었다면 비서실에 말씀해 주세요.` };
    case 'overdue': return { title: "보고가 끝나셨으면 '보고 완료'를 눌러 주세요", body: `예상 시간(${extra.expMin ?? '-'}분)이 지났습니다. 보고 중이시면 이 알림은 넘기셔도 됩니다. 끝나셨으면 '보고 완료'를 눌러야 다음 분이 호출됩니다.` };
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
  // 3) 호출 후 N분마다 '보고 시작' 재알림 → 제한 시간(기본 3분)이 지나면 자동 취소
  for (const t of T) {
    if (t.status !== 'called') continue;
    const el = now - t.calledAt;
    if (el >= s.callLimitMin * MIN) { set(t, { status: 'timeout', doneAt: now }); note(t, 'timeout'); continue; }
    const k = Math.floor(el / (s.remindEveryMin * MIN));
    if (k >= 1 && k > (t.flags.remindN || 0)) {
      t.flags.remindN = k; set(t, { flags: { ...t.flags } });
      note(t, 'remind', { left: Math.max(1, Math.ceil((s.callLimitMin * MIN - el) / MIN)) });
    }
  }
  // 4) 예상 시간(본인이 입력한 시간, 없으면 평균)이 지나도 '보고 완료'가 없으면 N분마다 확인 알림 — 자동 취소는 하지 않음
  for (const t of T) {
    if (t.status !== 'in_progress') continue;
    const exp = expectedMs(t, s);
    const over = now - t.startedAt - exp;
    if (over < 0) continue;
    const k = Math.floor(over / (s.overdueEveryMin * MIN)) + 1;
    if (k > (t.flags.overdueN || 0)) {
      t.flags.overdueN = k; set(t, { flags: { ...t.flags } });
      note(t, 'overdue', { expMin: Math.round(exp / MIN) });
    }
  }
  // 5) 아무도 호출·보고 중이 아니고 보고 가능 시간이면 다음 사람 자동 호출
  if (!T.some(t => ACTIVE.includes(t.status)) && now < we && availability(s, dayDoc, now).ok) {
    const w = T.filter(t => t.status === 'waiting').sort(byOrder)[0];
    if (w) {
      set(w, { status: 'called', calledAt: now });
      w.flags.remindN = 0;
      flag(w, 'call', 'soon', 'next');
      note(w, 'call');
    }
  }
  // 6) 바로 다음 차례(앞 사람 보고 시작 시) · 곧 차례
  const q = computeQueue(T, s, dayDoc, now);
  for (const t of q.waiting) {
    const e = q.eta[t.id];
    const mins = e == null ? Infinity : (e - now) / MIN;
    const a = q.ahead[t.id];
    // 앞 사람이 '보고 시작'을 누르면(보고 중) 바로 다음 사람에게 '문 앞 대기' 알림 — 예상 시간과 관계없이
    if (a === 1 && q.active.some(x => x.status === 'in_progress') && !t.flags.next) { flag(t, 'next', 'soon'); note(t, 'next'); }
    else if (a <= s.soonAhead && mins <= s.soonMin && !t.flags.soon && !t.flags.next) { flag(t, 'soon'); note(t, 'soon', { ahead: a, etaAt: e }); }
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
  if (!dept || dept.length > 40) fail('invalid-argument', '부서를 40자 이내로 입력해 주세요.');
  if (topic.length > 60) fail('invalid-argument', '보고 건명은 60자 이내로 입력해 주세요.');
  let refMin = input.refMin == null || input.refMin === '' ? null : Number(input.refMin);
  if (refMin != null && !(refMin >= 1 && refMin <= 180)) fail('invalid-argument', '예상 소요 시간은 1~180분 사이 숫자로 입력해 주세요.');
  if (refMin != null) refMin = Math.round(refMin);
  if (now >= we) fail('failed-precondition', '오늘 보고 시간이 끝났습니다. 내일 다시 받아 주세요.');
  if (!proxy) {
    if (s.requirePush && !ctx.deviceVerified) fail('failed-precondition', '먼저 알림을 켜고 테스트 알림을 받아 주세요.');
    const mine = tickets.find(t => t.day === day && t.uid === ctx.uid && OPEN.includes(t.status));
    if (mine) fail('already-exists', `이미 ${pad(mine.no)}번 번호표가 있습니다. 새로 받으려면 먼저 취소해 주세요.`);
  }
  // 시간 지정 기능은 없앴습니다(선착순). 예전 앱이 보내도 무시합니다.
  return {
    ticket: {
      day, no: null, maskedName: maskName(name), dept, refMin, appointAt: null,
      status: 'waiting', order: now, createdAt: now,
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
  const dur = now - t.startedAt;
  // 평균 계산에는 30초~2시간 사이 보고만 반영(잘못 누른 경우 제외)
  return { patch: { status: 'done', doneAt: now }, dur: dur >= 30000 && dur <= 120 * MIN ? dur : null };
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
  for (const k of ['lunch', 'requirePush', 'showEventTitles']) if (input[k] != null) o[k] = !!input[k];
  if (input.calendarId != null) o.calendarId = String(input.calendarId).trim().slice(0, 200);
  if (input.icalUrl != null) {
    const u = String(input.icalUrl).trim();
    if (u && !/^https:\/\/\S+$/.test(u)) fail('invalid-argument', 'iCal 주소는 https://로 시작해야 합니다.');
    o.icalUrl = u.slice(0, 500);
  }
  num('soonAhead', 1, 10); num('soonMin', 5, 120); num('callLimitMin', 1, 30); num('remindEveryMin', 1, 10); num('overdueEveryMin', 1, 30);
  num('resumeBufferMin', 0, 30); num('returnMin', 0, 600); num('returnKmPerHour', 30, 200);
  if (input.places != null) {
    const items = String(input.places).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    for (const it of items) if (!/^[^=]{1,20}=\s*(\d{1,4}|\d{1,4}\s*분|종일)$/.test(it)) fail('invalid-argument', `출장 지역 형식이 맞지 않습니다: "${it}" (예: 서울=230, 제주=300분, 해외=종일)`);
    o.places = items.join(', ').slice(0, 3000);
  }
  for (const k of ['extKeywords', 'localKeywords']) if (input[k] != null) o[k] = String(input[k]).split(/[,\n]/).map(x => x.trim()).filter(Boolean).join(',').slice(0, 1000); num('defaultMin', 3, 60);
  if (o.remindEveryMin != null && o.callLimitMin != null && o.remindEveryMin > o.callLimitMin) fail('invalid-argument', '재알림 간격은 자동 취소 시간보다 길 수 없습니다.');
  return o;
}

// ---------- 대외 일정 판단 ----------
const kw = str => String(str || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
export function parsePlaces(str) {
  return String(str || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean).map(x => {
    const [name, v = ''] = x.split('=').map(y => y.trim());
    if (/종일/.test(v)) return { name, day: true };
    if (/분$/.test(v)) return { name, min: parseInt(v, 10) };
    return { name, km: Number(v) };
  }).filter(p => p.name && (p.day || p.min > 0 || p.km > 0));
}
// 복귀 시간(분): 거리 ÷ 속도, 10분 단위 올림. 종일 = 그날 복귀 어려움
export function placeReturnMin(p, sIn) {
  const s = withDefaults(sIn);
  if (!p) return s.returnMin;
  if (p.day) return 24 * 60;
  const m = p.min || (p.km / s.returnKmPerHour) * 60;
  return Math.max(s.resumeBufferMin, Math.ceil(m / 10) * 10);
}
export function retMinOf(b, s) { return b.ret != null ? b.ret : s.returnMin; }

// ev: { title, loc, desc } → { ext, place, km, ret(분) }
// 순서: ① 제목의 [대외]/[내부] 표시 ② 화상·온라인·내방 → 내부 ③ 장소에 출장 지역 → 대외(거리로 복귀 시간)
//       ④ 장소에 전주·완주 낱말 → 내부 ⑤ 제목·설명에 출장 지역 → 대외 ⑥ 출장·외부 등 낱말 → 대외(기본 복귀 시간) ⑦ 그 밖 → 내부
export function extInfo(ev, sIn) {
  const s = withDefaults(sIn);
  const title = String(ev.title || ''), loc = String(ev.loc || ''), desc = String(ev.desc || '').slice(0, 400);
  const places = parsePlaces(s.places);
  const far = p => (p.day ? 1e9 : p.min ? p.min * 1.5 : p.km); // 가장 먼 곳 기준(보수적으로)
  const findPlace = text => { const t = text.toLowerCase(); return places.filter(p => t.includes(p.name.toLowerCase())).sort((a, b) => far(b) - far(a) || b.name.length - a.name.length)[0] || null; };
  const out = p => ({ ext: true, place: p ? p.name : '', km: p && p.km ? p.km : null, ret: placeReturnMin(p, s) });
  const forced = /[\[(](대외|외부|출장)[\])]/.test(title);
  if (/[\[(](내부|청내)[\])]/.test(title)) return { ext: false };
  if (!forced && /화상|영상회의|온라인|비대면|zoom|webex|teams|내방/i.test(title + ' ' + loc)) return { ext: false };
  const pl = loc && findPlace(loc);
  if (pl) return out(pl);
  if (!forced && loc && kw(s.localKeywords).some(k => loc.toLowerCase().includes(k))) return { ext: false };
  const pt = findPlace(`${title} ${desc}`);
  if (pt) return out(pt);
  if (forced || kw(s.extKeywords).some(k => `${loc} ${title} ${desc}`.toLowerCase().includes(k))) return out(null);
  return { ext: false };
}
export const isExternal = (ev, s) => extInfo(ev, s).ext;
// 공개용 일정 목록(제목 없이 시각·대외 여부·복귀 시간만)
// withTitle: 신청자 화면에도 일정 제목을 보여 줄지(관리 설정 showEventTitles)
export function publicBusy(list, withTitle = false) {
  return (list || []).map(b => {
    const o = { s: b.s, e: b.e };
    if (b.ext) { o.ext = true; o.ret = b.ret ?? null; }
    if (withTitle && b.title) o.title = String(b.title).slice(0, 80);
    return o;
  });
}
