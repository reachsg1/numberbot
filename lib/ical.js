// 구글 캘린더 iCal(.ics) 주소에서 "오늘" 일정만 뽑아냅니다. 시각은 한국 시간(KST) 기준.
// 지원: 한 번짜리 일정, 종일 일정, 반복 일정(매일·매주·매월·매년, 간격·횟수·종료일·요일), 제외 날짜, 한 회차만 바꾼 일정, 취소된 일정.

const DAYMS = 86400000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function unfold(text) { return text.replace(/\r?\n[ \t]/g, ''); }
function unescape(v) { return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1'); }

function parseProps(block) {
  const props = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const params = {};
    for (const p of m[2].split(';').slice(1)) { const [k, v] = p.split('='); params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, ''); }
    props.push({ name: m[1].toUpperCase(), params, value: m[3] });
  }
  return props;
}

// 값 → { ms, allDay }  (TZID가 있거나 시간대 표시가 없으면 한국 시간으로 봄)
function parseTime(value, params) {
  const allDay = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h = '00', mi = '00', s = '00', z] = m;
  const iso = `${Y}-${Mo}-${D}T${h}:${mi}:${s}`;
  const ms = z ? Date.parse(iso + 'Z') : Date.parse(iso + '+09:00');
  return { ms, allDay, date: `${Y}-${Mo}-${D}` };
}
const kstDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const dateMs = d => Date.parse(d + 'T00:00:00+09:00');
const weekday = d => new Date(dateMs(d) + 9 * 3600000).getUTCDay();

function parseDuration(v) {
  const m = (v || '').match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, w = 0, d = 0, h = 0, mi = 0, s = 0] = m.map(x => Number(x) || 0);
  return (((+w * 7 + +d) * 24 + +h) * 60 + +mi) * 60000 + +s * 1000;
}

function parseRule(v) {
  const r = {};
  for (const part of v.split(';')) { const [k, val] = part.split('='); r[k] = val; }
  return {
    freq: r.FREQ, interval: Number(r.INTERVAL || 1), count: r.COUNT ? Number(r.COUNT) : null,
    until: r.UNTIL ? parseTime(r.UNTIL, {}) : null,
    byday: r.BYDAY ? r.BYDAY.split(',') : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
  };
}

// 반복 규칙상 날짜 d(YYYY-MM-DD)가 회차에 해당하는지 (시작일 s0 기준)
function matches(rule, s0, d) {
  const [y0, m0, d0] = s0.split('-').map(Number);
  const [y, m, dd] = d.split('-').map(Number);
  const days = Math.round((dateMs(d) - dateMs(s0)) / DAYMS);
  if (days < 0) return false;
  const wd = weekday(d);
  const monthsDiff = (y - y0) * 12 + (m - m0);
  const nthOk = code => {
    const mm = code.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!mm || WD.indexOf(mm[2]) !== wd) return false;
    if (!mm[1]) return true;
    const n = Number(mm[1]);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return n > 0 ? Math.ceil(dd / 7) === n : Math.ceil((last - dd + 1) / 7) === -n;
  };
  switch (rule.freq) {
    case 'DAILY':
      if (days % rule.interval) return false;
      return rule.byday ? rule.byday.some(nthOk) : true;
    case 'WEEKLY': {
      const startWeek = dateMs(s0) - ((weekday(s0) + 6) % 7) * DAYMS; // 월요일 시작
      const weeks = Math.floor((dateMs(d) - startWeek) / (7 * DAYMS));
      if (weeks % rule.interval) return false;
      return (rule.byday || [WD[weekday(s0)]]).some(c => c.slice(-2) === WD[wd]);
    }
    case 'MONTHLY':
      if (monthsDiff % rule.interval) return false;
      if (rule.byday) return rule.byday.some(nthOk);
      return (rule.bymonthday || [d0]).includes(dd);
    case 'YEARLY':
      if ((y - y0) % rule.interval) return false;
      if (rule.bymonth && !rule.bymonth.includes(m)) return false;
      if (rule.byday) return rule.byday.some(nthOk);
      return m === (rule.bymonth ? m : m0) && dd === d0;
    default: return false;
  }
}

