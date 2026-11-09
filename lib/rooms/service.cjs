const crypto = require('crypto');
const cfg = require('./config.cjs');
const { query } = require('./db.cjs');
const { httpError, kstNow, toMin, fromMin, addDays, isDate, isTime, str, hashPin } = require('./util.cjs');

const ROOM = 'main';

// 모든 조회에서 같은 모양으로 돌려주는 컬럼(시각은 한국 시간 문자열)
const COLS = `id::int AS id, kind,
  to_char(start_at, 'YYYY-MM-DD') AS date,
  to_char(start_at, 'HH24:MI') AS start,
  CASE WHEN end_at::date > start_at::date THEN '24:00' ELSE to_char(end_at, 'HH24:MI') END AS "end",
  title, applicant, dept, phone, attendees, note, series_id, status,
  (pin_hash <> '') AS has_pin,
  to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS created_at,
  to_char(updated_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS updated_at`;

function norm(r) {
  return {
    ...r,
    id: Number(r.id),
    attendees: r.attendees === null || r.attendees === undefined || r.attendees === '' ? null : Number(r.attendees),
    has_pin: r.has_pin === true || r.has_pin === 't',
    series_id: r.series_id || null,
  };
}
const publicView = (r) => {
  const { has_pin, ...rest } = norm(r);
  return rest;
};

const ts = (date, time) => `${date} ${time}`;
const summary = (b) => `${b.date} ${b.start}~${b.end} ${b.title} (${b.applicant}${b.dept ? '/' + b.dept : ''})`;

/* ---------- 검증 ---------- */

function validateSlot(input, { admin }) {
  const date = input.date, start = input.start, end = input.end;
  if (!isDate(date)) throw httpError(400, '날짜를 확인해 주세요.');
  if (!isTime(start) || !isTime(end)) throw httpError(400, '시간을 확인해 주세요.');
  const s = toMin(start), e = toMin(end);
  if (e <= s) throw httpError(400, '종료 시간은 시작 시간보다 늦어야 합니다.');
  if (s % cfg.slotMinutes || e % cfg.slotMinutes) throw httpError(400, `${cfg.slotMinutes}분 단위로 선택해 주세요.`);
  if (!admin) {
    if (s < toMin(cfg.openTime) || e > toMin(cfg.closeTime))
      throw httpError(400, `이용 가능 시간은 ${cfg.openTime}~${cfg.closeTime}입니다.`);
    if (cfg.maxHours > 0 && e - s > cfg.maxHours * 60) throw httpError(400, `1회 최대 ${cfg.maxHours}시간까지 예약할 수 있습니다.`);
    const now = kstNow();
    if (ts(date, start) < now.stamp) throw httpError(400, '이미 지난 시간은 예약할 수 없습니다.');
    if (date > addDays(now.date, cfg.maxAdvanceDays))
      throw httpError(400, `오늘부터 ${cfg.maxAdvanceDays}일 이내만 예약할 수 있습니다.`);
  }
  return { date, start, end };
}

function validateFields(input, { admin, kind }) {
  const f = {
    title: str(input.title, 100),
    applicant: str(input.applicant, 30),
    dept: str(input.dept, 40),
    phone: str(input.phone, 30),
    note: str(input.note, 500),
    attendees: input.attendees === '' || input.attendees === null || input.attendees === undefined ? '' : String(input.attendees).trim(),
  };
  if (kind === 'block') {
    if (!f.title) f.title = '예약 불가';
    if (!f.applicant) f.applicant = '관리자';
  }
  if (!f.title) throw httpError(400, '회의명을 입력해 주세요.');
  if (!f.applicant) throw httpError(400, '신청자 이름을 입력해 주세요.');
  if (f.attendees !== '' && !/^\d{1,3}$/.test(f.attendees)) throw httpError(400, '참석 인원은 숫자로 입력해 주세요.');
  return f;
}

function checkPinFormat(pin, required) {
  const p = str(pin, 10);
  if (!p && !required) return '';
  if (!/^\d{4}$/.test(p)) throw httpError(400, '비밀번호는 숫자 4자리입니다.');
  return p;
}

/* ---------- 조회 ---------- */

async function getConfig() {
  return {
    config: { ...cfg },
    now: kstNow(),
    accessRequired: !!process.env.ROOM_ACCESS_CODE,
    adminEnabled: !!process.env.ROOM_ADMIN_PASSWORD,
  };
}

