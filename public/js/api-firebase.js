// 실제 운영용: Firebase(로그인 · 실시간 데이터 · 푸시, 무료 요금제)와 Vercel 서버(/api/op)에 연결합니다.
import * as L from './logic.js';

const V = '10.12.2';
const B = `https://www.gstatic.com/firebasejs/${V}`;

export async function create(cfg) {
  const [{ initializeApp }, A, F, M] = await Promise.all([
    import(`${B}/firebase-app.js`), import(`${B}/firebase-auth.js`), import(`${B}/firebase-firestore.js`),
    import(`${B}/firebase-messaging.js`),
  ]);
  const app = initializeApp(cfg.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  // 서버(Vercel) 호출: 로그인 토큰을 붙여 보냅니다.
  async function call(body) {
    const u = auth.currentUser;
    if (!u) throw { code: 'unauthenticated', message: '로그인이 필요합니다.' };
    const r = await fetch(cfg.apiBase ? cfg.apiBase + '/api/op' : '/api/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await u.getIdToken()) },
      body: JSON.stringify(body),
    }).catch(() => { throw { code: 'network', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' }; });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.error?.code || String(r.status), message: j.error?.message || `서버 오류(${r.status})` };
    return j;
  }
  let messaging = null, pendingNonce = null, msgHooked = false;
  const listeners = [];

  async function hookMessages() {
    if (msgHooked) return;
    if (!(await M.isSupported().catch(() => false))) return;
    messaging = messaging || M.getMessaging(app);
    M.onMessage(messaging, p => {
      const d = p.data || {};
      if (d.kind === 'test' && pendingNonce) { pendingNonce(d.nonce); return; }
      const msg = { title: d.title || p.notification?.title || '', body: d.body || p.notification?.body || '', kind: d.kind };
      listeners.forEach(f => f(msg));
    });
    msgHooked = true;
  }

  const api = {
    mode: 'firebase',
    async ready() {
      await A.getRedirectResult(auth).catch(() => null);
      return new Promise(res => { const un = A.onAuthStateChanged(auth, u => { un(); res(u); }); });
    },
    user: () => auth.currentUser,
    async signInAnon() { if (!auth.currentUser) await A.signInAnonymously(auth); return auth.currentUser; },
    async signInGoogle() {
      const p = new A.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await A.signInWithPopup(auth, p); }
      catch (e) {
        if (/popup-blocked|operation-not-supported|popup-closed/.test(e.code || '')) await A.signInWithRedirect(auth, p);
        else throw { code: e.code, message: '구글 로그인에 실패했습니다: ' + (e.message || e.code) };
      }
      return auth.currentUser;
    },
    async signOut() { await A.signOut(auth); },
    async refreshToken() { if (auth.currentUser) await auth.currentUser.getIdToken(true); },
    async op(name, data = {}) { return call({ op: name, ...data }); },
    now: () => Date.now(),

    // 공개 데이터: 설정 · 오늘 · 오늘 번호표
    watch(cb, onErr) {
      const day = L.dayKey(Date.now());
      const st = { settings: L.withDefaults({}), dayDoc: {}, tickets: [], loaded: 0 };
      const fire = () => cb({ ...st });
      const err = e => onErr && onErr({ code: e.code, message: '데이터를 불러오지 못했습니다(' + e.code + ').' });
      const uns = [
        F.onSnapshot(F.doc(db, 'settings/public'), s => { st.settings = L.withDefaults(s.data()); st.loaded |= 1; fire(); }, err),
        F.onSnapshot(F.doc(db, 'days/' + day), s => { st.dayDoc = s.data() || {}; st.loaded |= 2; fire(); }, err),
        F.onSnapshot(F.query(F.collection(db, 'tickets'), F.where('day', '==', day)), s => { st.tickets = s.docs.map(d => ({ id: d.id, ...d.data() })); st.loaded |= 4; fire(); }, err),
      ];
      const dayTimer = setInterval(() => { if (L.dayKey(Date.now()) !== day) location.reload(); }, 60000);
      return () => { uns.forEach(u => u()); clearInterval(dayTimer); };
    },
    // 관리자 전용: 실명·건명 · 일정 제목 · 알림 기록
    watchAdmin(cb, onErr) {
      const day = L.dayKey(Date.now());
      const st = { priv: {}, dayPrivate: {}, logs: [] };
      const fire = () => cb({ ...st });
      const err = e => onErr && onErr({ code: e.code, message: '관리자 데이터를 불러오지 못했습니다(' + e.code + ').' });
      const uns = [
        F.onSnapshot(F.query(F.collection(db, 'private'), F.where('day', '==', day)), s => { st.priv = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); fire(); }, err),
        F.onSnapshot(F.doc(db, 'dayPrivate/' + day), s => { st.dayPrivate = s.data() || {}; fire(); }, err),
        F.onSnapshot(F.query(F.collection(db, 'logs'), F.where('day', '==', day)), s => { st.logs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at); fire(); }, err),
      ];
      return () => uns.forEach(u => u());
    },

    // 푸시
    pushState() {
      if (!('Notification' in self) || !('serviceWorker' in navigator)) return 'unsupported';
      return Notification.permission; // default | granted | denied
    },
    async resumePush() {
      if (api.pushState() !== 'granted' || !cfg.vapidKey) return;
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        await hookMessages();
        if (!messaging) return;
        const token = await M.getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
        if (token) await api.op('registerDevice', { token });
      } catch (e) { console.warn('resumePush', e); }
    },
    async enablePush() {
      if (api.pushState() === 'unsupported') throw { code: 'unsupported', message: '이 브라우저에서는 알림을 받을 수 없습니다. 아이폰은 Safari에서 "홈 화면에 추가"한 앱으로 열어 주세요.' };
      if (!cfg.vapidKey) throw { code: 'config', message: '관리자가 알림 키(vapidKey)를 아직 설정하지 않았습니다.' };
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw { code: 'denied', message: '알림이 차단되어 있습니다. 휴대폰 설정에서 이 앱(또는 브라우저)의 알림을 허용한 뒤 다시 눌러 주세요.' };
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      await hookMessages();
      if (!messaging) throw { code: 'unsupported', message: '이 브라우저에서는 알림을 받을 수 없습니다.' };
      const token = await M.getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
      if (!token) throw { code: 'token', message: '알림 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
      await api.op('registerDevice', { token });
      const nonceP = new Promise((res, rej) => {
        const to = setTimeout(() => { pendingNonce = null; rej({ code: 'timeout', message: '테스트 알림이 20초 안에 오지 않았습니다. 앱을 켜 둔 채로 다시 눌러 주세요.' }); }, 20000);
        pendingNonce = n => { clearTimeout(to); pendingNonce = null; res(n); };
      });
      await api.op('testPush');
      const nonce = await nonceP;
      await api.op('confirmPush', { nonce });
      return true;
    },
    onMessage(fn) { listeners.push(fn); hookMessages(); },
  };
  return api;
}
