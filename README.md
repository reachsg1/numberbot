# 보고 대기 번호표 — GitHub + Vercel 버전

국장실 보고 대기 번호표를 휴대폰으로 받고, 차례가 되면 푸시 알림으로 부르는 설치형 웹앱입니다.
**결제 카드 없이, 명령 프롬프트 없이** 웹사이트 화면만으로 올리고 고칠 수 있게 만들었습니다.

| 역할 | 서비스 | 요금 |
|---|---|---|
| 코드 보관 · 웹에서 바로 수정 | GitHub | 무료 |
| 앱 화면 + 서버(`/api`) · 자동 배포 | Vercel (Hobby) | 무료 |
| 로그인 · 실시간 데이터 · 푸시 알림 | Firebase (Spark) | 무료, 카드 불필요 |
| 1분마다 서버 깨우기 | cron-job.org | 무료 |

- 신청자 화면: `https://<앱이름>.vercel.app`
- 관리 화면(비서실): `https://<앱이름>.vercel.app/admin.html`

> Vercel 무료(Hobby) 요금제는 약관상 "비상업·개인 용도"입니다. 비공식 업무 도구로 쓰기 전에 한 번 확인해 두세요.

---

## 1단계. 데모로 먼저 띄워 보기 (약 15분)

`public/js/config.js`의 `firebase` 값이 비어 있으면 앱은 **데모 모드**로 동작합니다.
서버 없이 브라우저 안에서 실제와 같은 규칙으로 움직이고, 화면 맨 위 노란 막대에서
"보는 사람(나 / 동료 A·B·C)"을 바꾸거나 시간을 +1분·+5분·+30분 앞으로 돌려 볼 수 있습니다.

### 1-1. GitHub에 올리기
1. https://github.com 가입 → 오른쪽 위 **+** → **New repository**
2. 이름 `bogo-queue`, **Private**(비공개) 선택 → **Create repository**
3. 새 저장소 화면의 **"uploading an existing file"** 링크를 누릅니다.
4. 받은 압축을 풀고, `bogo-vercel` 폴더 **안에 있는 것 전부**(`api`, `lib`, `public`, `tests`, `package.json`, `vercel.json`, `README.md` 등)를 끌어다 놓습니다.
5. 아래 **Commit changes**를 누릅니다.

### 1-2. Vercel에 연결하기
1. https://vercel.com → **Sign Up** → **Continue with GitHub** (Hobby 선택)
2. **Add New… → Project** → 방금 만든 `bogo-queue` 옆 **Import**
3. Framework Preset은 **Other** 그대로 두고 **Deploy**를 누릅니다.
4. 1분 정도 뒤 나오는 주소(예: `https://bogo-queue.vercel.app`)를 휴대폰이나 PC에서 열어 봅니다.

> 데모 모드는 각자의 브라우저 안에만 저장됩니다. 여러 사람이 함께 쓰려면 2단계부터 진행합니다.

**앞으로 고칠 때**: GitHub 저장소에서 파일을 열고 연필(✏️) 아이콘으로 고친 뒤 **Commit changes** → Vercel이 1분 안에 자동으로 다시 올립니다.

---

## 2단계. Firebase 준비 (무료, 카드 불필요, 약 20분)

### 2-1. 프로젝트 만들기
https://console.firebase.google.com → **프로젝트 추가** → 이름(예: `bogo-queue`) → 애널리틱스는 꺼도 됨 → 만들기.
요금제는 **Spark(무료)** 그대로 둡니다.

### 2-2. 로그인 켜기
**Authentication → 시작하기 → 로그인 방법**
- **익명** → 사용 설정 → 저장 (신청자는 가입 없이 사용)
- **Google** → 사용 설정 → 지원 이메일 선택 → 저장 (관리자 로그인용)

그리고 **Authentication → 설정 → 승인된 도메인 → 도메인 추가**에 Vercel 주소(예: `bogo-queue.vercel.app`)를 넣습니다. 이걸 빠뜨리면 관리자 구글 로그인이 안 됩니다.

### 2-3. 데이터베이스 만들기
1. **Firestore Database → 데이터베이스 만들기** → 위치 **asia-northeast3 (서울)** → **프로덕션 모드** → 만들기
2. 만들어지면 위쪽 **규칙** 탭 → 내용을 전부 지우고 이 폴더의 `firestore.rules` 내용을 붙여 넣은 뒤 **게시**

### 2-4. 앱 설정값 두 개 받기
1. **프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → 웹(`</>`)** → 앱 닉네임(예: 보고 대기) → 앱 등록
   → 나오는 `firebaseConfig = { ... }`의 **중괄호 부분**을 복사해 둡니다.
