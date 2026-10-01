// 보고 대기 번호표 — 서버 동작 (Vercel 함수에서 호출)
// 저장소: Upstash Redis(무료) 하나. 푸시: 표준 웹 푸시(외부 서비스 없음). 캘린더: 구글 캘린더 iCal 주소.
// 규칙은 public/js/logic.js에 있고, 여기서는 읽기·쓰기, 푸시 발송, 캘린더 읽기만 합니다.
//
// 저장 구조 (키 몇 개뿐이라 무료 한도 안에서 넉넉합니다)
//   bq:settings        설정(JSON)
//   bq:secret          서명 키 · 푸시(VAPID) 키 · 접수 코드 (처음 한 번 자동 생성)
//   bq:day:YYYY-MM-DD  그날의 모든 것: 번호표 · 실명/건명 · 일정 · 알림 기록 (90일 뒤 자동 삭제)
//   bq:dev:<기기ID>     기기별 푸시 구독
//   bq:lock            동시에 두 요청이 같은 날을 고치지 않도록 잠금(8초)
import crypto from 'node:crypto';
import * as L from '../public/js/logic.js';
import { generateVapidKeys, sendWebPush } from './webpush.js';
import { eventsForDay, publicIcalUrl } from './ical.js';

export class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
const err = (code, msg) => new ApiError(code, msg);

