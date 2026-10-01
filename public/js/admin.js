// 관리 화면(비서실): 국장님 부재 설정 · 순서 조정 · 앱 상태 관리
import * as L from './logic.js';
import { $, esc, loadApi, toast, showError, availText, timelineHTML, demoBar, statusLabel, mmss, minsAgo, attachOrgPicker } from './ui.js';

const api = await loadApi();
const S = { pub: null, adm: { priv: {}, dayPrivate: {}, logs: [] }, code: '', settingsFilled: false, noteDraft: null };
demoBar(api, () => render());

const op = (name, data = {}) => api.op(name, api.mode === 'demo' ? { ...data, __admin: true } : data);

async function boot() {
  await api.ready();
  if (api.mode === 'server' && !api.hasAdmin()) return showLogin();
  const me = await op('me').catch(e => ({ isAdmin: false, error: e }));
  if (!me.isAdmin) { await api.signOut().catch(() => {}); return showLogin(me.error?.code === 'network' ? me.error.message : '로그인이 만료되었습니다. 다시 로그인해 주세요.'); }
  $('#login').hidden = true; $('#main').hidden = false; $('#logout').hidden = api.mode === 'demo';
  api.watch(p => { S.pub = p; render(); fillSettings(); }, e => banner(e.message));
  // 관리 화면이 켜져 있는 동안 15초마다 실명·기록을 받아 오며, 이때 서버가 호출·알림 판단도 함께 합니다.
  api.watchAdmin(a => { banner(''); S.adm = a; render(); fillSettings(); }, e => banner(e.message));
  loadSecret();
  setInterval(render, 1000);
}
function showLogin(msg) { $('#login').hidden = false; $('#main').hidden = true; $('#login-err').textContent = msg || ''; $('#h-state').hidden = true; $('#logout').hidden = true; }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-err').textContent = '';
  const btn = $('#login-btn'); btn.disabled = true;
  try { await api.op('adminLogin', { password: $('#login-pw').value }); location.reload(); }
  catch (err) { $('#login-err').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('#logout').addEventListener('click', async () => { await api.signOut(); location.reload(); });
function banner(m) { $('#banner').innerHTML = m ? `<div class="banner err">${esc(m)}</div>` : ''; }
async function loadSecret() { try { S.code = (await op('getSecret')).accessCode; $('#s-accessCode').value = S.code; render(); } catch {} }

function setHTML(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }
const name = t => esc(S.adm.priv[t.id]?.name || t.maskedName);
const topic = t => S.adm.priv[t.id]?.topic || '';

function render() {
  const P = S.pub; if (!P) return;
  const t0 = api.now(), s = P.settings;
  const av = L.availability(s, P.dayDoc, t0), at = availText(av);
  const q = L.computeQueue(P.tickets, s, P.dayDoc, t0);
  $('#h-office').textContent = `${s.officeName} 보고 대기 · 관리`;
  const hs = $('#h-state'); hs.hidden = false; hs.className = 'pill ' + (at.ok ? 'ok' : 'no'); hs.innerHTML = `<i></i>${esc(at.ok ? '보고 가능' : at.text)}`;

  // 국장님 상태
  const pm = L.presenceMode(s, t0);
  const p = s.presence || {};
  const noteVal = S.noteDraft ?? p.note ?? '';
  if (document.activeElement?.id !== 'pr-note') setHTML($('#presence'), `<div class="row between"><h2>국장님 상태</h2><span class="sub">${pm === 'present' && p.until ? `재실 · ${L.hm(p.until)}까지 일정 무시` : pm === 'absent' ? '부재 · 자동 호출 멈춤' : '캘린더대로 자동'}</span></div>
    <div class="seg" role="group" aria-label="국장님 상태">
      <button type="button" data-presence="auto" aria-pressed="${pm === 'auto'}">자동 (캘린더대로)</button>
      <button type="button" data-presence="absent" aria-pressed="${pm === 'absent'}">부재</button>
      <button type="button" data-presence="present" aria-pressed="${pm === 'present'}">재실</button>
    </div>
    <div class="field"><label for="pr-note">부재 안내 문구 (모두에게 표시)</label><input type="text" id="pr-note" maxlength="60" placeholder="예: 11시 30분까지 외부 회의" value="${esc(noteVal)}"></div>
    <p class="hint">부재: 호출을 멈춥니다(번호표 접수는 계속). 재실: 회의가 일찍 끝났거나 <b>대외 일정에서 예상보다 일찍 복귀</b>하셨을 때 누르면, 지금 걸린 일정·복귀 시간을 무시하고 바로 보고 가능으로 바뀝니다.</p>`);

  // 요약
  const done = P.tickets.filter(t => t.status === 'done');
  setHTML($('#summary'), `<div class="stat"><small>대기</small><b>${q.waiting.length}</b></div><div class="stat"><small>호출·보고 중</small><b>${q.active.length}</b></div><div class="stat"><small>오늘 완료</small><b>${done.length}</b></div><div class="stat"><small>평균 보고</small><b>${Math.round(q.avg / 60000)}<span class="u">분</span></b></div>`);

  // 지금
  const nowHTML = q.active.length ? q.active.map(t => {
    const called = t.status === 'called';
    const exp = L.expectedMs(t, s);
    const overdue = !called && t0 - t.startedAt >= exp;
    const left = called ? t.calledAt + s.callLimitMin * L.MIN - t0 : 0;
    return `<div class="card nowcard ${called ? '' : 'prog'}">
      <div class="row between"><h3 style="color:${called ? 'var(--red)' : 'var(--accent)'}">${called ? `호출됨 · ${L.hm(t.calledAt)} · 자동 취소까지 ${mmss(left)}` : `보고 중 · ${L.hm(t.startedAt)} 시작 · ${minsAgo(t.startedAt, t0)}분 경과`}</h3>${t.proxy ? '<span class="tag">대리 접수</span>' : ''}${t.flags?.pushFail ? '<span class="tag red">알림 실패</span>' : ''}</div>
      <div class="row"><span class="num" style="font-size:30px;font-weight:600">${L.pad(t.no)}</span><b>${name(t)}</b><span class="sub">${esc(t.dept)}${t.refMin ? ` · 예상 ${t.refMin}분` : ''}</span></div>
      ${topic(t) ? `<p>${esc(topic(t))}</p>` : ''}
      ${overdue ? `<div class="banner err"><b>예상 시간(${Math.round(exp / 60000)}분) 초과</b> · 본인에게 ${s.overdueEveryMin}분마다 '보고 완료' 확인 알림을 보내는 중입니다${t.flags?.overdueN ? `(${t.flags.overdueN}회)` : ''}. 보고가 끝났다면 대신 완료해 주세요.</div>` : ''}
      <div class="actions">${called ? `<button class="btn ghost sm" data-op="start" data-id="${t.id}">대신 보고 시작</button><button class="btn ghost sm" data-op="cancel" data-id="${t.id}" data-confirm="1">호출 취소</button>` : `<button class="btn ${overdue || t.proxy ? '' : 'ghost'} sm" data-op="complete" data-id="${t.id}" data-confirm="1">대신 보고 완료</button>`}</div>
    </div>`;
  }).join('') : `<div class="card"><h3>지금</h3><p class="sub">${at.ok ? (q.waiting.length ? '곧 서버가 다음 분을 호출합니다.' : '대기 중인 분이 없습니다.') : `${esc(at.text)} · ${esc(at.sub || '')} — 호출을 멈춘 상태입니다.`}</p></div>`;
  setHTML($('#now'), nowHTML);

  // 대기 순서
  setHTML($('#queue'), `<div class="row between"><h2>대기 순서</h2><span class="sub">앞 ${s.soonAhead}명 이내 + ${s.soonMin}분 안이면 '곧 차례' 자동 알림</span></div>
    <div>${q.waiting.length ? q.waiting.map((t, i) => `<div class="arow"><div class="l1"><span class="num">${L.pad(t.no)}</span><b>${name(t)}</b><span class="sub">${esc(t.dept)}</span>${t.urgent ? '<span class="tag amber">긴급</span>' : ''}${t.proxy ? '<span class="tag">대리</span>' : ''}${t.flags?.next ? '<span class="tag ok">문 앞 대기 알림</span>' : t.flags?.soon ? '<span class="tag ok">곧 차례 알림</span>' : ''}${t.flags?.pushFail ? '<span class="tag red">알림 실패</span>' : ''}</div>
      ${topic(t) ? `<div>${esc(topic(t))}</div>` : ''}
      <div class="l2"><span>${L.hm(t.createdAt)} 접수</span>${t.refMin ? `<span>예상 ${t.refMin}분</span>` : ''}<span>${q.eta[t.id] ? L.hm(q.eta[t.id]) + '경 호출 예상' : '오늘 중 어려움'}</span></div>
      <div class="actions"><button class="btn ghost sm" data-op="move" data-dir="-1" data-id="${t.id}" ${i === 0 ? 'disabled' : ''} aria-label="한 칸 위로">▲</button><button class="btn ghost sm" data-op="move" data-dir="1" data-id="${t.id}" ${i === q.waiting.length - 1 ? 'disabled' : ''} aria-label="한 칸 아래로">▼</button>${i > 0 ? `<button class="btn ghost sm" data-op="urgent" data-id="${t.id}">긴급 · 맨 앞</button>` : ''}<button class="btn ghost sm" data-op="cancel" data-id="${t.id}" data-confirm="1">취소</button></div></div>`).join('') : '<p class="empty">대기 중인 분이 없습니다.</p>'}</div>`);

  // 끝난 번호표
  const closed = P.tickets.filter(t => ['done', 'timeout', 'cancelled', 'expired'].includes(t.status)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const openDetails = $('#closed details')?.open;
  setHTML($('#closed'), `<details ${openDetails ? 'open' : ''}><summary>끝난 번호표 ${closed.length}건 (완료 ${done.length} · 시간 초과 ${closed.filter(t => t.status === 'timeout').length} · 취소 ${closed.filter(t => t.status === 'cancelled').length})</summary>
    <div>${closed.map(t => { const [c, lb] = statusLabel(t, s, t0); return `<div class="arow"><div class="l1"><span class="num">${L.pad(t.no)}</span><b>${name(t)}</b><span class="sub">${esc(t.dept)}</span><span class="state ${c}" style="align-self:auto;font-size:11.5px;padding:1px 8px">${lb}</span></div>
      <div class="l2">${t.startedAt && t.doneAt && t.status === 'done' ? `<span>${L.hm(t.startedAt)}~${L.hm(t.doneAt)} (${Math.round((t.doneAt - t.startedAt) / 60000)}분)</span>` : ''}${t.doneAt ? `<span>${L.hm(t.doneAt)}</span>` : ''}</div>
      ${t.status !== 'done' ? `<div class="actions"><button class="btn ghost sm" data-op="restore" data-id="${t.id}">대기열 맨 뒤로 복귀</button></div>` : ''}</div>`; }).join('') || '<p class="empty">아직 없습니다.</p>'}</div></details>`);

  // 일정
  const dp = S.adm.dayPrivate || {};
  const dd = P.dayDoc || {};
  setHTML($('#sched'), `<div class="row between"><h2>오늘 국장님 일정</h2><button class="btn ghost sm" data-op="syncCalendar">지금 다시 읽기</button></div>
    <div class="avail ${at.ok ? '' : 'no'}"><span class="dot"></span><span>${esc(at.ok ? '지금 보고 가능' : at.text)}${at.sub ? `<small>${esc(at.sub)}</small>` : ''}</span></div>
    ${timelineHTML(s, dd, t0, dp.busy || null, { admin: true })}
    ${(dp.allDay || []).length ? `<p class="sub">종일 일정(시간 미정 · 호출을 막지 않음): ${dp.allDay.map(esc).join(' / ')}</p>` : ''}
    <p class="hint">${dd.calendarError ? `<span class="tag red">연동 문제</span> ${esc(dd.calendarError)}` : dd.syncedAt ? `${S.adm.settings?.icalUrl ? '비밀 주소(iCal)' : esc(s.calendarId) + ' 공개 주소'} · ${L.hm(dd.syncedAt)} 확인 · 5분마다 자동` : '아직 캘린더를 읽지 않았습니다.'} · 일정이 끝나고 ${s.resumeBufferMin}분 뒤부터 호출합니다.</p>`);

  // 접수 안내 QR
  const link = location.origin + '/?code=' + encodeURIComponent(S.code || '');
  const qrKey = link;
  const entry = $('#entry');
  if (entry.dataset.key !== qrKey) {
    entry.dataset.key = qrKey;
    entry.innerHTML = `<h2>접수 안내 QR</h2><p class="sub">국장실 앞에 붙여 두세요. 휴대폰 카메라로 찍으면 접수 코드가 자동으로 입력됩니다.</p>
      <div class="qr"><div id="qr-img"></div><div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px"><div class="linkbox" id="qr-link">${esc(link)}</div><div class="actions"><button class="btn ghost sm" id="copy-link">링크 복사</button></div><p class="hint">접수 코드: <b class="num">${esc(S.code || '-')}</b> · 관리 화면 주소: ${esc(location.origin)}/admin.html</p></div></div>`;
    const draw = () => { if (!self.qrcode) return setTimeout(draw, 300); const qr = self.qrcode(0, 'M'); qr.addData(link); qr.make(); $('#qr-img').innerHTML = qr.createImgTag(5, 8); };
    draw();
    $('#copy-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); toast('링크를 복사했습니다'); } catch { toast('복사하지 못했습니다', '링크를 길게 눌러 직접 복사해 주세요.'); } });
  }

  // 알림 기록
  const logs = (S.adm.logs || []).slice(0, 40);
  const KIND = { call: '입실 요청', next: '바로 다음 차례', soon: '곧 차례', remind: '재알림', timeout: '시간 초과 취소', overdue: '완료 확인', expired: '마감', uncall: '호출 취소', test: '테스트' };
  setHTML($('#logs'), `<h2>오늘 알림 기록</h2><div>${logs.map(l => `<div class="logi"><span><span class="num">${L.hm(l.at)}</span> · ${L.pad(l.no)}번 · ${KIND[l.kind] || l.kind}</span>${l.ok ? '<span class="tag ok">전달</span>' : `<span class="tag red" title="${esc(l.error || '')}">${l.error === 'no-device' ? '대리 접수' : '실패'}</span>`}</div>`).join('') || '<p class="sub">아직 보낸 알림이 없습니다.</p>'}</div>`);
}

function fillSettings() {
  if (S.settingsFilled || !S.pub) return;
  if (api.mode === 'server' && !S.adm.settings) return; // 관리자용 설정(비밀 주소 포함)을 받은 뒤 채움
  const s = { ...S.pub.settings, ...(S.adm.settings || {}) };
  $('#s-icalUrl').value = s.icalUrl || '';
  for (const k of ['officeName', 'calendarId', 'workStart', 'workEnd', 'callLimitMin', 'remindEveryMin', 'overdueEveryMin', 'soonAhead', 'soonMin', 'resumeBufferMin', 'returnMin', 'returnKmPerHour', 'defaultMin']) $('#s-' + k).value = s[k];
  for (const k of ['extKeywords', 'localKeywords', 'places']) $('#s-' + k).value = String(s[k] || '').split(',').map(x => x.trim()).join(', ');
  for (const k of ['lunch', 'requirePush']) $('#s-' + k).checked = !!s[k];
  S.settingsFilled = true;
}

// ---------- 동작 ----------
document.addEventListener('input', e => { if (e.target.id === 'pr-note') S.noteDraft = e.target.value; });
document.addEventListener('click', async e => {
  const pr = e.target.closest('[data-presence]');
  if (pr) {
    try {
      const r = await op('presence', { mode: pr.dataset.presence, note: $('#pr-note')?.value || '' });
      S.noteDraft = null;
      if (pr.dataset.presence === 'present' && r.presence?.mode === 'auto') toast('지금 걸린 일정이 없어 자동 상태로 둡니다');
      else toast('국장님 상태를 바꿨습니다', pr.dataset.presence === 'absent' ? '자동 호출을 멈췄습니다.' : pr.dataset.presence === 'present' ? '호출을 바로 재개합니다.' : '캘린더대로 호출합니다.');
    } catch (err) { showError(err); }
    return;
  }
  const xb = e.target.closest('[data-ext-key]');
  if (xb) {
    xb.disabled = true;
    try { await op('eventExt', { key: xb.dataset.extKey, ext: xb.dataset.extTo === '1' }); toast(xb.dataset.extTo === '1' ? '대외 일정으로 바꿨습니다' : '내부 일정으로 바꿨습니다', xb.dataset.extTo === '1' ? '끝난 뒤 복귀 시간 동안 호출하지 않습니다.' : ''); }
    catch (err) { showError(err); xb.disabled = false; }
    return;
  }
  const b = e.target.closest('[data-op]');
  if (b) {
    if (b.dataset.confirm && !b.dataset.armed) { b.dataset.armed = '1'; const t = b.textContent; b.textContent = '한 번 더 누르면 ' + t; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = t; b.classList.remove('danger'); } }, 4000); return; }
    b.disabled = true;
    try {
      const r = await op(b.dataset.op, { ticketId: b.dataset.id, dir: Number(b.dataset.dir) || undefined });
      if (b.dataset.op === 'syncCalendar') r && r.ok === false ? showError({ message: r.error }) : toast('캘린더를 다시 읽었습니다');
    } catch (err) { showError(err); }
    finally { b.disabled = false; }
    return;
  }
});
$('#set-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#s-err').textContent = '';
  const values = {};
  for (const k of ['officeName', 'calendarId', 'workStart', 'workEnd', 'icalUrl']) values[k] = $('#s-' + k).value.trim();
  for (const k of ['callLimitMin', 'remindEveryMin', 'overdueEveryMin', 'soonAhead', 'soonMin', 'resumeBufferMin', 'returnMin', 'returnKmPerHour', 'defaultMin']) values[k] = Number($('#s-' + k).value);
  for (const k of ['extKeywords', 'localKeywords', 'places']) values[k] = $('#s-' + k).value;
  for (const k of ['lunch', 'requirePush']) values[k] = $('#s-' + k).checked;
  const code = $('#s-accessCode').value.trim();
  try {
    const r = await op('settings', { values, accessCode: code && code !== S.code ? code : undefined });
    if (code) S.code = code;
    toast('설정을 저장했습니다', r?.calendar && !r.calendar.ok ? '단, 캘린더를 읽지 못했습니다: ' + r.calendar.error : '');
  } catch (err) { $('#s-err').textContent = err.message; }
});
$('#proxy-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#p-err').textContent = '';
  try {
    const r = await op('issue', { proxy: true, name: $('#p-name').value, dept: $('#p-dept').value, topic: $('#p-topic').value });
    toast('대리 접수했습니다', `${L.pad(r.no)}번`);
    e.target.reset();
  } catch (err) { $('#p-err').textContent = err.message; }
});

attachOrgPicker($('#p-dept'));

boot().catch(e => { console.error(e); banner('관리 화면을 시작하지 못했습니다: ' + (e.message || e)); });