2. **프로젝트 설정 → 클라우드 메시징 → 웹 구성 → 웹 푸시 인증서 → 키 쌍 생성** → 나온 긴 키를 복사해 둡니다.
3. GitHub 저장소에서 `public/js/config.js`를 열고 연필 아이콘 → 아래처럼 채운 뒤 **Commit changes**
   ```js
   self.BOGO_CONFIG = {
     firebase: {
       apiKey: "AIza...",
       authDomain: "bogo-queue-1a2b3.firebaseapp.com",
       projectId: "bogo-queue-1a2b3",
       storageBucket: "bogo-queue-1a2b3.appspot.com",
       messagingSenderId: "1234567890",
       appId: "1:1234567890:web:abcdef"
     },
     vapidKey: '여기에-키-쌍',
   };
   ```
   이 두 값은 앱 화면에 들어가는 공개 값이라 GitHub에 올려도 괜찮습니다.

### 2-5. 서버용 비밀 키 받기
**프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** → JSON 파일이 내려받아집니다.
> 이 파일은 데이터베이스 전체 권한을 가진 **비밀 키**입니다. **GitHub에 절대 올리지 말고**, 3단계에서 Vercel에만 붙여 넣으세요.

### 2-6. 국장님 캘린더 연결
1. https://console.cloud.google.com/apis/library/calendar-json.googleapis.com 에서 위쪽 프로젝트를 방금 만든 Firebase 프로젝트로 고르고 **사용**을 누릅니다.
2. 국장님 캘린더가 **공개 캘린더**면 끝입니다.
   공개가 아니면 구글 캘린더 → 해당 캘린더 **설정 및 공유 → 특정 사용자와 공유**에
   2-5 JSON 파일 안의 `client_email` 값(예: `firebase-adminsdk-xxxx@bogo-queue-1a2b3.iam.gserviceaccount.com`)을 **"모든 일정 세부정보 보기"**로 추가합니다.

---

## 3단계. Vercel에 비밀 값 넣기 (약 5분)

Vercel → 프로젝트 → **Settings → Environment Variables**에서 네 개를 추가합니다(Environment는 모두 체크 그대로).

| 이름 | 값 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 2-5 JSON 파일을 메모장으로 열어 **내용 전체**를 복사해 붙여 넣기 |
| `ADMIN_EMAILS` | 관리자 구글 이메일. 여러 명이면 쉼표로 (예: `me@gmail.com,sec@korea.kr`) |
| `ACCESS_CODE` | 처음 접수 코드 (예: `2580`). 나중에 관리 화면에서 바꿀 수 있음 |
| `CRON_SECRET` | 아무도 모를 긴 문자열 (영문·숫자 20자 이상, 예: `k8Tq2zLm9Xw4Rb7Nc1Vp`) |

추가한 뒤 **Deployments → 맨 위 배포의 ⋯ → Redeploy**를 눌러 새 값으로 다시 올립니다.

---

## 4단계. 1분마다 깨우기 (cron-job.org, 약 5분)

Vercel 무료 요금제는 예약 작업이 하루 1번뿐이라, 1분 판단(자동 호출·5분 시간 초과·재알림·회의 후 재개)은 외부 무료 서비스가 맡습니다.

1. https://cron-job.org 가입(무료)
2. **Create cronjob**
   - URL: `https://<앱이름>.vercel.app/api/tick?key=<CRON_SECRET 값>`
   - Execution schedule: **Every 1 minute**
   - (Advanced) Time zone: **Asia/Seoul**
3. 저장 후 1~2분 뒤 **History**에 `200 OK`가 찍히면 성공입니다.

> 22:00~06:00에는 서버가 스스로 쉬고, 밤 11시 30분 이후 한 번 개인정보를 지웁니다.
> Vercel도 하루 한 번(23:30경) 따로 불러서, cron-job.org가 멈춰도 밤 정리는 됩니다.

---

## 5단계. 첫 확인

1. PC에서 `https://<앱이름>.vercel.app/admin.html` → 구글 로그인 → 관리 화면이 열리면 성공.
   - **오늘 국장님 일정** 카드에 일정이 보이는지 확인("지금 다시 읽기" 버튼).
   - **접수 안내 QR**을 인쇄해 국장실 앞에 붙입니다.
2. 휴대폰으로 QR을 찍어 앱을 엽니다.
   - **아이폰**: Safari → 공유 버튼 → **홈 화면에 추가** → 홈 화면의 "보고 대기"로 다시 열기 (iOS 16.4 이상)
   - **안드로이드**: Chrome 메뉴 → **앱 설치** 또는 **홈 화면에 추가**
3. **알림 켜고 테스트하기** → 테스트 알림이 오면 번호표를 받을 수 있습니다.

---

