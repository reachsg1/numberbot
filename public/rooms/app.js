'use strict';
/* 연구정책국 회의실 예약 — 프런트엔드 (프레임워크 없이 동작) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const fmtDate = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 (${WD[dow(d)]})`;
const fmtDur = (m) => [m >= 60 ? Math.floor(m / 60) + '시간' : '', m % 60 ? (m % 60) + '분' : ''].filter(Boolean).join(' ');
const kst = () => { const i = new Date(Date.now() + 9 * 3600e3).toISOString(); return { date: i.slice(0, 10), time: i.slice(11, 16), min: toMin(i.slice(11, 16)) }; };
const store = {
  get: (k, s = localStorage) => { try { return s.getItem(k); } catch { return null; } },
  set: (k, v, s = localStorage) => { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

const PALETTE = ['#6d3fa0', '#0e6b4e', '#1f5fa8', '#a8650f', '#1d8584', '#c0306a', '#5f6f2a', '#3d5a80', '#7a4e2e'];
const S = {
  cfg: null, month: '', date: '', data: [], todayData: [], sel: null, anchor: null, dragging: false,
  admin: null, access: '', logOffset: 0, picked: new Set(), adminRows: [], mineName: '',
};

function deptColor(dept) {
  if (!dept) return '#6b7a74';
  const i = S.cfg.depts.indexOf(dept);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const c of dept) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[6 + (h % 3)];
}
const tint = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const colorOf = (b) => (b.kind === 'block' ? '#8a9590' : deptColor(b.dept));

/* ---------- 서버 호출 ---------- */
async function api(fn, action, { method = 'GET', body, q = {}, admin = false, raw = false } = {}) {
  const qs = new URLSearchParams({ action, ...q });
  const headers = { 'content-type': 'application/json' };
  if (S.access) headers['x-access-code'] = S.access;
  if (admin && S.admin) headers.authorization = 'Bearer ' + S.admin.token;
  let r;
  try {
    r = await fetch(`/api/room-${fn}?${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.'), { status: 0 });
  }
  if (raw && r.ok) return r.blob();
  const data = await r.json().catch(() => ({ error: '응답을 읽지 못했습니다.' }));
  if (!r.ok) {
    if (data.needAccess) { store.set('rpb.access', null); askAccess(true); }
    if (data.needLogin && admin) adminLogout(true);
    throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), data, { status: r.status });
  }
  return data;
}

/* ---------- 알림·모달 ---------- */
let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), type === 'error' ? 5000 : 3200);
}
let modalOnClose = null;
function openModal(title, html, onClose, { celebrate = false, wide = false } = {}) {
  $('.modal').classList.toggle('celebrate', celebrate);
  $('.modal').classList.toggle('wide', wide);
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  modalOnClose = onClose || null;
  const f = $('#modalBody input:not([type=hidden]):not([type=radio]), #modalBody button');
  if (f) setTimeout(() => f.focus(), 30);
  return $('#modalBody');
}
function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  const cb = modalOnClose;
  modalOnClose = null;
  if (cb) cb();
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden && !$('#modal').dataset.locked) closeModal(); });

/* ---------- 접속 코드 ---------- */
function askAccess(retry) {
  $('#modal').dataset.locked = '1';
  const body = openModal('접속 코드 입력', `
    <p class="muted">연구정책국 직원에게 공유된 접속 코드를 입력해 주세요. 이 기기에 저장되어 다음부터는 묻지 않습니다.</p>
    ${retry ? '<p class="err">접속 코드가 바뀌었거나 맞지 않습니다.</p>' : ''}
    <form class="stack" id="accessForm"><label>접속 코드<input name="code" type="password" required autocomplete="off" /></label>
    <p class="err" id="accessErr" hidden></p><button class="primary">확인</button></form>`);
  $('.modal-x').hidden = true;
  body.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    S.access = e.target.code.value.trim();
    try {
      await api('bookings', 'list', { q: { from: kst().date, to: kst().date } });
      store.set('rpb.access', S.access);
      location.reload();
    } catch (err) {
      $('#accessErr').textContent = err.message;
      $('#accessErr').hidden = false;
    }
  });
}

/* ---------- 공통 렌더 도우미 ---------- */
function timeOptions(from, to, step, sel) {
  let h = '';
  for (let m = toMin(from); m <= toMin(to); m += step) { const t = fromMin(m); h += `<option${t === sel ? ' selected' : ''}>${t}</option>`; }
  return h;
}
function deptOptions(sel) {
  const list = S.cfg.depts;
  const other = sel && !list.includes(sel);
  return '<option value="">선택 안 함</option>' + list.map((d) => `<option${d === sel ? ' selected' : ''}>${esc(d)}</option>`).join('') +
    `<option value="__other"${other ? ' selected' : ''}>기타(직접 입력)</option>`;
}
function repeatOptions(max) {
  let h = '<option value="1">반복 안 함</option>';
  for (let w = 2; w <= max; w++) h += `<option value="${w}">매주, ${w}주 동안</option>`;
  return h;
}
const fixedHolidays = ['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25'];
const isHoliday = (d) => fixedHolidays.includes(d.slice(5)) || S.cfg.holidays.includes(d);
const isEditable = (b) => S.admin || (b.kind === 'meeting' && `${b.date} ${b.start}` > `${kst().date} ${kst().time}`);

function downloadIcs(list) {
  const utc = (d, t) => {
    const ms = Date.parse(`${d}T${t === '24:00' ? '00:00' : t}:00+09:00`) + (t === '24:00' ? 864e5 : 0);
    return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  };
  const e = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RPB//Meeting Room//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const b of list) {
    L.push('BEGIN:VEVENT', `UID:rpb-room-${b.id}@${location.host}`, `DTSTAMP:${stamp}`, `DTSTART:${utc(b.date, b.start)}`, `DTEND:${utc(b.date, b.end)}`,
      `SUMMARY:${e(b.title)}`, `LOCATION:${e(S.cfg.roomName + (S.cfg.roomLocation ? ' ' + S.cfg.roomLocation : ''))}`,
      `DESCRIPTION:${e(`신청자: ${b.applicant}${b.dept ? ' (' + b.dept + ')' : ''}${b.note ? '\n' + b.note : ''}`)}`, 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([L.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  a.download = `회의실예약_${list[0].date}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- 지금 상태 ---------- */
function nowState(list) {
  const n = kst();
  const today = list.filter((b) => b.date === n.date).sort((a, b) => a.start.localeCompare(b.start));
  const cur = today.find((b) => toMin(b.start) <= n.min && n.min < toMin(b.end));
  const next = today.find((b) => toMin(b.start) > n.min);
  return { today, cur, next, n };
}
function renderNow() {
  const { cur, next } = nowState(S.todayData);
  const el = $('#nowStatus');
  el.classList.toggle('busy', !!cur);
  el.innerHTML = cur
    ? `<i class="dot"></i><strong>사용 중</strong><span>${esc(cur.title)}, ${cur.end}까지</span>`
    : `<i class="dot"></i><strong>비어 있음</strong><span>${next ? `다음 회의 ${next.start} ${esc(next.title)}` : '오늘 남은 회의 없음'}</span>`;
}

/* ================= 예약 화면 ================= */
// 그 달을 담는 데 필요한 주(週)만 달력에 표시(4~6주)
function monthGrid(month) {
  const first = month + '-01';
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((dow(first) + days) / 7) * 7;
  const start = addDays(first, -dow(first));
  return { start, end: addDays(start, cells - 1), cells };
}
const slotM = () => S.cfg.slotMinutes;
const openM = () => toMin(S.cfg.openTime);
const closeM = () => toMin(S.cfg.closeTime);

async function loadMonth() {
  const { start, end } = monthGrid(S.month);
  const today = kst().date;
  const [grid, todayRes] = await Promise.all([
    api('bookings', 'list', { q: { from: start, to: end } }),
    today >= start && today <= end ? null : api('bookings', 'list', { q: { from: today, to: today } }),
  ]);
  S.data = grid.bookings;
  S.todayData = todayRes ? todayRes.bookings : S.data.filter((b) => b.date === today);
  if (S.sel && !rangeFree(S.sel.start, S.sel.end)) {
    S.sel = null;
    toast('고르신 시간에 방금 다른 예약이 들어왔습니다. 다른 시간을 골라 주세요.', 'error');
  }
  renderCalendar();
  renderDay();
  renderNow();
}

function renderCalendar() {
  const { start, cells } = monthGrid(S.month);
  const today = kst().date;
  $('#monthLabel').textContent = `${S.month.slice(0, 4)}년 ${Number(S.month.slice(5))}월`;
  const hours = [];
  for (let m = openM(); m < closeM(); m += 60) hours.push(m);
  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = addDays(start, i);
    const list = S.data.filter((b) => b.date === d);
    const meetings = list.filter((b) => b.kind === 'meeting').length;
    const blocked = list.some((b) => b.kind === 'block');
    const strip = hours.map((h) => `<i${list.some((b) => toMin(b.start) < h + 60 && toMin(b.end) > h) ? ' class="on"' : ''}></i>`).join('');
    const cls = ['day', d.slice(0, 7) !== S.month && 'other', d < today && 'past', d === today && 'today', d === S.date && 'selected',
      dow(d) === 0 && 'sun', dow(d) === 6 && 'sat', isHoliday(d) && 'hol'].filter(Boolean).join(' ');
    const label = `${fmtDate(d)}${meetings ? `, 예약 ${meetings}건` : ''}`;
    html += `<button class="${cls}" data-date="${d}" aria-label="${label}" aria-pressed="${d === S.date}"><span class="n">${Number(d.slice(8))}</span>` +
      `<span class="strip">${strip}</span><span class="cnt">${meetings ? meetings + '건' : blocked ? '불가' : ''}</span></button>`;
  }
  $('#calGrid').innerHTML = html;
}

function dayList() { return S.data.filter((b) => b.date === S.date).sort((a, b) => a.start.localeCompare(b.start)); }
function rangeFree(s, e) { return !dayList().some((b) => toMin(b.start) < e && toMin(b.end) > s); }
function minStart() { const n = kst(); if (S.date < n.date) return Infinity; if (S.date > n.date) return 0; return n.min; }

function renderDay() {
  const list = dayList();
  const n = kst();
  $('#dayLabel').textContent = fmtDate(S.date) + (S.date === n.date ? ' 오늘' : '');
  const meetings = list.filter((b) => b.kind === 'meeting');
  const busy = list.reduce((a, b) => a + Math.min(toMin(b.end), closeM()) - Math.max(toMin(b.start), openM()), 0);
  const free = closeM() - openM() - busy;
  $('#daySummary').textContent = S.date < n.date
    ? `지난 날짜입니다. 예약 ${meetings.length}건`
    : meetings.length || list.length ? `예약 ${meetings.length}건, 빈 시간 ${fmtDur(Math.max(free, 0)) || '없음'}` : '아직 예약이 없습니다. 원하는 시간을 바로 고르세요.';

  const row = 26, step = slotM(), o = openM(), c = closeM(), ms = minStart();
  let labels = '', slots = '';
  for (let m = o; m < c; m += step) {
    if (m % 60 === 0) labels += `<span style="top:${((m - o) / step) * row}px">${fromMin(m)}</span>`;
    const taken = list.some((b) => toMin(b.start) < m + step && toMin(b.end) > m);
    const past = m < ms;
    slots += `<div class="slot${m % 60 === 0 ? ' hour' : ''}${past ? ' past' : ''}${taken ? ' taken' : ''}" data-m="${m}"></div>`;
  }
  labels += `<span style="top:${((c - o) / step) * row}px">${fromMin(c)}</span>`;
  let mags = '';
  for (const b of list) {
    const s = Math.max(toMin(b.start), o), e = Math.min(toMin(b.end), c);
    if (e <= s) continue;
    const col = colorOf(b);
    const short = e - s <= step;
    mags += `<button class="mag${b.kind === 'block' ? ' block' : ''}${short ? ' short' : ''}" data-id="${b.id}" style="top:${((s - o) / step) * row + 1}px;height:${((e - s) / step) * row - 2}px;--c:${col};--bg:${tint(col, 0.13)}">` +
      `<b>${esc(b.title)}</b><span class="t">${b.start}~${b.end}</span>` +
      (b.kind === 'meeting' ? `<span class="w">${esc(b.applicant)}${b.dept ? ', ' + esc(b.dept) : ''}${b.attendees ? `, ${b.attendees}명` : ''}</span>` : '') + `</button>`;
  }
  const nowLine = S.date === n.date && n.min >= o && n.min <= c ? `<div class="now-line" style="top:${((n.min - o) / step) * row}px"></div>` : '';
  $('#timeline').innerHTML = `<div class="tl-labels" style="height:${((c - o) / step) * row}px">${labels}</div><div class="tl-lane" id="lane">${slots}<div class="tl-end"></div>${mags}${nowLine}</div>`;
  $('#boardHint').hidden = S.date < n.date;
  renderSelection();
}

function renderSelection() {
  const sel = S.sel;
  for (const el of $$('#lane .slot')) {
    const m = Number(el.dataset.m);
    const on = sel && m >= sel.start && m < sel.end;
    el.classList.toggle('picked', !!on);
    el.classList.toggle('first', !!(on && m === sel.start));
    if (on && m === sel.start) el.dataset.t = `${fromMin(sel.start)}~${fromMin(sel.end)}`;
  }
  const f = $('#bookForm');
  f.date.value = S.date;
  const box = $('#selSummary');
  if (sel) {
    f.start.value = fromMin(sel.start);
    f.end.value = fromMin(sel.end);
    box.className = 'sel-summary on';
    const go = $('#mobileGo');
    go.textContent = `${fromMin(sel.start)}~${fromMin(sel.end)} 신청서 작성하기`;
    go.hidden = $('#tab-book').hidden;
    box.innerHTML = `<strong>${fmtDate(S.date)} ${fromMin(sel.start)}~${fromMin(sel.end)}</strong>${fmtDur(sel.end - sel.start)}` +
      (sel.end - sel.start >= 240 ? '<span class="long-note">긴 시간을 예약하시네요. 다른 과도 쓸 수 있도록 회의에 꼭 필요한 시간만큼만 잡아 주세요.</span>' : '');
  } else {
    $('#mobileGo').hidden = true;
    box.className = 'sel-summary';
    box.textContent = S.date < kst().date ? '지난 날짜는 예약할 수 없습니다.' : '왼쪽 시간표에서 빈 시간을 고르거나 아래에서 시간을 선택하세요.';
  }
}

function selectDate(d) {
  if (!d) return;
  const changed = d !== S.date;
  S.date = d;
  if (changed) S.sel = null;
  if (d.slice(0, 7) !== S.month) {
    S.month = d.slice(0, 7);
    loadMonth().catch((e) => toast(e.message, 'error'));
  } else {
    renderCalendar();
    renderDay();
  }
}

function slotAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.classList && el.classList.contains('slot') ? el : null;
}
function canPick(lo, hi) {
  return lo >= minStart() && hi <= closeM() && (!S.cfg.maxHours || hi - lo <= S.cfg.maxHours * 60) && rangeFree(lo, hi);
}

function bindBooking() {
  $('#calGrid').addEventListener('click', (e) => { const b = e.target.closest('.day'); if (b) selectDate(b.dataset.date); });
  const shiftMonth = (k) => {
    const [y, m] = S.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7);
    S.month = d;
    S.date = d === kst().date.slice(0, 7) ? kst().date : d + '-01';
    S.sel = null;
    loadMonth().catch((e) => toast(e.message, 'error'));
  };
  $('#prevMonth').onclick = () => shiftMonth(-1);
  $('#nextMonth').onclick = () => shiftMonth(1);
  $('#todayBtn').onclick = () => selectDate(kst().date);

  const tl = $('#timeline');
  tl.addEventListener('pointerdown', (e) => {
    const slot = e.target.closest('.slot');
    if (!slot || slot.classList.contains('past') || slot.classList.contains('taken')) return;
    const m = Number(slot.dataset.m), st = slotM();
    const sel = S.sel;
    if (sel && sel.end - sel.start === st && m === sel.start) { S.sel = null; S.anchor = null; }
    else if (sel && sel.end - sel.start === st && m > sel.start && canPick(sel.start, m + st)) { S.sel = { start: sel.start, end: m + st }; S.anchor = null; }
    else { S.sel = { start: m, end: m + st }; S.anchor = m; S.dragging = e.pointerType === 'mouse'; }
    renderSelection();
  });
  tl.addEventListener('pointermove', (e) => {
    if (!S.dragging || S.anchor == null) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (!slot) return;
    const m = Number(slot.dataset.m), st = slotM();
    const lo = Math.min(S.anchor, m), hi = Math.max(S.anchor, m) + st;
    if (canPick(lo, hi) && (!S.sel || S.sel.start !== lo || S.sel.end !== hi)) { S.sel = { start: lo, end: hi }; renderSelection(); }
  });
  window.addEventListener('pointerup', () => { S.dragging = false; });
  tl.addEventListener('click', (e) => {
    const mag = e.target.closest('.mag');
    if (mag) openDetail(S.data.find((b) => b.id === Number(mag.dataset.id)));
  });

  const f = $('#bookForm');
  f.date.addEventListener('change', () => selectDate(f.date.value));
  const syncTime = () => {
    const s = toMin(f.start.value), e = toMin(f.end.value);
    if (e <= s) { f.end.value = fromMin(Math.min(s + slotM() * 2, closeM())); return syncTime(); }
    S.sel = { start: s, end: toMin(f.end.value) };
    renderSelection();
    if (!rangeFree(S.sel.start, S.sel.end)) toast('이 시간에는 이미 예약이 있습니다. 시간표를 확인해 주세요.', 'error');
  };
  f.start.addEventListener('change', syncTime);
  f.end.addEventListener('change', syncTime);
  f.dept.addEventListener('change', () => { $('.dept-other', f).hidden = f.dept.value !== '__other'; });
  f.pin.addEventListener('input', () => { f.pin.value = f.pin.value.replace(/\D/g, '').slice(0, 4); });
  f.addEventListener('submit', submitBooking);
  $('#mobileGo').onclick = () => { $('#formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#mobileGo').hidden = true; setTimeout(() => f.title.focus({ preventScroll: true }), 400); };
}

