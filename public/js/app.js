// 신청자 화면: 번호표 받기 · 내 번호표 · 대기 현황
import * as L from './logic.js';
import { $, esc, loadApi, toast, showError, beep, availText, timelineHTML, demoBar, statusLabel, mmss, minsAgo } from './ui.js';

const api = await loadApi();
const S = { pub: null, me: { verified: false }, uid: null, tab: null, apptMode: false, confirmCancel: false };
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

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
  if (!s.requirePush || S.me.verified) { el.innerHTML = ''; return; }
  const iosNeedsInstall = isIOS && !standalone && api.mode !== 'demo';
  const key = 'push' + iosNeedsInstall + api.pushState();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = `<div class="card" style="border-color:var(--accent)">
    <h2>먼저 알림을 켜 주세요</h2>
    ${iosNeedsInstall ? `<p class="sub">아이폰은 <b>홈 화면에 추가한 앱</b>에서만 알림을 받을 수 있습니다.</p>
      <ol class="sub" style="margin:0;padding-left:18px"><li>Safari 아래쪽 <b>공유 버튼(□↑)</b>을 누릅니다.</li><li><b>홈 화면에 추가</b>를 누릅니다.</li><li>홈 화면에 생긴 <b>보고 대기</b> 아이콘으로 다시 열어 이 버튼을 누릅니다.</li></ol>` :
      `<p class="sub">차례가 되면 휴대폰 알림으로 부릅니다. 알림을 켜면 테스트 알림을 한 번 보내 확인합니다. 확인이 끝나야 번호표를 받을 수 있습니다.</p>`}
    ${api.pushState() === 'denied' ? '<div class="banner err">알림이 차단되어 있습니다. 휴대폰 설정 → 알림에서 이 앱(또는 브라우저)의 알림을 허용한 뒤 다시 눌러 주세요.</div>' : ''}
    <button class="btn block" id="push-btn" ${iosNeedsInstall ? 'disabled' : ''}>알림 켜고 테스트하기</button>
    ${!standalone && !isIOS && api.mode !== 'demo' ? '<p class="hint">브라우저 메뉴의 "홈 화면에 추가" 또는 "앱 설치"로 설치해 두면 더 편하게 쓸 수 있습니다.</p>' : ''}
  </div>`;
  const btn = $('#push-btn');
  btn && btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = '테스트 알림을 기다리는 중…';
    try { await api.enablePush(); toast('알림 준비 완료', '이제 번호표를 받을 수 있습니다.'); await refreshMe(); el.dataset.key = ''; }
    catch (e) { showError(e); btn.disabled = false; btn.textContent = '다시 시도하기'; }
  });
}

function renderApplySummary(q, av, at, s) {
  const el = $('#apply-summary');
  const nextTxt = q.nextAt == null ? '<span style="font-size:15px;font-family:var(--font)">오늘 중 어려움</span>' : `${L.hm(q.nextAt)}<span class="u">경</span>`;
  const html = `<div class="stats"><div class="stat"><small>지금 대기</small><b>${q.waiting.length}<span class="u">명</span></b></div><div class="stat"><small>지금 받으면 예상 호출</small><b>${nextTxt}</b></div></div>
    <p class="sub">${at.ok ? '지금은 보고 가능한 시간입니다.' : `${esc(at.text)}${at.sub ? ' · ' + esc(at.sub) : ''}. 번호표는 지금 받아 두실 수 있습니다.`}</p>`;
  setHTML(el, html);
}

function renderApplyParts(q, s, t0) {
  renderPushCard(s);
  const mf = $('#mode-field');
  mf.hidden = !s.appointEnabled;
  if (!s.appointEnabled && S.apptMode) setMode(false);
  if (S.apptMode) {
    const slots = L.appointSlots(S.pub.tickets, s, S.pub.dayDoc, t0);
    const sel = $('#f-appt');
    const key = slots.map(x => x.at + ':' + x.count).join(',');
    if (sel.dataset.key !== key) {
      const cur = sel.value;
      sel.innerHTML = slots.length ? slots.map(x => `<option value="${x.at}">${L.hm(x.at)}${x.count ? ` · 이미 ${x.count}명 지정` : ''}</option>`).join('') : '<option value="">오늘 지정할 수 있는 시각이 없습니다</option>';
      if (cur && slots.some(x => String(x.at) === cur)) sel.value = cur;
      sel.dataset.key = key;
    }
  }
  const mt = myTicket();
  const btn = $('#f-submit');
  const blocked = s.requirePush && !S.me.verified;
  btn.disabled = blocked;
  btn.textContent = mt && L.OPEN.includes(mt.status) ? `이미 ${L.pad(mt.no)}번 번호표가 있습니다` : (blocked ? '알림을 먼저 켜 주세요' : (S.apptMode ? '시간 지정 번호표 받기' : '번호표 받기'));
  if (mt && L.OPEN.includes(mt.status)) btn.disabled = true;
}

