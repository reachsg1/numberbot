// 신청자 화면: 번호표 받기 · 내 번호표 · 대기 현황
import * as L from './logic.js';
import { $, esc, loadApi, toast, showError, beep, availText, timelineHTML, demoBar, statusLabel, mmss, minsAgo, attachOrgPicker, attachOrgBrowser, isAndroid, isAndroidChrome, isStandalone, chromeIntentUrl, modal } from './ui.js';

const api = await loadApi();
const S = { pub: null, me: { verified: false }, uid: null, tab: null, confirmCancel: false };
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = isStandalone();
const mobile = isIOS || isAndroid;
// 휴대폰은 홈 화면에 설치한 앱으로 열어야 번호표를 받을 수 있음(관리 설정에서 끌 수 있음)
const mustInstall = s => api.mode !== 'demo' && mobile && !standalone && s.requireInstall !== false;

demoBar(api, () => { S.uid = api.demo.uid; refreshMe(); render(); });

// ---------- 첫 화면: 보고 대기 / 회의실 예약 고르기 ----------
const QS = new URLSearchParams(location.search);
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
};
function wantLauncher() {
  if (QS.get('code')) return false;                                              // 국장실 앞 QR → 보고 대기로 바로
  if (['apply', 'mine', 'board'].includes(location.hash.slice(1))) return false; // 알림을 눌러 들어온 경우 등
  if (QS.has('home')) return true;                                               // '처음으로'
  return ss.get('jas-mode') !== 'queue';                                         // 보고 대기를 쓰다가 새로고침하면 그대로
}
// 줄안서 접수 코드를 회의실 예약에도 넘겨 줌(같은 코드면 회의실에서 다시 묻지 않음)
function rememberCode(code) { try { if (code && !localStorage.getItem('rpb.access')) localStorage.setItem('rpb.access', String(code).trim()); } catch {} }

function launcher() {
  return new Promise(resolve => {
    const el = $('#launcher');
    el.hidden = false; $('#q-top').hidden = true;
    const d0 = new Date(Date.now() + 9 * 3600000);
    $('#l-date').textContent = `${d0.getUTCMonth() + 1}월 ${d0.getUTCDate()}일 ${'일월화수목금토'[d0.getUTCDay()]}요일`;
    if (QS.has('home')) history.replaceState(null, '', '/');
    let stop = null, done = false, uid = null;
    const enter = tab => {
      if (done) return;
      done = true; if (stop) stop();
      ss.set('jas-mode', 'queue');
      el.hidden = true; $('#q-top').hidden = false;
      if (tab) history.replaceState(null, '', '/#' + tab);
      resolve();
    };
    $('#l-queue').addEventListener('click', () => enter());
    // 알림을 누르면 주소가 #mine 으로 바뀜 → 첫 화면에 있어도 바로 내 번호표로
    addEventListener('hashchange', () => { const h = location.hash.slice(1); if (['apply', 'mine', 'board'].includes(h)) enter(h); });
    $('#l-rooms').addEventListener('click', e => {
      if (api.mode === 'demo' && api.noServer) { e.preventDefault(); toast('미리보기에서는 회의실 예약을 열 수 없습니다', '실제 주소에서 열어 주세요.'); }
      else ss.set('jas-mode', null);
    });
    (async () => { try { const me = await api.op('me'); if (me.member) uid = api.mode === 'demo' ? api.demo.uid : me.uid; } catch {} })();
    stop = api.watch(pub => {
      if (done || !pub || !pub.settings) return;
      const t0 = api.now();
      const q = L.computeQueue(pub.tickets, pub.settings, pub.dayDoc, t0);
      const at = availText(L.availability(pub.settings, pub.dayDoc, t0));
      $('#l-queue-sub').textContent = `지금 대기 ${q.waiting.length}명 · ${at.ok ? '보고 가능' : at.text}`;
      const day = L.dayKey(t0);
      const mt = uid && pub.tickets.find(t => t.day === day && t.uid === uid && L.OPEN.includes(t.status));
      if (mt && ['called', 'in_progress'].includes(mt.status)) return enter('mine'); // 호출됐으면 바로 내 번호표로
      if (mt) $('#l-queue-sub').textContent = `내 번호표 ${L.pad(mt.no)}번 · 내 앞 ${q.ahead[mt.id] ?? '-'}명`;
    }, () => {});
    roomStatus();
  });
}
// 첫 화면 '회의실 예약' 버튼에 지금 사용 중인지 표시
async function roomStatus() {
  if (api.mode === 'demo') return;
  try {
    const d = L.dayKey(Date.now());
    const h = {};
    try { const c = localStorage.getItem('rpb.access'); if (c) h['x-access-code'] = c; } catch {}
    const r = await fetch(`/api/room-bookings?action=list&from=${d}&to=${d}`, { headers: h });
    if (!r.ok) return;
    const j = await r.json();
    const hm = j.now?.time || L.hm(Date.now());
    const today = (j.bookings || []).filter(b => b.date === d).sort((a, b) => (a.start < b.start ? -1 : 1));
    const cur = today.find(b => b.start <= hm && hm < b.end);
    const next = today.find(b => b.start > hm);
    const sub = $('#l-rooms-sub');
    if (cur) { sub.innerHTML = `<em class="busy">사용 중</em> · ${cur.end}까지`; }
    else sub.textContent = next ? `지금 비어 있음 · 다음 예약 ${next.start}` : '오늘 남은 예약 없음 · 바로 예약 가능';
  } catch {}
}