async function submitBooking(e) {
  e.preventDefault();
  const f = e.target;
  const dept = f.dept.value === '__other' ? f.deptOther.value.trim() : f.dept.value;
  const body = {
    date: f.date.value, start: f.start.value, end: f.end.value, title: f.title.value.trim(), applicant: f.applicant.value.trim(),
    dept, phone: f.phone.value.trim(), attendees: f.attendees.value, note: f.note.value.trim(), pin: f.pin.value, repeatWeeks: f.repeatWeeks.value,
  };
  const miss = !body.title ? f.title : !body.applicant ? f.applicant : !/^\d{4}$/.test(body.pin) ? f.pin : null;
  if (miss) { toast(miss === f.pin ? '비밀번호 숫자 4자리를 입력해 주세요.' : '필수 항목을 입력해 주세요.', 'error'); miss.focus(); return; }
  if (toMin(body.end) <= toMin(body.start)) { toast('종료 시간을 확인해 주세요.', 'error'); return; }
  store.set('rpb.me', JSON.stringify({ applicant: body.applicant, dept: f.dept.value, deptOther: f.deptOther.value, phone: body.phone }));
  const btn = $('#submitBtn');
  btn.disabled = true;
  btn.textContent = '예약하는 중';
  try {
    const r = await api('bookings', 'create', { method: 'POST', body });
    f.title.value = ''; f.note.value = ''; f.pin.value = ''; f.attendees.value = ''; f.repeatWeeks.value = '1';
    S.sel = null;
    await loadMonth();
    showCreated(r);
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 409) loadMonth().catch(() => {});
  } finally {
    btn.disabled = false;
    btn.textContent = '예약하기';
  }
}

