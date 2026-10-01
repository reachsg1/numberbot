// 신청자 화면: 번호표 받기 · 내 번호표 · 대기 현황
import * as L from './logic.js';
import { $, esc, loadApi, toast, showError, beep, availText, timelineHTML, demoBar, statusLabel, mmss, minsAgo, attachOrgPicker, attachOrgBrowser, isAndroid, isAndroidChrome, isStandalone, chromeIntentUrl, modal } from './ui.js';

const api = await loadApi();
const S = { pub: null, me: { verified: false }, uid: null, tab: null, confirmCancel: false };
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = isStandalone();

demoBar(api, () => { S.uid = api.demo.uid; refreshMe(); render(); });

// ---------- 시작 ----------
async function boot() {
  let user = await api.ready();
  if (!user) user = await api.signInAnon();
  S.uid = api.mode === 'demo' ? api.demo.uid : user.uid;
  const code = new URLSearchParams(location.search).get('code');
  let me = await api.op('me').catch(() => ({ member: false }));
  if (!me.member && code) {
    try { await api.op('join', { code }); await api.refreshToken(); me = await api.op('me'); } catch (e) { $('#g-err').textContent = e.message; }
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
  document.title = mt && mt.status === 'called' ? '● 입실하세요 — 보고 대기' : '보고 대기 번호표';
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
  if ((!s.requirePush || S.me.verified) && !showInstall) { el.innerHTML = ''; el.dataset.key = ''; return; }
  const needPush = s.requirePush && !S.me.verified;
  const iosNeedsInstall = isIOS && !standalone && api.mode !== 'demo';
  const key = 'push' + iosNeedsInstall + api.pushState() + !!showInstall + needPush;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = `<div class="card" style="border-color:var(--accent)">
    <h2>${showInstall ? '앱 설치하고 알림 켜기' : '먼저 알림을 켜 주세요'}</h2>
    ${showInstall ? `<p class="sub">홈 화면에 앱을 설치하면 알림을 더 안정적으로 받을 수 있습니다. 설치가 끝나면 알림 설정 화면으로 바로 안내합니다.</p>
      <button class="btn block" id="install-btn">홈 화면에 앱 설치</button>` : ''}
    ${!needPush ? '' : iosNeedsInstall ? `<p class="sub">아이폰은 <b>홈 화면에 추가한 앱</b>에서만 알림을 받을 수 있습니다.</p>
      <ol class="sub" style="margin:0;padding-left:18px"><li>Safari 아래쪽 <b>공유 버튼(□↑)</b> 또는 주소창 옆 <b>⋯ → 공유</b>를 누릅니다.</li><li><b>홈 화면에 추가</b>를 누릅니다.</li><li>홈 화면에 생긴 <b>보고 대기</b> 아이콘으로 다시 열어 알림을 켭니다.</li></ol>` :
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
  // 설치가 끝나면 곧바로 알림 설정 화면으로 안내 (앱과 브라우저는 알림 권한을 함께 씁니다)
  if (!S.me.verified) openPushModal(true);
  else toast('앱을 설치했습니다', '홈 화면의 "보고 대기" 아이콘으로 열어 쓰세요.');
});
async function installApp() {
  if (!installEvt) return;
  installEvt.prompt();
  const r = await installEvt.userChoice.catch(() => null);
  if (r && r.outcome !== 'accepted') toast('설치를 취소했습니다', '나중에 브라우저 메뉴 ⋮ → "앱 설치"로도 설치할 수 있습니다.');
}
function deniedHelp() {
  if (isIOS) return `<div class="banner err"><b>알림이 꺼져 있습니다.</b></div><ol><li>아이폰 <b>설정</b> 앱 → <b>알림</b>을 엽니다.</li><li>목록에서 <b>보고 대기</b>를 누르고 <b>알림 허용</b>을 켭니다.</li><li>이 앱으로 돌아와 아래 버튼을 누릅니다.</li></ol>`;
  return `<div class="banner err"><b>알림이 차단되어 있습니다.</b> 아래 순서로 허용한 뒤 돌아와 주세요.</div>
    <ol><li>홈 화면의 <b>보고 대기</b> 아이콘을 <b>길게</b> 누릅니다.</li><li><b>앱 정보(ⓘ)</b> → <b>알림</b>을 누릅니다.</li><li><b>알림 허용</b>(모든 알림)을 켭니다.</li></ol>
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
    ${justInstalled ? '<p class="hint">다음부터는 홈 화면의 <b>보고 대기</b> 아이콘으로 여세요.</p>' : ''}
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
  const nextTxt = q.nextAt == null ? '<span style="font-size:15px;font-family:var(--font)">오늘 중 어려움</span>' : `${L.hm(q.nextAt)}<span class="u">경</span>`;
  const html = `<div class="stats"><div class="stat"><small>지금 대기</small><b>${q.waiting.length}<span class="u">명</span></b></div><div class="stat"><small>지금 받으면 예상 호출</small><b>${nextTxt}</b></div></div>
    <p class="sub">${at.ok ? '지금은 보고 가능한 시간입니다.' : `${esc(at.text)}${at.sub ? ' · ' + esc(at.sub) : ''}. 번호표는 지금 받아 두실 수 있습니다.`}</p>`;
  setHTML(el, html);
}

function renderApplyParts(q, s, t0) {
  renderPushCard(s);
  const mt = myTicket();
  const btn = $('#f-submit');
  const blocked = s.requirePush && !S.me.verified;
  btn.disabled = blocked;
  btn.textContent = mt && L.OPEN.includes(mt.status) ? `이미 ${L.pad(mt.no)}번 번호표가 있습니다` : (blocked ? '알림을 먼저 켜 주세요' : '번호표 받기');
  if (mt && L.OPEN.includes(mt.status)) btn.disabled = true;
}

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
    const r = await api.op('issue', { name, dept, topic, refMin: ref });
    ls.set('bogo-draft', { name, dept });
    $('#f-topic').value = ''; $('#f-ref').value = '';
    toast('번호표를 받았습니다', `${L.pad(r.no)}번 · 선착순`);
    go('mine');
  } catch (e2) { err.textContent = e2.message; }
  finally { btn.disabled = false; render(); }
});