// ---------- 시작 ----------
async function boot() {
  let user = await api.ready();
  if (wantLauncher()) await launcher();
  else ss.set('jas-mode', 'queue');
  if (!user) user = await api.signInAnon();
  S.uid = api.mode === 'demo' ? api.demo.uid : user.uid;
  const code = new URLSearchParams(location.search).get('code');
  let me = await api.op('me').catch(() => ({ member: false }));
  if (!me.member && code) {
    try { await api.op('join', { code }); await api.refreshToken(); me = await api.op('me'); rememberCode(code); } catch (e) { $('#g-err').textContent = e.message; }
    history.replaceState(null, '', location.pathname);
  }
  if (!me.member) { $('#gate').hidden = false; $('#h-state').hidden = true; return; }
  start(me);
}

$('#gate-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#g-err').textContent = '';
  try {
    await api.op('join', { code: $('#g-code').value.trim() });
    await api.refreshToken();
    rememberCode($('#g-code').value.trim());
    const me = await api.op('me');
    $('#gate').hidden = true; $('#h-state').hidden = false;
    start(me);
  } catch (err) { $('#g-err').textContent = err.message; }
});

function start(me) {
  S.me = me;
  if (api.mode !== 'demo') S.uid = me.uid; // 서버가 알려 주는 이 기기의 표식
  $('#nav').hidden = false;
  api.watch(pub => { S.pub = pub; render(); checkInitialTab(); }, e => { $('#banner').innerHTML = `<div class="banner err">${esc(e.message)}</div>`; });
  api.onMessage(m => { toast(m.title, m.body, m.kind === 'call' ? 'call' : ''); beep(m.kind === 'call'); });
  api.resumePush();
  const h = location.hash.slice(1);
  go(['apply', 'mine', 'board'].includes(h) ? h : 'apply');
  addEventListener('hashchange', () => { const x = location.hash.slice(1); if (['apply', 'mine', 'board'].includes(x) && x !== S.tab) go(x); });
  setInterval(() => { if (S.pub) render(); }, 1000);
}
let initialTabDone = false;
function checkInitialTab() {
  if (initialTabDone || !S.pub) return;
  initialTabDone = true;
  if (standalone && S.pub.settings.requirePush && !S.me.verified) openPushModal(false);
  const t = myTicket();
  if (t && L.OPEN.includes(t.status) && !location.hash) go('mine');
}
async function refreshMe() { S.me = await api.op('me').catch(() => S.me); render(); }

// ---------- 공통 ----------
function now() { return api.now(); }
function myTicket() {
  if (!S.pub) return null;
  const mine = S.pub.tickets.filter(t => t.uid && t.uid === S.uid).sort((a, b) => a.createdAt - b.createdAt);
  return mine.filter(t => L.OPEN.includes(t.status)).pop() || mine.pop() || null;
}
function go(tab) {
  S.tab = tab; S.confirmCancel = false;
  document.querySelectorAll('section[data-tab]').forEach(s => (s.hidden = s.dataset.tab !== tab));
  document.querySelectorAll('[data-tab-btn]').forEach(b => b.setAttribute('aria-current', b.dataset.tabBtn === tab ? 'page' : 'false'));
  scrollTo(0, 0);
  render();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tab-btn]'); if (b) go(b.dataset.tabBtn);
  const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
});

// ---------- 렌더 ----------

