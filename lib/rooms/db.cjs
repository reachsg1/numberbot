const { httpError } = require('./util.cjs');

let driver = null;
let schemaReady = null;

function getDriver() {
  if (driver) return driver;
  if (process.env.DB_DRIVER === 'psql') {
    driver = require('./psql-driver.cjs'); // 로컬 테스트 전용
    return driver;
  }
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw httpError(500, 'DATABASE_URL 환경변수가 설정되지 않았습니다. Vercel에서 데이터베이스(Neon)를 연결해 주세요.');
  const { Pool } = require('pg');
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: local ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' },
    max: 3,
    idleTimeoutMillis: 10000,
  });
  driver = { query: async (text, params = []) => (await pool.query(text, params)).rows };
  return driver;
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS bookings (
  id           BIGSERIAL PRIMARY KEY,
  room         TEXT NOT NULL DEFAULT 'main',
  kind         TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting','block')),
  start_at     TIMESTAMP NOT NULL,
  end_at       TIMESTAMP NOT NULL,
  title        TEXT NOT NULL,
  applicant    TEXT NOT NULL,
  dept         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  attendees    INT,
  note         TEXT NOT NULL DEFAULT '',
  pin_hash     TEXT NOT NULL DEFAULT '',
  series_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT bookings_time_ok CHECK (end_at > start_at),
  -- 같은 회의실·겹치는 시간에 활성 예약은 1건만: 동시에 눌러도 먼저 저장된 1건만 성공(선착순 보장)
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (room WITH =, tsrange(start_at, end_at) WITH &&)
    WHERE (status = 'active') DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS bookings_start_idx ON bookings (start_at);
CREATE INDEX IF NOT EXISTS bookings_applicant_idx ON bookings (applicant);
CREATE TABLE IF NOT EXISTS booking_logs (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  BIGINT,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  snapshot    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_logs_booking_idx ON booking_logs (booking_id);
`;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await getDriver().query(SCHEMA);
      } catch (e) {
        // 첫 실행 시 여러 요청이 동시에 테이블을 만들면 한쪽이 실패할 수 있어 한 번 더 시도
        await new Promise((r) => setTimeout(r, 300));
        await getDriver().query(SCHEMA);
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return getDriver().query(text, params);
}

module.exports = { query };