function showCreated(r) {
  const c = r.created;
  const first = c[0];
  const body = openModal('예약되었습니다', `
    <img class="hello" src="/rooms/img/mascot.png" alt="" width="132" height="141" />
    <dl><dt>일시</dt><dd>${c.length > 1 ? `${c.length}회, ${fmtDate(first.date)}부터 매주` : fmtDate(first.date)} ${first.start}~${first.end}</dd>
    <dt>회의명</dt><dd>${esc(first.title)}</dd><dt>신청자</dt><dd>${esc(first.applicant)}${first.dept ? ' (' + esc(first.dept) + ')' : ''}</dd></dl>
    ${r.skipped && r.skipped.length ? `<div class="skipped"><b>예약하지 못한 날짜 ${r.skipped.length}건</b><br>${r.skipped.map((s) => `${fmtDate(s.date)}: ${esc(s.reason)}`).join('<br>')}</div>` : ''}
    <div class="actions"><button class="secondary" data-ics>내 캘린더에 추가</button><button class="primary" data-close>확인</button></div>`, null, { celebrate: true });
  body.querySelector('[data-ics]').onclick = () => downloadIcs(c);
}

/* ---------- 상세·수정·취소 ---------- */
function openDetail(b) {
  if (!b) return;
  const rows = [
    ['일시', `${fmtDate(b.date)} ${b.start}~${b.end}`],
    [b.kind === 'block' ? '사유' : '회의명', b.title],
    ...(b.kind === 'meeting' ? [['신청자', b.applicant], ['부서', b.dept], ['내선번호', b.phone], ['참석 인원', b.attendees ? b.attendees + '명' : '']] : []),
    ['메모', b.note], ['반복', b.series_id ? '매주 반복 예약' : ''], ['등록', b.created_at],
  ].filter((r) => r[1]);
  const can = isEditable(b) && (b.kind === 'meeting' || S.admin);
  const body = openModal(b.kind === 'block' ? '예약 불가 시간' : '예약 정보', `
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="actions">
      ${b.kind === 'meeting' ? '<button class="secondary" data-ics>내 캘린더에 추가</button>' : ''}
      ${can ? '<button class="secondary" data-edit>수정</button><button class="danger" data-cancel>예약 취소</button>' : ''}
      <button class="primary" data-close>닫기</button>
    </div>
    ${!can && b.kind === 'meeting' ? '<p class="muted">이미 시작했거나 지난 회의는 관리자만 바꿀 수 있습니다.</p>' : ''}`);
  const ics = body.querySelector('[data-ics]');
  if (ics) ics.onclick = () => downloadIcs([b]);
  if (can) {
    body.querySelector('[data-edit]').onclick = () => openEdit(b);
    body.querySelector('[data-cancel]').onclick = () => openCancel(b);
  }
}