function occursOn(rule, s0, d) {
  if (!matches(rule, s0, d)) return false;
  if (rule.until && dateMs(d) > dateMs(rule.until.allDay ? rule.until.date : kstDate(rule.until.ms))) return false;
  if (rule.count) {
    let n = 0;
    for (let x = dateMs(s0); x <= dateMs(d) && n <= rule.count; x += DAYMS) if (matches(rule, s0, kstDate(x))) n++;
    return n <= rule.count;
  }
  return true;
}

export function eventsForDay(icsText, day) {
  const d0 = dateMs(day), d1 = d0 + DAYMS;
  const text = unfold(icsText || '');
  const blocks = text.split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
  const events = blocks.map(b => {
    const p = parseProps(b);
    const get = n => p.find(x => x.name === n);
    const st = get('DTSTART') && parseTime(get('DTSTART').value, get('DTSTART').params);
    if (!st) return null;
    let en = get('DTEND') && parseTime(get('DTEND').value, get('DTEND').params);
    if (!en) {
      const dur = parseDuration(get('DURATION')?.value);
      en = { ms: st.ms + (dur || (st.allDay ? DAYMS : 0)), allDay: st.allDay, date: kstDate(st.ms + (dur || DAYMS)) };
    }
    const exdates = new Set();
    for (const x of p.filter(x => x.name === 'EXDATE')) for (const v of x.value.split(',')) { const t = parseTime(v.trim(), x.params); if (t) exdates.add(t.allDay ? t.date : kstDate(t.ms)); }
    const rid = get('RECURRENCE-ID') && parseTime(get('RECURRENCE-ID').value, get('RECURRENCE-ID').params);
    return {
      uid: get('UID')?.value || Math.random().toString(36),
      title: unescape(get('SUMMARY')?.value || '(제목 없음)').slice(0, 80),
      cancelled: (get('STATUS')?.value || '').toUpperCase() === 'CANCELLED',
      st, en, rule: get('RRULE') ? parseRule(get('RRULE').value) : null, exdates,
      recurrenceDate: rid ? (rid.allDay ? rid.date : kstDate(rid.ms)) : null,
    };
  }).filter(Boolean);

  // 한 회차만 바꾼 일정: 원래 회차는 빼고 바뀐 일정으로 대신
  const overridden = new Map();
  for (const e of events) if (e.recurrenceDate) { if (!overridden.has(e.uid)) overridden.set(e.uid, new Set()); overridden.get(e.uid).add(e.recurrenceDate); }

  const busy = [], allDay = [];
  const add = (e, s, t) => {
    if (e.cancelled) return;
    if (e.st.allDay) { if (s < d1 && t > d0) allDay.push(e.title); return; }
    const a = Math.max(s, d0), b = Math.min(t, d1);
    if (b > a) busy.push({ s: a, e: b, title: e.title });
  };
  for (const e of events) {
    const len = e.en.ms - e.st.ms;
    if (!e.rule || e.recurrenceDate) { add(e, e.st.ms, e.en.ms); continue; }
    // 반복 일정: 오늘 시작하는 회차와, 어제 시작해 오늘까지 이어지는 회차를 확인
    const s0 = e.st.allDay ? e.st.date : kstDate(e.st.ms);
    const tod = e.st.allDay ? 0 : e.st.ms - dateMs(s0);
    for (const cand of [kstDate(d0 - DAYMS), day]) {
      if (e.exdates.has(cand) || overridden.get(e.uid)?.has(cand)) continue;
      if (!occursOn(e.rule, s0, cand)) continue;
      const s = dateMs(cand) + tod;
      add(e, s, s + len);
    }
  }
  busy.sort((a, b) => a.s - b.s);
  return { busy, allDay };
}

export function publicIcalUrl(calendarId) {
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
}