## 동작 규칙 요약 (관리 화면 "운영 설정"에서 바꿀 수 있음)

| 항목 | 기본값 |
|---|---|
| 호출 | 서버가 자동으로. 보고자가 입실하며 **보고 시작**, 나오며 **밀어서 보고 완료** |
| 호출 후 제한 | 3분에 재알림, **5분 안에 보고 시작 없으면 자동 취소** 후 다음 사람 호출 |
| 곧 차례 알림 | 앞 대기 2명 이하 **그리고** 예상 20분 이내 |
| 바로 다음 차례 | 앞 사람이 호출·보고 중이면 "문 앞에서 대기" 알림 |
| 보고 가능 시간 | 09:00~18:00 − 국장님 캘린더 일정(끝나고 5분 여유) − 점심 12~13시 |
| 종일 일정 | 시간을 몰라 호출을 막지 않음(관리 화면에 표시만) |
| 예상 시각 | 실제 "보고 시작~완료" 평균으로 계산(기록 전에는 1인 10분). 신청 때 적는 소요 시간은 참고용 |
| 시간 지정 | 켜고 끌 수 있음, 건수 제한 없음, 오늘·지금부터 30분 이후, 10분 단위, 10분 전 알림 |
| 국장님 상태 | 자동(캘린더) / 부재(호출 멈춤) / 재실(지금 걸린 일정 무시하고 재개) |
| 완료 누락 | 평균+10분에 본인에게 알림, 평균+20분에 관리 화면 경고 → "대신 보고 완료" |
| 되돌리기 | 보고 완료 후 1분 안에 본인이 되돌릴 수 있음(방금 호출된 다음 사람은 대기로 복귀) |
| 개인정보 | 휴대폰 번호는 받지 않음. 실명·건명은 매일 밤 삭제. 번호표 기록은 90일 뒤 삭제 |

## 무료 사용량 걱정

Firebase 무료 요금제는 하루 읽기 5만 번·쓰기 2만 번까지입니다. 서버는 1분마다 **열려 있는 번호표만** 읽고 밤에는 쉬도록 만들어,
하루 30~50건 규모에서 읽기 1만 번 안팎으로 예상합니다. 한도를 넘으면 다음 날까지 멈출 뿐, 요금이 청구되지는 않습니다.

## 폴더 구성

```
bogo-vercel/
├─ public/               앱 화면 (Vercel이 그대로 올림)
│  ├─ index.html         신청자 화면
│  ├─ admin.html         관리 화면
│  ├─ sw.js              설치·푸시용 서비스 워커
│  └─ js/
│     ├─ config.js       ← 2-4에서 값 채우기
│     ├─ logic.js        모든 규칙 (앱과 서버가 함께 씀)
│     ├─ app.js, admin.js, ui.js
│     └─ api-firebase.js, api-demo.js
├─ api/
│  ├─ op.js              앱의 요청 창구 (번호표 발급·시작·완료·관리 기능)
│  └─ tick.js            1분마다 판단 (cron-job.org가 호출)
├─ lib/
│  ├─ server.js          서버 동작 (데이터베이스·푸시·캘린더)
│  └─ firebase.js        Firebase 연결 (비밀 키는 Vercel 환경 변수에서)
├─ firestore.rules       데이터 접근 규칙 → 2-3에서 콘솔에 붙여 넣기
├─ vercel.json           Vercel 설정 (서울 리전, 밤 정리 예약)
└─ tests/                규칙·서버 테스트 (`npm test`, 가짜 Firebase로 실행)
```

## 문제가 생기면

- **관리자 구글 로그인 창이 안 뜨거나 오류**: 2-2 "승인된 도메인"에 Vercel 주소를 넣었는지 확인.
- **"관리자로 등록되어 있지 않습니다"**: Vercel `ADMIN_EMAILS` 철자 확인 → Redeploy.
- **앱에서 "서버 오류(500)"**: Vercel `FIREBASE_SERVICE_ACCOUNT`에 JSON 전체가 들어갔는지 확인 → Redeploy.
  Vercel 프로젝트 → **Logs**에서 자세한 오류를 볼 수 있습니다.
- **테스트 알림이 안 와요**: `config.js`의 `vapidKey` · 아이폰은 홈 화면 앱에서 열었는지 · 휴대폰 알림 허용.
- **호출이 안 넘어가요 / 5분이 지나도 취소가 안 돼요**: cron-job.org History가 `200 OK`인지, URL의 key가 `CRON_SECRET`과 같은지 확인.
- **일정 카드에 "연동 문제"**: 2-6 Calendar API 사용 여부, 캘린더 공유 확인.
- 오류 문구나 화면을 그대로 Claude에게 보여 주시면 바로 고쳐 드립니다.
