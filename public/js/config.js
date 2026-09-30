// 보고 대기 번호표 — 설정 (보통은 고칠 필요 없습니다)
// 서버(/api/state)에 저장소(Upstash Redis)가 연결되어 있으면 자동으로 '실제 운영'으로 동작하고,
// 연결 전이거나 서버가 없는 곳(내 컴퓨터에서 파일만 열기 등)에서는 '데모 모드'로 동작합니다.
self.BOGO_CONFIG = {
  apiBase: '',   // 다른 주소의 서버를 쓸 때만 입력 (예: 'https://numberbot-six.vercel.app')
  demo: false,   // true로 바꾸면 서버가 있어도 항상 데모 모드
};
