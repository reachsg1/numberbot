import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsForDay } from '../lib/ical.js';

const T = (d, h) => Date.parse(`${d}T${h}:00+09:00`);
// 구글 캘린더가 내보내는 형식을 흉내 낸 예시(9/30 실제 일정 포함)
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-TIMEZONE:Asia/Seoul',
  'BEGIN:VEVENT', 'DTSTART:20260930T000000Z', 'DTEND:20260930T023000Z', 'UID:a1@google.com',
  'SUMMARY:(국) 기관장협의회 *농과원 생물부 5층', 'STATUS:CONFIRMED', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260930T150000', 'DTEND;TZID=Asia/Seoul:20260930T170000', 'UID:a2@google.com',
  'SUMMARY:(국) RDA 인사이트데이 *오디토리움', 'TRANSP:TRANSPARENT', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001', 'UID:a3@google.com', 'SUMMARY:실국장 만찬', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260930T130000', 'DTEND;TZID=Asia/Seoul:20260930T140000', 'UID:a4@google.com', 'SUMMARY:취소된 회의', 'STATUS:CANCELLED', 'END:VEVENT',
  // 매주 금요일 주간업무점검회의 09~10시, 10/16은 빠짐, 10/23은 11시로 변경
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260807T090000', 'DTEND;TZID=Asia/Seoul:20260807T100000', 'RRULE:FREQ=WEEKLY;BYDAY=FR', 'EXDATE;TZID=Asia/Seoul:20261016T090000',
  'UID:w1@google.com', 'SUMMARY:(국&과) 주간업무점검회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20261023T110000', 'DTEND;TZID=Asia/Seoul:20261023T120000', 'RECURRENCE-ID;TZID=Asia/Seoul:20261023T090000',
  'UID:w1@google.com', 'SUMMARY:(국&과) 주간업무점검회의(변경)', 'END:VEVENT',
  // 격주 화요일 3회, 매월 첫째 월요일, 긴 제목 줄바꿈(folding)
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20261006T140000', 'DTEND;TZID=Asia/Seoul:20261006T150000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=TU', 'UID:b1', 'SUMMARY:격주 회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20260907T100000', 'DTEND;TZID=Asia/Seoul:20260907T103000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO', 'UID:m1', 'SUMMARY:월례 간부회의 및', ' 성과 점검', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Seoul:20261007T100000', 'DTEND;TZID=Asia/Seoul:20261007T120000', 'UID:x1', 'SUMMARY:국정감사 출석', 'LOCATION:국회 본관\\, 서울', 'DESCRIPTION:<b>배석</b> 국장', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const hm = ms => new Date(ms + 9 * 3600000).toISOString().slice(11, 16);
const brief = r => r.busy.map(b => `${hm(b.s)}-${hm(b.e)} ${b.title}`);

test('9/30: 시간 일정 2개(한가함 표시 포함), 종일 1개, 취소 제외', () => {
  const r = eventsForDay(ICS, '2026-09-30');
  assert.deepEqual(brief(r), ['09:00-11:30 (국) 기관장협의회 *농과원 생물부 5층', '15:00-17:00 (국) RDA 인사이트데이 *오디토리움']);
  assert.deepEqual(r.allDay, ['실국장 만찬']);
});
test('매주 반복 · 제외 날짜 · 한 회차 변경', () => {
  assert.deepEqual(brief(eventsForDay(ICS, '2026-10-02')), ['09:00-10:00 (국&과) 주간업무점검회의']);
  assert.deepEqual(brief(eventsForDay(ICS, '2026-10-16')), []);
  assert.deepEqual(brief(eventsForDay(ICS, '2026-10-23')), ['11:00-12:00 (국&과) 주간업무점검회의(변경)']);
  assert.deepEqual(brief(eventsForDay(ICS, '2026-08-06')), [], '시작 전');
});
test('격주·횟수 제한, 매월 첫째 월요일, 줄바꿈된 제목', () => {
  assert.equal(brief(eventsForDay(ICS, '2026-10-06')).length, 1);
  assert.equal(brief(eventsForDay(ICS, '2026-10-13')).length, 0, '격주');
  assert.equal(brief(eventsForDay(ICS, '2026-11-03')).length, 1, '3회차');
  assert.equal(brief(eventsForDay(ICS, '2026-11-17')).length, 0, '횟수 끝');
  assert.deepEqual(brief(eventsForDay(ICS, '2026-10-05')), ['10:00-10:30 월례 간부회의 및성과 점검']);
  assert.equal(brief(eventsForDay(ICS, '2026-10-12')).length, 0, '둘째 월요일 아님');
});

test('장소·설명도 읽음(대외 일정 판단용)', () => {
  const b = eventsForDay(ICS, '2026-10-07').busy.find(x => x.uid === 'x1');
  assert.equal(b.loc, '국회 본관, 서울');
  assert.match(b.desc, /배석/);
});