function render() {
  const P = S.pub; if (!P) return;
  const t0 = now(), s = P.settings;
  const av = L.availability(s, P.dayDoc, t0);
  const at = availText(av);
  $('#h-office').textContent = `${s.officeName} 보고 대기`;
  const d = new Date(t0 + 9 * 3600000);
  $('#h-date').textContent = `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${'일월화수목금토'[d.getUTCDay()]}요일`;
  const hs = $('#h-state'); hs.className = 'pill ' + (at.ok ? 'ok' : 'no'); hs.innerHTML = `<i></i>${esc(at.ok ? '보고 가능' : at.text)}`;
  let b = '';
  if (s.presence?.note && L.presenceMode(s, t0) === 'absent') b += `<div class="banner warn"><b>국장님 부재</b> · ${esc(s.presence.note)} · 번호표 접수는 계속 받습니다.</div>`;
  $('#banner').innerHTML = b;
  const mt = myTicket();
  const badge = $('#nav-badge');
  if (mt && L.OPEN.includes(mt.status)) { badge.hidden = false; badge.textContent = L.pad(mt.no); } else badge.hidden = true;
  document.title = mt && mt.status === 'called' ? '● 입실하세요 — 줄안서' : '줄안서 · 국장실 보고 대기';
  const q = L.computeQueue(P.tickets, s, P.dayDoc, t0);
  // 1초마다 다시 그리되, 입력 중인 폼은 건드리지 않습니다.
  renderApplySummary(q, av, at, s);
  if (S.tab === 'mine') renderMine(mt, q, av, at, s, t0);
  if (S.tab === 'board') renderBoard(q, av, at, s, t0, mt);
  if (S.tab === 'apply') renderApplyParts(q, s, t0);
}

function renderPushCard(s) {
  const el = $('#push-card');
  const showInstall = installEvt && !standalone;
  const must = mustInstall(s);
  if ((!s.requirePush || S.me.verified) && !showInstall && !must) { el.innerHTML = ''; el.dataset.key = ''; return; }
  const needPush = s.requirePush && !S.me.verified;
  if (must) {
    const key = 'must' + !!installEvt + isIOS;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = `<div class="card" style="border-color:var(--accent)">
      <h2>먼저 앱을 설치해 주세요</h2>
      <p class="sub">번호표는 <b>홈 화면에 설치한 「줄안서」 앱</b>에서만 받을 수 있습니다. 앱으로 열어야 차례 알림이 확실하게 옵니다.</p>
      ${isIOS ? `<ol class="sub" style="margin:0;padding-left:18px"><li>Safari 아래쪽 <b>공유 버튼(□↑)</b> 또는 주소창 옆 <b>⋯ → 공유</b>를 누릅니다.</li><li><b>홈 화면에 추가</b>를 누릅니다.</li><li>홈 화면의 <b>줄안서</b> 아이콘으로 다시 열어 알림을 켭니다.</li></ol>`
        : installEvt ? `<button class="btn block" id="install-btn">홈 화면에 앱 설치</button>`
        : `<ol class="sub" style="margin:0;padding-left:18px"><li>크롬 오른쪽 위 메뉴 <b>⋮</b>를 누릅니다.</li><li><b>앱 설치</b>(또는 <b>홈 화면에 추가 → 설치</b>)를 누릅니다.</li><li>홈 화면의 <b>줄안서</b> 아이콘으로 다시 열어 알림을 켭니다.</li></ol>`}
      <p class="hint">이미 설치했다면 이 화면 말고 <b>홈 화면의 줄안서 아이콘</b>으로 열어 주세요. 설치가 계속 '설치 중'에서 멈추면 비서실에 말씀해 주세요(대리 접수 가능).</p>
    </div>`;
    const ib = $('#install-btn');
    ib && ib.addEventListener('click', installApp);
    return;
  }
  const iosNeedsInstall = isIOS && !standalone && api.mode !== 'demo';
  const key = 'push' + iosNeedsInstall + api.pushState() + !!showInstall + needPush;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = `<div class="card" style="border-color:var(--accent)">
    <h2>${showInstall ? '앱 설치하고 알림 켜기' : '먼저 알림을 켜 주세요'}</h2>
    ${showInstall ? `<p class="sub">홈 화면에 앱을 설치하면 알림을 더 안정적으로 받을 수 있습니다. 설치가 끝나면 알림 설정 화면으로 바로 안내합니다.</p>
      <button class="btn block" id="install-btn">홈 화면에 앱 설치</button>` : ''}
    ${!needPush ? '' : iosNeedsInstall ? `<p class="sub">아이폰은 <b>홈 화면에 추가한 앱</b>에서만 알림을 받을 수 있습니다.</p>
      <ol class="sub" style="margin:0;padding-left:18px"><li>Safari 아래쪽 <b>공유 버튼(□↑)</b> 또는 주소창 옆 <b>⋯ → 공유</b>를 누릅니다.</li><li><b>홈 화면에 추가</b>를 누릅니다.</li><li>홈 화면에 생긴 <b>줄안서</b> 아이콘으로 다시 열어 알림을 켭니다.</li></ol>` :
      `<p class="sub">차례가 되면 휴대폰 알림으로 부릅니다. 알림을 켜면 테스트 알림을 한 번 보내 확인합니다. 확인이 끝나야 번호표를 받을 수 있습니다.</p>`}
    ${needPush && api.pushState() === 'denied' ? deniedHelp() : ''}
    ${needPush ? `<button class="btn ${showInstall ? 'ghost' : ''} block" id="push-btn" ${iosNeedsInstall ? 'disabled' : ''}>${showInstall ? '설치 없이 알림만 켜기' : '알림 켜고 테스트하기'}</button>` : ''}
  </div>`;
  const ib = $('#install-btn');
  ib && ib.addEventListener('click', installApp);
  const btn = $('#push-btn');
  btn && btn.addEventListener('click', () => enablePushFlow(btn));
}

