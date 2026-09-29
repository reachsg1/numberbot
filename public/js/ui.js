// 두 화면(신청자 · 관리)이 함께 쓰는 화면 도우미
import * as L from './logic.js';

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function loadApi() {
  const cfg = self.BOGO_CONFIG || {};
  if (cfg.firebase) return (await import('./api-firebase.js')).create(cfg);
  return (await import('./api-demo.js')).create();
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
  if (av.ok) return { ok: true, text: '지금 보고 가능', sub: av.next ? `${L.hm(av.next.s)}부터 ${av.next.kind === 'lunch' ? '점심시간' : '국장님 일정'}` : '' };
  return { ok: false, text: L.whyText(av), sub: av.until ? `${L.hm(av.until)}부터 호출 재개` : (av.why === 'closed' ? '' : '오늘 호출 어려움') };
}

// 오늘 일정 막대: 보고 가능(초록) · 일정(빗금) · 점심(회색) · 지금 위치
export function timelineHTML(s, dayDoc, now, titled) {
  const c = L.context(s, dayDoc, now);
  const [ws, we] = L.workRange(c.s, c.day);
  const pct = t => Math.min(100, Math.max(0, ((t - ws) / (we - ws)) * 100));
  const bars = c.bl.filter(b => b.kind !== 'absent').map(b => {
    const bs = b.raw ? b.raw.s : b.s, be = b.raw ? b.raw.e : b.e;
    return `<i class="tb ${b.kind}" style="left:${pct(bs)}%;width:${Math.max(0.8, pct(be) - pct(bs))}%"></i>`;
  }).join('');
  const nowm = now >= ws && now < we ? `<i class="nowm" style="left:${pct(now)}%"></i>` : '';
  const list = (titled || (dayDoc.busy || []).map(b => ({ ...b, title: '일정 있음' })));
  return `<div class="tl" aria-hidden="true">${bars}${nowm}</div>
    <div class="tl-l num"><span>${L.hm(ws)}</span><span>${L.hm((ws + we) / 2)}</span><span>${L.hm(we)}</span></div>
    ${list.length ? `<div class="evs">${list.map(b => `<div><span class="num">${L.hm(b.s)}~${L.hm(b.e)}</span><span>${esc(b.title)}</span></div>`).join('')}</div>` : '<p class="sub">오늘 국장님 캘린더에 시간이 정해진 일정이 없습니다.</p>'}`;
}

// 데모 모드 막대: 누구로 볼지, 시간 앞으로 돌리기
export function demoBar(api, onChange) {
  if (api.mode !== 'demo') return;
  const bar = document.createElement('div');
  bar.className = 'demobar';
  const draw = () => {
    const off = api.demo.offsetMin();
    bar.innerHTML = `<b>데모 모드</b><span class="sub">서버 없이 이 브라우저에서만 동작 · ${off ? `시간 +${off}분` : '실제 시각'}</span>
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
    case 'held': return ['st-held', `${L.hm(t.appointAt)} 지정`];
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