function openEdit(b, { admin = !!S.admin } = {}) {
  const tFrom = admin ? '00:00' : S.cfg.openTime, tTo = admin ? '24:00' : S.cfg.closeTime;
  const body = openModal(admin ? '예약 수정 (관리자)' : '예약 수정', `
    <form class="stack" id="editForm" novalidate>
      <div class="row-3"><label>날짜<input type="date" name="date" value="${b.date}" /></label>
      <label>시작<select name="start">${timeOptions(tFrom, fromMin(toMin(tTo) - slotM()), slotM(), b.start)}</select></label>
      <label>종료<select name="end">${timeOptions(fromMin(toMin(tFrom) + slotM()), tTo, slotM(), b.end)}</select></label></div>
      <label>${b.kind === 'block' ? '사유' : '회의명'}<input name="title" value="${esc(b.title)}" maxlength="100" /></label>
      ${b.kind === 'meeting' ? `
      <div class="row-2"><label>신청자<input name="applicant" value="${esc(b.applicant)}" maxlength="30" /></label>
      <label>부서<select name="dept">${deptOptions(b.dept)}</select></label></div>
      <label class="dept-other"${b.dept && !S.cfg.depts.includes(b.dept) ? '' : ' hidden'}>부서명<input name="deptOther" value="${esc(b.dept)}" maxlength="40" /></label>
      <div class="row-2"><label>내선번호<input name="phone" value="${esc(b.phone)}" maxlength="30" /></label>
      <label>참석 인원<input name="attendees" type="number" min="1" max="999" value="${b.attendees ?? ''}" /></label></div>` : ''}
      <label>메모<textarea name="note" rows="2" maxlength="500">${esc(b.note)}</textarea></label>
      ${admin ? (b.kind === 'meeting' ? '<label>비밀번호 재설정(선택)<input name="newPin" maxlength="4" inputmode="numeric" placeholder="새 4자리" /></label>' : '')
        : '<label>예약할 때 정한 비밀번호<input name="pin" type="password" maxlength="4" inputmode="numeric" required autocomplete="off" /></label>'}
      <p class="err" hidden></p>
      <div class="actions"><button type="button" class="secondary" data-close>닫기</button><button class="primary">저장</button></div>
    </form>`);
  const f = body.querySelector('form');
  if (f.dept) f.dept.addEventListener('change', () => { $('.dept-other', f).hidden = f.dept.value !== '__other'; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { id: b.id, date: f.date.value, start: f.start.value, end: f.end.value, title: f.title.value, note: f.note.value };
    if (f.applicant) Object.assign(payload, {
      applicant: f.applicant.value, phone: f.phone.value, attendees: f.attendees.value,
      dept: f.dept.value === '__other' ? f.deptOther.value.trim() : f.dept.value,
    });
    if (f.pin) payload.pin = f.pin.value;
    if (f.newPin && f.newPin.value) payload.newPin = f.newPin.value;
    try {
      await api(admin ? 'admin' : 'bookings', 'update', { method: 'POST', body: payload, admin });
      closeModal();
      toast('예약을 수정했습니다.');
      afterChange();
    } catch (err) {
      const p = $('.err', f); p.textContent = err.message; p.hidden = false;
    }
  });
}

