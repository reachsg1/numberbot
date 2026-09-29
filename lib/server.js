// 보고 대기 번호표 — 서버 동작 (Vercel 함수에서 호출)
// 규칙은 public/js/logic.js에 있고, 여기서는 데이터베이스 읽기·쓰기, 푸시 발송, 캘린더 읽기만 합니다.
// db · auth · messaging 등을 밖에서 넣어 주는 구조라 테스트에서는 가짜(메모리) 데이터베이스로 돌려 볼 수 있습니다.
import * as L from '../public/js/logic.js';

export class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
const err = (code, msg) => new ApiError(code, msg);

export function createServer({ db, auth, messaging, env = {}, fetchFn = fetch, googleToken, now: clock = () => Date.now() }) {
  const SETTINGS = () => db.doc('settings/public');
  const DAY = d => db.doc('days/' + d);
  const TICKET = id => db.doc('tickets/' + id);
  const PRIV = id => db.doc('private/' + id);
  const bootAdmins = () => String(env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

  // ---------- 상태 읽기 ----------
  // 무료 사용량을 아끼려고 '열린 번호표(대기·지정·호출·보고 중)'만 읽습니다.
  async function readState(tx, now, all = false) {
    const day = L.dayKey(now);
    let q = db.collection('tickets').where('day', '==', day);
    if (!all) q = q.where('open', '==', true);
    const [s, d, t] = await Promise.all([tx.get(SETTINGS()), tx.get(DAY(day)), tx.get(q)]);
    return { day, settings: L.withDefaults(s.data()), dayDoc: d.data() || {}, tickets: t.docs.map(x => ({ id: x.id, ...x.data() })) };
  }
  const upd = (tx, id, patch) => tx.update(TICKET(id), L.withOpen(patch));

  // ---------- 푸시 ----------
  async function sendPush(uid, msg, data = {}) {
    if (!uid) return { ok: false, error: 'no-device' };
    const devRef = db.doc('devices/' + uid);
    const dev = await devRef.get();
    const token = dev.data()?.token;
    if (!token) return { ok: false, error: 'no-token' };
    try {
      await messaging.send({
        token,
        notification: { title: msg.title, body: msg.body },
        data: { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), title: msg.title, body: msg.body },
        webpush: {
          notification: { icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: data.kind || 'bogo', renotify: true, requireInteraction: data.kind === 'call', vibrate: [200, 100, 200, 100, 300] },
          fcmOptions: { link: '/' },
          headers: { Urgency: 'high', TTL: '600' },
        },
      });
      return { ok: true };
    } catch (e) {
      const code = e?.errorInfo?.code || e?.code || String(e);
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) await devRef.update({ token: null, verified: false });
      return { ok: false, error: code };
    }
  }
  async function deliver(notices, tickets, settings, now) {
    for (const n of notices) {
      const t = tickets.find(x => x.id === n.id);
      if (!t) continue;
      const r = await sendPush(t.uid, L.noticeText(n.kind, t, settings, n.extra), { kind: n.kind, ticketId: t.id });
      await db.collection('logs').add({ day: t.day, at: now, ticketId: t.id, no: t.no, kind: n.kind, ok: r.ok, error: r.error || null });
      if (!r.ok) await TICKET(t.id).update({ 'flags.pushFail': true }).catch(() => {});
    }
  }

  // ---------- 엔진: 호출·알림 판단 ----------
  async function runEngine() {
    const now = clock();
    let out = { notices: [], tickets: [], settings: null };
    await db.runTransaction(async tx => {
      const st = await readState(tx, now);
      const r = L.tick(st.tickets, st.settings, st.dayDoc, now);
      for (const u of r.updates) upd(tx, u.id, u.patch);
      const byId = new Map(st.tickets.map(t => [t.id, { ...t }]));
      for (const u of r.updates) Object.assign(byId.get(u.id), u.patch);
      out = { notices: r.notices, tickets: [...byId.values()], settings: st.settings };
    });
    await deliver(out.notices, out.tickets, out.settings, now);
    return out.notices.length;
  }

  // ---------- 국장님 캘린더 ----------
  async function syncCalendar(now) {
    const day = L.dayKey(now);
    const s = L.withDefaults((await SETTINGS().get()).data());
    const cur = (await DAY(day).get()).data() || {};
    try {
      const token = await googleToken('https://www.googleapis.com/auth/calendar.readonly');
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(s.calendarId)}/events`);
      u.search = new URLSearchParams({ timeMin: `${day}T00:00:00+09:00`, timeMax: `${day}T23:59:59+09:00`, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeZone: 'Asia/Seoul' });
      const r = await fetchFn(u, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) {
        const why = r.status === 404 ? '캘린더를 찾을 수 없습니다. 캘린더 ID와 공유 설정을 확인해 주세요.'
          : r.status === 403 ? 'Google Calendar API가 꺼져 있거나 캘린더 보기 권한이 없습니다.' : `캘린더 읽기 실패(${r.status})`;
        throw new Error(why);
      }
      const items = (await r.json()).items || [];
      const d0 = L.at(day, '00:00'), d1 = d0 + 86400000;
      const busy = [], titled = [], allDay = [];
      for (const e of items) {
        if (e.status === 'cancelled' || e.eventType === 'workingLocation' || e.eventType === 'birthday') continue;
        const title = String(e.summary || '(제목 없음)').slice(0, 80);
        if (e.start?.dateTime && e.end?.dateTime) {
          const a = Math.max(Date.parse(e.start.dateTime), d0), b = Math.min(Date.parse(e.end.dateTime), d1);
          if (b > a) { busy.push({ s: a, e: b }); titled.push({ s: a, e: b, title }); }
        } else if (e.start?.date) allDay.push(title);
      }
      busy.sort((a, b) => a.s - b.s); titled.sort((a, b) => a.s - b.s);
      const changed = JSON.stringify(cur.busy || []) !== JSON.stringify(busy) || cur.calendarError || cur.allDayCount !== allDay.length;
      // 바뀐 게 없으면 확인 시각만 가볍게 남깁니다(앱 화면에 불필요한 갱신을 줄이기 위해 5분 단위).
      await DAY(day).set({ busy, allDayCount: allDay.length, syncedAt: now, calendarError: null }, { merge: true });
      if (changed || !(await db.doc('dayPrivate/' + day).get()).exists) await db.doc('dayPrivate/' + day).set({ busy: titled, allDay, syncedAt: now });
      return { ok: true, events: busy.length };
    } catch (e) {
      await DAY(day).set({ syncedAt: now, calendarError: String(e.message || e) }, { merge: true });
      return { ok: false, error: String(e.message || e) };
    }
  }

  // ---------- 매일 밤: 개인정보 삭제 ----------
  async function nightlyCleanup(now, day = L.dayKey(now)) {
    const w = [];
    (await db.collection('private').where('day', '<=', day).get()).forEach(d => w.push(d.ref));
    (await db.collection('dayPrivate').get()).forEach(d => w.push(d.ref));
    const old = L.dayKey(now - 90 * 86400000);
    (await db.collection('logs').where('day', '<', old).get()).forEach(d => w.push(d.ref));
    (await db.collection('tickets').where('day', '<', old).get()).forEach(d => w.push(d.ref));
    const bw = db.bulkWriter();
    for (const r of w) bw.delete(r);
    await bw.close();
    await DAY(day).set({ cleanedAt: now }, { merge: true });
    return w.length;
  }

  // ---------- 1분마다 (cron-job.org 등이 /api/tick 호출) ----------
  async function runTick() {
    const now = clock();
    const hmNow = L.hm(now);
    const out = { at: hmNow };
    // 밤 23:30~다음 날 06:00: 그날 개인정보 정리(하루 한 번, 자정을 넘겨도 전날 것을 정리)
    if (hmNow >= '23:30' || hmNow < '06:00') {
      const target = hmNow >= '23:30' ? L.dayKey(now) : L.dayKey(now - 86400000);
      const d = (await DAY(target).get()).data() || {};
      if (!d.cleanedAt) out.cleaned = await nightlyCleanup(now, target);
      else out.skipped = true;
      return out;
    }
    // 22:00~23:30은 쉬어서 무료 사용량을 아낍니다.
    if (hmNow >= '22:00') { out.skipped = true; return out; }
    const d = (await DAY(L.dayKey(now)).get()).data() || {};
    if (!d.syncedAt || now - d.syncedAt >= 5 * L.MIN) out.calendar = await syncCalendar(now);
    out.notices = await runEngine();
    return out;
  }

  // ---------- 권한 ----------
  async function identify(idToken) {
    if (!idToken) throw err('unauthenticated', '로그인이 필요합니다.');
    let tok;
    try { tok = await auth.verifyIdToken(idToken); } catch { throw err('unauthenticated', '로그인이 만료되었습니다. 앱을 새로고침해 주세요.'); }
    let isAdmin = false;
    const email = tok.email && tok.email_verified === true ? String(tok.email).toLowerCase() : null;
    if (email) {
      const ref = db.doc('admins/' + email);
      if ((await ref.get()).exists) isAdmin = true;
      else if (bootAdmins().includes(email)) { await ref.set({ addedAt: clock(), by: 'env' }); isAdmin = true; }
    }
    return { uid: tok.uid, email, member: tok.member === true || isAdmin, isAdmin };
  }

  // ---------- 앱이 부르는 기능 ----------
  async function handleOp(idToken, d) {
    const me = await identify(idToken);
    const { uid, isAdmin } = me;
    const op = d.op;
    const now = clock();
    try {
      if (op === 'join') {
        const sec = (await db.doc('config/secret').get()).data();
        const code = sec?.accessCode || env.ACCESS_CODE || '1234';
        if (String(d.code || '').trim() !== String(code)) throw err('permission-denied', '접수 코드가 맞지 않습니다.');
        await auth.setCustomUserClaims(uid, { member: true });
        return { ok: true };
      }
      if (op === 'me') {
        const dev = (await db.doc('devices/' + uid).get()).data() || {};
        return { member: me.member, isAdmin, verified: !!dev.verified && !!dev.token, email: me.email };
      }
      if (!me.member) throw err('permission-denied', '먼저 접수 코드를 입력해 주세요.');

      if (op === 'registerDevice') {
        const ref = db.doc('devices/' + uid);
        const cur = (await ref.get()).data() || {};
        const token = String(d.token || '');
        if (!token) throw err('invalid-argument', '알림 토큰이 없습니다.');
        await ref.set({ token, verified: cur.token === token ? !!cur.verified : false, updatedAt: now }, { merge: true });
        return { ok: true };
      }
      if (op === 'testPush') {
        const nonce = Math.random().toString(36).slice(2, 10);
        await db.doc('devices/' + uid).set({ nonce }, { merge: true });
        const r = await sendPush(uid, L.noticeText('test', {}, {}), { kind: 'test', nonce });
        if (!r.ok) throw err('unavailable', '테스트 알림을 보내지 못했습니다: ' + r.error);
        return { ok: true };
      }
      if (op === 'confirmPush') {
        const ref = db.doc('devices/' + uid);
        const cur = (await ref.get()).data() || {};
        if (!cur.nonce || cur.nonce !== d.nonce) throw err('failed-precondition', '테스트 알림 확인값이 맞지 않습니다. 다시 시도해 주세요.');
        await ref.update({ verified: true, nonce: null });
        return { ok: true };
      }

      if (op === 'issue') {
        const dev = (await db.doc('devices/' + uid).get()).data() || {};
        const ctx = { uid, isAdmin, deviceVerified: !!dev.verified && !!dev.token };
        let result;
        await db.runTransaction(async tx => {
          const st = await readState(tx, now);
          const r = L.actIssue(d, ctx, st.tickets, st.settings, st.dayDoc, now);
          const no = st.dayDoc.nextNo || 1;
          const ref = db.collection('tickets').doc();
          tx.set(DAY(st.day), { nextNo: no + 1 }, { merge: true });
          tx.set(ref, { ...r.ticket, no });
          tx.set(PRIV(ref.id), r.priv);
          result = { id: ref.id, no };
        });
        await runEngine();
        return result;
      }

      if (['start', 'complete', 'undo', 'cancel', 'move', 'urgent', 'restore'].includes(op)) {
        if (['move', 'urgent', 'restore'].includes(op) && !isAdmin) throw err('permission-denied', '관리자만 할 수 있습니다.');
        const ctx = { uid, isAdmin };
        let extra = [], snap;
        await db.runTransaction(async tx => {
          const st = await readState(tx, now, op === 'undo' || op === 'restore');
          const t = st.tickets.find(x => x.id === d.ticketId);
          if (!t) throw err('not-found', '번호표를 찾을 수 없습니다.');
          if (op === 'start') upd(tx, t.id, L.actStart(t, ctx, now));
          if (op === 'complete') {
            const r = L.actComplete(t, ctx, now);
            upd(tx, t.id, r.patch);
            if (r.dur) tx.set(SETTINGS(), { avgMs: L.nextAvg(st.settings, r.dur) }, { merge: true });
          }
          if (op === 'undo') { const r = L.actUndo(t, ctx, st.tickets, now); for (const u of r.updates) upd(tx, u.id, u.patch); extra = r.notices; }
          if (op === 'cancel') upd(tx, t.id, L.actCancel(t, ctx, now));
          if (op === 'move') for (const u of L.actMove(t, d.dir === 1 ? 1 : -1, st.tickets)) upd(tx, u.id, u.patch);
          if (op === 'urgent') upd(tx, t.id, L.actUrgent(t, st.tickets));
          if (op === 'restore') upd(tx, t.id, L.actRestore(t, now));
          snap = st;
        });
        if (extra.length) await deliver(extra, snap.tickets, snap.settings, now);
        await runEngine();
        return { ok: true };
      }

      // ---------- 관리자 ----------
      if (!isAdmin) throw err('permission-denied', '관리자만 할 수 있습니다.');
      if (op === 'presence') {
        const s = L.withDefaults((await SETTINGS().get()).data());
        const dayDoc = (await DAY(L.dayKey(now)).get()).data() || {};
        const p = L.presencePatch(d.mode, d.note, s, dayDoc, now);
        await SETTINGS().set({ presence: p }, { merge: true });
        await runEngine();
        return { ok: true, presence: p };
      }
      if (op === 'settings') {
        const o = L.cleanSettings(d.values || {});
        const cur = L.withDefaults((await SETTINGS().get()).data());
        const merged = { ...cur, ...o };
        if (merged.workStart >= merged.workEnd) throw err('invalid-argument', '보고 시작 시각이 종료 시각보다 빨라야 합니다.');
        if (merged.remindMin >= merged.startLimitMin) throw err('invalid-argument', '재알림은 자동 취소보다 먼저여야 합니다.');
        if (d.accessCode != null && d.accessCode !== '') {
          const c = String(d.accessCode).trim();
          if (!/^[0-9A-Za-z]{4,12}$/.test(c)) throw err('invalid-argument', '접수 코드는 영문·숫자 4~12자로 정해 주세요.');
          await db.doc('config/secret').set({ accessCode: c }, { merge: true });
        }
        await SETTINGS().set(o, { merge: true });
        if (o.calendarId && o.calendarId !== cur.calendarId) await syncCalendar(now);
        await runEngine();
        return { ok: true };
      }
      if (op === 'getSecret') {
        const sec = (await db.doc('config/secret').get()).data();
        return { accessCode: sec?.accessCode || env.ACCESS_CODE || '1234' };
      }
      if (op === 'syncCalendar') { const r = await syncCalendar(now); await runEngine(); return r; }
      if (op === 'admins') {
        if (d.action === 'list') {
          const list = (await db.collection('admins').get()).docs.map(x => x.id);
          return { admins: [...new Set([...list, ...bootAdmins()])].sort() };
        }
        const email = String(d.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw err('invalid-argument', '이메일 형식이 아닙니다.');
        if (d.action === 'add') await db.doc('admins/' + email).set({ addedAt: now, by: me.email });
        if (d.action === 'remove') {
          if (email === me.email) throw err('failed-precondition', '자기 자신은 뺄 수 없습니다.');
          if (bootAdmins().includes(email)) throw err('failed-precondition', 'Vercel 환경 변수 ADMIN_EMAILS에 적힌 관리자는 거기서 지워야 합니다.');
          await db.doc('admins/' + email).delete();
        }
        return { ok: true };
      }
      if (op === 'tick') { await runEngine(); return { ok: true }; }
      throw err('invalid-argument', '알 수 없는 요청입니다: ' + op);
    } catch (e) {
      if (e instanceof L.RuleError) throw err(e.code, e.message);
      throw e;
    }
  }

  return { handleOp, runTick, runEngine, syncCalendar, nightlyCleanup, identify };
}