// ---------- 앱 설치 · 알림 켜기 ----------
let installEvt = null, pushModal = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.pub) render(); });
addEventListener('appinstalled', () => {
  installEvt = null;
  if (S.pub) render();
  // 설치가 끝나면: 앱으로 열어야 하는 경우엔 아이콘으로 다시 열도록, 아니면 곧바로 알림 설정 안내
  if (S.pub && mustInstall(S.pub.settings)) toast('설치가 끝났습니다', '홈 화면의 "줄안서" 아이콘으로 다시 열어 알림을 켜 주세요.');
  else if (!S.me.verified) openPushModal(true);
  else toast('앱을 설치했습니다', '홈 화면의 "줄안서" 아이콘으로 열어 쓰세요.');
});
async function installApp() {
  if (!installEvt) return;
  installEvt.prompt();
  const r = await installEvt.userChoice.catch(() => null);
  if (r && r.outcome !== 'accepted') toast('설치를 취소했습니다', '나중에 브라우저 메뉴 ⋮ → "앱 설치"로도 설치할 수 있습니다.');
}
function deniedHelp() {
  if (isIOS) return `<div class="banner err"><b>알림이 꺼져 있습니다.</b></div><ol><li>아이폰 <b>설정</b> 앱 → <b>알림</b>을 엽니다.</li><li>목록에서 <b>줄안서</b>를 누르고 <b>알림 허용</b>을 켭니다.</li><li>이 앱으로 돌아와 아래 버튼을 누릅니다.</li></ol>`;
  return `<div class="banner err"><b>알림이 차단되어 있습니다.</b> 아래 순서로 허용한 뒤 돌아와 주세요.</div>
    <ol><li>홈 화면의 <b>줄안서</b> 아이콘을 <b>길게</b> 누릅니다.</li><li><b>앱 정보(ⓘ)</b> → <b>알림</b>을 누릅니다.</li><li><b>알림 허용</b>(모든 알림)을 켭니다.</li></ol>
    <p class="hint">크롬 화면에서 쓰는 경우: 주소창 왼쪽 <b>설정 아이콘(⊶)</b> → <b>권한</b> → <b>알림</b> → 허용</p>`;
}
async function enablePushFlow(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '테스트 알림을 기다리는 중…';
  try {
    await api.enablePush();
    toast('알림 준비 완료', '이제 번호표를 받을 수 있습니다.');
    await refreshMe(); $('#push-card').dataset.key = '';
    return true;
  } catch (e) {
    if (e.code !== 'denied') showError(e);
    btn.disabled = false; btn.textContent = e.code === 'denied' ? '설정을 바꿨어요, 다시 확인' : label;
    $('#push-card').dataset.key = ''; render();
    if (e.code === 'denied' && pushModal) { pushModal.close(); openPushModal(false); }
    return false;
  }
}
function openPushModal(justInstalled) {
  if (pushModal || api.mode === 'demo' || S.me.verified || api.pushState() === 'unsupported') return;
  const denied = api.pushState() === 'denied';
  pushModal = modal(`<h2>${justInstalled ? '설치 완료! 이제 알림을 켜 주세요' : '알림 설정'}</h2>
    <p class="sub">차례가 되면 휴대폰 알림으로 부릅니다. 아래 버튼을 누르고, 알림 허용 창이 뜨면 <b>허용</b>을 눌러 주세요. 확인용 테스트 알림이 한 번 옵니다.</p>
    ${denied ? deniedHelp() : ''}
    <button class="btn block" id="pm-go">${denied ? '설정을 바꿨어요, 다시 확인' : '알림 켜고 테스트하기'}</button>
    ${justInstalled ? '<p class="hint">다음부터는 홈 화면의 <b>줄안서</b> 아이콘으로 여세요.</p>' : ''}
    <button class="btn ghost block" data-close>나중에</button>`, { onClose: () => { pushModal = null; } });
  $('#pm-go').addEventListener('click', async ev => { if (await enablePushFlow(ev.currentTarget)) pushModal && pushModal.close(); });
}
// 안드로이드에서 크롬이 아닌 브라우저(카카오톡·네이버 앱 안, 삼성 인터넷 등)로 열면 크롬으로 열도록 안내
function chromeNotice() {
  if (!isAndroid || isAndroidChrome || isStandalone()) return;
  try { if (sessionStorage.getItem('bogo-chrome-skip')) return; } catch {}
  const m = modal(`<h2>크롬(Chrome)으로 열어 주세요</h2>
    <p class="sub">지금 브라우저에서는 <b>앱 설치와 알림</b>이 제대로 되지 않을 수 있습니다. 아래 버튼을 누르면 같은 화면이 크롬으로 열립니다.</p>
    <a class="btn block" id="chrome-go" href="${esc(chromeIntentUrl())}">크롬으로 열기</a>
    <p class="hint">버튼이 안 되면 오른쪽 위(또는 아래) 메뉴 ⋮ → <b>다른 브라우저로 열기</b> → <b>Chrome</b>을 고르세요.</p>
    <button class="btn ghost block" data-close>이 브라우저로 계속</button>`, { onClose: () => { try { sessionStorage.setItem('bogo-chrome-skip', '1'); } catch {} } });
  return m;
}
chromeNotice();