function openCancel(b, { admin = !!S.admin } = {}) {
  const body = openModal('예약 취소', `
    <form class="stack" id="cancelForm">
      <p>${fmtDate(b.date)} ${b.start}~${b.end} <b>${esc(b.title)}</b> 예약을 취소합니다.</p>
      ${b.series_id ? `<fieldset class="seg"><label><input type="radio" name="scope" value="one" checked /> 이 회의만</label><label><input type="radio" name="scope" value="series" /> 이번 회의부터 반복 전체</label></fieldset>` : ''}
      ${admin ? '<label>취소 사유(이력에 남습니다)<input name="reason" maxlength="100" /></label>'
        : '<label>예약할 때 정한 비밀번호<input name="pin" type="password" maxlength="4" inputmode="numeric" required autocomplete="off" /></label>'}
      <p class="err" hidden></p>
      <div class="actions"><button type="button" class="secondary" data-close>돌아가기</button><button class="danger">예약 취소</button></div>
    </form>`);
  const f = body.querySelector('form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { id: b.id, scope: f.scope ? f.scope.value : 'one' };
    if (f.pin) payload.pin = f.pin.value;
    if (f.reason) payload.reason = f.reason.value;
    try {
      const r = await api(admin ? 'admin' : 'bookings', 'cancel', { method: 'POST', body: payload, admin });
      closeModal();
      toast(r.cancelled > 1 ? `예약 ${r.cancelled}건을 취소했습니다.` : '예약을 취소했습니다.');
      afterChange();
    } catch (err) {
      const p = $('.err', f); p.textContent = err.message; p.hidden = false;
    }
  });
}

function afterChange() {
  loadMonth().catch(() => {});
  if (S.mineName) loadMine(S.mineName);
  if (S.admin && !$('#adminArea').hidden) loadAdminTable();
}