async function listBookings(from, to) {
  if (!isDate(from) || !isDate(to) || to < from) throw httpError(400, '조회 기간을 확인해 주세요.');
  if (to > addDays(from, 120)) throw httpError(400, '한 번에 120일까지 조회할 수 있습니다.');
  const rows = await query(
    `SELECT ${COLS} FROM bookings
      WHERE status = 'active' AND room = $1 AND start_at < ($3::date + 1) AND end_at > $2::date
      ORDER BY start_at`,
    [ROOM, from, to]
  );
  return { bookings: rows.map(publicView), now: kstNow() };
}

async function findByApplicant(name) {
  const n = str(name, 30);
  if (!n) throw httpError(400, '이름을 입력해 주세요.');
  const now = kstNow();
  const rows = await query(
    `SELECT ${COLS} FROM bookings
      WHERE status = 'active' AND kind = 'meeting' AND applicant = $1 AND end_at > $2::timestamp
      ORDER BY start_at LIMIT 100`,
    [n, now.stamp]
  );
  return { bookings: rows.map(publicView) };
}

async function findConflicts(date, start, end, excludeIds = []) {
  const rows = await query(
    `SELECT ${COLS} FROM bookings
      WHERE status = 'active' AND room = $1
        AND tsrange(start_at, end_at) && tsrange($2::timestamp, $3::timestamp)
        AND NOT (id = ANY($4::bigint[]))
      ORDER BY start_at`,
    [ROOM, ts(date, start), ts(date, end), '{' + excludeIds.map(Number).join(',') + '}']
  );
  return rows.map(publicView);
}

async function getRow(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, '잘못된 예약 번호입니다.');
  const rows = await query(`SELECT ${COLS}, pin_hash FROM bookings WHERE id = $1`, [n]);
  if (!rows.length) throw httpError(404, '예약을 찾을 수 없습니다.');
  return norm(rows[0]);
}

function conflictError(conflicts) {
  const c = conflicts[0];
  const msg = c
    ? `이미 예약된 시간입니다: ${c.start}~${c.end} ${c.title} (${c.applicant}${c.dept ? '/' + c.dept : ''})`
    : '방금 다른 예약이 먼저 등록되었습니다. 현황을 새로고침해 주세요.';
  return httpError(409, msg, { conflicts });
}

/* ---------- 등록 ---------- */

async function insertOne(slot, f, { kind, pinHash, seriesId, actor }) {
  const rows = await query(
    `WITH ins AS (
       INSERT INTO bookings (room, kind, start_at, end_at, title, applicant, dept, phone, attendees, note, pin_hash, series_id)
       VALUES ($1, $2, $3::timestamp, $4::timestamp, $5, $6, $7, $8, NULLIF($9, '')::int, $10, $11, NULLIF($12, ''))
       RETURNING *
     ), lg AS (
       INSERT INTO booking_logs (booking_id, action, actor, summary, snapshot)
       SELECT id, 'create', $13, $14, to_jsonb(ins) - 'pin_hash' FROM ins
     )
     SELECT ${COLS} FROM ins`,
    [ROOM, kind, ts(slot.date, slot.start), ts(slot.date, slot.end), f.title, f.applicant, f.dept, f.phone,
      f.attendees, f.note, pinHash, seriesId || '', actor, summary({ ...slot, ...f })]
  );
  return publicView(rows[0]);
}

async function createBooking(input, { admin, actor }) {
  const kind = admin && input.kind === 'block' ? 'block' : 'meeting';
  const first = validateSlot(input, { admin });
  const f = validateFields(input, { admin, kind });
  const pin = checkPinFormat(input.pin, !admin);
  const weeks = Math.max(1, Math.min(Number(input.repeatWeeks) || 1, admin ? 52 : cfg.maxRepeatWeeks));
  const seriesId = weeks > 1 ? crypto.randomBytes(6).toString('hex') : '';
  const who = actor || f.applicant;

  const created = [], skipped = [];
  for (let i = 0; i < weeks; i++) {
    const slot = { ...first, date: addDays(first.date, i * 7) };
    if (i > 0) {
      try { validateSlot(slot, { admin }); } catch (e) { skipped.push({ date: slot.date, reason: e.message }); continue; }
    }
    const conflicts = await findConflicts(slot.date, slot.start, slot.end);
    if (conflicts.length) {
      if (weeks === 1) throw conflictError(conflicts);
      skipped.push({ date: slot.date, reason: conflictError(conflicts).message });
      continue;
    }
    try {
      created.push(await insertOne(slot, f, { kind, pinHash: pin ? hashPin(pin) : '', seriesId, actor: who }));
    } catch (e) {
      if (e.code !== '23P01') throw e; // 동시에 들어온 예약에 밀린 경우
      const again = await findConflicts(slot.date, slot.start, slot.end);
      if (weeks === 1) throw conflictError(again);
      skipped.push({ date: slot.date, reason: conflictError(again).message });
    }
  }
  if (!created.length) throw httpError(409, '예약 가능한 날짜가 없습니다.', { skipped });
  return { created, skipped };
}

