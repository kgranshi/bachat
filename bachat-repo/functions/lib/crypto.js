/**
 * Pure Web Crypto utilities for Cloudflare Pages Functions & Node 20+
 * - PBKDF2-SHA256 salted password / PIN hashing
 * - HMAC-SHA256 JWT signing & verification
 * - VAPID JWT (ES256) + RFC 8291 (aes128gcm) Web Push encryption (zero npm deps)
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function randomHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ========== PBKDF2 PASSWORD / PIN HASHING ==========
export async function hashSecret(secret) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(String(secret)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return 'pbkdf2$' + b64urlEncode(salt) + '$' + b64urlEncode(new Uint8Array(bits));
}

export async function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (!stored.startsWith('pbkdf2$')) {
    return String(secret) === stored;
  }
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const salt = b64urlDecode(parts[1]);
  const expected = b64urlDecode(parts[2]);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(String(secret)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ========== HMAC-SHA256 JWT ==========
export async function signJwt(payload, secret, ttlSec = 60 * 60 * 24 * 30) {
  const header = b64urlEncode(textEncoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const bodyObj = Object.assign({}, payload, { iat: now, exp: now + ttlSec });
  const body = b64urlEncode(textEncoder.encode(JSON.stringify(bodyObj)));
  const signingInput = header + '.' + body;
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(signingInput));
  return signingInput + '.' + b64urlEncode(new Uint8Array(sig));
}

export async function verifyJwt(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signingInput = parts[0] + '.' + parts[1];
    const sig = b64urlDecode(parts[2]);
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify('HMAC', key, sig, textEncoder.encode(signingInput));
    if (!ok) return null;
    const payload = JSON.parse(textDecoder.decode(b64urlDecode(parts[1])));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ========== VAPID & RFC 8291 WEB PUSH (aes128gcm) ==========
export async function generateVapidKeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    publicKey: b64urlEncode(rawPub),
    privateJwk: jwk
  };
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw',
    salt.length ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const input = concatBytes(info, new Uint8Array([1]));
  const out = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
  return out.slice(0, length);
}

async function signVapidJwt(audience, subject, privateJwk) {
  const header = b64urlEncode(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = b64urlEncode(textEncoder.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const signingInput = header + '.' + payload;
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, textEncoder.encode(signingInput))
  );
  return signingInput + '.' + b64urlEncode(sig);
}

export async function encryptWebPushPayload(payloadText, p256dhB64, authB64) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);

  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256)
  );

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const prkKey = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo = concatBytes(textEncoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, textEncoder.encode('Content-Encoding: nonce\0'), 12);

  const plainBytes = textEncoder.encode(payloadText);
  const padded = concatBytes(plainBytes, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, 4096, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concatBytes(header, ciphertext);
}

export async function sendWebPush(subscription, payloadObj, vapid) {
  const url = new URL(subscription.endpoint);
  const audience = url.origin;
  const jwt = await signVapidJwt(audience, vapid.subject || 'mailto:admin@bachat.local', vapid.privateJwk);
  const body = await encryptWebPushPayload(JSON.stringify(payloadObj), subscription.p256dh, subscription.auth);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high'
    },
    body
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
}