/* ---------- 내 예약 ---------- */
async function loadMine(name) {
  S.mineName = name;
  const box = $('#mineList');
  try {
    const { bookings } = await api('bookings', 'mine', { q: { name } });
    if (!bookings.length) { box.innerHTML = `<p class="empty">${esc(name)} 님 이름으로 예정된 예약이 없습니다.</p>`; return; }
    box.innerHTML = bookings.map((b) => `
      <div class="item" style="--c:${colorOf(b)}"><span class="bar"></span>
        <div><div class="when">${fmtDate(b.date)} ${b.start}~${b.end}${b.series_id ? '<span class="tag">반복</span>' : ''}</div>
        <div class="what">${esc(b.title)}${b.dept ? ', ' + esc(b.dept) : ''}</div></div>
        <div class="acts"><button class="secondary" data-act="detail" data-id="${b.id}">보기</button>
        <button class="secondary" data-act="edit" data-id="${b.id}">수정</button>
        <button class="danger" data-act="cancel" data-id="${b.id}">취소</button></div>
      </div>`).join('');
    box.onclick = (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const b = bookings.find((x) => x.id === Number(btn.dataset.id));
      const act = btn.dataset.act;
      if (act === 'detail') openDetail(b);
      else if (act === 'edit') openEdit(b, { admin: false });
      else openCancel(b, { admin: false });
    };
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

/* ================= 관리자 ================= */
function adminLogin(token, name) {
  S.admin = { token, name };
  store.set('rpb.admin', JSON.stringify(S.admin), sessionStorage);
  $('#adminLogin').hidden = true;
  $('#adminArea').hidden = false;
  $('#adminWho').textContent = name ? `${name} 님 로그인` : '관리자 로그인';
  const f = $('#filterForm');
  if (!f.from.value) { f.from.value = addDays(kst().date, -7); f.to.value = addDays(kst().date, 60); }
  loadAdminTable();
}
function adminLogout(expired) {
  S.admin = null;
  store.set('rpb.admin', null, sessionStorage);
  $('#adminLogin').hidden = false;
  $('#adminArea').hidden = true;
  if (expired) toast('관리자 로그인이 만료되었습니다. 다시 로그인해 주세요.', 'error');
}

async function loadAdminTable() {
  const f = $('#filterForm');
  const t = $('#adminTable');
  try {
    const { bookings } = await api('admin', 'list', { admin: true, q: { from: f.from.value, to: f.to.value, status: f.status.value, q: f.q.value } });
    S.adminRows = bookings;
    S.picked.clear();
    updateSwap();
    t.innerHTML = `<thead><tr><th></th><th>날짜</th><th>시간</th><th>회의명</th><th>신청자</th><th>부서</th><th>내선</th><th>인원</th><th>등록</th><th>관리</th></tr></thead><tbody>` +
      (bookings.length ? bookings.map((b) => `
        <tr class="${b.status}" data-id="${b.id}">
          <td>${b.status === 'active' ? `<input type="checkbox" data-pick="${b.id}" aria-label="선택" />` : ''}</td>
          <td>${fmtDate(b.date)}</td><td>${b.start}~${b.end}</td>
          <td><span class="chip" style="--c:${colorOf(b)}"></span>${esc(b.title)}${b.kind === 'block' ? '<span class="tag">예약 불가</span>' : ''}${b.series_id ? '<span class="tag">반복</span>' : ''}${b.status === 'cancelled' ? '<span class="tag">취소</span>' : ''}</td>
          <td>${esc(b.applicant)}</td><td>${esc(b.dept)}</td><td>${esc(b.phone)}</td><td>${b.attendees ?? ''}</td><td>${b.created_at}</td>
          <td class="acts">${b.status === 'active'
            ? `<button class="secondary" data-act="edit">수정</button><button class="danger" data-act="cancel">취소</button>`
            : `<button class="secondary" data-act="restore">복구</button>`}<button class="secondary" data-act="log">이력</button></td>
        </tr>`).join('') : '<tr><td colspan="10" class="empty">조건에 맞는 예약이 없습니다.</td></tr>') + '</tbody>';
  } catch (err) {
    t.innerHTML = `<tbody><tr><td class="empty">${esc(err.message)}</td></tr></tbody>`;
  }
}
function updateSwap() {
  const ids = [...S.picked];
  const rows = ids.map((id) => S.adminRows.find((b) => b.id === id));
  $('#swapBtn').disabled = !(ids.length === 2 && rows[0].date === rows[1].date);
  $('#swapHint').textContent = ids.length === 2 && rows[0].date !== rows[1].date
    ? '날짜가 다른 예약은 [수정]으로 옮겨 주세요.'
    : '같은 날 예약 2건을 체크하면 시간대를 맞바꿉니다. 각 회의 길이는 그대로입니다.';
}

const ACTION_LABEL = { create: '등록', update: '수정', cancel: '취소', restore: '복구', swap: '순서 변경' };
function logRows(logs) {
  return logs.map((l) => `<tr><td>${l.at}</td><td>${ACTION_LABEL[l.action] || esc(l.action)}</td><td>${esc(l.actor)}</td><td>${esc(l.summary)}</td></tr>`).join('');
}
async function loadLogs(reset) {
  if (reset) S.logOffset = 0;
  const { logs } = await api('admin', 'logs', { admin: true, q: { limit: 50, offset: S.logOffset } });
  const t = $('#logTable');
  if (reset) t.innerHTML = '<thead><tr><th>일시</th><th>구분</th><th>처리자</th><th>내용</th></tr></thead><tbody></tbody>';
  $('tbody', t).insertAdjacentHTML('beforeend', logs.length || !reset ? logRows(logs) : '<tr><td colspan="4" class="empty">아직 이력이 없습니다.</td></tr>');
  S.logOffset += logs.length;
  $('#moreLogs').hidden = logs.length < 50;
}

async function loadStats() {
  const month = $('#statsForm').month.value;
  const box = $('#statsBody');
  try {
    const s = await api('admin', 'stats', { admin: true, q: { month } });
    const maxD = Math.max(1, ...s.byDept.map((d) => d.hours));
    const maxH = Math.max(1, ...s.byHour.map((d) => d.n));
    box.innerHTML = `
      <div class="stat-nums">
        <div><b>${s.total.n}건</b><span>예약된 회의</span></div>
        <div><b>${s.total.hours}시간</b><span>총 이용 시간</span></div>
        <div><b>${s.utilization}%</b><span>이용률 (평일 ${s.weekdays}일, 운영시간 기준)</span></div>
        <div><b>${s.total.people}명</b><span>신청한 직원 수</span></div>
        <div><b>${s.total.cancelled}건</b><span>취소된 예약</span></div>
      </div>
      <h3 class="stats-h">부서별 이용 시간</h3>
      <div class="bars">${s.byDept.length ? s.byDept.map((d) => `<div class="b"><span>${esc(d.dept)}</span><i style="width:${(d.hours / maxD) * 100}%;--c:${deptColor(d.dept === '(미기재)' ? '' : d.dept)}"></i><span>${d.n}건, ${d.hours}시간</span></div>`).join('') : '<p class="muted">이 달에는 이용 기록이 없습니다.</p>'}</div>
      <h3 class="stats-h">시작 시각별 회의 수</h3>
      <div class="bars">${s.byHour.map((d) => `<div class="b"><span>${pad(d.hour)}시대</span><i style="width:${(d.n / maxH) * 100}%"></i><span>${d.n}건</span></div>`).join('') || '<p class="muted">기록 없음</p>'}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function bindAdmin() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('admin', 'login', { method: 'POST', body: { password: f.password.value, name: f.name.value } });
      f.password.value = '';
      adminLogin(r.token, r.name);
      renderDay();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#logoutBtn').onclick = () => { adminLogout(); renderDay(); };
  $$('.subtabs button').forEach((b) => (b.onclick = () => {
    $$('.subtabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    $$('[data-sub-panel]').forEach((p) => (p.hidden = p.dataset.subPanel !== b.dataset.sub));
    if (b.dataset.sub === 'logs') loadLogs(true).catch((err) => toast(err.message, 'error'));
    if (b.dataset.sub === 'stats') loadStats();
    if (b.dataset.sub === 'manage') loadAdminTable();
  }));
  $('#filterForm').addEventListener('submit', (e) => { e.preventDefault(); loadAdminTable(); });
  $('#adminTable').addEventListener('change', (e) => {
    const id = Number(e.target.dataset.pick);
    if (!id) return;
    e.target.checked ? S.picked.add(id) : S.picked.delete(id);
    if (S.picked.size > 2) { S.picked.delete(id); e.target.checked = false; toast('순서 바꾸기는 2건만 고를 수 있습니다.', 'error'); }
    updateSwap();
  });
  $('#adminTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const b = S.adminRows.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    const act = btn.dataset.act;
    if (act === 'edit') openEdit(b, { admin: true });
    else if (act === 'cancel') openCancel(b, { admin: true });
    else if (act === 'restore') {
      try { await api('admin', 'restore', { method: 'POST', admin: true, body: { id: b.id } }); toast('예약을 복구했습니다.'); afterChange(); }
      catch (err) { toast(err.message, 'error'); }
    } else if (act === 'log') {
      try {
        const { logs } = await api('admin', 'logs', { admin: true, q: { bookingId: b.id, limit: 100 } });
        openModal(`변경 이력: ${b.title}`, `<div class="table-wrap"><table class="data"><thead><tr><th>일시</th><th>구분</th><th>처리자</th><th>내용</th></tr></thead><tbody>${logRows(logs)}</tbody></table></div><div class="actions"><button class="primary" data-close>닫기</button></div>`);
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  $('#swapBtn').onclick = async () => {
    const [a, b] = [...S.picked];
    try {
      const r = await api('admin', 'swap', { method: 'POST', admin: true, body: { a, b } });
      toast(`순서를 바꿨습니다: ${r.bookings.map((x) => `${x.start} ${x.title}`).join(', ')}`);
      afterChange();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#exportBtn').onclick = async () => {
    const f = $('#filterForm');
    try {
      const blob = await api('admin', 'export', { admin: true, raw: true, q: { from: f.from.value, to: f.to.value } });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `회의실예약_${f.from.value}_${f.to.value}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#moreLogs').onclick = () => loadLogs(false).catch((err) => toast(err.message, 'error'));
  $('#statsForm').addEventListener('submit', (e) => { e.preventDefault(); loadStats(); });

  const cf = $('#adminCreateForm');
  const syncKind = () => { const meeting = cf.kind.value === 'meeting'; $$('.meeting-only', cf).forEach((el) => (el.hidden = !meeting)); };
  cf.addEventListener('change', (e) => {
    if (e.target.name === 'kind') syncKind();
    if (e.target.name === 'allDay') {
      cf.start.disabled = cf.end.disabled = e.target.checked;
      if (e.target.checked) { cf.start.value = S.cfg.openTime; cf.end.value = S.cfg.closeTime; }
    }
    if (e.target.name === 'dept' && e.target.value === '__other') {
      const v = prompt('부서명을 입력하세요');
      if (v) { e.target.insertAdjacentHTML('afterbegin', `<option selected>${esc(v.trim())}</option>`); } else e.target.value = '';
    }
  });
  cf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      kind: cf.kind.value, date: cf.date.value, start: cf.start.value, end: cf.end.value, title: cf.title.value,
      applicant: cf.applicant.value, dept: cf.dept.value === '__other' ? '' : cf.dept.value, phone: cf.phone.value,
      attendees: cf.attendees.value, note: cf.note.value, pin: cf.pin.value, repeatWeeks: cf.repeatWeeks.value,
    };
    if (body.kind === 'meeting' && (!body.title.trim() || !body.applicant.trim())) { toast('회의명과 신청자를 입력해 주세요.', 'error'); return; }
    try {
      const r = await api('admin', 'create', { method: 'POST', admin: true, body });
      showCreated(r);
      cf.title.value = ''; cf.note.value = ''; cf.pin.value = '';
      afterChange();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ================= 시작 ================= */
function initTabs() {
  $$('.tabs button').forEach((b) => (b.onclick = () => {
    $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + b.dataset.tab));
    $('#mobileGo').hidden = true;
    if (b.dataset.tab === 'book') renderDay();
  }));
}

function fillStatic() {
  const c = S.cfg;
  document.title = `${c.roomName} 예약`;
  $('#roomName').textContent = c.roomName;
  $('#orgName').textContent = c.orgName;
  $('#roomPhoto').alt = `${c.roomName} 전경`;
  $('#notices').innerHTML = c.notices.map((t) => `<li>${esc(t)}</li>`).join('');
  const f = $('#bookForm');
  f.start.innerHTML = timeOptions(c.openTime, fromMin(closeM() - slotM()), slotM());
  f.end.innerHTML = timeOptions(fromMin(openM() + slotM()), c.closeTime, slotM());
  f.dept.innerHTML = deptOptions('');
  f.repeatWeeks.innerHTML = repeatOptions(c.maxRepeatWeeks);
  const cf = $('#adminCreateForm');
  cf.start.innerHTML = timeOptions('00:00', '23:30', slotM(), c.openTime);
  cf.end.innerHTML = timeOptions(fromMin(slotM()), '24:00', slotM(), fromMin(openM() + 60));
  cf.dept.innerHTML = deptOptions('');
  cf.repeatWeeks.innerHTML = repeatOptions(52);
  cf.date.value = kst().date;
  $('#statsForm').month.value = kst().date.slice(0, 7);
  $('#rules').innerHTML = [
    `이용 시간 ${c.openTime}~${c.closeTime}, ${c.slotMinutes}분 단위`,
    c.maxHours ? `1회 최대 ${c.maxHours}시간` : '1회 이용 시간 제한 없음(하루 종일 회의도 가능)',
    `오늘부터 ${c.maxAdvanceDays}일 앞까지 예약`,
    `매주 반복 예약은 최대 ${c.maxRepeatWeeks}주`,
    c.capacity ? `수용 인원 ${c.capacity}명` : '',
    c.roomLocation ? `위치: ${c.roomLocation}` : '',
    '먼저 신청한 예약이 확정됩니다. 일정 조정은 관리자에게 문의해 주세요.',
  ].filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('');
  $('#deptLegend').innerHTML = c.depts.map((d) => `<span><i style="background:${deptColor(d)}"></i>${esc(d)}</span>`).join('') +
    '<span><i style="background:#c3cac7"></i>예약 불가</span>';
  try {
    const me = JSON.parse(store.get('rpb.me') || 'null');
    if (me) {
      f.applicant.value = me.applicant || '';
      f.dept.value = me.dept || '';
      f.deptOther.value = me.deptOther || '';
      $('.dept-other', f).hidden = f.dept.value !== '__other';
      f.phone.value = me.phone || '';
      $('#mineForm').name.value = me.applicant || '';
    }
  } catch { /* 저장값 무시 */ }
}

async function initApp() {
  $('#app').hidden = false;
  fillStatic();
  initTabs();
  bindBooking();
  bindAdmin();
  $('#mineForm').addEventListener('submit', (e) => { e.preventDefault(); const n = e.target.name.value.trim(); if (n) loadMine(n); });
  // CI를 누르면 처음 화면(예약하기, 오늘)으로
  $('#homeLink').addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
    $('.tabs button[data-tab="book"]').click();
    S.sel = null;
    selectDate(kst().date);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#roomPhotoBtn').onclick = () => openModal(`${S.cfg.roomName} 전경`,
    `<img class="room-big" src="${esc(S.cfg.roomPhoto)}" alt="${esc(S.cfg.roomName)} 전경" />
     <ul class="notices">${S.cfg.notices.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
     <div class="actions"><button class="primary" data-close>닫기</button></div>`, null, { wide: true });
  S.date = kst().date;
  S.month = S.date.slice(0, 7);
  try {
    const saved = JSON.parse(store.get('rpb.admin', sessionStorage) || 'null');
    if (saved && saved.token) adminLogin(saved.token, saved.name);
  } catch { /* 무시 */ }
  await loadMonth();
  // 30초마다 최신 현황 반영, 1분마다 현재 시각선 갱신
  setInterval(() => { if (!document.hidden && !S.dragging) loadMonth().catch(() => {}); }, 30000);
  setInterval(() => { if (!S.dragging) { renderNow(); if (S.date === kst().date) renderDay(); } }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMonth().catch(() => {}); });
}

