// 두 화면(신청자 · 관리)이 함께 쓰는 화면 도우미
import * as L from './logic.js';
import { searchOrgs, ORG_TREE, ORGS } from './orgs.js';

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 서버에 저장소가 연결되어 있으면 실제 운영, 아니면 데모 모드
export async function loadApi() {
  const cfg = self.BOGO_CONFIG || {};
  let note = '서버 없이 이 브라우저에서만 동작';
  if (!cfg.demo && /^https?:$/.test(location.protocol)) {
    try {
      const r = await fetch((cfg.apiBase || '') + '/api/state');
      const j = await r.json().catch(() => null);
      if (j && j.configured) return (await import('./api-server.js')).create(cfg, j);
      if (j && j.configured === false) note = '저장소(Upstash Redis) 연결 전이라 이 브라우저에서만 동작';
      else if (j && j.error) {
        // 서버는 있는데 잠깐 오류: 데모로 빠지지 않고 실제 운영 화면에서 오류를 보여 줍니다.
        return (await import('./api-server.js')).create(cfg, null);
      }
    } catch {}
  }
  const api = (await import('./api-demo.js')).create();
  api.demoNote = note;
  return api;
}

// 알림 소리(화면이 켜져 있을 때)
let actx = null;
addEventListener('pointerdown', () => {
  try { actx = actx || new (self.AudioContext || self.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
}, { passive: true });
export function beep(strong) {
  try {
    if (!actx || actx.state !== 'running') return;
    const offs = strong ? [0, 0.25, 0.5] : [0, 0.22];
    for (const off of offs) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = strong ? 988 : 880; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + off;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    }
  } catch {}
  try { navigator.vibrate && navigator.vibrate(strong ? [300, 120, 300, 120, 400] : [200, 100, 200]); } catch {}
}

let toastTimer = null;
export function toast(title, body = '', kind = '') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), body.length > 40 ? 7000 : 3500);
  el.onclick = () => (el.hidden = true);
}
export function showError(e) { toast('처리하지 못했습니다', e?.message || String(e), 'err'); }

export function availText(av) {
  if (av.ok) return { ok: true, text: '지금 보고 가능', sub: av.next ? `${L.hm(av.next.s)}부터 ${av.next.kind === 'lunch' ? '점심시간' : av.next.ext ? `대외 일정(${L.hm(av.next.e)}경 복귀)` : '국장님 일정'}` : '' };
  return { ok: false, text: L.whyText(av), sub: av.until ? `${L.hm(av.until)}부터 호출 재개` : (av.why === 'closed' ? '' : '오늘 호출 어려움') };
}