function renderApplySummary(q, av, at, s) {
  const el = $('#apply-summary');
  const nextTxt = q.nextAt == null ? '오늘 중 어려움' : `${L.hm(q.nextAt)}경`;
  const html = `<div class="sum"><div><small>지금 대기</small><b>${q.waiting.length}명</b></div><div><small>지금 받으면</small><b>${nextTxt}</b></div></div>
    <p class="sub">${at.ok ? '지금은 보고 가능한 시간입니다.' : `${esc(at.text)}${at.sub ? ' · ' + esc(at.sub) : ''}. 번호표는 지금 받아 두실 수 있습니다.`}</p>`;
  setHTML(el, html);
}

function renderApplyParts(q, s, t0) {
  renderPushCard(s);
  const mt = myTicket();
  const btn = $('#f-submit');
  const needApp = mustInstall(s);
  const blocked = needApp || (s.requirePush && !S.me.verified);
  btn.disabled = blocked;
  btn.textContent = mt && L.OPEN.includes(mt.status) ? `이미 ${L.pad(mt.no)}번 번호표가 있습니다` : needApp ? '설치한 앱에서만 받을 수 있어요' : (blocked ? '알림을 먼저 켜 주세요' : '번호표 받기');
  if (mt && L.OPEN.includes(mt.status)) btn.disabled = true;
  // 국장님 긴급 호출 카드(보고 중이 아닐 때)
  const ec = $('#emerg-card');
  const showE = !(mt && mt.status === 'in_progress');
  const ekey = showE ? 'e' + (mt && L.OPEN.includes(mt.status) ? mt.id : '') : '';
  if (ec.dataset.key !== ekey) {
    ec.dataset.key = ekey;
    ec.innerHTML = showE ? `<div class="emg-line"><span>국장님이 직접 부르셨나요?</span><button type="button" class="emg-btn" data-emerg="1">긴급 호출</button></div>
      <p class="emg-help">국장님 긴급 호출을 받은 경우에만 누르세요. 순서와 관계없이 바로 '보고 중'이 되고, 대기 중인 분들의 호출은 잠시 멈춥니다.${mt && L.OPEN.includes(mt.status) ? ` 지금 가진 ${L.pad(mt.no)}번 번호표로 들어갑니다.` : ' 위의 이름·부서를 먼저 입력해 주세요.'}</p>` : '';
  }
}

// 예상 시간: 버튼으로 고르기(다시 누르면 해제), 직접 입력도 가능
$('#f-ref-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-ref]'); if (!b) return;
  const on = !b.classList.contains('on');
  document.querySelectorAll('#f-ref-chips button').forEach(x => x.classList.remove('on'));
  if (on) b.classList.add('on');
  $('#f-ref').value = on ? b.dataset.ref : '';
});
$('#f-ref').addEventListener('input', () => document.querySelectorAll('#f-ref-chips button').forEach(x => x.classList.toggle('on', x.dataset.ref === $('#f-ref').value)));
attachOrgPicker($('#f-dept'));
attachOrgBrowser($('#f-dept-browse'), $('#f-dept-panel'), $('#f-dept'));
const draft = ls.get('bogo-draft', null);
if (draft) { $('#f-name').value = draft.name || ''; $('#f-dept').value = draft.dept || ''; }

