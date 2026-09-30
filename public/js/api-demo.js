// 데모 모드: 서버 없이 이 브라우저 안에서 서버와 똑같은 규칙(logic.js)으로 동작합니다.
// 같은 브라우저의 다른 탭(예: 관리 화면)과 실시간으로 공유되고, 시간을 앞으로 돌려 볼 수 있습니다.
import * as L from './logic.js';

const KEY = 'bogo-demo-v1';
export const DEMO_USERS = [
  { uid: 'u-me', label: '나' },
  { uid: 'u-a', label: '동료 A' },
  { uid: 'u-b', label: '동료 B' },
  { uid: 'u-c', label: '동료 C' },
];

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } }
function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} }

function seedDay(st, now) {
  const day = L.dayKey(now);
  if (st.day === day) return;
  const T = h => L.at(day, h);
  st.day = day;
  st.dayDoc = { nextNo: 1, syncedAt: now, allDayCount: 1, busy: [{ s: T('10:30'), e: T('11:30') }, { s: T('14:00'), e: T('15:00') }, { s: T('16:30'), e: T('17:00') }] };
  st.dayPrivate = { syncedAt: now, allDay: ['(예시) 실국장 만찬'], busy: [
    { s: T('10:30'), e: T('11:30'), title: '(예시) 국정감사 대비 간부회의' },
    { s: T('14:00'), e: T('15:00'), title: '(예시) 사전질의답변서 검토' },
    { s: T('16:30'), e: T('17:00'), title: '(예시) 기관장 보고' }] };
  st.tickets = []; st.priv = {}; st.logs = []; st.inbox = [];
  // 예시 대기자 두 명
  const mk = (uid, name, dept, topic, refMin, ago) => {
    const r = L.actIssue({ name, dept, topic, refMin }, { uid, deviceVerified: true }, st.tickets, st.settings, st.dayDoc, now - ago * L.MIN);
    const id = 'd' + Math.random().toString(36).slice(2, 9);
    st.tickets.push({ id, ...r.ticket, no: st.dayDoc.nextNo++ });
    st.priv[id] = r.priv;
  };
  st.devices = { ...(st.devices || {}), 'u-a': { verified: true }, 'u-b': { verified: true } };
  const [ws, we] = L.workRange(L.withDefaults(st.settings), day);
  if (now >= ws && now < we - 30 * L.MIN) {
    mk('u-a', '이서연', '정책총괄과', '국정감사 업무현황 보고서 최종본', 15, 12);
    mk('u-b', '박준호', '운영지원과', '위원실 요구자료 제출 목록', 5, 6);
  }
}

function fresh(now) {
  const st = { v: 1, offset: 0, settings: { ...L.DEFAULTS, requirePush: true }, devices: {}, accessCode: '1234' };
  seedDay(st, now);
  return st;
}

