// 운영 규칙. Vercel 환경변수로 덮어쓸 수 있습니다(README 참고).
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

module.exports = {
  orgName: env.ORG_NAME || '농촌진흥청 연구정책국',
  roomName: env.ROOM_NAME || '711호 회의실',
  roomLocation: env.ROOM_LOCATION || '',
  capacity: num(env.ROOM_CAPACITY, 0), // 0이면 표시 안 함
  openTime: env.OPEN_TIME || '07:00',
  closeTime: env.CLOSE_TIME || '23:00',
  slotMinutes: num(env.SLOT_MINUTES, 30),
  maxHours: num(env.MAX_HOURS, 0), // 1회 최대 이용시간. 0이면 제한 없음(하루 종일 회의 가능)
  maxAdvanceDays: num(env.MAX_ADVANCE_DAYS, 90), // 며칠 앞까지 예약 가능
  maxRepeatWeeks: num(env.MAX_REPEAT_WEEKS, 12), // 매주 반복 최대 주수
  // 화면 왼쪽 '회의실 안내'에 나오는 이용 안내. ROOM_NOTICES 환경변수에 | 로 구분해 바꿀 수 있음
  notices: (env.ROOM_NOTICES ? env.ROOM_NOTICES.split('|') : [
    '빔프로젝터를 사용할 수 있습니다.',
    'PC는 없으니 과에서 보유한 노트북을 가져와 연결해 주세요.',
    '회의에 꼭 필요한 시간만큼만 예약해 주세요. 일찍 끝나면 [내 예약]에서 시간을 줄이거나 취소해 주세요.',
    '사용 후에는 책상·의자를 원래대로 두고 프로젝터, 조명, 냉난방기를 꺼 주세요.',
  ]).map((s) => s.trim()).filter(Boolean),
  roomPhoto: env.ROOM_PHOTO || '/rooms/img/room.jpg',
  depts: list(env.DEPTS, ['국장실', '연구정책과', '연구개발과', '연구관리과', '농자재산업과', '스마트농업팀']),
  // 음력·대체공휴일 등 해마다 바뀌는 휴일(양력 고정 공휴일은 자동 표시)
  // 기본값: 2027년 설·부처님오신날·추석과 대체공휴일. 해가 바뀌면 HOLIDAYS 환경변수로 추가하세요(표시용, 예약은 막지 않음).
  holidays: list(env.HOLIDAYS, [
    '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-05-13', '2027-08-16',
    '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27',
  ]),
};
