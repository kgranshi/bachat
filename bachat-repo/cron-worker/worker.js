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
  return new Date(Date.now() + (5 * 60 + 45) * 60000);
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

function normalizeMobile(m) {
  const digits = String(m || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : String(m || '').trim();
}

async function getSecretJson(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_secrets WHERE key = ?').bind(key).first();
    return row && row.value ? JSON.parse(row.value) : null;
  } catch (e) {
    return null;
  }
}

async function setSecretJson(db, key, val) {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO system_secrets (key, value, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .bind(key, JSON.stringify(val), nowIso)
    .run();
}

async function evaluateCriticalHealthErrors(db) {
  const errors = [];
  let stateRow = null;
  try {
    stateRow = await db.prepare("SELECT version, data_json, updated_at FROM group_state WHERE id = 'main'").first();
  } catch (e) {
    errors.push({ code: 'db_read', title: 'D1 डाटाबेस पढ्न त्रुटि देखियो' });
    return errors;
  }
  if (!stateRow || !stateRow.data_json) return errors;

  let st = null;
  try {
    st = JSON.parse(stateRow.data_json);
  } catch (e) {
    errors.push({ code: 'state_json', title: 'मुख्य हिसाब डाटा (JSON) बिग्रिएको देखियो' });
    return errors;
  }

  const members = Array.isArray(st.members) ? st.members : [];
  const activeMembers = members.filter((m) => m && m.active !== false);
  const months = Array.isArray(st.months) ? st.months : [];
  const currentMonth = months.find((m) => m && m.id === st.currentMonthId) || null;

  const sumMemberLoans = activeMembers.reduce((s, m) => s + (Number(m.outstandingLoan) || 0), 0);
  const monthLoanTotal = currentMonth ? (Number(currentMonth.outstandingLoans) || 0) : sumMemberLoans;
  const loanMismatch = currentMonth && currentMonth.status === 'closed'
    ? Math.round((monthLoanTotal - sumMemberLoans) * 100) / 100
    : 0;
  if (Math.abs(loanMismatch) > 1) {
    errors.push({ code: 'loan_mismatch', title: 'ऋण हिसाब फरक देखियो (रु. ' + loanMismatch + ')' });
  }

  if (currentMonth && typeof currentMonth.cashInHand === 'number' && currentMonth.cashInHand < -1) {
    errors.push({ code: 'neg_cash', title: 'समूहको नगद मौज्दात ऋणात्मक देखियो' });
  }

  const mobCounts = new Map();
  for (const m of activeMembers) {
    const mob = normalizeMobile(m.mobile);
    if (mob) mobCounts.set(mob, (mobCounts.get(mob) || 0) + 1);
  }
  const dupMob = Array.from(mobCounts.values()).filter((n) => n > 1).length;
  if (dupMob > 0) {
    errors.push({ code: 'dup_mobile', title: 'सक्रिय सदस्यको मोबाइल नम्बर दोहोरिएको देखियो' });
  }

  const stateBytes = String(stateRow.data_json || '').length;
  if (stateBytes >= 2 * 1024 * 1024) {
    errors.push({ code: 'state_size', title: 'मुख्य डाटा साइज सीमा नजिक पुग्यो (' + Math.round(stateBytes / 1024) + ' KB)' });
  }
  return errors;
}

function getResendKey(env) {
  return String((env && (env.RESEND_API_KEY || env.RESEND_KEY || env.RESEND_API || env.resend_api_key)) || '').trim();
}

async function sendAdminHealthEmail(env, st, errors, nepalDate) {
  const toEmail = String(
    (env && env.ADMIN_EMAIL) ||
    (st && st.admin && st.admin.email) ||
    (st && st.settings && st.settings.appOwner && st.settings.appOwner.email) ||
    ''
  ).trim();
  if (!toEmail || !toEmail.includes('@')) {
    return { sent: false, status: 'no_admin_email', to: '' };
  }

  const groupName = (st && st.group && st.group.name) || 'समूह बचत';
  const subject = `🚨 ${groupName}: प्रणाली स्वास्थ्य त्रुटि (${errors.length}) — ${nepalDate}`;
  const lines = [
    `${groupName} को मासिक स्वचालित स्वास्थ्य जाँच (${nepalDate}) मा निम्न गम्भीर त्रुटि फेला परेको छ:`,
    ''
  ];
  errors.forEach((e, idx) => {
    lines.push(`${idx + 1}. ${e.title}`);
  });
  lines.push('');
  lines.push('कृपया तुरुन्त Admin प्यानल → सेटिङ → "प्रणाली स्वास्थ्य र भण्डारण" खोलेर जाँच गर्नुहोस्।');
  lines.push('स्वास्थ्य जाँच नखोलेसम्म हरेक १ घण्टामा Admin मोबाइलमा Push सूचना गइरहनेछ।');
  const bodyText = lines.join('\n');

  try {
    const resendKey = getResendKey(env);
    if (resendKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + resendKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.ALERT_FROM_EMAIL || 'Bachat System <onboarding@resend.dev>',
          to: [toEmail],
          subject,
          text: bodyText
        })
      });
      return { sent: res.ok, status: res.ok ? 'sent_resend' : 'error_resend_' + res.status, to: toEmail };
    }

    if (env && env.BREVO_API_KEY) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: groupName, email: env.ALERT_FROM_EMAIL || 'noreply@bachat.gopalkoirala.com.np' },
          to: [{ email: toEmail }],
          subject,
          textContent: bodyText
        })
      });
      return { sent: res.ok, status: res.ok ? 'sent_brevo' : 'error_brevo_' + res.status, to: toEmail };
    }

    if (env && env.SEND_EMAIL && typeof env.SEND_EMAIL.send === 'function') {
      const mod = await import('cloudflare:email');
      const fromAddr = env.ALERT_FROM_EMAIL || 'noreply@bachat.gopalkoirala.com.np';
      const subjectB64 = btoa(String.fromCharCode(...textEncoder.encode(subject)));
      const rawMime =
        `From: ${fromAddr}\r\n` +
        `To: ${toEmail}\r\n` +
        `Subject: =?UTF-8?B?${subjectB64}?=\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
        bodyText;
      const msg = new mod.EmailMessage(fromAddr, toEmail, rawMime);
      await env.SEND_EMAIL.send(msg);
      return { sent: true, status: 'sent_cf_email', to: toEmail };
    }

    return { sent: false, status: 'provider_not_configured', to: toEmail };
  } catch (err) {
    return { sent: false, status: 'send_failed', to: toEmail, error: err && err.message ? err.message : String(err) };
  }
}

async function getVapidKeysForCron(env) {
  if (env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) {
    return {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateJwk: typeof env.VAPID_PRIVATE_JWK === 'string' ? JSON.parse(env.VAPID_PRIVATE_JWK) : env.VAPID_PRIVATE_JWK,
      subject: env.VAPID_SUBJECT || 'mailto:admin@bachat.local'
    };
  }
  const vapidRow = await env.DB.prepare("SELECT value FROM system_secrets WHERE key = 'vapid_keys'").first();
  if (!vapidRow || !vapidRow.value) return null;
  return JSON.parse(vapidRow.value);
}

async function sendAdminHealthPush(env, errors, countNum) {
  const db = env.DB;
  const vapid = await getVapidKeysForCron(env);
  if (!vapid) return 0;
  const subs = await db.prepare("SELECT sub_key, endpoint, p256dh, auth FROM push_subscriptions WHERE user_key = 'admin'").all();
  let sent = 0;
  const firstTitle = (errors[0] && errors[0].title) || 'प्रणाली त्रुटि';
  const payload = {
    title: '🚨 प्रणाली स्वास्थ्यमा त्रुटि (' + errors.length + ')',
    body: firstTitle + ' — नहेरेसम्म हरेक घण्टा अलर्ट आउनेछ (#' + countNum + ')। कृपया "प्रणाली स्वास्थ्य" खोल्नुहोस्।',
    tag: 'admin-health-alert',
    renotify: true,
    requireInteraction: true,
    data: { openHealth: true, url: './?open=health' }
  };
  for (const s of subs.results || []) {
    try {
      const res = await sendWebPush(s, payload, vapid);
      if (res.ok) sent++;
      if (res.gone) {
        await db.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
      }
    } catch (e) {}
  }
  return sent;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const nepal = getNepalNow();
    const nepalHour = nepal.getUTCHours();
    const nepalDate = nepal.toISOString().slice(0, 10);
    const nowIso = new Date(Date.now()).toISOString();
    const bs = adToBsParts(nepal);
    const secondFridayDay = bs ? nthWeekdayOfBsMonth(bs.year, bs.monthIndex, 5, 2) : null;
    const isSecondFriday = !!(bs && secondFridayDay && bs.day === secondFridayDay);

    // १. यदि अघिल्लो स्वास्थ्य जाँचको त्रुटि Admin ले नहेरेको भए हरेक १ घण्टामा Admin लाई मात्र Push
    const existingAlert = await getSecretJson(env.DB, 'health_alert_state');
    if (existingAlert && existingAlert.active && !existingAlert.acknowledgedAt) {
      const lastMs = Date.parse(existingAlert.lastNotifiedAt || 0) || 0;
      if (Date.now() - lastMs >= 55 * 60 * 1000) {
        const errors = await evaluateCriticalHealthErrors(env.DB);
        if (errors.length > 0) {
          const nextCount = Number(existingAlert.notifyCount || 0) + 1;
          await sendAdminHealthPush(env, errors, nextCount);
          await setSecretJson(
            env.DB,
            'health_alert_state',
            Object.assign({}, existingAlert, {
              errorCount: errors.length,
              errorSignature: errors.map((e) => e.code + ':' + e.title).join('|'),
              summary: errors[0].title,
              lastNotifiedAt: nowIso,
              notifyCount: nextCount
            })
          );
        } else {
          await setSecretJson(
            env.DB,
            'health_alert_state',
            Object.assign({}, existingAlert, { active: false, autoClearedAt: nowIso })
          );
        }
      }
    }

    if (!isSecondFriday) return;

    // २. काम दोस्रो: हरेक नेपाली महिनाको दोस्रो शुक्रबार बिहान (>= 6:00 AM NPT) स्वतः स्वास्थ्य जाँच
    if (nepalHour >= 6) {
      const healthKey = `health_check_${bs.year}_${bs.monthIndex}`;
      const healthDone = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(healthKey).first();
      if (!healthDone) {
        const errors = await evaluateCriticalHealthErrors(env.DB);
        const errSig = errors.map((e) => e.code + ':' + e.title).join('|');
        const curAlert = await getSecretJson(env.DB, 'health_alert_state');
        if (errors.length > 0) {
          let stObj = null;
          try {
            const gs = await env.DB.prepare("SELECT data_json FROM group_state WHERE id = 'main'").first();
            stObj = gs && gs.data_json ? JSON.parse(gs.data_json) : null;
          } catch (e) {}
          const emailRes = await sendAdminHealthEmail(env, stObj, errors, nepalDate);
          await sendAdminHealthPush(env, errors, 1);
          const nextAlert = {
            active: true,
            healthKey,
            alertDate: nepalDate,
            detectedAt: nowIso,
            acknowledgedAt: null,
            acknowledgedKey: null,
            acknowledgedSignature: null,
            errorCount: errors.length,
            errorSignature: errSig,
            summary: errors[0].title,
            emailStatus: emailRes.status,
            emailTo: emailRes.to || '',
            emailSentAt: emailRes.sent ? nowIso : null,
            lastNotifiedAt: nowIso,
            notifyCount: 1
          };
          await setSecretJson(env.DB, 'health_alert_state', nextAlert);
        } else if (curAlert && curAlert.active) {
          await setSecretJson(env.DB, 'health_alert_state', Object.assign({}, curAlert, { active: false, autoClearedAt: nowIso }));
        }
        await env.DB
          .prepare('INSERT OR IGNORE INTO schedule_log (job_key, ran_at) VALUES (?, ?)')
          .bind(healthKey, nowIso)
          .run();
      }
    }

    // ३. काम पहिलो: हरेक नेपाली महिनाको दोस्रो शुक्रबार बेलुकी (>= 18:00 NPT) बैठक रिमाइन्डर (महिनामा एक पटक मात्र)
    if (nepalHour < 18) return;

    const jobKey = `remind_${bs.year}_${bs.monthIndex}`;
    const already = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(jobKey).first();
    if (already) return;

    const satDay = bs.day + 1;
    const msgText =
      `🔔 दोस्रो शनिबार — बचत बैठक सूचना (${BS_MONTHS_NP[bs.monthIndex]} ${bs.year})\n` +
      `भोलि (${BS_MONTHS_NP[bs.monthIndex]} ${satDay} गते, दोस्रो शनिबार) समूहको नियमित मासिक बचत बैठक बस्ने छ।\n` +
      `सदस्यज्यूहरूले आफ्नो पासबुक हेरी तोकिएको समयमा अनिवार्य बचत, ब्याज तथा किस्ता रकमसहित उपस्थित भइदिनुहोला। धन्यवाद!`;

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
         VALUES (?, 'group', 'system', 'समूह सूचना', 'system', ?, 'auto_group', NULL, ?)`
      )
      .bind('rem_fri_' + bs.year + '_' + bs.monthIndex, msgText, nowIso)
      .run();

    const vapid = await getVapidKeysForCron(env);
    if (vapid) {
      const subs = await env.DB.prepare('SELECT sub_key, endpoint, p256dh, auth FROM push_subscriptions').all();
      for (const s of subs.results || []) {
        try {
          const res = await sendWebPush(s, {
            title: '🔔 भोलि बचत बैठक छ',
            body: `${BS_MONTHS_NP[bs.monthIndex]} ${satDay} गते (दोस्रो शनिबार) — समयमै उपस्थित हुनुहोला।`,
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
