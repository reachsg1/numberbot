// 실제 Firebase(무료 Spark 요금제로 충분) 연결: Vercel 환경 변수 FIREBASE_SERVICE_ACCOUNT의 서비스 계정 키를 씁니다.
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { createServer } from './server.js';

function serviceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw Object.assign(new Error('Vercel 환경 변수 FIREBASE_SERVICE_ACCOUNT가 비어 있습니다. 설치 안내 3-4를 확인해 주세요.'), { code: 'config' });
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const j = JSON.parse(text);
  if (j.private_key) j.private_key = j.private_key.replace(/\\n/g, '\n');
  return j;
}

// 서비스 계정으로 구글 API 토큰 받기(캘린더 읽기용)
let cached = { token: null, exp: 0, scope: '' };
async function googleToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.scope === scope && cached.exp - 120 > now) return cached.token;
  const sa = serviceAccount();
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  if (!r.ok) throw new Error('구글 인증에 실패했습니다(' + r.status + '). 서비스 계정 키를 확인해 주세요.');
  const j = await r.json();
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600), scope };
  return cached.token;
}

let server = null;
export function getServer() {
  if (server) return server;
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount()) });
  server = createServer({
    db: getFirestore(), auth: getAuth(), messaging: getMessaging(),
    env: { ADMIN_EMAILS: process.env.ADMIN_EMAILS, ACCESS_CODE: process.env.ACCESS_CODE },
    googleToken,
  });
  return server;
}