async function initBoard() {
  document.body.classList.add('board-mode');
  $('#board').hidden = false;
  const c = S.cfg;
  document.title = `${c.roomName} 현황판`;
  $('#bdOrg').textContent = c.orgName;
  $('#bdRoom').textContent = c.roomName;
  $('#bdFoot').textContent = location.host + '/rooms';
  let list = [];
  const draw = () => {
    const { today, cur, next, n } = nowState(list);
    $('#bdTime').textContent = new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);
    $('#bdDate').textContent = fmtDate(n.date);
    const st = $('#bdStatus');
    st.classList.toggle('busy', !!cur);
    st.innerHTML = cur
      ? `<div class="st">사용 중</div><div class="big">${esc(cur.title)}</div><div class="sm">${cur.start}~${cur.end}${cur.kind === 'meeting' ? `, ${esc(cur.applicant)}${cur.dept ? ' (' + esc(cur.dept) + ')' : ''}` : ''}</div>`
      : `<div class="st">비어 있음</div><div class="big">${next ? `다음 회의 ${next.start}` : '오늘 남은 회의가 없습니다'}</div><div class="sm">${next ? esc(next.title) : ''}</div>`;
    $('#bdList').innerHTML = today.length
      ? today.map((b) => `<li class="${toMin(b.end) <= n.min ? 'done' : b === cur ? 'cur' : ''}" style="--c:${colorOf(b)}"><span>${b.start}~${b.end}</span><span>${esc(b.title)}</span><span class="who">${b.kind === 'meeting' ? esc(b.applicant) + (b.dept ? ', ' + esc(b.dept) : '') : ''}</span></li>`).join('')
      : '<li style="--c:#2e5245"><span></span><span>오늘 예약이 없습니다</span><span></span></li>';
  };
  const load = async () => {
    try { list = (await api('bookings', 'list', { q: { from: kst().date, to: kst().date } })).bookings; } catch { /* 다음 주기에 재시도 */ }
    draw();
  };
  await load();
  setInterval(load, 30000);
  setInterval(draw, 15000);
}

(async function start() {
  S.access = store.get('rpb.access') || '';
  try {
    const r = await api('bookings', 'config');
    S.cfg = r.config;
    if (r.accessRequired && !S.access) { $('#app').hidden = true; return askAccess(false); }
    if (new URLSearchParams(location.search).get('view') === 'board') await initBoard();
    else await initApp();
  } catch (err) {
    document.body.innerHTML = `<div class="panel narrow" style="margin:60px auto"><h2>예약 시스템을 불러오지 못했습니다</h2><p class="muted">${esc(err.message)}</p></div>`;
  }
})();