/* ---------- 수정 ---------- */

function authorize(cur, { admin, pin }) {
  if (cur.status !== 'active') throw httpError(410, '이미 취소된 예약입니다.');
  if (admin) return;
  if (cur.kind !== 'meeting' || !cur.pin_hash) throw httpError(403, '이 예약은 관리자만 변경할 수 있습니다.');
  const p = checkPinFormat(pin, true);
  if (hashPin(p) !== cur.pin_hash) throw httpError(403, '비밀번호가 맞지 않습니다.');
  if (ts(cur.date, cur.start) < kstNow().stamp) throw httpError(400, '이미 시작된 회의는 변경할 수 없습니다. 관리자에게 문의해 주세요.');
}

async function updateBooking(id, input, { admin, pin, actor }) {
  const cur = await getRow(id);
  authorize(cur, { admin, pin });

  const slotChanged = ['date', 'start', 'end'].some((k) => input[k] !== undefined && input[k] !== cur[k]);
  const slot = slotChanged
    ? validateSlot({ date: input.date ?? cur.date, start: input.start ?? cur.start, end: input.end ?? cur.end }, { admin })
    : { date: cur.date, start: cur.start, end: cur.end };
  const merged = {};
  for (const k of ['title', 'applicant', 'dept', 'phone', 'note', 'attendees']) merged[k] = input[k] !== undefined ? input[k] : cur[k];
  const f = validateFields(merged, { admin, kind: cur.kind });
  let pinHash = cur.pin_hash;
  const newPin = checkPinFormat(input.newPin, false);
  if (newPin) pinHash = hashPin(newPin);

  if (slotChanged) {
    const conflicts = await findConflicts(slot.date, slot.start, slot.end, [cur.id]);
    if (conflicts.length) throw conflictError(conflicts);
  }
  try {
    const rows = await query(
      `WITH old AS (SELECT * FROM bookings WHERE id = $1 AND status = 'active'),
       upd AS (
         UPDATE bookings b SET start_at = $2::timestamp, end_at = $3::timestamp, title = $4, applicant = $5, dept = $6,
           phone = $7, attendees = NULLIF($8, '')::int, note = $9, pin_hash = $10, updated_at = now()
         FROM old WHERE b.id = old.id RETURNING b.*
       ), lg AS (
         INSERT INTO booking_logs (booking_id, action, actor, summary, snapshot)
         SELECT upd.id, 'update', $11, $12,
           jsonb_build_object('before', to_jsonb(old) - 'pin_hash', 'after', to_jsonb(upd) - 'pin_hash')
         FROM upd JOIN old ON old.id = upd.id
       )
       SELECT ${COLS} FROM upd`,
      [cur.id, ts(slot.date, slot.start), ts(slot.date, slot.end), f.title, f.applicant, f.dept, f.phone,
        f.attendees, f.note, pinHash, actor || `${cur.applicant}(본인)`,
        `${summary(cur)} → ${summary({ ...slot, ...f })}`]
    );
    if (!rows.length) throw httpError(409, '예약 상태가 바뀌었습니다. 새로고침 후 다시 시도해 주세요.');
    return { booking: publicView(rows[0]) };
  } catch (e) {
    if (e.code === '23P01') throw conflictError(await findConflicts(slot.date, slot.start, slot.end, [cur.id]));
    throw e;
  }
}

/* ---------- 취소·복구 ---------- */

async function cancelBooking(id, { admin, pin, actor, scope, reason }) {
  const cur = await getRow(id);
  authorize(cur, { admin, pin });
  const series = scope === 'series' && cur.series_id ? cur.series_id : '';
  const why = str(reason, 100);
  const rows = await query(
    `WITH c AS (
       UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE status = 'active' AND (id = $1 OR ($2 <> '' AND series_id = $2 AND start_at >= $3::timestamp))
       RETURNING *
     ), lg AS (
       INSERT INTO booking_logs (booking_id, action, actor, summary, snapshot)
       SELECT id, 'cancel', $4,
         to_char(start_at, 'YYYY-MM-DD HH24:MI') || ' ' || title || ' (' || applicant || ')' || CASE WHEN $5 <> '' THEN ' / 사유: ' || $5 ELSE '' END,
         to_jsonb(c) - 'pin_hash'
       FROM c
     )
     SELECT count(*)::int AS n FROM c`,
    [cur.id, series, ts(cur.date, cur.start), actor || `${cur.applicant}(본인)`, why]
  );
  return { cancelled: Number(rows[0].n) };
}