// 오늘 일정 막대: 보고 가능(초록) · 일정(빗금) · 대외 일정+복귀(진한 빗금+옅은 칸) · 점심(회색) · 지금 위치
// titled: 관리자용 제목 목록(없으면 공개용) · opts.admin: 대외/내부 바꾸기 버튼 표시
export function timelineHTML(s, dayDoc, now, titled, opts = {}) {
  const c = L.context(s, dayDoc, now);
  const [ws, we] = L.workRange(c.s, c.day);
  const pct = t => Math.min(100, Math.max(0, ((t - ws) / (we - ws)) * 100));
  const bar = (a, b, cls) => `<i class="tb ${cls}" style="left:${pct(a)}%;width:${Math.max(0.8, pct(b) - pct(a))}%"></i>`;
  let bars = '', tags = '';
  for (const b of c.bl) {
    if (b.kind === 'absent') continue;
    const bs = b.raw ? b.raw.s : b.s, be = b.raw ? b.raw.e : b.e;
    if (b.ext) {
      bars += bar(bs, be, 'busy ext') + bar(be, b.e, 'ret');
      tags += `<span style="left:${pct(bs)}%">대외 일정</span>`;
    } else bars += bar(bs, be, b.kind);
  }
  const nowm = now >= ws && now < we ? `<i class="nowm" style="left:${pct(now)}%"></i>` : '';
  const retAt = b => b.e + L.retMinOf(b, c.s) * L.MIN;
  const ret = b => (retAt(b) >= we ? '오늘 복귀 어려움' : `${L.hm(retAt(b))}경 복귀`);
  const dur = m => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ' ' + (m % 60) + '분' : ''}` : `${m}분`);
  const where = b => (titled && b.ext ? `<small class="ret">${b.place ? esc(b.place) + (b.km ? ` ${b.km}km` : '') + ' · ' : '거리 모름 · '}이동 ${dur(L.retMinOf(b, c.s))}</small>` : '');
  const list = titled || (dayDoc.busy || []).map(b => ({ ...b, title: b.title || (b.ext ? '대외 일정' : '일정 있음') }));
  const row = b => `<div><span class="num">${L.hm(b.s)}~${L.hm(b.e)}</span><span>${esc(b.title)}${b.ext ? `${titled || b.title ? '<span class="tag amber">대외</span>' : ''}<small class="ret">${ret(b)}</small>${where(b)}` : ''}${opts.admin && b.key ? ` <button type="button" class="linkbtn" data-ext-key="${esc(b.key)}" data-ext-to="${b.ext ? 0 : 1}">${b.ext ? '내부 일정으로' : '대외 일정으로'}</button>` : ''}</span></div>`;
  // 약 2시간 간격 눈금: 시작 시각부터 2시간마다 + 끝 시각
  const ticks = [];
  const first = Math.ceil(ws / 3600000) * 3600000;
  for (let t = first; t < we - 90 * L.MIN; t += 2 * 3600000) ticks.push(t);
  ticks.push(we);
  const hourTxt = t => (t === we && c.s.workEnd === '24:00' ? '24시' : `${Number(L.hm(t).slice(0, 2))}시${L.hm(t).slice(3) !== '00' ? L.hm(t).slice(3) + '분' : ''}`);
  const gridLines = ticks.slice(1, -1).map(t => `<i class="tg" style="left:${pct(t)}%"></i>`).join('');
  const labels = ticks.map((t, i) => `<span class="${i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : ''}" style="left:${pct(t)}%">${hourTxt(t)}</span>`).join('');
  return `<div class="tl" aria-hidden="true">${bars}${gridLines}${nowm}</div>
    <div class="tl-ticks num" aria-hidden="true">${labels}</div>
    ${tags ? `<div class="tl-tags" aria-hidden="true">${tags}</div>` : ''}
    <div class="tl-key"><span><i class="k-ok"></i>보고 가능</span><span><i class="k-busy"></i>일정</span>${c.bl.some(b => b.ext) ? '<span><i class="k-ext"></i>대외 일정</span><span><i class="k-ret"></i>복귀 이동</span>' : ''}${c.s.lunch ? '<span><i class="k-lunch"></i>점심</span>' : ''}</div>
    ${list.length ? `<div class="evs">${list.map(row).join('')}</div>` : '<p class="sub">오늘 국장님 캘린더에 시간이 정해진 일정이 없습니다.</p>'}`;
}

// ---------- 부서 고르기: 두세 글자 입력하면 자동완성 + 목록(기관 > 국·부 > 과)에서 고르기 ----------
export function attachOrgPicker(input) {
  const wrap = input.parentElement;
  wrap.classList.add('ac');
  const box = document.createElement('div');
  box.className = 'ac-list'; box.hidden = true; box.setAttribute('role', 'listbox');
  wrap.appendChild(box);
  input.setAttribute('autocomplete', 'off'); input.setAttribute('role', 'combobox');
  let items = [], sel = -1;
  const close = () => { box.hidden = true; sel = -1; };
  const where = o => (o.inst === '본청' ? (o.up || '본청') : o.short + (o.up ? ' · ' + o.up : ''));
  const draw = () => {
    items = input.value.trim().length >= 1 ? searchOrgs(input.value, 8) : [];
    if (!items.length || document.activeElement !== input || items.some(o => o.value === input.value)) return close();
    box.innerHTML = items.map((o, i) => `<button type="button" role="option" data-i="${i}" class="${i === sel ? 'on' : ''}"><b>${esc(o.name)}</b><span>${esc(where(o))}</span></button>`).join('');
    box.hidden = false;
  };
  const pick = o => { input.value = o.value; close(); input.dispatchEvent(new Event('change', { bubbles: true })); };
  input.addEventListener('input', () => { sel = -1; draw(); });
  input.addEventListener('focus', draw);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(items[Math.max(0, sel)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('pointerdown', e => e.preventDefault());
  box.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pick(items[+b.dataset.i]); });
}
export function attachOrgBrowser(btn, panel, input) {
  panel.innerHTML = '<select aria-label="기관"></select><select aria-label="국·부" disabled></select><select aria-label="과·팀" disabled></select>';
  const [s0, s1, s2] = panel.querySelectorAll('select');
  const fill = (el, opts, ph) => { el.innerHTML = `<option value="">${ph}</option>` + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); };
  const inst = () => ORG_TREE.find(x => x[0] === s0.value);
  fill(s0, ORG_TREE.map(x => [x[0], x[0]]), '기관 선택');
  s0.onchange = () => { const t = inst(); fill(s1, t ? Object.keys(t[2]).map(k => [k, k === '직속' ? '직속 부서' : k]) : [], '국·부 선택'); fill(s2, [], '과·팀 선택'); s1.disabled = !t; s2.disabled = true; };
  s1.onchange = () => {
    const t = inst(), up = s1.value, l = (t && t[2][up]) || [];
    fill(s2, [...(up && up !== '직속' ? [[up, `${up} (국·부 자체)`]] : []), ...l.map(n => [n, n])], '과·팀 선택');
    s2.disabled = !up;
  };
  s2.onchange = () => {
    const up = s1.value, v = s2.value;
    const o = ORGS.find(o => o.inst === s0.value && o.name === v && (up === '직속' || v === up ? o.up === '' : o.up === up));
    if (o) { input.value = o.value; panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); input.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); });
}

// ---------- 안드로이드: 크롬 안내 · 앱 설치 ----------
const UA = navigator.userAgent;
export const isAndroid = /Android/i.test(UA);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const inAppBrowser = /KAKAOTALK|NAVER\(|NAVER|Line\/|Instagram|FBAN|FBAV|DaumApps|DaumDevice|everytime|BAND\/|; wv\)/i.test(UA);
export const isAndroidChrome = isAndroid && /Chrome\/\d+/.test(UA) && !inAppBrowser && !/SamsungBrowser|EdgA|OPR\/|Whale|YaBrowser|Firefox|UCBrowser|MiuiBrowser|HeyTapBrowser|Vivaldi|DuckDuckGo|GSA\//i.test(UA);
export function chromeIntentUrl() {
  const fb = encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome');
  return `intent://${location.host}${location.pathname}${location.search}${location.hash}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fb};end`;
}
export function modal(html, { onClose } = {}) {
  const el = document.createElement('div');
  el.className = 'modal';
  el.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(el);
  const close = () => { el.remove(); onClose && onClose(); };
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  return { el, close };
}