function setMode(appt) {
  S.apptMode = appt;
  $('#m-now').setAttribute('aria-pressed', String(!appt));
  $('#m-appt').setAttribute('aria-pressed', String(appt));
  $('#appt-box').hidden = !appt;
  $('#f-appt').dataset.key = '';
  render();
}
$('#m-now').addEventListener('click', () => setMode(false));
$('#m-appt').addEventListener('click', () => setMode(true));

const draft = ls.get('bogo-draft', null);
if (draft) { $('#f-name').value = draft.name || ''; $('#f-dept').value = draft.dept || ''; }

$('#apply-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#f-err'); err.textContent = '';
  const name = $('#f-name').value.trim(), dept = $('#f-dept').value.trim(), topic = $('#f-topic').value.trim();
  const ref = (document.querySelector('input[name=f-ref]:checked') || {}).value;
  if (!name) return (err.textContent = '이름을 입력해 주세요.');
  if (!dept) return (err.textContent = '부서를 입력해 주세요.');
  const appointAt = S.apptMode ? Number($('#f-appt').value) || null : null;
  if (S.apptMode && !appointAt) return (err.textContent = '보고 희망 시각을 골라 주세요.');
  const btn = $('#f-submit'); btn.disabled = true;
  try {
    const r = await api.op('issue', { name, dept, topic, refMin: ref ? Number(ref) : null, appointAt });
    ls.set('bogo-draft', { name, dept });
    $('#f-topic').value = '';
    toast('번호표를 받았습니다', `${L.pad(r.no)}번${appointAt ? ` · ${L.hm(appointAt)} 지정` : ''}`);
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
  if (t.status === 'held') {
    body = `<div class="stats"><div class="stat"><small>지정 시각</small><b>${L.hm(t.appointAt)}</b></div><div class="stat"><small>예상 호출</small><b>${eta ? L.hm(eta) + '<span class="u">경</span>' : '<span style="font-size:14px;font-family:var(--font)">오늘 중 어려움</span>'}</b></div></div>
      <p class="sub" style="text-align:center">지정 시각 10분 전에 알림을 보내 드립니다. 그 시각이 되면 지금 보고 중인 분 바로 다음 차례입니다.</p>`;
  } else if (t.status === 'waiting') {
    const a = q.ahead[t.id];
    body = `<div class="stats"><div class="stat"><small>내 앞</small><b>${a}<span class="u">명</span></b></div><div class="stat"><small>예상 호출</small><b>${eta ? L.hm(eta) + `<span class="u">경 · ${Math.max(0, Math.round((eta - t0) / 60000))}분 후</span>` : '<span style="font-size:14px;font-family:var(--font)">오늘 중 어려움</span>'}</b></div></div>`;
    if (!av.ok) top += `<div class="banner info"><b>${esc(at.text)}</b>${at.sub ? ' · ' + esc(at.sub) : ''}. 예상 시각에 반영되어 있습니다.</div>`;
    if (t.flags?.next) top += `<div class="banner warn"><b>바로 다음 차례입니다.</b> ${esc(s.officeName)} 문 앞에서 기다려 주세요.</div>`;
    else if (t.flags?.soon) top += `<div class="banner warn"><b>곧 차례입니다.</b> ${esc(s.officeName)} 근처로 와 주세요.</div>`;
  } else if (t.status === 'called') {
    const left = t.calledAt + s.startLimitMin * L.MIN - t0;
    top = `<div class="callbox"><b>지금 ${esc(s.officeName)}에 들어가 주세요</b><span>들어가면서 아래 버튼을 눌러 주세요</span><span class="num">${mmss(left)}</span><span style="font-size:12.5px">남은 시간 안에 누르지 않으면 자동 취소되고 다음 분이 호출됩니다</span></div>`;
    body = `<button class="btn xl block hot" data-act="start">보고 시작</button>`;
  } else if (t.status === 'in_progress') {
    const canAt = t.startedAt + L.MIN;
    const ready = t0 >= canAt;
    body = `<div class="stats"><div class="stat"><small>보고 시작</small><b>${L.hm(t.startedAt)}</b></div><div class="stat"><small>경과</small><b>${minsAgo(t.startedAt, t0)}<span class="u">분</span></b></div></div>
      <div class="slide ${ready ? '' : 'off'}"><input type="range" id="slide" min="0" max="100" value="0" ${ready ? '' : 'disabled'} aria-label="밀어서 보고 완료"><span>${ready ? '밀어서 보고 완료 →' : `${mmss(canAt - t0)} 뒤에 완료할 수 있습니다`}</span></div>
      <p class="sub" style="text-align:center">나오면서 밀어 주세요. 다음 분이 바로 호출됩니다.</p>`;
  } else if (t.status === 'done') {
    const canUndo = t0 - t.doneAt <= L.MIN;
    body = `<p class="sub" style="text-align:center">${L.hm(t.doneAt)}에 보고를 마쳤습니다. 수고하셨습니다.</p>
      ${canUndo ? `<button class="btn ghost block" data-act="undo">잘못 눌렀어요, 되돌리기 (${mmss(t.doneAt + L.MIN - t0)})</button>` : ''}
      <button class="btn ghost block" data-go="apply">새 번호표 받기</button>`;
  } else {
    const why = t.status === 'timeout' ? `호출 후 ${s.startLimitMin}분 안에 '보고 시작'이 없어 취소되었습니다. 사정이 있었다면 비서실에 말씀해 주세요. 대기열 맨 뒤로 다시 넣어 드릴 수 있습니다.`
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
  // 슬라이더를 끄는 중에는 다시 그리지 않음
  if (document.activeElement && document.activeElement.id === 'slide') return;
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
    if (act === 'start') { await api.op('start', { ticketId: t.id }); toast('보고 중으로 표시했습니다', '나오면서 "보고 완료"를 밀어 주세요.'); }
    if (act === 'undo') { await api.op('undo', { ticketId: t.id }); toast('보고 중으로 되돌렸습니다'); }
    if (act === 'cancel') { await api.op('cancel', { ticketId: t.id }); S.confirmCancel = false; toast('번호표를 취소했습니다'); }
  } catch (err) { showError(err); }
  finally { b.disabled = false; }
});
let completing = false;
document.addEventListener('input', async e => {
  if (e.target.id !== 'slide' || completing) return;
  const t = myTicket();
  if (Number(e.target.value) >= 92 && t) {
    completing = true;
    e.target.disabled = true;
    try { await api.op('complete', { ticketId: t.id }); toast('보고 완료', '다음 분을 호출했습니다. 수고하셨습니다.'); }
    catch (err) { showError(err); }
    finally { completing = false; e.target.blur(); render(); }
  }
});
document.addEventListener('change', e => { if (e.target.id === 'slide' && !completing) { e.target.value = 0; e.target.blur(); } });

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
      <div class="list">${q.waiting.length ? q.waiting.map(t => `<div class="li ${mt && mt.id === t.id ? 'mine' : ''}"><span class="num no">${L.pad(t.no)}</span><div><div>${esc(t.maskedName)}${mt && mt.id === t.id ? '<span class="tag ok">나</span>' : ''}${t.urgent ? '<span class="tag amber">긴급</span>' : ''}${t.appointAt ? `<span class="tag">${L.hm(t.appointAt)} 지정</span>` : ''}</div><div class="meta">${esc(t.dept)}</div></div><span class="eta">${q.eta[t.id] ? L.hm(q.eta[t.id]) + '경' : '오늘 중 어려움'}</span></div>`).join('') : '<p class="empty">대기 중인 분이 없습니다.</p>'}</div>
    </div>
    ${q.held.length ? `<div class="card"><h3>시간 지정</h3><div class="list">${q.held.map(t => `<div class="li ${mt && mt.id === t.id ? 'mine' : ''}"><span class="num no">${L.pad(t.no)}</span><div><div>${esc(t.maskedName)}</div><div class="meta">${esc(t.dept)}</div></div><span class="eta num">${L.hm(t.appointAt)}</span></div>`).join('')}</div></div>` : ''}
    <p class="sub" style="text-align:center">오늘 보고 완료 ${done}건 · 1인 평균 약 ${Math.round(q.avg / 60000)}분</p>`;
  setHTML(el, html);
}

boot().catch(e => { console.error(e); $('#banner').innerHTML = `<div class="banner err">앱을 시작하지 못했습니다: ${esc(e.message || e)}</div>`; });