$('#apply-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#f-err'); err.textContent = '';
  const name = $('#f-name').value.trim(), dept = $('#f-dept').value.trim(), topic = $('#f-topic').value.trim();
  const refRaw = $('#f-ref').value.trim();
  const ref = refRaw === '' ? null : Number(refRaw);
  if (ref != null && !(ref >= 1 && ref <= 180)) return (err.textContent = '예상 소요 시간은 1~180분 사이 숫자로 입력해 주세요.');
  if (!name) return (err.textContent = '이름을 입력해 주세요.');
  if (!dept) return (err.textContent = '부서를 입력해 주세요.');
  const btn = $('#f-submit'); btn.disabled = true;
  try {
    const r = await api.op('issue', { name, dept, topic, refMin: ref, mobile, app: standalone });
    ls.set('bogo-draft', { name, dept });
    $('#f-topic').value = ''; $('#f-ref').value = ''; document.querySelectorAll('#f-ref-chips button').forEach(x => x.classList.remove('on'));
    toast('번호표를 받았습니다', `${L.pad(r.no)}번 · 선착순`);
    go('mine');
  } catch (e2) { err.textContent = e2.message; }
  finally { btn.disabled = false; render(); }
});

// ---------- 내 번호표 ----------
function renderMine(t, q, av, at, s, t0) {
  const el = $('#mine');
  if (!t) { setHTML(el, `<div class="card empty-card"><b>오늘 받은 번호표가 없어요</b><p class="sub">번호표를 받으면 여기에서 내 순서를 볼 수 있어요.</p><button class="btn block" data-go="apply">번호표 받기</button></div>`); return; }
  const no = L.pad(t.no), office = esc(s.officeName);
  const prog = q.active.find(x => x.status === 'in_progress' && x.id !== t.id);
  const kv = rows => `<div class="card kv">${rows.map(([k, v, c]) => `<div class="kvr"><span>${k}</span><b class="${c || ''}">${v}</b></div>`).join('')}</div>`;
  const who = `${esc(t.maskedName)} · ${esc(t.dept)}`;
  const emg = `<div class="emg-line"><span>국장님이 직접 부르셨나요?</span><button type="button" class="emg-btn" data-emerg="1">긴급 호출</button></div>`;
  let html = '';
  if (t.status === 'waiting' || t.status === 'held') {
    const a = q.ahead[t.id] ?? 0, eta = q.eta[t.id];
    const cur = t.flags?.next ? 2 : t.flags?.soon ? 1 : 0;
    const steps = ['번호표 받음', '곧 차례', '문 앞 대기', '입실'].map((n, i) =>
      `<div class="st ${i === 0 || i < cur ? 'done' : i === cur ? 'now' : ''}"><span class="sd">${i === 0 || i < cur ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : ''}</span><small>${n}</small></div>`).join('');
    const guide = t.flags?.next ? `${office} 문 앞에서 기다려 주세요. 앞 분이 나오면 바로 불러 드려요.`
      : t.flags?.soon ? `${office} 근처로 와 주세요. 곧 불러 드려요.` : '자리에서 일하시다가 알림이 오면 이동하세요.';
    html = `<div class="hero"><p class="cap">내 번호표 · ${who}</p><div class="bignum">${no}</div>
        <p class="lead">${a > 0 ? `내 앞에 <b>${a}명</b> 남았어요` : '곧 들어가실 차례예요'}</p><p class="guide">${guide}</p></div>
      <div class="steps" style="--prog:${[0, 33, 66, 100][cur]}%">${steps}</div>
      ${!av.ok ? `<div class="banner info"><b>${esc(at.text)}</b>${at.sub ? ' · ' + esc(at.sub) : ''}. 예상 시각에 반영되어 있어요.</div>` : ''}
      ${kv([['예상 호출', eta ? `${L.hm(eta)}경 · ${Math.max(0, Math.round((eta - t0) / 60000))}분 후` : '오늘 중 어려움'],
            ['지금 보고 중', prog ? `${L.pad(prog.no)}번 · ${L.hm(prog.startedAt)} 시작` : '없음'],
            ['국장님', at.ok ? '보고 가능' : esc(at.text), at.ok ? 'okc' : 'warnc']])}
      ${S.confirmCancel ? `<div class="confirm"><span>번호표를 취소할까요?</span><button class="btn danger" data-act="cancel">취소하기</button><button class="btn ghost" data-act="keep">유지</button></div>`
        : `<button class="btn ghost block" data-act="askCancel">번호표 취소</button>`}
      ${emg}`;
  } else if (t.status === 'called' && t.blockedAt) {
    html = `<div class="callhero calm"><span class="pill2">입실 대기 중</span><h1>국장실이 비면<br>들어가 주세요</h1><p>다른 분이 먼저 들어가 계신 것으로 표시했어요. 자동 취소되지 않고 순서도 그대로예요.</p>
        <div class="timer"><span>대기 시작</span><b>${L.hm(t.blockedAt)}</b></div></div>
      <div class="card slip2"><span>내 번호표</span><b>${no}</b><small>${who}</small></div>
      <button class="btn xl block" data-act="start">보고 시작</button>${emg}`;
  } else if (t.status === 'called') {
    const left = t.calledAt + s.callLimitMin * L.MIN - t0;
    html = `<div class="callhero"><span class="pill2">호출됨</span><h1>지금 ${office}에<br>들어가 주세요</h1><p>들어가면서 <b>보고 시작</b>을 눌러 주세요</p>
        <div class="timer"><span>남은 시간</span><b>${mmss(left)}</b></div></div>
      <div class="card slip2"><span>내 번호표</span><b>${no}</b><small>${who}</small></div>
      <button class="btn xl block" data-act="start">보고 시작</button>
      <button class="btn ghost block two-line" data-act="cantStart"><b>보고 시작 불가(잠시 대기)</b><small>다른 분 보고 중</small></button>
      <p class="sub center">${s.remindEveryMin}분마다 다시 알려 드리고, 남은 시간 안에 누르지 않으면 다음 분을 불러요.</p>${emg}`;
  } else if (t.status === 'in_progress') {
    const exp = L.expectedMs(t, s), over = t0 - t.startedAt >= exp;
    html = `<div class="hero"><p class="cap">${t.emergency ? '긴급 호출 · ' : ''}보고 중 · ${who}</p><div class="bignum">${no}</div>
        <p class="lead">보고가 끝나면 <b>보고 완료</b>를 눌러 주세요</p><p class="guide">나오면서 누르면 다음 분을 바로 불러요. 잘못 눌렀으면 1분 안에 되돌릴 수 있어요.</p></div>
      ${over ? `<div class="banner warn"><b>예상 시간이 지났어요.</b> 끝나셨으면 '보고 완료'를 눌러 주세요. 누를 때까지 ${s.overdueEveryMin}분마다 알림이 가요.</div>` : ''}
      ${kv([['보고 시작', L.hm(t.startedAt)], ['경과 / 예상', `${minsAgo(t.startedAt, t0)}분 / ${Math.round(exp / 60000)}분`]])}
      <button class="btn xl block" data-act="complete">보고 완료</button>`;
  } else if (t.status === 'done') {
    const open = !t.flags?.final && t0 - t.doneAt <= L.MIN;
    html = `<div class="hero"><p class="cap">내 번호표 · ${who}</p><div class="bignum done">${no}</div>
        <p class="lead">${open ? '보고 완료를 눌렀어요' : '보고가 종료되었어요'}</p><p class="guide">${t.startedAt ? `${L.hm(t.startedAt)}~` : ''}${L.hm(t.doneAt)} · 수고하셨습니다.</p></div>
      ${open ? `<button class="btn xl block" data-act="finalize">보고 종료</button>
        <button class="btn ghost block" data-act="undo">잘못 눌렀어요, 되돌리기 (${mmss(t.doneAt + L.MIN - t0)})</button>`
        : `<p class="sub center">다른 보고가 있으면 아래 '번호표 받기'에서 새로 받으세요.</p>`}`;
  } else {
    const why = t.status === 'timeout' ? `호출 후 ${s.callLimitMin}분 안에 '보고 시작'이 없어 취소되었어요. 사정이 있었다면 비서실에 말씀해 주세요. 대기열 맨 뒤로 다시 넣어 드릴 수 있어요.`
      : t.status === 'expired' ? '오늘 보고 시간이 끝나 마감되었어요. 내일 다시 받아 주세요.' : '번호표를 취소했어요.';
    html = `<div class="hero"><p class="cap">내 번호표 · ${who}</p><div class="bignum off">${no}</div><p class="guide">${why}</p></div>
      <button class="btn block" data-go="apply">새 번호표 받기</button>`;
  }
  setHTML(el, html);
}
function setHTML(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const t = myTicket(); if (!t) return;
  const act = b.dataset.act;
  if (act === 'askCancel') { S.confirmCancel = true; render(); return; }
  if (act === 'keep') { S.confirmCancel = false; render(); return; }
  b.disabled = true;
  try {
    if (act === 'start') { await api.op('start', { ticketId: t.id }); toast('보고 중으로 표시했습니다', '다음 분에게 문 앞 대기 알림을 보냈습니다. 나오면서 "보고 완료"를 눌러 주세요.'); }
    if (act === 'complete') { await api.op('complete', { ticketId: t.id }); toast('보고 완료', '다음 분을 호출했습니다. 수고하셨습니다.'); }
    if (act === 'undo') { await api.op('undo', { ticketId: t.id }); toast('보고 중으로 되돌렸습니다'); }
    if (act === 'cancel') { await api.op('cancel', { ticketId: t.id }); S.confirmCancel = false; toast('번호표를 취소했습니다'); }
    if (act === 'cantStart') { await api.op('cantStart', { ticketId: t.id }); toast('입실 대기로 표시했습니다', '자동 취소되지 않습니다. 들어가실 때 "보고 시작"을 눌러 주세요.'); }
    if (act === 'finalize') { await api.op('finalize', { ticketId: t.id }); toast('보고 종료', '수고하셨습니다.'); }
  } catch (err) { showError(err); }
  finally { b.disabled = false; }
});
// ---------- 국장님 긴급 호출 ----------
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-emerg]'); if (!b) return;
  if (!b.dataset.armed) {
    b.dataset.armed = '1'; const t = b.textContent; b.textContent = '한 번 더 누르면 바로 보고 중'; b.classList.add('armed');
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = t; b.classList.remove('armed'); } }, 5000);
    return;
  }
  const mt = myTicket();
  const data = mt && L.OPEN.includes(mt.status) ? { ticketId: mt.id } : { name: $('#f-name').value.trim(), dept: $('#f-dept').value.trim(), topic: $('#f-topic').value.trim() };
  if (!data.ticketId && (!data.name || !data.dept)) { delete b.dataset.armed; $('#f-err').textContent = '긴급 호출도 이름과 부서는 입력해 주세요.'; $('#f-name').focus(); return; }
  b.disabled = true;
  try {
    await api.op('emergency', data);
    if (data.name) ls.set('bogo-draft', { name: data.name, dept: data.dept });
    toast('긴급 호출 · 보고 중으로 표시했습니다', '대기 중인 분들의 호출을 잠시 멈췄습니다. 나오면서 "보고 완료"를 눌러 주세요.', 'call');
    go('mine');
  } catch (err) { showError(err); b.disabled = false; delete b.dataset.armed; }
});