export function create() {
  const listeners = new Set(), adminListeners = new Set(), msgListeners = [];
  let uid = sessionStorage.getItem('bogo-demo-uid') || 'u-me';
  let seenInbox = null;
  const now = () => Date.now() + ((load() || {}).offset || 0);

  function state() {
    let st = load();
    if (!st) { st = fresh(Date.now()); save(st); }
    seedDay(st, Date.now() + (st.offset || 0));
    return st;
  }
  function deliver(st, notices, t0) {
    for (const n of notices) {
      const t = st.tickets.find(x => x.id === n.id);
      if (!t) continue;
      const msg = L.noticeText(n.kind, t, st.settings, n.extra);
      const ok = !!t.uid && !!st.devices[t.uid]?.verified;
      st.logs.unshift({ id: 'l' + Math.random().toString(36).slice(2), day: t.day, at: t0, ticketId: t.id, no: t.no, kind: n.kind, ok, error: ok ? null : (t.uid ? 'no-token' : 'no-device') });
      if (!ok) t.flags = { ...(t.flags || {}), pushFail: true };
      if (t.uid) st.inbox.push({ id: 'm' + Math.random().toString(36).slice(2), to: t.uid, at: t0, kind: n.kind, ...msg });
    }
    st.inbox = st.inbox.slice(-200); st.logs = st.logs.slice(0, 300);
  }
  function engine(st) {
    const t0 = Date.now() + (st.offset || 0);
    seedDay(st, t0);
    const r = L.tick(st.tickets, st.settings, st.dayDoc, t0);
    for (const u of r.updates) Object.assign(st.tickets.find(x => x.id === u.id), u.patch);
    deliver(st, r.notices, t0);
  }
  function commit(st) { engine(st); save(st); emit(); }
  function emit() {
    const st = state();
    const pub = { settings: L.withDefaults(st.settings), dayDoc: st.dayDoc, tickets: st.tickets.map(t => ({ ...t })), loaded: 7 };
    listeners.forEach(f => f(pub));
    adminListeners.forEach(f => f({ priv: st.priv, dayPrivate: st.dayPrivate, logs: st.logs }));
    const mine = st.inbox.filter(m => m.to === uid);
    if (seenInbox === null) seenInbox = new Set(mine.map(m => m.id));
    for (const m of mine) if (!seenInbox.has(m.id)) { seenInbox.add(m.id); msgListeners.forEach(f => f(m)); }
  }
  addEventListener('storage', e => { if (e.key === KEY) emit(); });
  setInterval(() => { const st = state(); engine(st); save(st); emit(); }, 4000);

  const api = {
    mode: 'demo',
    async ready() { return { uid, isAnonymous: true }; },
    user: () => ({ uid, email: 'demo@example.com', isAnonymous: false }),
    async signInAnon() { return api.user(); },
    hasMember: () => true,
    hasAdmin: () => true,
    async signOut() { location.reload(); },
    async refreshToken() {},
    now,
    watch(cb) { listeners.add(cb); setTimeout(emit, 0); return () => listeners.delete(cb); },
    watchAdmin(cb) { adminListeners.add(cb); setTimeout(emit, 0); return () => adminListeners.delete(cb); },
    pushState: () => 'granted',
    async resumePush() {},
    async enablePush() { const st = state(); st.devices[uid] = { verified: true }; save(st); emit(); return true; },
    onMessage(fn) { msgListeners.push(fn); },

    async op(name, d = {}) {
      const st = state();
      const t0 = now();
      const isAdmin = !!d.__admin;
      const ctx = { uid, isAdmin, deviceVerified: !!st.devices[uid]?.verified };
      const find = () => { const t = st.tickets.find(x => x.id === d.ticketId); if (!t) throw { code: 'not-found', message: '번호표를 찾을 수 없습니다.' }; return t; };
      try {
        switch (name) {
          case 'join': if (String(d.code) !== st.accessCode) throw { code: 'permission-denied', message: '접수 코드가 맞지 않습니다.' }; return { ok: true };
          case 'me': return { member: true, isAdmin: true, uid, verified: !!st.devices[uid]?.verified };
          case 'issue': {
            const r = L.actIssue(d, ctx, st.tickets, st.settings, st.dayDoc, t0);
            const id = 'd' + Math.random().toString(36).slice(2, 9);
            const no = st.dayDoc.nextNo || 1;
            st.dayDoc.nextNo = no + 1;
            st.tickets.push({ id, ...r.ticket, no });
            st.priv[id] = r.priv;
            commit(st); return { id, no };
          }
          case 'start': { const t = find(); Object.assign(t, L.actStart(t, ctx, t0)); break; }
          case 'complete': { const t = find(); const r = L.actComplete(t, ctx, t0); Object.assign(t, r.patch); if (r.dur) st.settings.avgMs = L.nextAvg(L.withDefaults(st.settings), r.dur); break; }
          case 'undo': { const t = find(); const r = L.actUndo(t, ctx, st.tickets, t0); for (const u of r.updates) Object.assign(st.tickets.find(x => x.id === u.id), u.patch); deliver(st, r.notices, t0); break; }
          case 'cancel': { const t = find(); Object.assign(t, L.actCancel(t, ctx, t0)); break; }
          case 'move': { const t = find(); for (const u of L.actMove(t, d.dir === 1 ? 1 : -1, st.tickets)) Object.assign(st.tickets.find(x => x.id === u.id), u.patch); break; }
          case 'urgent': { const t = find(); Object.assign(t, L.actUrgent(t, st.tickets)); break; }
          case 'restore': { const t = find(); Object.assign(t, L.actRestore(t, t0)); break; }
          case 'presence': { const p = L.presencePatch(d.mode, d.note, st.settings, st.dayDoc, t0); st.settings.presence = p; commit(st); return { ok: true, presence: p }; }
          case 'settings': {
            const o = L.cleanSettings(d.values || {});
            const merged = L.withDefaults({ ...st.settings, ...o });
            if (merged.workStart >= merged.workEnd) throw new L.RuleError('invalid-argument', '보고 시작 시각이 종료 시각보다 빨라야 합니다.');
            if (merged.remindMin >= merged.startLimitMin) throw new L.RuleError('invalid-argument', '재알림은 자동 취소보다 먼저여야 합니다.');
            Object.assign(st.settings, o);
            if (d.accessCode != null) st.accessCode = String(d.accessCode).trim() || st.accessCode;
            break;
          }
          case 'getSecret': return { accessCode: st.accessCode };
          case 'syncCalendar': st.dayDoc.syncedAt = t0; st.dayPrivate.syncedAt = t0; break;
          case 'registerPush': case 'testPush': case 'confirmPush': case 'tick': case 'state': case 'adminState': break;
          case 'adminLogin': return { ok: true };
          default: throw { code: 'invalid-argument', message: '알 수 없는 요청: ' + name };
        }
        commit(st);
        return { ok: true };
      } catch (e) {
        throw { code: e.code || 'internal', message: e.message || String(e) };
      }
    },

    // 데모 전용 도구
    demo: {
      users: DEMO_USERS,
      get uid() { return uid; },
      setUser(u) { uid = u; sessionStorage.setItem('bogo-demo-uid', u); seenInbox = null; emit(); },
      advance(min) { const st = state(); st.offset = (st.offset || 0) + min * L.MIN; engine(st); save(st); emit(); },
      reset() { localStorage.removeItem(KEY); sessionStorage.removeItem('bogo-demo-uid'); location.reload(); },
      offsetMin() { return Math.round(((load() || {}).offset || 0) / L.MIN); },
    },
  };
  return api;
}