// 데모 모드 막대: 누구로 볼지, 시간 앞으로 돌리기
export function demoBar(api, onChange) {
  if (api.mode !== 'demo') return;
  const bar = document.createElement('div');
  bar.className = 'demobar';
  const draw = () => {
    const off = api.demo.offsetMin();
    bar.innerHTML = `<b>데모 모드</b><span class="sub">${api.demoNote || '서버 없이 이 브라우저에서만 동작'} · ${off ? `시간 +${off}분` : '실제 시각'}</span>
      <label>보는 사람 <select id="demo-user">${api.demo.users.map(u => `<option value="${u.uid}" ${u.uid === api.demo.uid ? 'selected' : ''}>${u.label}</option>`).join('')}</select></label>
      <span class="grp"><button type="button" data-adv="1">+1분</button><button type="button" data-adv="5">+5분</button><button type="button" data-adv="30">+30분</button></span>
      <button type="button" data-reset>처음부터</button>`;
  };
  draw();
  bar.addEventListener('change', e => { if (e.target.id === 'demo-user') { api.demo.setUser(e.target.value); onChange && onChange(); } });
  bar.addEventListener('click', e => {
    const a = e.target.closest('[data-adv]'); if (a) { api.demo.advance(+a.dataset.adv); draw(); }
    if (e.target.closest('[data-reset]')) api.demo.reset();
  });
  document.body.prepend(bar);
  setInterval(draw, 15000);
}

export function statusLabel(t, s, now) {
  switch (t.status) {
    case 'held': return ['st-wait', '대기 중'];
    case 'waiting': return ['st-wait', '대기 중'];
    case 'called': return ['st-call', '호출됨 · 입실 대기'];
    case 'in_progress': return ['st-prog', '보고 중'];
    case 'done': return ['st-done', '보고 완료'];
    case 'timeout': return ['st-off', '시간 초과 취소'];
    case 'cancelled': return ['st-off', '취소'];
    case 'expired': return ['st-off', '마감'];
    default: return ['st-off', t.status];
  }
}
export function mmss(ms) { ms = Math.max(0, ms); const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return `${m}:${String(s).padStart(2, '0')}`; }
export function minsAgo(ms, now) { return Math.max(0, Math.floor((now - ms) / 60000)); }
