/**
 * Self-contained Scheduled Cloudflare Worker — 2nd Friday 6:00 PM Nepal Time (UTC+5:45) Reminder
 * - Can be copy-pasted directly into Cloudflare Dashboard Worker Quick Edit (no external imports!)
 * - Shares the exact same D1 database (`DB`) as your main Bachat app.
 * - Sends standard Web Push (VAPID + RFC 8291) even when everyone's phone app is closed,
 *   and logs a group announcement in `chat_messages`.
 */

const textEncoder = new TextEncoder();

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function randomHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
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

async function encryptWebPushPayload(payloadText, p256dhB64, authB64) {
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

async function sendWebPush(subscription, payloadObj, vapid) {
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

const BS_MONTHS_NP = ['बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज', 'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फाल्गुन', 'चैत'];
const BS_CAL_DATA = {
  2080: { start: [2023, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2081: { start: [2024, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2082: { start: [2025, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] },
  2083: { start: [2026, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30] },
  2084: { start: [2027, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30] },
  2085: { start: [2028, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2086: { start: [2029, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] }
};

function getNepalNow() {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 45) * 60000);
}

function adToBsParts(dt) {
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
  const utc = Date.UTC(y, m - 1, d);
  for (const [yr, info] of Object.entries(BS_CAL_DATA)) {
    const s = info.start;
    const startUtc = Date.UTC(s[0], s[1] - 1, s[2]);
    const yearLen = info.lens.reduce((a, b) => a + b, 0);
    if (utc >= startUtc && utc < startUtc + yearLen * 86400000) {
      let days = Math.round((utc - startUtc) / 86400000);
      let bm = 0;
      for (; bm < 12; bm++) {
        if (days < info.lens[bm]) break;
        days -= info.lens[bm];
      }
      return { year: parseInt(yr, 10), monthIndex: bm, day: days + 1 };
    }
  }
  return null;
}

function nthWeekdayOfBsMonth(year, monthIndex, weekday, n) {
  const info = BS_CAL_DATA[year];
  if (!info) return null;
  let days = 0;
  for (let i = 0; i < monthIndex; i++) days += info.lens[i];
  const s = info.start;
  const first = new Date(Date.UTC(s[0], s[1] - 1, s[2]) + days * 86400000);
  const firstWd = first.getUTCDay();
  const day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
  if (day > info.lens[monthIndex]) return null;
  return day;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const nepal = getNepalNow();
    const bs = adToBsParts(nepal);
    if (!bs) return;

    const secondFridayDay = nthWeekdayOfBsMonth(bs.year, bs.monthIndex, 5, 2);
    if (!secondFridayDay || bs.day !== secondFridayDay) return;
    if (nepal.getUTCHours() < 18) return;

    const jobKey = `remind_${bs.year}_${bs.monthIndex}`;
    const already = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(jobKey).first();
    if (already) return;

    const nowIso = new Date().toISOString();
    const msgText =
      `🔔 बचत भेला रिमाइन्डर (${BS_MONTHS_NP[bs.monthIndex]} ${bs.year})\n\n` +
      `भोलि नेपाली महिनाको दोस्रो शनिबार समूहको बचत भेला बस्ने छ।\n` +
      `कृपया समयमै उपस्थित भई अनिवार्य रकम बुझाउनुहोला।`;

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
         VALUES (?, 'group', 'system', 'समूह सूचना', 'system', ?, 'auto_group', NULL, ?)`
      )
      .bind('rem_' + bs.year + '_' + bs.monthIndex + '_' + randomHex(3), msgText, nowIso)
      .run();

    const vapidRow = await env.DB.prepare("SELECT value FROM system_secrets WHERE key = 'vapid_keys'").first();
    if (vapidRow && vapidRow.value) {
      const vapid = JSON.parse(vapidRow.value);
      const subs = await env.DB.prepare('SELECT sub_key, endpoint, p256dh, auth FROM push_subscriptions').all();
      for (const s of subs.results || []) {
        try {
          const res = await sendWebPush(s, {
            title: '🔔 भोलि बचत भेला छ',
            body: `${BS_MONTHS_NP[bs.monthIndex]} महिनाको दोस्रो शनिबार भेला — समयमै उपस्थित हुनुहोला।`,
            tag: jobKey
          }, vapid);
          if (res.gone) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
          }
        } catch (e) {}
      }
    }

    await env.DB
      .prepare('INSERT OR IGNORE INTO schedule_log (job_key, ran_at) VALUES (?, ?)')
      .bind(jobKey, nowIso)
      .run();
  }
};
