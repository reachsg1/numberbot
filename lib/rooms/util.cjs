const crypto = require('crypto');

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

// 한국 시간(KST) 기준 현재 날짜·시각
function kstNow() {
  const iso = new Date(Date.now() + 9 * 3600e3).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), stamp: iso.slice(0, 10) + ' ' + iso.slice(11, 16) };
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

const isTime = (s) => typeof s === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(s) || s === '24:00');

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// 예약 비밀번호 암호화 키. 예전 회의실 프로젝트의 APP_SECRET(없었다면 예전 관리자 비밀번호)을 ROOM_APP_SECRET에 그대로 넣어야 기존 예약 비밀번호가 맞습니다.
const secret = () => process.env.ROOM_APP_SECRET || process.env.APP_SECRET || 'local-dev-secret';

const hashPin = (pin) => crypto.createHmac('sha256', secret()).update('pin:' + pin).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

module.exports = { httpError, kstNow, toMin, fromMin, addDays, isDate, isTime, str, hashPin, safeEqual, signToken, verifyToken };
