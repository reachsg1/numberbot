// 표준 웹 푸시(RFC 8291 암호화 + RFC 8292 VAPID) — 외부 서비스·라이브러리 없이 Node 기본 기능으로 구현
import crypto from 'node:crypto';

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// VAPID 키 한 쌍 만들기 (서버가 처음 한 번 만들어 저장)
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// 메시지 암호화 (aes128gcm). salt·서버 임시키는 테스트에서만 지정
export function encrypt(payload, sub, { salt = crypto.randomBytes(16), asPrivate } = {}) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(unb64u(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// VAPID 서명(JWT, ES256)
export function vapidHeader(endpoint, vapid, subject = 'mailto:admin@example.com') {
  const aud = new URL(endpoint).origin;
  const pub = unb64u(vapid.publicKey);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const enc = o => b64u(JSON.stringify(o));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// 보내기. 결과: { ok, status, gone } — gone이면 구독이 끊긴 것(삭제 대상)
export async function sendWebPush(sub, payloadObj, vapid, { ttl = 600, urgency = 'high', fetchFn = fetch, subject } = {}) {
  const body = encrypt(JSON.stringify(payloadObj), sub);
  const r = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: vapidHeader(sub.endpoint, vapid, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
    body,
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}