async function restoreBooking(id, { actor }) {
  const cur = await getRow(id);
  if (cur.status === 'active') throw httpError(400, '이미 활성 상태인 예약입니다.');
  const conflicts = await findConflicts(cur.date, cur.start, cur.end, [cur.id]);
  if (conflicts.length) throw conflictError(conflicts);
  try {
    const rows = await query(
      `WITH r AS (
         UPDATE bookings SET status = 'active', cancelled_at = NULL, updated_at = now() WHERE id = $1 AND status = 'cancelled' RETURNING *
       ), lg AS (
         INSERT INTO booking_logs (booking_id, action, actor, summary, snapshot) SELECT id, 'restore', $2, $3, to_jsonb(r) - 'pin_hash' FROM r
       )
       SELECT ${COLS} FROM r`,
      [cur.id, actor, summary(cur)]
    );
    return { booking: publicView(rows[0]) };
  } catch (e) {
    if (e.code === '23P01') throw conflictError(await findConflicts(cur.date, cur.start, cur.end, [cur.id]));
    throw e;
  }
}

/* ---------- 관리자: 순서 바꾸기 ---------- */
// 같은 날 두 회의의 순서를 맞바꿈. 각 회의 길이와 사이 간격은 그대로 유지.
async function swapBookings(aId, bId, { actor }) {
  const a = await getRow(aId), b = await getRow(bId);
  if (a.id === b.id) throw httpError(400, '서로 다른 예약 2건을 선택해 주세요.');
  if (a.status !== 'active' || b.status !== 'active') throw httpError(400, '취소된 예약은 순서를 바꿀 수 없습니다.');
  if (a.date !== b.date) throw httpError(400, '같은 날짜의 예약끼리만 순서를 바꿀 수 있습니다. 다른 날로 옮길 때는 [수정]을 이용해 주세요.');
  const [x, y] = toMin(a.start) <= toMin(b.start) ? [a, b] : [b, a];
  const s1 = toMin(x.start), e2 = toMin(y.end);
  const dx = toMin(x.end) - toMin(x.start), dy = toMin(y.end) - toMin(y.start);
  const yNew = { start: fromMin(s1), end: fromMin(s1 + dy) };
  const xNew = { start: fromMin(e2 - dx), end: fromMin(e2) };
  const d = x.date;
  try {
    const rows = await query(
      `WITH old AS (SELECT * FROM bookings WHERE id IN ($1, $2) AND status = 'active'),
       upd AS (
         UPDATE bookings b SET
           start_at = CASE WHEN b.id = $1 THEN $3::timestamp ELSE $5::timestamp END,
           end_at   = CASE WHEN b.id = $1 THEN $4::timestamp ELSE $6::timestamp END,
           updated_at = now()
         FROM old WHERE b.id = old.id RETURNING b.*
       ), lg AS (
         INSERT INTO booking_logs (booking_id, action, actor, summary, snapshot)
         SELECT upd.id, 'swap', $7,
           to_char(upd.start_at, 'YYYY-MM-DD') || ' ' || upd.title || ' ' ||
           to_char(old.start_at, 'HH24:MI') || '~' || to_char(old.end_at, 'HH24:MI') || ' → ' ||
           to_char(upd.start_at, 'HH24:MI') || '~' || to_char(upd.end_at, 'HH24:MI') || ' (순서 맞바꿈)',
           jsonb_build_object('before', to_jsonb(old) - 'pin_hash', 'after', to_jsonb(upd) - 'pin_hash')
         FROM upd JOIN old ON old.id = upd.id
       )
       SELECT ${COLS} FROM upd ORDER BY start_at`,
      [x.id, y.id, ts(d, xNew.start), ts(d, xNew.end), ts(d, yNew.start), ts(d, yNew.end), actor]
    );
    if (rows.length !== 2) throw httpError(409, '예약 상태가 바뀌었습니다. 새로고침 후 다시 시도해 주세요.');
    return { bookings: rows.map(publicView) };
  } catch (e) {
    if (e.code === '23P01') throw httpError(409, '두 회의 사이에 다른 예약이 있어 순서를 바꿀 수 없습니다. [수정]으로 시간을 직접 옮겨 주세요.');
    throw e;
  }
}

/* ---------- 관리자: 목록·이력·통계·내보내기 ---------- */

