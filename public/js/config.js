// 보고 대기 번호표 — 설정
// firebase 값을 비워 두면 '데모 모드'로 동작합니다(이 브라우저 안에서만 저장, 서버 없음).
// 실제 운영 시: 설치 안내서(README.md) 3단계를 따라 아래 두 값을 채워 넣으세요(GitHub 웹에서 이 파일을 바로 고치면 됩니다).
self.BOGO_CONFIG = {
  // Firebase 콘솔 → 프로젝트 설정(톱니바퀴) → 일반 → 내 앱(웹) → SDK 설정 및 구성 → "구성"의 firebaseConfig 내용
  firebase: null,
  /* 예시:
  firebase: {
    apiKey: "AIza...",
    authDomain: "bogo-queue.firebaseapp.com",
    projectId: "bogo-queue",
    storageBucket: "bogo-queue.appspot.com",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef"
  },
  */
  // Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 구성 → 웹 푸시 인증서 → "키 쌍"
  vapidKey: '',
};