const K = { settings: 'bq:settings', secret: 'bq:secret', lock: 'bq:lock', sync: 'bq:synclock', fail: 'bq:adminfail', day: d => 'bq:day:' + d, dev: d => 'bq:dev:' + d };
const DAY_TTL = 90 * 86400;
const SYNC_EVERY = 5 * L.MIN;
const J = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const b64u = b => Buffer.from(b).toString('base64url');
const rid = (p = '') => p + crypto.randomBytes(9).toString('base64url');
const emptyDay = () => ({ nextNo: 1, tickets: [], priv: {}, busy: [], busyTitled: [], allDay: [], allDayCount: 0, syncedAt: null, calendarError: null, logs: [] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createServer({ redis, env = {}, fetchFn = fetch, now: clock = () => Date.now() }) {
  // ---------- 비밀값(처음 한 번 자동 생성) ----------
  let secretCache = null;
  async function secret(raw) {
    if (raw === undefined && secretCache) return secretCache;
    let s = J(raw !== undefined ? raw : await redis.cmd('GET', K.secret));
    if (!s) {
      const fresh = { hmac: crypto.randomBytes(32).toString('base64url'), vapid: generateVapidKeys(), accessCode: String(env.ACCESS_CODE || '1234') };
      await redis.cmd('SET', K.secret, JSON.stringify(fresh), 'NX');
      s = J(await redis.cmd('GET', K.secret));
    }
    return (secretCache = s);
  }
  const saveSecret = async s => { secretCache = s; await redis.cmd('SET', K.secret, JSON.stringify(s)); };

  // ---------- 출입증(토큰): 기기ID + 역할에 서명 ----------
  const sign = (sec, obj) => { const p = b64u(JSON.stringify(obj)); return p + '.' + b64u(crypto.createHmac('sha256', sec.hmac).update(p).digest()); };
  function verify(sec, token) {
    const [p, sig] = String(token || '').split('.');
    if (!p || !sig) return null;
    const want = b64u(crypto.createHmac('sha256', sec.hmac).update(p).digest());
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    const o = J(Buffer.from(p, 'base64url').toString());
    if (!o || !o.d || (o.exp && o.exp < clock())) return null;
    return o;
  }
  // 공개 화면에는 기기ID 대신 짧은 표식만 보냅니다(본인 번호표 찾기용).
  const tag = (sec, d) => d ? crypto.createHmac('sha256', sec.hmac).update('tag:' + d).digest('base64url').slice(0, 12) : null;

  // ---------- 잠금 ----------
  async function withLock(fn) {
    const me = rid();
    for (let i = 0; ; i++) {
      if (await redis.cmd('SET', K.lock, me, 'NX', 'PX', 8000)) break;
      if (i > 40) throw err('unavailable', '요청이 몰려 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      await sleep(120 + Math.random() * 120);
    }
    try { return await fn(); }
    finally { await redis.cmd('DEL', K.lock).catch(() => {}); }
  }

  // ---------- 푸시 ----------
  async function deliver(sec, st, notices, now) {
    if (!notices.length) return;
    const tickets = st.day.tickets;
    const list = notices.map(n => ({ n, t: tickets.find(x => x.id === n.id) })).filter(x => x.t);
    const uids = [...new Set(list.map(x => x.t.uid).filter(Boolean))];
    const devs = uids.length ? await redis.cmd('MGET', ...uids.map(K.dev)) : [];
    const devOf = Object.fromEntries(uids.map((u, i) => [u, J(devs[i])]));
    const gone = new Set();
    await Promise.all(list.map(async ({ n, t }) => {
      const msg = L.noticeText(n.kind, t, st.settings, n.extra);
      let ok = false, error = null;
      const dev = t.uid ? devOf[t.uid] : null;
      if (!t.uid) error = 'no-device';
      else if (!dev?.sub) error = 'no-token';
      else {
        try {
          const r = await Promise.race([
            sendWebPush(dev.sub, { ...msg, kind: n.kind, ticketId: t.id }, sec.vapid, { fetchFn, subject: env.VAPID_SUBJECT, urgency: 'high', ttl: 600 }),
            sleep(4000).then(() => ({ ok: false, status: 'timeout' })),
          ]);
          ok = r.ok; if (!ok) error = 'push-' + r.status;
          if (r.gone) gone.add(t.uid);
        } catch (e) { error = 'push-error'; }
      }
      st.day.logs.unshift({ id: rid('l'), at: now, ticketId: t.id, no: t.no, kind: n.kind, ok, error });
      if (!ok) t.flags = { ...(t.flags || {}), pushFail: true };
    }));
    st.day.logs = st.day.logs.slice(0, 300);
    if (gone.size) await redis.pipeline([...gone].map(u => ['SET', K.dev(u), JSON.stringify({ sub: null, verified: false }), 'EX', 180 * 86400]));
  }

  function engine(st, now) {
    const r = L.tick(st.day.tickets, st.settings, st.day, now);
    for (const u of r.updates) Object.assign(st.day.tickets.find(x => x.id === u.id), L.withOpen(u.patch));
    return r.notices;
  }

  // ---------- 고치기: 잠금 → 읽기 → 바꾸기 → 엔진 → 푸시 → 저장 ----------
  async function mutate(now, fn, { dayKey = L.dayKey(now), runEngine = true } = {}) {
    const sec = await secret();
    return withLock(async () => {
      const [sRaw, dRaw] = await redis.pipeline([['GET', K.settings], ['GET', K.day(dayKey)]]);
      const st = { settings: L.withDefaults(J(sRaw)), day: { ...emptyDay(), ...(J(dRaw) || {}) }, dayKey, settingsDirty: false };
      const out = (await fn(st, sec)) || {};
      const notices = [...(out.notices || [])];
      if (runEngine && dayKey === L.dayKey(now)) notices.push(...engine(st, now));
      await deliver(sec, st, notices, now);
      const cmds = [['SET', K.day(dayKey), JSON.stringify(st.day), 'EX', DAY_TTL]];
      if (st.settingsDirty) cmds.push(['SET', K.settings, JSON.stringify(st.settings)]);
      await redis.pipeline(cmds);
      return { st, sec, result: out.result };
    });
  }

  // ---------- 화면에 보낼 모양 ----------
  function publicView(st, sec, now) {
    const { icalUrl, extKeywords, localKeywords, places, ...settings } = st.settings;
    const d = st.day;
    return {
      configured: true, serverNow: now, vapidPublic: sec.vapid.publicKey,
      settings,
      dayDoc: { nextNo: d.nextNo, busy: L.publicBusy(d.busy), allDayCount: d.allDayCount || 0, syncedAt: d.syncedAt, calendarError: d.calendarError },
      tickets: d.tickets.map(t => ({ ...t, uid: tag(sec, t.uid) })),
    };
  }
  function adminView(st) {
    const d = st.day;
    return {
      settings: st.settings,
      priv: Object.fromEntries(Object.entries(d.priv || {}).map(([k, v]) => [k, { name: v.name, topic: v.topic }])),
      dayPrivate: { busy: d.busyTitled || [], allDay: d.allDay || [], syncedAt: d.syncedAt },
      logs: d.logs || [],
    };
  }

  // ---------- 국장님 캘린더(iCal) ----------
  async function readCalendar(settings, day) {
    const url = settings.icalUrl || publicIcalUrl(settings.calendarId);
    try {
      const r = await Promise.race([fetchFn(url, { headers: { 'User-Agent': 'bogo-queue' } }), sleep(8000).then(() => { throw new Error('캘린더 응답이 너무 늦습니다.'); })]);
      if (!r.ok) {
        throw new Error(r.status === 404 || r.status === 403
          ? '캘린더를 읽을 수 없습니다. 캘린더가 "공개"인지 확인하거나, 관리 화면 설정에 "비밀 주소(iCal 형식)"를 넣어 주세요.'
          : `캘린더 읽기 실패(${r.status})`);
      }
      const text = await r.text();
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('iCal 형식이 아닙니다. 주소를 확인해 주세요.');
      return { ok: true, ...eventsForDay(text, day) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  async function syncCalendar(now, force = false) {
    const day = L.dayKey(now);
    if (!force && !(await redis.cmd('SET', K.sync, '1', 'NX', 'EX', 50))) return null; // 다른 요청이 읽는 중
    const s = L.withDefaults(J(await redis.cmd('GET', K.settings)));
    const cal = await readCalendar(s, day);
    return mutate(now, st => {
      const d = st.day;
      d.syncedAt = now;
      if (!cal.ok) { d.calendarError = cal.error; return { result: { ok: false, error: cal.error } }; }
      d.calendarError = null;
      d.busyTitled = cal.busy.map(b => {
        const x = L.extInfo(b, st.settings);
        return { s: b.s, e: b.e, title: b.title, loc: b.loc || '', key: `${b.uid}@${b.s}`, auto: x.ext, autoRet: x.ext ? x.ret : null, place: x.place || '', km: x.km || null };
      });
      d.allDay = cal.allDay; d.allDayCount = cal.allDay.length;
      applyExt(d);
      return { result: { ok: true, events: cal.busy.length } };
    });
  }

  // 대외 일정 표시: 자동 판단 + 관리자가 바꾼 것(extOverride)을 합쳐 공개용 busy를 만듭니다.
  function applyExt(d) {
    const ov = d.extOverride || {};
    d.busyTitled = (d.busyTitled || []).map(b => {
      const ext = b.key in ov ? !!ov[b.key] : !!b.auto;
      return { ...b, ext, ret: ext && b.auto ? b.autoRet : null }; // 수동으로 대외로 바꾼 일정은 기본 복귀 시간
    });
    d.busy = L.publicBusy(d.busyTitled);
  }

  // ---------- 밤 정리: 남은 번호표 마감 + 실명·건명·일정 제목·기록 삭제 ----------
  async function cleanupDay(now, day) {
    return mutate(now, st => {
      const d = st.day;
      for (const t of d.tickets) if (L.OPEN.includes(t.status)) Object.assign(t, { status: 'expired', open: false, doneAt: now });
      d.priv = {}; d.busyTitled = []; d.allDay = []; d.logs = [];
      d.cleanedAt = now;
    }, { dayKey: day, runEngine: false });
  }

  // ---------- 새로 고침: 상태 읽기 + (필요하면) 엔진·캘린더·정리 ----------
  // 앱이 상태를 물어볼 때마다(최대 10초에 한 번, 캐시 덕분에) 이것이 돌아 1분 타이머 역할도 합니다.
  async function refresh(now = clock(), { sync = true } = {}) {
    const today = L.dayKey(now);
    const hmNow = L.hm(now);
    if (hmNow < '06:30') {
      const prev = L.dayKey(now - 86400000);
      const pd = J(await redis.cmd('GET', K.day(prev)));
      if (pd && !pd.cleanedAt) await cleanupDay(now, prev);
    }
    const [sRaw, dRaw, secRaw] = await redis.cmd('MGET', K.settings, K.day(today), K.secret);
    const sec = await secret(secRaw);
    let st = { settings: L.withDefaults(J(sRaw)), day: { ...emptyDay(), ...(J(dRaw) || {}) } };
    const dry = L.tick(st.day.tickets, st.settings, st.day, now);
    if (dry.updates.length || dry.notices.length) st = (await mutate(now, () => {})).st;
    if (sync && hmNow >= '06:30' && (!st.day.syncedAt || now - st.day.syncedAt >= SYNC_EVERY)) {
      const r = await syncCalendar(now);
      if (r) st = r.st;
    }
    return { st, sec };
  }

  async function publicState() {
    if (!redis) return { configured: false };
    const now = clock();
    const { st, sec } = await refresh(now);
    return publicView(st, sec, now);
  }

  // 1분 예약 작업(cron-job.org · Vercel 매일 예약)용
  async function runTick() {
    const now = clock();
    const { st } = await refresh(now);
    return { ok: true, at: L.hm(now), open: st.day.tickets.filter(t => t.open).length };
  }

  // ---------- 앱이 부르는 기능 ----------
  async function handleOp(token, d = {}) {
    const dIn = d;
    if (!redis) throw err('failed-precondition', '저장소(Upstash Redis)가 아직 연결되지 않았습니다. 설치 안내서 2단계를 확인해 주세요.');
    const now = clock();
    const sec = await secret();
    const op = String(d.op || '');
    const who = verify(sec, token);

    try {
      // --- 들어오기: 접수 코드 → 기기 출입증 ---
      if (op === 'join') {
        secretCache = null;
        const fresh = await secret();
        if (String(d.code || '').trim() !== String(fresh.accessCode)) throw err('permission-denied', '접수 코드가 맞지 않습니다.');
        const dev = who?.d || rid('d');
        return { token: sign(sec, { d: dev, r: 'm' }), uid: tag(sec, dev) };
      }
      if (op === 'adminLogin') {
        if (!env.ADMIN_PASSWORD) throw err('failed-precondition', 'Vercel 환경 변수 ADMIN_PASSWORD(관리자 비밀번호)가 아직 없습니다. 설치 안내서 3단계를 확인해 주세요.');
        const fails = Number(await redis.cmd('GET', K.fail) || 0);
        if (fails >= 20) throw err('resource-exhausted', '비밀번호를 여러 번 틀려 잠시 막혔습니다. 1시간 뒤 다시 시도해 주세요.');
        const a = crypto.createHash('sha256').update(String(d.password || '')).digest();
        const b = crypto.createHash('sha256').update(String(env.ADMIN_PASSWORD)).digest();
        if (!crypto.timingSafeEqual(a, b)) {
          await redis.pipeline([['INCR', K.fail], ['EXPIRE', K.fail, 3600]]);
          throw err('permission-denied', '관리자 비밀번호가 맞지 않습니다.');
        }
        const dev = who?.d || rid('d');
        return { token: sign(sec, { d: dev, r: 'a', exp: now + 30 * 86400000 }), uid: tag(sec, dev) };
      }

      if (!who) throw err('unauthenticated', '접수 코드를 입력해 주세요.');
      const uid = who.d, isAdmin = who.r === 'a';
      const withState = async (result, st) => {
        if (!st) st = (await refresh(now, { sync: false })).st;
        return { ...(result || { ok: true }), state: publicView(st, sec, now), ...(isAdmin ? { admin: adminView(st) } : {}) };
      };

      if (op === 'me') {
        const dev = J(await redis.cmd('GET', K.dev(uid))) || {};
        return { member: true, isAdmin, uid: tag(sec, uid), verified: !!dev.verified && !!dev.sub, vapidPublic: sec.vapid.publicKey };
      }
      if (op === 'state' || op === 'adminState' || op === 'tick') {
        const { st } = await refresh(now);
        return withState({ ok: true }, st);
      }

      // --- 푸시 등록 · 테스트 ---
      if (op === 'registerPush') {
        const sub = d.sub;
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw err('invalid-argument', '알림 등록 정보가 올바르지 않습니다.');
        const cur = J(await redis.cmd('GET', K.dev(uid))) || {};
        const clean = { endpoint: sub.endpoint.slice(0, 1000), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } };
        const same = cur.sub && cur.sub.endpoint === clean.endpoint;
        await redis.cmd('SET', K.dev(uid), JSON.stringify({ sub: clean, verified: same ? !!cur.verified : false, nonce: cur.nonce || null }), 'EX', 180 * 86400);
        return { ok: true, verified: same && !!cur.verified };
      }
      if (op === 'testPush') {
        const cur = J(await redis.cmd('GET', K.dev(uid))) || {};
        if (!cur.sub) throw err('failed-precondition', '먼저 알림을 허용해 주세요.');
        const nonce = rid();
        await redis.cmd('SET', K.dev(uid), JSON.stringify({ ...cur, nonce }), 'EX', 180 * 86400);
        const r = await sendWebPush(cur.sub, { ...L.noticeText('test', {}, {}), kind: 'test', nonce }, sec.vapid, { fetchFn, subject: env.VAPID_SUBJECT, ttl: 60 })
          .catch(e => ({ ok: false, status: String(e.message || e) }));
        if (!r.ok) throw err('unavailable', `테스트 알림을 보내지 못했습니다(${r.status}). 잠시 후 다시 시도해 주세요.`);
        return { ok: true };
      }
      if (op === 'confirmPush') {
        const cur = J(await redis.cmd('GET', K.dev(uid))) || {};
        if (!cur.nonce || cur.nonce !== d.nonce) throw err('failed-precondition', '테스트 알림 확인값이 맞지 않습니다. 다시 시도해 주세요.');
        await redis.cmd('SET', K.dev(uid), JSON.stringify({ sub: cur.sub, verified: true, nonce: null }), 'EX', 180 * 86400);
        return { ok: true, verified: true };
      }

      // --- 번호표 ---
      if (op === 'issue') {
        const dev = J(await redis.cmd('GET', K.dev(uid))) || {};
        const ctx = { uid, isAdmin, deviceVerified: !!dev.verified && !!dev.sub };
        const { st, result } = await mutate(now, st => {
          const r = L.actIssue(d, ctx, st.day.tickets, st.settings, st.day, now);
          const id = rid('t');
          const no = st.day.nextNo || 1;
          st.day.nextNo = no + 1;
          st.day.tickets.push({ id, ...r.ticket, no });
          st.day.priv[id] = r.priv;
          return { result: { id, no } };
        });
        return withState(result, st);
      }

      if (['start', 'complete', 'undo', 'cancel', 'move', 'urgent', 'restore'].includes(op)) {
        if (['move', 'urgent', 'restore'].includes(op) && !isAdmin) throw err('permission-denied', '관리자만 할 수 있습니다.');
        const ctx = { uid, isAdmin };
        const { st } = await mutate(now, st => {
          const T = st.day.tickets;
          const t = T.find(x => x.id === d.ticketId);
          if (!t) throw err('not-found', '번호표를 찾을 수 없습니다.');
          const apply = (id, patch) => Object.assign(T.find(x => x.id === id), L.withOpen(patch));
          if (op === 'start') apply(t.id, L.actStart(t, ctx, now));
          if (op === 'complete') {
            const r = L.actComplete(t, ctx, now);
            apply(t.id, r.patch);
            if (r.dur) { st.settings.avgMs = L.nextAvg(st.settings, r.dur); st.settingsDirty = true; }
          }
          if (op === 'undo') { const r = L.actUndo(t, ctx, T, now); for (const u of r.updates) apply(u.id, u.patch); return { notices: r.notices }; }
          if (op === 'cancel') apply(t.id, L.actCancel(t, ctx, now));
          if (op === 'move') for (const u of L.actMove(t, Number(d.dir) === 1 ? 1 : -1, T)) apply(u.id, u.patch);
          if (op === 'urgent') apply(t.id, L.actUrgent(t, T));
          if (op === 'restore') apply(t.id, L.actRestore(t, now));
        });
        return withState({ ok: true }, st);
      }

      // --- 관리자 ---
      if (!isAdmin) throw err('permission-denied', '관리자만 할 수 있습니다.');
      if (op === 'presence') {
        let p;
        const { st } = await mutate(now, st => {
          p = L.presencePatch(d.mode, d.note, st.settings, st.day, now);
          st.settings.presence = p; st.settingsDirty = true;
        });
        return withState({ ok: true, presence: p }, st);
      }
      if (op === 'settings') {
        const o = L.cleanSettings(d.values || {});
        let calChanged = false;
        const { st } = await mutate(now, st => {
          const merged = { ...st.settings, ...o };
          if (merged.workStart >= merged.workEnd) throw err('invalid-argument', '보고 시작 시각이 종료 시각보다 빨라야 합니다.');
          if (merged.remindEveryMin > merged.callLimitMin) throw err('invalid-argument', '재알림 간격은 자동 취소 시간보다 길 수 없습니다.');
          calChanged = ['calendarId', 'icalUrl', 'extKeywords', 'localKeywords', 'places', 'returnMin', 'returnKmPerHour'].some(k => merged[k] !== st.settings[k]);
          st.settings = L.withDefaults(merged); st.settingsDirty = true;
        });
        if (d.accessCode != null && d.accessCode !== '') {
          const c = String(d.accessCode).trim();
          if (!/^[0-9A-Za-z]{4,12}$/.test(c)) throw err('invalid-argument', '접수 코드는 영문·숫자 4~12자로 정해 주세요.');
          await saveSecret({ ...sec, accessCode: c });
        }
        if (calChanged) { const r = await syncCalendar(now, true); return withState({ ok: true, calendar: r.result }, r.st); }
        return withState({ ok: true }, st);
      }
      if (op === 'eventExt') {
        const { st } = await mutate(now, st => {
          const d = st.day;
          const b = (d.busyTitled || []).find(x => x.key === String(dIn.key));
          if (!b) throw err('not-found', '일정을 찾을 수 없습니다. 캘린더를 다시 읽어 주세요.');
          d.extOverride = { ...(d.extOverride || {}) };
          if (dIn.ext == null || !!dIn.ext === !!b.auto) delete d.extOverride[b.key]; else d.extOverride[b.key] = !!dIn.ext;
          applyExt(d);
        });
        return withState({ ok: true }, st);
      }
      if (op === 'getSecret') { secretCache = null; return { accessCode: (await secret()).accessCode }; }
      if (op === 'syncCalendar') {
        const r = await syncCalendar(now, true);
        return withState(r.result, r.st);
      }
      throw err('invalid-argument', '알 수 없는 요청입니다: ' + op);
    } catch (e) {
      if (e instanceof L.RuleError) throw err(e.code, e.message);
      throw e;
    }
  }

  return { handleOp, publicState, runTick, refresh, syncCalendar, cleanupDay, secret };
}