// ---------- 현황판 ----------
function renderBoard(q, av, at, s, t0, mt) {
  const el = $('#board');
  const done = S.pub.tickets.filter(t => t.status === 'done').length;
  const html = `
    <div class="card"><h3>오늘 ${esc(s.officeName)} 일정</h3>
      <div class="avail ${at.ok ? '' : 'no'}"><span class="dot"></span><span>${esc(at.text)}${at.sub ? `<small>${esc(at.sub)}</small>` : ''}</span></div>
      ${timelineHTML(s, S.pub.dayDoc, t0, null)}</div>
    <div class="card"><h3>지금</h3>
      ${q.active.length ? q.active.map(t => `<div class="row"><span class="num" style="font-size:34px;font-weight:600;color:${t.status === 'called' ? 'var(--red)' : 'var(--accent)'}">${L.pad(t.no)}</span><div><b>${t.status === 'called' ? (t.blockedAt ? '입실 대기(보고 시작 불가)' : '호출됨 · 입실 대기') : '보고 중'}</b>${t.emergency ? '<span class="tag red">긴급 호출</span>' : ''}<div class="sub">${esc(t.dept)} · ${t.status === 'called' ? L.hm(t.calledAt) + ' 호출' : L.hm(t.startedAt) + ' 시작'}</div></div></div>`).join('') : '<p class="sub">지금 보고 중인 분이 없습니다.</p>'}
    </div>
    <div class="card"><div class="row between"><h3>대기 순서</h3><span class="sub">${q.waiting.length}명</span></div>
      <div class="list">${q.waiting.length ? q.waiting.map(t => `<div class="li ${mt && mt.id === t.id ? 'mine' : ''}"><span class="num no">${L.pad(t.no)}</span><div><div>${esc(t.maskedName)}${mt && mt.id === t.id ? '<span class="tag ok">나</span>' : ''}${t.urgent ? '<span class="tag amber">긴급</span>' : ''}</div><div class="meta">${esc(t.dept)}</div></div><span class="eta">${q.eta[t.id] ? L.hm(q.eta[t.id]) + '경' : '오늘 중 어려움'}</span></div>`).join('') : '<p class="empty">대기 중인 분이 없습니다.</p>'}</div>
    </div>
    <p class="sub" style="text-align:center">오늘 보고 완료 ${done}건 · 1인 평균 약 ${Math.round(q.avg / 60000)}분</p>`;
  setHTML(el, html);
}

boot().catch(e => { console.error(e); $('#banner').innerHTML = `<div class="banner err">앱을 시작하지 못했습니다: ${esc(e.message || e)}</div>`; });