async function adminList({ from, to, status, q }) {
  if (!isDate(from) || !isDate(to) || to < from) throw httpError(400, '조회 기간을 확인해 주세요.');
  const st = ['active', 'cancelled'].includes(status) ? status : '';
  const rows = await query(
    `SELECT ${COLS} FROM bookings
      WHERE start_at >= $1::date AND start_at < ($2::date + 1)
        AND ($3 = '' OR status = $3)
        AND ($4 = '' OR title ILIKE '%' || $4 || '%' OR applicant ILIKE '%' || $4 || '%' OR dept ILIKE '%' || $4 || '%')
      ORDER BY start_at, id LIMIT 3000`,
    [from, to, st, str(q, 50)]
  );
  return { bookings: rows.map(norm) };
}

async function adminLogs({ bookingId, limit, offset }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const bid = bookingId ? String(Number(bookingId) || 0) : '';
  const rows = await query(
    `SELECT id::int AS id, booking_id::int AS booking_id, action, actor, summary,
            to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS at
       FROM booking_logs WHERE ($1 = '' OR booking_id = NULLIF($1, '')::bigint)
       ORDER BY id DESC LIMIT $2::int OFFSET $3::int`,
    [bid, String(lim), String(off)]
  );
  return { logs: rows.map((r) => ({ ...r, id: Number(r.id), booking_id: r.booking_id == null || r.booking_id === '' ? null : Number(r.booking_id) })) };
}

async function adminStats({ month }) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw httpError(400, '월을 확인해 주세요.');
  const first = month + '-01';
  const byDept = await query(
    `SELECT COALESCE(NULLIF(dept, ''), '(미기재)') AS dept, count(*)::int AS n,
            round(sum(extract(epoch FROM end_at - start_at)) / 3600.0, 1)::text AS hours
       FROM bookings
      WHERE kind = 'meeting' AND status = 'active' AND start_at >= $1::date AND start_at < ($1::date + interval '1 month')
      GROUP BY 1 ORDER BY 2 DESC, 1`,
    [first]
  );
  const tot = await query(
    `SELECT count(*) FILTER (WHERE status = 'active' AND kind = 'meeting')::int AS n,
            count(*) FILTER (WHERE status = 'cancelled' AND kind = 'meeting')::int AS cancelled,
            COALESCE(round(sum(extract(epoch FROM end_at - start_at)) FILTER (WHERE status = 'active' AND kind = 'meeting') / 3600.0, 1), 0)::text AS hours,
            count(DISTINCT applicant) FILTER (WHERE status = 'active' AND kind = 'meeting')::int AS people
       FROM bookings WHERE start_at >= $1::date AND start_at < ($1::date + interval '1 month')`,
    [first]
  );
  const byHour = await query(
    `SELECT extract(hour FROM start_at)::int AS hour, count(*)::int AS n FROM bookings
      WHERE kind = 'meeting' AND status = 'active' AND start_at >= $1::date AND start_at < ($1::date + interval '1 month')
      GROUP BY 1 ORDER BY 1`,
    [first]
  );
  // 평일 수 × 운영시간 대비 이용률
  let weekdays = 0;
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) weekdays++;
  }
  const openHours = (toMin(cfg.closeTime) - toMin(cfg.openTime)) / 60;
  const t = tot[0];
  return {
    month,
    total: { n: Number(t.n), cancelled: Number(t.cancelled), hours: Number(t.hours), people: Number(t.people) },
    utilization: weekdays ? Math.round((Number(t.hours) / (weekdays * openHours)) * 1000) / 10 : 0,
    weekdays,
    byDept: byDept.map((r) => ({ dept: r.dept, n: Number(r.n), hours: Number(r.hours) })),
    byHour: byHour.map((r) => ({ hour: Number(r.hour), n: Number(r.n) })),
  };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function adminExport({ from, to }) {
  const { bookings } = await adminList({ from, to, status: '', q: '' });
  const head = ['번호', '구분', '날짜', '시작', '종료', '회의명', '신청자', '부서', '연락처', '참석인원', '메모', '상태', '반복묶음', '등록일시', '최종수정'];
  const lines = [head.join(',')];
  for (const b of bookings) {
    lines.push([b.id, b.kind === 'block' ? '예약불가' : '회의', b.date, b.start, b.end, b.title, b.applicant, b.dept, b.phone,
      b.attendees ?? '', b.note, b.status === 'active' ? '예약' : '취소', b.series_id || '', b.created_at, b.updated_at].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n'); // 엑셀에서 한글이 깨지지 않도록 BOM 포함
}

module.exports = {
  getConfig, listBookings, findByApplicant, createBooking, updateBooking, cancelBooking, restoreBooking,
  swapBookings, adminList, adminLogs, adminStats, adminExport,
};