// ---------- 내 번호표 ----------
function renderMine(t, q, av, at, s, t0) {
  const el = $('#mine');
  if (!t) { setHTML(el, `<div class="card empty"><p style="margin-bottom:12px">오늘 받은 번호표가 없습니다.</p><button class="btn" data-go="apply">번호표 받기</button></div>`); return; }
  const [cls, label] = statusLabel(t, s, t0);
  const eta = q.eta[t.id];
  let body = '', top = '';
  if (t.status === 'waiting' || t.status === 'held') {
    const a = q.ahead[t.id];
    body = `<div class="stats"><div class="stat"><small>내 앞</small><b>${a}<span class="u">명</span></b></div><div class="stat"><small>예상 호출</small><b>${eta ? L.hm(eta) + `<span class="u">경 · ${Math.max(0, Math.round((eta - t0) / 60000))}분 후</span>` : '<span style="font-size:14px;font-family:var(--font)">오늘 중 어려움</span>'}</b></div></div>`;
    if (!av.ok) top += `<div class="banner info"><b>${esc(at.text)}</b>${at.sub ? ' · ' + esc(at.sub) : ''}. 예상 시각에 반영되어 있습니다.</div>`;
    if (t.flags?.next) top += `<div class="banner warn"><b>바로 다음 차례입니다.</b> ${esc(s.officeName)} 문 앞에서 기다려 주세요.</div>`;
    else if (t.flags?.soon) top += `<div class="banner warn"><b>곧 차례입니다.</b> ${esc(s.officeName)} 근처로 와 주세요.</div>`;
  } else if (t.status === 'called') {
    const left = t.calledAt + s.callLimitMin * L.MIN - t0;
    top = `<div class="callbox"><b>지금 ${esc(s.officeName)}에 들어가 주세요</b><span>들어가면서 아래 버튼을 눌러 주세요</span><span class="num">${mmss(left)}</span><span style="font-size:12.5px">${s.remindEveryMin}분마다 다시 알려 드리고, 남은 시간 안에 누르지 않으면 자동 취소되고 다음 분이 호출됩니다</span></div>`;
    body = `<button class="btn xl block hot" data-act="start">보고 시작</button>`;
  } else if (t.status === 'in_progress') {
    const exp = L.expectedMs(t, s), over = t0 - t.startedAt >= exp;
    body = `<div class="stats"><div class="stat"><small>보고 시작</small><b>${L.hm(t.startedAt)}</b></div><div class="stat"><small>경과 / 예상</small><b>${minsAgo(t.startedAt, t0)}<span class="u">분 / ${Math.round(exp / 60000)}분</span></b></div></div>
      ${over ? `<div class="banner warn"><b>예상 시간이 지났습니다.</b> 보고가 끝나셨으면 '보고 완료'를 눌러 주세요. 누를 때까지 ${s.overdueEveryMin}분마다 알림이 갑니다.</div>` : ''}
      <button class="btn xl block" data-act="complete">보고 완료</button>
      <p class="sub" style="text-align:center">나오면서 눌러 주세요. 다음 분이 바로 호출됩니다. 잘못 눌렀으면 1분 안에 되돌릴 수 있습니다.</p>`;
  } else if (t.status === 'done') {
    const canUndo = t0 - t.doneAt <= L.MIN;
    body = `<p class="sub" style="text-align:center">${L.hm(t.doneAt)}에 보고를 마쳤습니다. 수고하셨습니다.</p>
      ${canUndo ? `<button class="btn ghost block" data-act="undo">잘못 눌렀어요, 되돌리기 (${mmss(t.doneAt + L.MIN - t0)})</button>` : ''}
      <button class="btn ghost block" data-go="apply">새 번호표 받기</button>`;
  } else {
    const why = t.status === 'timeout' ? `호출 후 ${s.callLimitMin}분 안에 '보고 시작'이 없어 취소되었습니다. 사정이 있었다면 비서실에 말씀해 주세요. 대기열 맨 뒤로 다시 넣어 드릴 수 있습니다.`
      : t.status === 'expired' ? '오늘 보고 시간이 끝나 마감되었습니다. 내일 다시 받아 주세요.' : '번호표를 취소했습니다.';
    body = `<p class="sub" style="text-align:center">${why}</p><button class="btn ghost block" data-go="apply">새 번호표 받기</button>`;
  }
  const cancelBox = ['held', 'waiting'].includes(t.status)
    ? (S.confirmCancel ? `<div class="actions" style="justify-content:center"><span class="sub" style="align-self:center">정말 취소할까요?</span><button class="btn danger sm" data-act="cancel">취소하기</button><button class="btn ghost sm" data-act="keep">유지</button></div>`
      : `<div class="actions" style="justify-content:center"><button class="btn ghost sm" data-act="askCancel">번호표 취소</button></div>`) : '';
  const html = `${top}
    <div class="slip">
      <div class="slip-top"><span class="kicker">보고 대기 번호표</span><span class="big">${L.pad(t.no)}</span><span class="sub">${esc(t.maskedName)} · ${esc(t.dept)} · ${L.hm(t.createdAt)} 발급${t.refMin ? ` · 예상 ${t.refMin}분` : ''}</span></div>
      <div class="perf"></div>
      <div class="slip-bot"><span class="state ${cls}">${esc(label)}</span>${body}</div>
    </div>${cancelBox}`;
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
  } catch (err) { showError(err); }
  finally { b.disabled = false; }
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
      ${q.active.length ? q.active.map(t => `<div class="row"><span class="num" style="font-size:34px;font-weight:600;color:${t.status === 'called' ? 'var(--red)' : 'var(--accent)'}">${L.pad(t.no)}</span><div><b>${t.status === 'called' ? '호출됨 · 입실 대기' : '보고 중'}</b><div class="sub">${esc(t.dept)} · ${t.status === 'called' ? L.hm(t.calledAt) + ' 호출' : L.hm(t.startedAt) + ' 시작'}</div></div></div>`).join('') : '<p class="sub">지금 보고 중인 분이 없습니다.</p>'}
    </div>
    <div class="card"><div class="row between"><h3>대기 순서</h3><span class="sub">${q.waiting.length}명</span></div>
      <div class="list">${q.waiting.length ? q.waiting.map(t => `<div class="li ${mt && mt.id === t.id ? 'mine' : ''}"><span class="num no">${L.pad(t.no)}</span><div><div>${esc(t.maskedName)}${mt && mt.id === t.id ? '<span class="tag ok">나</span>' : ''}${t.urgent ? '<span class="tag amber">긴급</span>' : ''}</div><div class="meta">${esc(t.dept)}</div></div><span class="eta">${q.eta[t.id] ? L.hm(q.eta[t.id]) + '경' : '오늘 중 어려움'}</span></div>`).join('') : '<p class="empty">대기 중인 분이 없습니다.</p>'}</div>
    </div>
    <p class="sub" style="text-align:center">오늘 보고 완료 ${done}건 · 1인 평균 약 ${Math.round(q.avg / 60000)}분</p>`;
  setHTML(el, html);
}

boot().catch(e => { console.error(e); $('#banner').innerHTML = `<div class="banner err">앱을 시작하지 못했습니다: ${esc(e.message || e)}</div>`; });
