// 실제 운영용: Vercel 서버(/api/state · /api/op)와 표준 웹 푸시에 연결합니다. (Firebase 없음)
// - 이 기기의 출입증(토큰)은 이 브라우저에만 저장됩니다. 접수 코드를 한 번 넣으면 계속 씁니다.
// - 현황은 화면이 켜져 있는 동안 10초마다 새로 받아 옵니다(화면을 끄면 멈춤 → 무료 한도 절약).
import * as L from './logic.js';

const TK = 'bogo-token', AK = 'bogo-admin-token';
const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const b64ToBytes = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
const sameKey = (a, b) => { if (!a || !b) return false; const x = new Uint8Array(a), y = b; return x.length === y.length && x.every((v, i) => v === y[i]); };

export function create(cfg = {}, first = null) {
  const base = cfg.apiBase || '';
  const isAdminPage = /admin/.test(location.pathname);
  let skew = 0, lastSeen = 0, vapidPublic = first?.vapidPublic || '';
  let pub = null, adm = null;
  const pubL = new Set(), admL = new Set(), msgL = [];
  let pendingNonce = null;

  function takeState(st, fresh) {
    if (!st || !st.configured) return;
    if (fresh) skew = st.serverNow - Date.now();
    if (st.serverNow < lastSeen) return; // 캐시된 옛 현황이 늦게 도착한 경우 무시
    lastSeen = st.serverNow;
    if (st.vapidPublic) vapidPublic = st.vapidPublic;
    pub = { settings: L.withDefaults(st.settings), dayDoc: st.dayDoc || {}, tickets: st.tickets || [], loaded: 7 };
    pubL.forEach(f => f(pub));
  }
  function takeAdmin(a) { if (!a) return; adm = a; admL.forEach(f => f(adm)); }
  if (first) takeState(first, false);

  async function call(body, token) {
    const r = await fetch(base + '/api/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    }).catch(() => { throw { code: 'network', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' }; });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = { code: j.error?.code || String(r.status), message: j.error?.message || `서버 오류(${r.status})` };
      if (e.code === 'unauthenticated' && token) store.set(token === store.get(AK) ? AK : TK, '');
      throw e;
    }
    if (j.state) takeState(j.state, true);
    if (j.admin) takeAdmin(j.admin);
    return j;
  }
  const tokenFor = () => (isAdminPage && store.get(AK)) || store.get(TK) || store.get(AK);

  // 화면이 보일 때만 주기적으로 실행
  function poll(fn, ms) {
    let timer = null, stopped = false;
    const run = async () => { clearTimeout(timer); if (stopped) return; if (document.visibilityState === 'visible') await fn().catch(() => {}); timer = setTimeout(run, ms); };
    const vis = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', vis);
    addEventListener('focus', vis);
    run();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); removeEventListener('focus', vis); };
  }

  // 서비스 워커가 전달하는 푸시
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      const m = e.data;
      if (!m || m.type !== 'bogo-push') return;
      const d = m.data || {};
      if (d.kind === 'test') { if (pendingNonce) pendingNonce(d.nonce); return; }
      msgL.forEach(f => f({ title: d.title || '', body: d.body || '', kind: d.kind }));
      // 알림이 오면 현황도 바로 새로 받기
      if (tokenFor()) api.op('state').catch(() => {});
    });
  }
  async function subscribe(force) {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!vapidPublic) vapidPublic = (await api.op('me')).vapidPublic;
    const key = b64ToBytes(vapidPublic);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) {
      if (!force) return null;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    return sub;
  }

  const api = {
    mode: 'server',
    hasMember: () => !!store.get(TK),
    hasAdmin: () => !!store.get(AK),
    async ready() { return { uid: null }; },
    user: () => ({ uid: null }),
    async signInAnon() { return { uid: null }; },
    async refreshToken() {},
    async signOut() { store.set(AK, ''); },
    now: () => Date.now() + skew,

    async op(name, data = {}) {
      if (name === 'join') {
        const j = await call({ op: 'join', ...data }, store.get(TK) || store.get(AK));
        store.set(TK, j.token);
        return j;
      }
      if (name === 'adminLogin') {
        const j = await call({ op: 'adminLogin', ...data }, store.get(TK) || store.get(AK));
        store.set(AK, j.token);
        return j;
      }
      const tok = tokenFor();
      if (!tok) throw { code: 'unauthenticated', message: '접수 코드를 입력해 주세요.' };
      return call({ op: name, ...data }, tok);
    },

    watch(cb, onErr) {
      pubL.add(cb);
      if (pub) setTimeout(() => cb(pub), 0);
      const stop = poll(async () => {
        const r = await fetch(base + '/api/state').catch(() => null);
        if (!r) return onErr && onErr({ code: 'network', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return onErr && onErr({ code: String(r.status), message: j.error?.message || `현황을 불러오지 못했습니다(${r.status}).` });
        takeState(j, false);
      }, 10000);
      return () => { pubL.delete(cb); stop(); };
    },
    // 관리자 전용: 실명·건명 · 일정 제목 · 알림 기록 (15초마다, 호출 판단도 함께 돌림)
    watchAdmin(cb, onErr) {
      admL.add(cb);
      if (adm) setTimeout(() => cb(adm), 0);
      const stop = poll(() => api.op('adminState').catch(e => onErr && onErr(e)), 15000);
      return () => { admL.delete(cb); stop(); };
    },

    // ---------- 푸시 ----------
    pushState() {
      if (!('Notification' in self) || !('serviceWorker' in navigator) || !('PushManager' in self)) return 'unsupported';
      return Notification.permission;
    },
    async resumePush() {
      if (api.pushState() !== 'granted' || !store.get(TK)) return;
      try { const sub = await subscribe(false); if (sub) await api.op('registerPush', { sub: sub.toJSON() }); }
      catch (e) { console.warn('resumePush', e); }
    },
    async enablePush() {
      if (api.pushState() === 'unsupported') throw { code: 'unsupported', message: '이 브라우저에서는 알림을 받을 수 없습니다. 아이폰은 Safari에서 "홈 화면에 추가"한 앱으로 열어 주세요.' };
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw { code: 'denied', message: '알림이 차단되어 있습니다. 휴대폰 설정에서 이 앱(또는 브라우저)의 알림을 허용한 뒤 다시 눌러 주세요.' };
      let sub;
      try { sub = await subscribe(true); }
      catch (e) { throw { code: 'subscribe', message: '알림 등록에 실패했습니다: ' + (e.message || e) }; }
      await api.op('registerPush', { sub: sub.toJSON() });
      const nonceP = new Promise((res, rej) => {
        const to = setTimeout(() => { pendingNonce = null; rej({ code: 'timeout', message: '테스트 알림이 20초 안에 오지 않았습니다. 앱을 켜 둔 채로 다시 눌러 주세요.' }); }, 20000);
        pendingNonce = n => { clearTimeout(to); pendingNonce = null; res(n); };
      });
      await api.op('testPush');
      const nonce = await nonceP;
      await api.op('confirmPush', { nonce });
      return true;
    },
    onMessage(fn) { msgL.push(fn); },
  };
  return api;
}
