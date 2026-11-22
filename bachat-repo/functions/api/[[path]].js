/**
 * Cloudflare Pages Function — Complete API for Samuha Bachat (समूह बचत)
 * Handles:
 *  - Auth (Admin A, Admin B, Member unified login, PBKDF2 hashes, JWT, rate limiting)
 *  - Versioned Accounting State (D1 + Idempotent Outbox txnId + Closed-Month Immutability)
 *  - Media & Signature Storage (Cloudflare R2)
 *  - Backup Import (compatible with old Firebase/localStorage JSON backups) & Export
 *  - Dedicated Chat table (no overwrite conflicts)
 *  - Standard Web Push (VAPID + RFC 8291, zero Firebase/OneSignal dependency)
 */

import {
  hashSecret,
  verifySecret,
  signJwt,
  verifyJwt,
  generateVapidKeyPair,
  sendWebPush,
  randomHex
} from '../lib/crypto.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function defaultState() {
  return {
    version: 1,
    _updatedAt: 0,
    group: { name: 'समूह बचत', address: '', established: '', logo: '💰' },
    admin: null,
    settings: {
      monthlySaving: 500,
      interestRate: 2,
      fineRate: 5,
      kittaReduceFee: 2,
      exitFee: 3,
      closePin: '',
      accountsWriterUsername: ''
    },
    treasurer: null,
    secondaryAdmins: [],
    members: [],
    months: [],
    currentMonthId: null,
    migrationDone: false,
    migration: { cash: 0, loans: {}, advances: {}, kittas: {} },
    pinRequests: [],
    complaints: [],
    rules: [],
    meetings: [],
    suggestions: [],
    activityLog: [],
    bills: {},
    billSeq: {},
    ruleChangeLog: [],
    pendingRuleEdits: [],
    scheduleLog: {},
    chat: { group: [] }
  };
}

async function getOrCreateSecret(db, key, factory) {
  const row = await db.prepare('SELECT value FROM system_secrets WHERE key = ?').bind(key).first();
  if (row && row.value) return row.value;
  const val = await factory();
  await db
    .prepare('INSERT OR IGNORE INTO system_secrets (key, value, created_at) VALUES (?, ?, ?)')
    .bind(key, val, new Date().toISOString())
    .run();
  const row2 = await db.prepare('SELECT value FROM system_secrets WHERE key = ?').bind(key).first();
  return row2 ? row2.value : val;
}

async function getJwtSecret(env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  return getOrCreateSecret(env.DB, 'jwt_secret', async () => randomHex(32));
}

async function getVapidKeys(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) {
    return {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK),
      subject: env.VAPID_SUBJECT || 'mailto:admin@bachat.local'
    };
  }
  const raw = await getOrCreateSecret(env.DB, 'vapid_keys', async () => {
    const kp = await generateVapidKeyPair();
    return JSON.stringify({
      publicKey: kp.publicKey,
      privateJwk: kp.privateJwk,
      subject: env.VAPID_SUBJECT || 'mailto:admin@bachat.local'
    });
  });
  return JSON.parse(raw);
}

function normalizeMobile(m) {
  const digits = String(m || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : String(m || '').trim();
}

function stripSecretsFromState(data) {
  const clean = JSON.parse(JSON.stringify(data || defaultState()));
  if (clean.admin) {
    clean.admin = {
      name: clean.admin.name || 'Admin',
      username: clean.admin.username || '',
      mobile: clean.admin.mobile || '',
      email: clean.admin.email || '',
      memberId: null,
      hasPin: !!(clean.admin.pin || clean.admin.hasPin)
    };
  }
  if (clean.settings) {
    clean.settings = Object.assign({}, clean.settings, { closePin: '' });
  }
  if (clean.treasurer && typeof clean.treasurer === 'object') {
    clean.treasurer = {
      memberId: clean.treasurer.memberId || '',
      name: clean.treasurer.name || '',
      username: clean.treasurer.username || '',
      active: clean.treasurer.active !== false,
      hasPin: !!(clean.treasurer.pin || clean.treasurer.hasPin)
    };
  }
  if (Array.isArray(clean.secondaryAdmins)) {
    clean.secondaryAdmins = clean.secondaryAdmins.map((s) => ({
      name: s.name || s.username || '',
      username: s.username || '',
      active: s.active !== false,
      hasPin: !!(s.pin || s.hasPin)
    }));
  }
  if (Array.isArray(clean.members)) {
    clean.members = clean.members.map((m) => {
      const copy = Object.assign({}, m);
      copy.hasPin = !!(m.pin || m.hasPin);
      delete copy.pin;
      return copy;
    });
  }
  delete clean.fcmTokens;
  delete clean.chat;
  return clean;
}

function sanitizeStateForRole(state, user, pinFlags, termsAcceptances) {
  const out = stripSecretsFromState(state);
  if (Array.isArray(out.members)) {
    out.members = out.members.map((m) => {
      if (!m || !m.id) return m;
      let next = m;
      if (pinFlags) {
        const flag = !!pinFlags[String(m.id)];
        if (next.mustChangePin !== flag) {
          next = Object.assign({}, next, { mustChangePin: flag });
        }
      }
      const ta = termsAcceptances && termsAcceptances['mem:' + String(m.id)];
      if (user.role === 'member') {
        if (String(m.id) === String(user.memberId)) {
          if (ta && Number(ta.version) >= Number(next.termsAcceptedVersion || 0)) {
            next = Object.assign({}, next, {
              termsAcceptedVersion: Number(ta.version),
              termsAcceptedAt: ta.acceptedAt || next.termsAcceptedAt || null
            });
          }
        } else {
          if (next.termsAcceptedVersion !== undefined || next.termsAcceptedAt !== undefined) {
            next = Object.assign({}, next);
            delete next.termsAcceptedVersion;
            delete next.termsAcceptedAt;
          }
        }
      } else if (ta && Number(ta.version) >= Number(next.termsAcceptedVersion || 0)) {
        next = Object.assign({}, next, {
          termsAcceptedVersion: Number(ta.version),
          termsAcceptedAt: ta.acceptedAt || next.termsAcceptedAt || null
        });
      }
      return next;
    });
  }
  if (user.role === 'member') {
    out.pinRequests = (out.pinRequests || []).filter((r) => r.memberId === user.memberId);
    out.complaints = (out.complaints || []).filter((c) => c.memberId === user.memberId);
    out.suggestions = (out.suggestions || []).filter((s) => s.memberId === user.memberId);
    out.secondaryAdmins = [];
    out.treasurer = null;
  }
  return out;
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const binStr = atob(m[2]);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  let ext = 'bin';
  if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
  else if (mime.includes('png')) ext = 'png';
  else if (mime.includes('webp')) ext = 'webp';
  else if (mime.includes('mp4')) ext = 'mp4';
  else if (mime.includes('webm')) ext = 'webm';
  return { mime, bytes, ext };
}

async function uploadDataUrlToR2(env, category, idHint, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  if (!env.MEDIA) {
    // No R2 binding configured yet: keep small items, skip huge videos
    if (dataUrl.length > 180000) return '';
    return dataUrl;
  }
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return '';
  const key = `media/${category}/${idHint}-${Date.now()}-${randomHex(4)}.${parsed.ext}`;
  await env.MEDIA.put(key, parsed.bytes, {
    httpMetadata: { contentType: parsed.mime }
  });
  return '/api/' + key;
}

async function offloadHeavyMediaToR2(env, state) {
  if (!state || typeof state !== 'object') return state;
  if (state.group) {
    if (state.group.logoImage && state.group.logoImage.startsWith('data:')) {
      state.group.logoImage = await uploadDataUrlToR2(env, 'group', 'logo', state.group.logoImage);
    }
    if (state.group.welcomeVideo && state.group.welcomeVideo.startsWith('data:')) {
      state.group.welcomeVideo = await uploadDataUrlToR2(env, 'group', 'welcome', state.group.welcomeVideo);
    }
  }
  if (state.settings && state.settings.theme && state.settings.theme.photo && state.settings.theme.photo.startsWith('data:')) {
    state.settings.theme.photo = await uploadDataUrlToR2(env, 'theme', 'bg', state.settings.theme.photo);
  }
  if (Array.isArray(state.members)) {
    for (const m of state.members) {
      if (!m) continue;
      if (m.photo && m.photo.startsWith('data:')) {
        m.photo = await uploadDataUrlToR2(env, 'members', `${m.id}-photo`, m.photo);
      }
      if (m.idCardPhoto && m.idCardPhoto.startsWith('data:')) {
        m.idCardPhoto = await uploadDataUrlToR2(env, 'members', `${m.id}-id`, m.idCardPhoto);
      }
    }
  }
  if (Array.isArray(state.months)) {
    for (const mo of state.months) {
      if (!mo || !Array.isArray(mo.loansGiven)) continue;
      for (let i = 0; i < mo.loansGiven.length; i++) {
        const l = mo.loansGiven[i];
        if (l && l.signature && l.signature.startsWith('data:')) {
          l.signature = await uploadDataUrlToR2(env, 'signatures', `${mo.id}-${l.memberId}-${i}`, l.signature);
        }
      }
    }
  }
  return state;
}

async function loadStateRow(db) {
  const row = await db.prepare("SELECT version, data_json, updated_at FROM group_state WHERE id = 'main'").first();
  if (!row) return { exists: false, version: 0, data: defaultState(), updatedAt: null };
  return {
    exists: true,
    version: Number(row.version) || 1,
    data: JSON.parse(row.data_json),
    updatedAt: row.updated_at
  };
}

async function getPinResetFlags(db) {
  try {
    const row = await db.prepare("SELECT value FROM system_secrets WHERE key = 'pin_reset_flags'").first();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

async function setPinResetFlag(db, memberId, mustChange) {
  if (!memberId) return;
  const flags = await getPinResetFlags(db);
  if (mustChange) flags[String(memberId)] = true;
  else delete flags[String(memberId)];
  await db
    .prepare(
      `INSERT INTO system_secrets (key, value, created_at) VALUES ('pin_reset_flags', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`
    )
    .bind(JSON.stringify(flags), new Date().toISOString())
    .run();
}

async function getTermsAcceptances(db) {
  try {
    const row = await db.prepare("SELECT value FROM system_secrets WHERE key = 'terms_acceptances'").first();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

async function recordTermsAcceptances(db, keys, record) {
  const all = await getTermsAcceptances(db);
  for (const k of keys) {
    if (!k) continue;
    all[String(k)] = record;
  }
  await db
    .prepare(
      `INSERT INTO system_secrets (key, value, created_at) VALUES ('terms_acceptances', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`
    )
    .bind(JSON.stringify(all), new Date().toISOString())
    .run();
  return all;
}

function getUserTermsAcceptance(allAcceptances, user) {
  if (!allAcceptances || !user) return null;
  const candidates = [];
  if (user.memberId) candidates.push('mem:' + String(user.memberId));
  const uk = userReadKey(user);
  if (uk && !candidates.includes(uk)) candidates.push(uk);
  let best = null;
  for (const k of candidates) {
    const rec = allAcceptances[k];
    if (rec && (!best || Number(rec.version || 0) >= Number(best.version || 0))) {
      best = rec;
    }
  }
  return best;
}

function mergeTermsAcceptancesIntoMembers(members, allAcceptances) {
  if (!Array.isArray(members) || !allAcceptances) return members;
  return members.map((m) => {
    if (!m || !m.id) return m;
    const ta = allAcceptances['mem:' + String(m.id)];
    if (ta && Number(ta.version || 0) >= Number(m.termsAcceptedVersion || 0)) {
      return Object.assign({}, m, {
        termsAcceptedVersion: Number(ta.version),
        termsAcceptedAt: ta.acceptedAt || m.termsAcceptedAt || null
      });
    }
    return m;
  });
}

async function getAppUpdateAcks(db) {
  try {
    const row = await db.prepare("SELECT value FROM system_secrets WHERE key = 'app_update_acks'").first();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

async function recordAppUpdateAcks(db, keys, record) {
  const all = await getAppUpdateAcks(db);
  for (const k of keys) {
    if (!k) continue;
    all[String(k)] = record;
  }
  await db
    .prepare(
      `INSERT INTO system_secrets (key, value, created_at) VALUES ('app_update_acks', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`
    )
    .bind(JSON.stringify(all), new Date().toISOString())
    .run();
  return all;
}

function getUserAppUpdateAck(allAcks, user) {
  if (!allAcks || !user) return null;
  const candidates = [];
  if (user.memberId) candidates.push('mem:' + String(user.memberId));
  const uk = userReadKey(user);
  if (uk && !candidates.includes(uk)) candidates.push(uk);
  let best = null;
  for (const k of candidates) {
    const rec = allAcks[k];
    if (rec && (!best || String(rec.answeredAt || '') >= String(best.answeredAt || ''))) {
      best = rec;
    }
  }
  return best;
}

function userReadKey(user) {
  if (!user) return '';
  if (user.role === 'member' && user.memberId) return 'mem:' + String(user.memberId);
  if (user.role === 'treasurer' && user.username) return 'trs:' + String(user.username);
  if (user.role === 'admin_ro' && user.username) return 'sec:' + String(user.username);
  return 'admin:' + String(user.username || 'admin');
}

async function getAllReadStates(db) {
  try {
    const row = await db.prepare("SELECT value FROM system_secrets WHERE key = 'user_read_states'").first();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

async function getUserReadState(db, user) {
  const key = userReadKey(user);
  if (!key) return {};
  const all = await getAllReadStates(db);
  return all[key] || {};
}

async function saveUserReadState(db, user, patch) {
  const key = userReadKey(user);
  if (!key || !patch || typeof patch !== 'object') return {};
  const all = await getAllReadStates(db);
  const prev = all[key] || {};
  const next = Object.assign({}, prev);
  if (patch.chatReadAt && (!prev.chatReadAt || patch.chatReadAt > prev.chatReadAt)) next.chatReadAt = String(patch.chatReadAt);
  if (patch.chatReadId) next.chatReadId = String(patch.chatReadId);
  if (patch.activityReadAt && (!prev.activityReadAt || patch.activityReadAt > prev.activityReadAt)) next.activityReadAt = String(patch.activityReadAt);
  if (patch.fbReadAt && (!prev.fbReadAt || patch.fbReadAt > prev.fbReadAt)) next.fbReadAt = String(patch.fbReadAt);
  if (Array.isArray(patch.csReadMonths)) {
    const merged = Array.from(new Set([...(Array.isArray(prev.csReadMonths) ? prev.csReadMonths : []), ...patch.csReadMonths.map(String)]));
    next.csReadMonths = merged.slice(-120);
  }
  all[key] = next;
  await db
    .prepare(
      `INSERT INTO system_secrets (key, value, created_at) VALUES ('user_read_states', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`
    )
    .bind(JSON.stringify(all), new Date().toISOString())
    .run();
  return next;
}

async function loadChatFromDb(db) {
  const rows = await db
    .prepare("SELECT id, channel, from_id, from_name, from_role, text, type, bill_id, created_at FROM chat_messages WHERE channel = 'group' ORDER BY created_at ASC LIMIT 800")
    .all();
  const group = [];
  for (const r of rows.results || []) {
    group.push({
      id: r.id,
      fromId: r.from_id,
      fromName: r.from_name,
      fromRole: r.from_role,
      text: r.text,
      type: r.type,
      billId: r.bill_id || undefined,
      time: r.created_at
    });
  }
  return { group: group.slice(-500) };
}

async function syncCredentialsFromBackup(db, rawData) {
  const now = new Date().toISOString();
  const stmts = [];
  if (rawData.admin && rawData.admin.username && rawData.admin.password) {
    const passHash = await hashSecret(rawData.admin.password);
    const pinVal = rawData.admin.pin || (rawData.settings && rawData.settings.closePin) || '';
    const pinHash = pinVal ? await hashSecret(pinVal) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
           VALUES ('admin', 'admin', ?, ?, ?, ?, ?, ?, 0, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             username=excluded.username, mobile=excluded.mobile, member_id=excluded.member_id,
             name=excluded.name, secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash,
             accounts_writer=0, active=1, updated_at=excluded.updated_at`
        )
        .bind(
          rawData.admin.username,
          normalizeMobile(rawData.admin.mobile),
          null,
          rawData.admin.name || 'Admin',
          passHash,
          pinHash,
          now
        )
    );
  }
  if (rawData.treasurer && rawData.treasurer.username && rawData.treasurer.password) {
    const t = rawData.treasurer;
    const passHash = await hashSecret(t.password);
    const pinHash = t.pin ? await hashSecret(t.pin) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
           VALUES ('treasurer', 'treasurer', ?, '', ?, ?, ?, ?, 1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             username=excluded.username, member_id=excluded.member_id, name=excluded.name,
             secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash, accounts_writer=1, active=1, updated_at=excluded.updated_at`
        )
        .bind(t.username, t.memberId || null, t.name || t.username, passHash, pinHash, now)
    );
  }
  for (const s of rawData.secondaryAdmins || []) {
    if (!s || !s.username || !s.password) continue;
    const passHash = await hashSecret(s.password);
    const pinHash = s.pin ? await hashSecret(s.pin) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
           VALUES (?, 'admin_ro', ?, '', NULL, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             username=excluded.username, name=excluded.name, secret_hash=excluded.secret_hash,
             pin_hash=excluded.pin_hash, active=excluded.active, updated_at=excluded.updated_at`
        )
        .bind('sec:' + s.username, s.username, s.name || s.username, passHash, pinHash, s.active === false ? 0 : 1, now)
    );
  }
  for (const m of rawData.members || []) {
    if (!m || !m.id) continue;
    const mob = normalizeMobile(m.mobile);
    if (!mob || !m.pin) continue;
    const pinHash = await hashSecret(m.pin);
    stmts.push(
      db
        .prepare(
          `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
           VALUES (?, 'member', NULL, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             mobile=excluded.mobile, member_id=excluded.member_id, name=excluded.name,
             secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash, active=excluded.active, updated_at=excluded.updated_at`
        )
        .bind('mem:' + m.id, mob, m.id, m.name || m.id, pinHash, pinHash, m.active === false ? 0 : 1, now)
    );
  }
  if (stmts.length) await db.batch(stmts);
}

async function broadcastPush(env, payloadObj, excludeUserKey = null) {
  try {
    const vapid = await getVapidKeys(env);
    const rows = await env.DB.prepare('SELECT sub_key, user_key, endpoint, p256dh, auth FROM push_subscriptions').all();
    const subs = rows.results || [];
    for (const s of subs) {
      if (excludeUserKey && s.user_key === excludeUserKey) continue;
      try {
        const res = await sendWebPush(s, payloadObj, vapid);
        if (res.gone) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
        }
      } catch (e) {
        // Continue sending to other devices
      }
    }
  } catch (e) {
    console.warn('broadcastPush error', e);
  }
}

async function sendPushToUserKey(env, userKey, payloadObj) {
  if (!userKey) return 0;
  try {
    const vapid = await getVapidKeys(env);
    const rows = await env.DB
      .prepare('SELECT sub_key, endpoint, p256dh, auth FROM push_subscriptions WHERE user_key = ?')
      .bind(String(userKey))
      .all();
    let sent = 0;
    for (const s of rows.results || []) {
      try {
        const res = await sendWebPush(s, payloadObj, vapid);
        if (res.ok) sent++;
        if (res.gone) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
        }
      } catch (e) {}
    }
    return sent;
  } catch (e) {
    console.warn('sendPushToUserKey error', e);
    return 0;
  }
}

const BS_MONTHS_NP_API = ['बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज', 'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फाल्गुन', 'चैत'];
const BS_CAL_DATA_API = {
  2080: { start: [2023, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2081: { start: [2024, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2082: { start: [2025, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] },
  2083: { start: [2026, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30] },
  2084: { start: [2027, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30] },
  2085: { start: [2028, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2086: { start: [2029, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] }
};

function getNepalNowApi(nowMs = Date.now()) {
  return new Date(nowMs + (5 * 60 + 45) * 60000);
}

function adToBsPartsApi(dt) {
  const utc = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  for (const [yr, info] of Object.entries(BS_CAL_DATA_API)) {
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

function nthWeekdayOfBsMonthApi(year, monthIndex, weekday, n) {
  const info = BS_CAL_DATA_API[year];
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

function evaluateHealthErrorsFromState(st, stateBytes = 0, d1UsedBytes = 0) {
  const errors = [];
  if (!st || typeof st !== 'object') {
    errors.push({
      code: 'state_json',
      severity: 'error',
      title: 'मुख्य हिसाब डाटा (JSON) पढ्न समस्या देखियो',
      detail: 'सर्भरमा सुरक्षित गरिएको समूह हिसाब डाटा अमान्य छ।',
      solution: 'ब्याकअप वा स्न्यापसट जाँच गरी डाटा पुनर्स्थापना गर्नुहोस्।',
      action: 'audit'
    });
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
    errors.push({
      code: 'loan_mismatch',
      severity: 'error',
      title: 'ऋण हिसाब फरक देखियो (रु. ' + loanMismatch + ')',
      detail: 'अन्तिम बन्द महिनाको कुल ऋण र सदस्यहरूको बाँकी ऋण योगमा फरक छ।',
      solution: 'हिसाब मिलान अडिट खोली स्न्यापसट जाँच तथा मिलान गर्नुहोस्।',
      action: 'audit'
    });
  }

  if (currentMonth && typeof currentMonth.cashInHand === 'number' && currentMonth.cashInHand < -1) {
    errors.push({
      code: 'neg_cash',
      severity: 'error',
      title: 'समूहको नगद मौज्दात ऋणात्मक देखियो (रु. ' + Math.round(currentMonth.cashInHand) + ')',
      detail: 'नगद मौज्दात शून्यभन्दा कम हुनु हिसाब प्रविष्टि त्रुटिको संकेत हो।',
      solution: 'यस महिनाको कलेक्सन, खर्च र ऋण लगानी प्रविष्टि जाँच गर्नुहोस्।',
      action: 'audit'
    });
  }

  const mobCounts = new Map();
  for (const m of activeMembers) {
    const mob = normalizeMobile(m.mobile);
    if (mob) mobCounts.set(mob, (mobCounts.get(mob) || 0) + 1);
  }
  const dupMob = Array.from(mobCounts.values()).filter((n) => n > 1).length;
  if (dupMob > 0) {
    errors.push({
      code: 'dup_mobile',
      severity: 'error',
      title: 'सक्रिय सदस्यको मोबाइल नम्बर दोहोरिएको देखियो',
      detail: 'दुई वा बढी सक्रिय सदस्यमा एउटै मोबाइल नम्बर प्रयोग भएको छ।',
      solution: 'प्रोफाइल ट्याबबाट सदस्यको मोबाइल नम्बर सच्याउनुहोस्।',
      action: 'nopin'
    });
  }

  if (stateBytes >= 2 * 1024 * 1024 || d1UsedBytes >= Math.floor(4.5 * 1024 * 1024 * 1024)) {
    errors.push({
      code: 'storage_limit',
      severity: 'error',
      title: 'डाटाबेस/स्टेट साइज उच्च सीमामा पुग्यो',
      detail: 'मुख्य डाटा साइज धेरै ठूलो भएकोले तत्काल मिडिया/R2 जाँच आवश्यक छ।',
      solution: 'R2 मिडिया बकेट जोडेर फोटो/सहि अफलोड गर्नुहोस्।',
      action: ''
    });
  }
  return errors;
}

function getAdminAlertRecipient(env, st) {
  return String(
    (env && env.ADMIN_EMAIL) ||
    (st && st.admin && st.admin.email) ||
    (st && st.settings && st.settings.appOwner && st.settings.appOwner.email) ||
    ''
  ).trim();
}

function getResendKey(env) {
  return String((env && (env.RESEND_API_KEY || env.RESEND_KEY || env.RESEND_API || env.resend_api_key)) || '').trim();
}

function isEmailProviderConfigured(env) {
  return Boolean(
    getResendKey(env) ||
    (env && String(env.BREVO_API_KEY || '').trim()) ||
    (env && env.SEND_EMAIL && typeof env.SEND_EMAIL.send === 'function')
  );
}

async function sendAdminHealthEmailApi(env, st, errors, nepalDate) {
  const toEmail = getAdminAlertRecipient(env, st);
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
    lines.push(`${idx + 1}. ${e.title}${e.solution ? ' — ' + e.solution : ''}`);
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
      let detail = '';
      if (!res.ok) {
        try { detail = await res.text(); } catch (e) {}
      }
      return { sent: res.ok, status: res.ok ? 'sent_resend' : 'error_resend_' + res.status, to: toEmail, detail };
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
      const subjectB64 = btoa(String.fromCharCode(...new TextEncoder().encode(subject)));
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

async function sendAdminHealthAlertPush(env, errors, notifyNum) {
  if (!errors || !errors.length) return 0;
  const firstTitle = errors[0].title || 'प्रणाली त्रुटि';
  return sendPushToUserKey(env, 'admin', {
    title: '🚨 प्रणाली स्वास्थ्यमा त्रुटि (' + errors.length + ')',
    body: firstTitle + ' — नहेरेसम्म हरेक घण्टा अलर्ट आउनेछ (#' + notifyNum + ')। कृपया "प्रणाली स्वास्थ्य" खोल्नुहोस्।',
    tag: 'admin-health-alert',
    renotify: true,
    requireInteraction: true,
    data: { openHealth: true, url: './?open=health' }
  });
}

let _lastScheduleTickMs = 0;
async function runBackgroundHealthAndReminderTick(env, opts = {}) {
  const nowMs = Number(opts.nowMs || Date.now());
  if (!opts.force && nowMs - _lastScheduleTickMs < 120000) return;
  _lastScheduleTickMs = nowMs;

  const nepal = getNepalNowApi(nowMs);
  const nepalHour = nepal.getUTCHours();
  const nepalDate = nepal.toISOString().slice(0, 10);
  const nowIso = new Date(nowMs).toISOString();
  const bs = adToBsPartsApi(nepal);
  const secondFridayDay = bs ? nthWeekdayOfBsMonthApi(bs.year, bs.monthIndex, 5, 2) : null;
  const isSecondFriday = !!(bs && secondFridayDay && bs.day === secondFridayDay);

  const loadHealthWithState = async () => {
    try {
      const gs = await env.DB.prepare("SELECT version, data_json, updated_at FROM group_state WHERE id = 'main'").first();
      if (!gs || !gs.data_json) return { st: null, errors: [] };
      const st = JSON.parse(gs.data_json);
      return { st, errors: evaluateHealthErrorsFromState(st, String(gs.data_json || '').length, 0) };
    } catch (e) {
      return { st: null, errors: evaluateHealthErrorsFromState(null, 0, 0) };
    }
  };

  // १. अघिल्लो त्रुटि Admin ले नहेरेको भए हरेक १ घण्टामा Admin लाई मात्र Push
  const alertState = await getSecretJson(env.DB, 'health_alert_state');
  if (alertState && alertState.active && !alertState.acknowledgedAt) {
    const lastMs = Date.parse(alertState.lastNotifiedAt || 0) || 0;
    if (nowMs - lastMs >= 55 * 60 * 1000) {
      const { errors } = await loadHealthWithState();
      if (errors.length > 0) {
        const nextCount = Number(alertState.notifyCount || 0) + 1;
        await sendAdminHealthAlertPush(env, errors, nextCount);
        await setSecretJson(
          env.DB,
          'health_alert_state',
          Object.assign({}, alertState, {
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
          Object.assign({}, alertState, { active: false, autoClearedAt: nowIso })
        );
      }
    }
  }

  if (!isSecondFriday) return;

  // २. काम दोस्रो: हरेक नेपाली महिनाको दोस्रो शुक्रबार बिहान (>= 6:00 AM NPT) स्वतः स्वास्थ्य जाँच
  if (nepalHour >= 6) {
    const healthKey = 'health_check_' + bs.year + '_' + bs.monthIndex;
    const healthDone = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(healthKey).first();
    if (!healthDone) {
      const { st, errors } = await loadHealthWithState();
      const errSig = errors.map((e) => e.code + ':' + e.title).join('|');
      const curAlert = await getSecretJson(env.DB, 'health_alert_state');
      if (errors.length > 0) {
        const alreadyAckedMonth = curAlert && curAlert.acknowledgedKey === healthKey && curAlert.acknowledgedSignature === errSig;
        if (!alreadyAckedMonth) {
          const emailRes = await sendAdminHealthEmailApi(env, st, errors, nepalDate);
          await sendAdminHealthAlertPush(env, errors, 1);
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
        }
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
  if (nepalHour >= 18) {
    const jobKey = 'remind_' + bs.year + '_' + bs.monthIndex;
    const already = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(jobKey).first();
    if (!already) {
      const satDay = bs.day + 1;
      const mName = BS_MONTHS_NP_API[bs.monthIndex] || '';
      const msgText =
        `🔔 दोस्रो शनिबार — बचत बैठक सूचना (${mName} ${bs.year})\n` +
        `भोलि (${mName} ${satDay} गते, दोस्रो शनिबार) समूहको नियमित मासिक बचत बैठक बस्ने छ।\n` +
        `सदस्यज्यूहरूले आफ्नो पासबुक हेरी तोकिएको समयमा अनिवार्य बचत, ब्याज तथा किस्ता रकमसहित उपस्थित भइदिनुहोला। धन्यवाद!`;

      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
           VALUES (?, 'group', 'system', 'समूह सूचना', 'system', ?, 'auto_group', NULL, ?)`
        )
        .bind('rem_fri_' + bs.year + '_' + bs.monthIndex, msgText, nowIso)
        .run();

      await broadcastPush(env, {
        title: '🔔 भोलि बचत बैठक छ',
        body: `${mName} ${satDay} गते (दोस्रो शनिबार) — समयमै उपस्थित हुनुहोला।`,
        tag: jobKey
      });

      await env.DB
        .prepare('INSERT OR IGNORE INTO schedule_log (job_key, ran_at) VALUES (?, ?)')
        .bind(jobKey, nowIso)
        .run();
    }
  }
}

function scanInlineMediaAndState(state) {
  let inlineCount = 0;
  let inlineBytes = 0;
  const checkVal = (v) => {
    if (typeof v === 'string' && v.startsWith('data:')) {
      inlineCount++;
      inlineBytes += v.length;
    }
  };
  if (state && state.group) {
    checkVal(state.group.logoImage);
    checkVal(state.group.welcomeVideo);
  }
  if (state && state.settings && state.settings.theme) {
    checkVal(state.settings.theme.photo);
  }
  for (const m of (state && state.members) || []) {
    if (!m) continue;
    checkVal(m.photo);
    checkVal(m.idCardPhoto);
  }
  for (const mo of (state && state.months) || []) {
    if (!mo || !Array.isArray(mo.loansGiven)) continue;
    for (const l of mo.loansGiven) {
      if (l) checkVal(l.signature);
    }
  }
  return { inlineCount, inlineBytes };
}

async function authenticateRequest(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const secret = await getJwtSecret(env);
  return verifyJwt(token, secret);
}

/** Protect closed months against accidental overwrite by an offline stale client */
function protectClosedMonths(existingState, incomingState) {
  if (!existingState || !Array.isArray(existingState.months)) return incomingState;
  const existingClosed = new Map();
  for (const m of existingState.months) {
    if (m && m.status === 'closed') existingClosed.set(m.id, m);
  }
  if (existingClosed.size === 0) return incomingState;

  const incomingMonths = Array.isArray(incomingState.months) ? incomingState.months.slice() : [];
  const incomingIds = new Set(incomingMonths.map((m) => m && m.id));
  for (let i = 0; i < incomingMonths.length; i++) {
    const m = incomingMonths[i];
    if (m && existingClosed.has(m.id)) {
      // Preserve immutable closed month from server, only allow updating media URLs if needed
      incomingMonths[i] = existingClosed.get(m.id);
    }
  }
  for (const [id, closedMo] of existingClosed.entries()) {
    if (!incomingIds.has(id)) incomingMonths.push(closedMo);
  }
  incomingState.months = incomingMonths;
  return incomingState;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS system_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, data_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_credentials (id TEXT PRIMARY KEY, role TEXT NOT NULL, username TEXT, mobile TEXT, member_id TEXT, name TEXT, secret_hash TEXT NOT NULL, pin_hash TEXT, accounts_writer INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_username ON auth_credentials(username)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_mobile ON auth_credentials(mobile)`,
  `CREATE TABLE IF NOT EXISTS processed_txns (txn_id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, base_version INTEGER, applied_version INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS month_snapshots (month_id TEXT PRIMARY KEY, name TEXT NOT NULL, year_bs INTEGER, month_index INTEGER, month_json TEXT NOT NULL, r2_backup_key TEXT, closed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, channel TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, from_role TEXT NOT NULL, text TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', bill_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_channel_time ON chat_messages(channel, created_at)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (sub_key TEXT PRIMARY KEY, user_key TEXT NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (ip_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS schedule_log (job_key TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`
];

let _schemaEnsured = false;
async function ensureSchema(db) {
  if (_schemaEnsured) return;
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  _schemaEnsured = true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method.toUpperCase();

  if (!env.DB) {
    return json({ ok: false, error: 'D1 database binding (DB) missing in Cloudflare Pages settings' }, 500);
  }

  const waitUntil = typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : () => {};

  try {
    if (!path.startsWith('/media/')) {
      await ensureSchema(env.DB);
      if (path === '/state' || path === '/sync' || path === '/ping' || path === '/vapid-public-key') {
        waitUntil(runBackgroundHealthAndReminderTick(env).catch(() => {}));
      }
    }

    // 1. Health & setup status (public)
    if (path === '/health' && method === 'GET') {
      try {
        const state = await loadStateRow(env.DB);
        const adminRow = await env.DB.prepare("SELECT id FROM auth_credentials WHERE role = 'admin' LIMIT 1").first();
        return json({
          ok: true,
          initialized: state.exists,
          hasAdmin: !!(adminRow || (state.data && state.data.admin)),
          version: state.version
        });
      } catch (e) {
        return json({ ok: false, needsSchema: true, error: e.message }, 200);
      }
    }

    // 2. Public R2 media serve
    if (path.startsWith('/media/') && method === 'GET') {
      if (!env.MEDIA) return new Response('R2 not configured', { status: 404 });
      const key = decodeURIComponent(path.slice(1)); // media/...
      let obj = await env.MEDIA.get(key);
      if (!obj && key.startsWith('media/media/')) {
        obj = await env.MEDIA.get(key.slice(6));
      }
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      });
    }

    // 3. VAPID public key
    if (path === '/push/vapid-public-key' && method === 'GET') {
      const vapid = await getVapidKeys(env);
      return json({ ok: true, publicKey: vapid.publicKey });
    }

    // 3b. Public Terms & Conditions (read-only for login footer before authentication)
    if (path === '/terms' && method === 'GET') {
      const state = await loadStateRow(env.DB);
      const groupName = (state.data && state.data.group && state.data.group.name) || 'समूह बचत';
      const terms = (state.data && state.data.settings && state.data.settings.terms) || null;
      return json({ ok: true, groupName, terms });
    }

    // 4. First-time admin bootstrap (only if NO admin exists)
    if (path === '/bootstrap-admin' && method === 'POST') {
      const existingAdmin = await env.DB.prepare("SELECT id FROM auth_credentials WHERE role = 'admin' LIMIT 1").first();
      if (existingAdmin) {
        return json({ ok: false, error: 'Admin खाता पहिले नै बनिसकेको छ' }, 403);
      }
      const body = await request.json();
      const { name, username, password, mobile, pin, initialState } = body || {};
      if (!name || !username || !password || !mobile || !pin) {
        return json({ ok: false, error: 'सबै फिल्ड भर्नुहोस्' }, 400);
      }
      const state = initialState || defaultState();
      state.admin = { name, username, password, mobile, pin, memberId: null };
      state.settings = Object.assign({}, defaultState().settings, state.settings || {}, {
        closePin: '',
        accountsWriterUsername: ''
      });
      await syncCredentialsFromBackup(env.DB, state);
      const clean = stripSecretsFromState(state);
      const now = new Date().toISOString();
      await env.DB
        .prepare(
          `INSERT INTO group_state (id, version, data_json, updated_at)
           VALUES ('main', 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version=version+1, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(JSON.stringify(clean), now)
        .run();
      return json({ ok: true, version: 1 });
    }

    // 5. Login (Unified: Admin A, Admin B, Member) with rate limit
    if (path === '/login' && method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const body = await request.json();
      const id = String((body && body.id) || '').trim();
      const secret = String((body && body.secret) || '').trim();
      if (!id || !secret) {
        return json({ ok: false, error: 'username/mobile र password/pin हाल्नुहोस्' }, 400);
      }

      const attemptKey = ip + ':' + id.toLowerCase();
      const nowMs = Date.now();
      const att = await env.DB.prepare('SELECT attempts, locked_until FROM login_attempts WHERE ip_key = ?').bind(attemptKey).first();
      if (att && att.locked_until > nowMs) {
        const mins = Math.ceil((att.locked_until - nowMs) / 60000);
        return json({ ok: false, error: `धेरै गलत प्रयास · ${mins} मिनेट पछि प्रयास गर्नुहोस्` }, 429);
      }

      const digits = normalizeMobile(id);
      const creds = await env.DB
        .prepare(
          `SELECT * FROM auth_credentials
           WHERE active = 1 AND (username = ? OR mobile = ? OR mobile = ?)
           LIMIT 10`
        )
        .bind(id, digits, id)
        .all();

      let matched = null;
      for (const c of creds.results || []) {
        if (await verifySecret(secret, c.secret_hash)) {
          matched = c;
          break;
        }
      }

      if (!matched) {
        const nextAtt = (att ? att.attempts : 0) + 1;
        const lockUntil = nextAtt >= 5 ? nowMs + 5 * 60 * 1000 : 0;
        await env.DB
          .prepare(
            `INSERT INTO login_attempts (ip_key, attempts, locked_until) VALUES (?, ?, ?)
             ON CONFLICT(ip_key) DO UPDATE SET attempts=excluded.attempts, locked_until=excluded.locked_until`
          )
          .bind(attemptKey, nextAtt, lockUntil)
          .run();
        return json({ ok: false, error: 'लगइन मिलेन · username/password वा mobile/PIN जाँच्नुहोस्' }, 401);
      }

      await env.DB.prepare('DELETE FROM login_attempts WHERE ip_key = ?').bind(attemptKey).run();

      const jwtSecret = await getJwtSecret(env);
      const pinFlags = await getPinResetFlags(env.DB);
      const mustChangePin = !!(matched.role === 'member' && matched.member_id && pinFlags[String(matched.member_id)]);
      const userObj = {
        role: matched.role,
        accountsWriter: matched.accounts_writer === 1,
        memberId: matched.member_id || null,
        name: matched.name || matched.username || 'User',
        username: matched.username || null,
        mobile: matched.mobile || null,
        mustChangePin
      };
      const token = await signJwt(userObj, jwtSecret);
      const stateRow = await loadStateRow(env.DB);
      const chat = await loadChatFromDb(env.DB, userObj);
      const readState = await getUserReadState(env.DB, userObj);
      const termsAcceptances = await getTermsAcceptances(env.DB);
      const termsAcceptance = getUserTermsAcceptance(termsAcceptances, userObj);
      const appUpdateAcks = await getAppUpdateAcks(env.DB);
      const appUpdateAck = getUserAppUpdateAck(appUpdateAcks, userObj);
      const canViewUpdateSummary = userObj.role === 'admin' || userObj.role === 'treasurer' || userObj.role === 'admin_ro';

      return json({
        ok: true,
        token,
        user: userObj,
        pinVerifier: matched.pin_hash || null,
        version: stateRow.version,
        data: sanitizeStateForRole(stateRow.data, userObj, pinFlags, termsAcceptances),
        chat,
        readState,
        termsAcceptance,
        appUpdateAck,
        ...(canViewUpdateSummary ? { appUpdateAcks } : {})
      });
    }

    // 6. Import Backup JSON (Allowed either BEFORE first admin exists OR by authenticated Admin!)
    if (path === '/import-backup' && method === 'POST') {
      const existingAdmin = await env.DB.prepare("SELECT id FROM auth_credentials WHERE role = 'admin' LIMIT 1").first();
      let actor = 'bootstrap';
      if (existingAdmin) {
        const user = await authenticateRequest(request, env);
        if (!user || user.role !== 'admin') {
          return json({ ok: false, error: 'Admin लगइन आवश्यक छ' }, 403);
        }
        actor = user.username || 'admin';
      }

      const rawBackup = await request.json();
      if (!rawBackup || typeof rawBackup !== 'object') {
        return json({ ok: false, error: 'अमान्य JSON ब्याकअप' }, 400);
      }

      const working = JSON.parse(JSON.stringify(rawBackup));
      if (!working.settings) working.settings = defaultState().settings;
      if (!working.group) working.group = defaultState().group;
      if (!Array.isArray(working.members)) working.members = [];
      if (!Array.isArray(working.months)) working.months = [];
      if (!working.migration) working.migration = defaultState().migration;

      if (working.admin && working.admin.username && !working.settings.accountsWriterUsername) {
        working.settings.accountsWriterUsername = working.admin.username;
      }

      // 1) Migrate credentials into hashed auth_credentials
      await syncCredentialsFromBackup(env.DB, working);

      // 2) Offload any base64 signatures/photos to R2
      await offloadHeavyMediaToR2(env, working);

      // 3) Migrate group chat messages into chat_messages table
      const chat = working.chat || { group: [] };
      const chatStmts = [];
      for (const m of chat.group || []) {
        if (!m || !m.id) continue;
        chatStmts.push(
          env.DB
            .prepare(
              `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
               VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              String(m.id),
              String(m.fromId || ''),
              String(m.fromName || ''),
              String(m.fromRole || 'member'),
              String(m.text || ''),
              String(m.type || 'text'),
              m.billId ? String(m.billId) : null,
              String(m.time || new Date().toISOString())
            )
        );
      }
      for (let i = 0; i < chatStmts.length; i += 50) {
        await env.DB.batch(chatStmts.slice(i, i + 50));
      }

      // 4) Strip plaintext secrets and save group_state
      const cleanState = stripSecretsFromState(working);
      const cur = await loadStateRow(env.DB);
      const nextVersion = (cur.version || 0) + 1;
      const now = new Date().toISOString();

      await env.DB
        .prepare(
          `INSERT INTO group_state (id, version, data_json, updated_at)
           VALUES ('main', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version=excluded.version, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(nextVersion, JSON.stringify(cleanState), now)
        .run();

      // 5) Save immutable month_snapshots for any closed months
      for (const mo of cleanState.months || []) {
        if (mo && mo.status === 'closed') {
          await env.DB
            .prepare(
              `INSERT OR REPLACE INTO month_snapshots (month_id, name, year_bs, month_index, month_json, r2_backup_key, closed_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?)`
            )
            .bind(
              mo.id,
              mo.name || '',
              mo.yearBS || null,
              mo.monthIndex != null ? mo.monthIndex : null,
              JSON.stringify(mo),
              mo.closedAt || now
            )
            .run();
        }
      }

      return json({ ok: true, version: nextVersion, actor, importedMonths: (cleanState.months || []).length });
    }

    // ========== AUTHENTICATED ENDPOINTS ==========
    const user = await authenticateRequest(request, env);
    if (!user) {
      return json({ ok: false, error: 'Unauthorized — कृपया फेरि लगइन गर्नुहोस्' }, 401);
    }

    // 7. Verify PIN online
    if (path === '/verify-pin' && method === 'POST') {
      const { pin } = await request.json();
      let cred;
      if (user.role === 'admin') {
        cred = await env.DB.prepare("SELECT pin_hash FROM auth_credentials WHERE id = 'admin'").first();
      } else if (user.role === 'treasurer') {
        cred = await env.DB.prepare("SELECT pin_hash FROM auth_credentials WHERE id = 'treasurer'").first();
      } else if (user.role === 'admin_ro') {
        cred = await env.DB.prepare('SELECT pin_hash FROM auth_credentials WHERE id = ?').bind('sec:' + user.username).first();
      } else {
        cred = await env.DB.prepare('SELECT pin_hash FROM auth_credentials WHERE id = ?').bind('mem:' + user.memberId).first();
      }
      const ok = cred && cred.pin_hash ? await verifySecret(String(pin || ''), cred.pin_hash) : false;
      return json({ ok });
    }

    // 8. Get State (lightweight delta check via sinceVersion)
    if (path === '/state' && method === 'GET') {
      const sinceVersion = Number(url.searchParams.get('sinceVersion') || -1);
      const stateRow = await loadStateRow(env.DB);
      const chat = await loadChatFromDb(env.DB);
      const readState = await getUserReadState(env.DB, user);
      const termsAcceptances = await getTermsAcceptances(env.DB);
      const termsAcceptance = getUserTermsAcceptance(termsAcceptances, user);
      const appUpdateAcks = await getAppUpdateAcks(env.DB);
      const appUpdateAck = getUserAppUpdateAck(appUpdateAcks, user);
      const canViewUpdateSummary = user.role === 'admin' || user.role === 'treasurer' || user.role === 'admin_ro';
      if (sinceVersion === stateRow.version) {
        return json({
          ok: true,
          unchanged: true,
          version: stateRow.version,
          chat,
          readState,
          termsAcceptance,
          appUpdateAck,
          ...(canViewUpdateSummary ? { appUpdateAcks } : {})
        });
      }
      const pinFlags = await getPinResetFlags(env.DB);
      return json({
        ok: true,
        unchanged: false,
        version: stateRow.version,
        data: sanitizeStateForRole(stateRow.data, user, pinFlags, termsAcceptances),
        chat,
        readState,
        termsAcceptance,
        appUpdateAck,
        ...(canViewUpdateSummary ? { appUpdateAcks } : {})
      });
    }

    // 8b. Admin Non-Accounting Settings & Rules Update (ONLY Admin, never overwrites accounting!)
    if (path === '/admin/settings' && method === 'POST') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'सेटिङ परिवर्तन गर्ने अधिकार Admin लाई मात्र छ' }, 403);
      }
      const patch = await request.json().catch(() => ({}));
      const cur = await loadStateRow(env.DB);
      const working = JSON.parse(JSON.stringify(cur.data || defaultState()));
      if (!working.settings) working.settings = defaultState().settings;
      if (!working.group) working.group = defaultState().group;

      if (patch.group && typeof patch.group === 'object') {
        working.group = Object.assign({}, working.group, patch.group);
      }
      if (patch.settingsPatch && typeof patch.settingsPatch === 'object') {
        const keepWriter = working.settings.accountsWriterUsername || '';
        const keepClosePin = working.settings.closePin || '';
        working.settings = Object.assign({}, working.settings, patch.settingsPatch, {
          accountsWriterUsername: keepWriter,
          closePin: keepClosePin
        });
      }
      if (Array.isArray(patch.rules)) working.rules = patch.rules;
      if (Array.isArray(patch.ruleChangeLog)) working.ruleChangeLog = patch.ruleChangeLog;
      if (Array.isArray(patch.pendingRuleEdits)) working.pendingRuleEdits = patch.pendingRuleEdits;
      if (Array.isArray(patch.meetings)) working.meetings = patch.meetings;
      if (Array.isArray(patch.suggestions)) working.suggestions = patch.suggestions;
      if (Array.isArray(patch.complaints)) working.complaints = patch.complaints;

      await offloadHeavyMediaToR2(env, working);
      const pinFlags = await getPinResetFlags(env.DB);
      const termsAcceptances = await getTermsAcceptances(env.DB);
      if (Array.isArray(working.members)) {
        working.members = mergeTermsAcceptancesIntoMembers(
          working.members.map((m) =>
            m && m.id ? Object.assign({}, m, { mustChangePin: !!pinFlags[String(m.id)] }) : m
          ),
          termsAcceptances
        );
      }
      const cleanState = stripSecretsFromState(working);
      const nextVersion = (cur.version || 0) + 1;
      const now = new Date().toISOString();

      await env.DB
        .prepare(
          `INSERT INTO group_state (id, version, data_json, updated_at)
           VALUES ('main', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version=excluded.version, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(nextVersion, JSON.stringify(cleanState), now)
        .run();

      return json({
        ok: true,
        version: nextVersion,
        data: sanitizeStateForRole(cleanState, user, pinFlags, termsAcceptances)
      });
    }

    // 9. Save State (कोषाध्यक्ष / Treasurer ONLY — version-checked & idempotent via txnId)
    if (path === '/state' && method === 'POST') {
      if (user.role !== 'treasurer' || !user.accountsWriter) {
        return json({ ok: false, error: 'Read-only: हिसाब किताब लेख्ने अधिकार कोषाध्यक्षलाई मात्र छ' }, 403);
      }
      const body = await request.json();
      const { txnId, baseVersion, forceOverwrite, data: incomingRaw, closedMonthId, pushNotice } = body || {};
      if (!incomingRaw || typeof incomingRaw !== 'object') {
        return json({ ok: false, error: 'अमान्य डेटा' }, 400);
      }

      if (txnId) {
        const dup = await env.DB.prepare('SELECT applied_version FROM processed_txns WHERE txn_id = ?').bind(String(txnId)).first();
        if (dup) {
          const cur = await loadStateRow(env.DB);
          return json({ ok: true, duplicate: true, version: cur.version, data: sanitizeStateForRole(cur.data, user) });
        }
      }

      const cur = await loadStateRow(env.DB);
      if (
        cur.exists &&
        !forceOverwrite &&
        baseVersion != null &&
        Number(baseVersion) > 0 &&
        Number(baseVersion) < cur.version
      ) {
        // Server moved ahead — check if it was only member feedback/pinRequests or real accounting change
        return json({
          ok: false,
          conflict: true,
          serverVersion: cur.version,
          serverData: sanitizeStateForRole(cur.data, user),
          error: 'अर्को डिभाइसबाट नया अपडेट भइसकेको छ'
        }, 409);
      }

      let prepared = JSON.parse(JSON.stringify(incomingRaw));
      if (!forceOverwrite && cur.exists) {
        prepared = protectClosedMonths(cur.data, prepared);
      }
      await offloadHeavyMediaToR2(env, prepared);
      const pinFlags = await getPinResetFlags(env.DB);
      const termsAcceptances = await getTermsAcceptances(env.DB);
      if (Array.isArray(prepared.members)) {
        prepared.members = mergeTermsAcceptancesIntoMembers(
          prepared.members.map((m) =>
            m && m.id ? Object.assign({}, m, { mustChangePin: !!pinFlags[String(m.id)] }) : m
          ),
          termsAcceptances
        );
      }
      const cleanState = stripSecretsFromState(prepared);

      const nextVersion = (cur.version || 0) + 1;
      const now = new Date().toISOString();

      await env.DB
        .prepare(
          `INSERT INTO group_state (id, version, data_json, updated_at)
           VALUES ('main', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version=excluded.version, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(nextVersion, JSON.stringify(cleanState), now)
        .run();

      if (txnId) {
        await env.DB
          .prepare(
            `INSERT OR IGNORE INTO processed_txns (txn_id, actor, action, base_version, applied_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            String(txnId),
            user.username || 'admin',
            closedMonthId ? 'close_month' : 'save_state',
            baseVersion != null ? Number(baseVersion) : null,
            nextVersion,
            now
          )
          .run();
      }

      // If closing a month, write immutable snapshot + R2 archive + Web Push
      if (closedMonthId) {
        const closedMo = (cleanState.months || []).find((m) => m && m.id === closedMonthId);
        if (closedMo) {
          let r2Key = null;
          if (env.MEDIA) {
            r2Key = `backups/month-${closedMonthId}-${now.slice(0, 10)}.json`;
            await env.MEDIA.put(r2Key, JSON.stringify(cleanState, null, 2), {
              httpMetadata: { contentType: 'application/json' }
            });
          }
          await env.DB
            .prepare(
              `INSERT OR REPLACE INTO month_snapshots (month_id, name, year_bs, month_index, month_json, r2_backup_key, closed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              closedMo.id,
              closedMo.name || '',
              closedMo.yearBS || null,
              closedMo.monthIndex != null ? closedMo.monthIndex : null,
              JSON.stringify(closedMo),
              r2Key,
              closedMo.closedAt || now
            )
            .run();
        }
      }

      if (pushNotice && pushNotice.title) {
        await broadcastPush(env, pushNotice, user.role === 'admin' ? 'admin' : null);
      }

      return json({
        ok: true,
        version: nextVersion,
        data: sanitizeStateForRole(cleanState, user, pinFlags, termsAcceptances)
      });
    }

    // 10. Manage Credentials (Admin updates Admin, Treasurer/कोषाध्यक्ष, or Member PIN; Treasurer can update member_meta)
    if (path === '/admin/credentials' && method === 'POST') {
      const body = await request.json();
      const now = new Date().toISOString();

      if (body.type === 'member_meta') {
        if (user.role !== 'admin' && !(user.role === 'treasurer' && user.accountsWriter)) {
          return json({ ok: false, error: 'अनुमति छैन' }, 403);
        }
        const { memberId, mobile, name, active, address, bio } = body;
        const mob = normalizeMobile(mobile);
        await env.DB
          .prepare('UPDATE auth_credentials SET mobile=?, name=?, active=?, updated_at=? WHERE id=?')
          .bind(mob, name || memberId, active === false ? 0 : 1, now, 'mem:' + memberId)
          .run();

        let nextVer = null;
        if (memberId && body.syncProfileFields) {
          const curState = await loadStateRow(env.DB);
          if (curState && curState.data && Array.isArray(curState.data.members)) {
            const stMem = curState.data.members.find((m) => m && m.id === memberId);
            if (stMem) {
              if (name !== undefined) stMem.name = String(name || stMem.name || '');
              if (mobile !== undefined) stMem.mobile = String(mobile || '');
              if (address !== undefined) stMem.address = String(address || '');
              if (bio !== undefined) stMem.bio = String(bio || '');
              nextVer = (curState.version || 0) + 1;
              await env.DB
                .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
                .bind(nextVer, JSON.stringify(stripSecretsFromState(curState.data)), now)
                .run();
            }
          }
        }
        return json({ ok: true, version: nextVer });
      }

      if (user.role !== 'admin') {
        return json({ ok: false, error: 'यो अधिकार Admin लाई मात्र छ' }, 403);
      }

      if (body.type === 'admin_profile') {
        const row = await env.DB.prepare("SELECT * FROM auth_credentials WHERE id = 'admin'").first();
        if (!row) return json({ ok: false, error: 'Admin फेला परेन' }, 404);
        const nextUser = String(body.username || row.username || '').trim();
        const nextName = String(body.name || row.name || '').trim();
        const nextMob = body.mobile ? normalizeMobile(body.mobile) : row.mobile;
        if (!nextUser || !nextName) return json({ ok: false, error: 'Admin नाम र Username चाहिन्छ' }, 400);
        const trRow = await env.DB.prepare("SELECT username FROM auth_credentials WHERE id = 'treasurer'").first();
        if (trRow && trRow.username && trRow.username === nextUser) {
          return json({ ok: false, error: 'यो Username कोषाध्यक्षसँग मिल्न गयो — फरक राख्नुहोस्' }, 400);
        }
        const nextPassHash = body.password ? await hashSecret(body.password) : row.secret_hash;
        const nextPinHash = body.pin ? await hashSecret(body.pin) : row.pin_hash;
        await env.DB
          .prepare(
            `UPDATE auth_credentials SET username=?, name=?, mobile=?, member_id=NULL, secret_hash=?, pin_hash=?, accounts_writer=0, updated_at=? WHERE id='admin'`
          )
          .bind(nextUser, nextName, nextMob, nextPassHash, nextPinHash, now)
          .run();

        const curState = await loadStateRow(env.DB);
        const stData = curState.data || defaultState();
        const nextEmail = body.email !== undefined ? String(body.email || '').trim() : ((stData.admin && stData.admin.email) || '');
        stData.admin = Object.assign({}, stData.admin || {}, {
          name: nextName,
          username: nextUser,
          mobile: nextMob,
          email: nextEmail,
          memberId: null,
          hasPin: !!nextPinHash
        });
        const nextVer = (curState.version || 0) + 1;
        await env.DB
          .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
          .bind(nextVer, JSON.stringify(stripSecretsFromState(stData)), now)
          .run();

        const jwtSecret = await getJwtSecret(env);
        const newUser = Object.assign({}, user, { accountsWriter: false, memberId: null, username: nextUser, name: nextName, mobile: nextMob });
        const token = await signJwt(newUser, jwtSecret);
        return json({ ok: true, token, user: newUser, pinVerifier: nextPinHash, version: nextVer });
      }

      if (body.type === 'treasurer_save') {
        const memberId = String(body.memberId || '').trim();
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const pin = String(body.pin || '').trim();
        if (!memberId || !username) {
          return json({ ok: false, error: 'सदस्य र कोषाध्यक्ष Username छान्नुहोस्' }, 400);
        }
        if (pin && (pin.length !== 4 || !/^\d{4}$/.test(pin))) {
          return json({ ok: false, error: 'PIN ठीक ४ अंकको हुनुपर्छ' }, 400);
        }

        const adminRow = await env.DB.prepare("SELECT username FROM auth_credentials WHERE id = 'admin'").first();
        if (adminRow && adminRow.username === username) {
          return json({ ok: false, error: 'कोषाध्यक्ष Username Admin को Username सँग एउटै हुनु हुँदैन' }, 400);
        }

        const curState = await loadStateRow(env.DB);
        const stData = curState.data || defaultState();
        const member = (stData.members || []).find((m) => m && m.id === memberId && m.active !== false);
        if (!member) {
          return json({ ok: false, error: 'सदस्य सूचीमा सक्रिय सदस्य भेटिएन' }, 404);
        }
        const conflictMem = (stData.members || []).find((m) => m && (m.mobile === username || normalizeMobile(m.mobile) === username));
        if (conflictMem) {
          return json({ ok: false, error: 'कोषाध्यक्ष Username सदस्यको मोबाइल नम्बरसँग नजुध्ने राख्नुहोस्' }, 400);
        }

        const existingTr = await env.DB.prepare("SELECT * FROM auth_credentials WHERE id = 'treasurer'").first();
        if (!existingTr && (!password || !pin)) {
          return json({ ok: false, error: 'पहिलो पटक कोषाध्यक्ष बनाउँदा Password र ४ अंकको PIN अनिवार्य छ' }, 400);
        }
        if (password && password.length < 4) {
          return json({ ok: false, error: 'Password कम्तिमा ४ अक्षरको हुनुपर्छ' }, 400);
        }

        const passHash = password ? await hashSecret(password) : existingTr.secret_hash;
        const pinHash = pin ? await hashSecret(pin) : (existingTr ? existingTr.pin_hash : null);
        if (!pinHash) {
          return json({ ok: false, error: '४ अंकको PIN अनिवार्य छ' }, 400);
        }

        await env.DB
          .prepare(
            `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
             VALUES ('treasurer', 'treasurer', ?, '', ?, ?, ?, ?, 1, 1, ?)
             ON CONFLICT(id) DO UPDATE SET
               role='treasurer', username=excluded.username, mobile='', member_id=excluded.member_id,
               name=excluded.name, secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash,
               accounts_writer=1, active=1, updated_at=excluded.updated_at`
          )
          .bind(username, member.id, member.name, passHash, pinHash, now)
          .run();

        // Ensure Admin is no longer accounts_writer & clean legacy Admin B rows
        await env.DB.prepare("UPDATE auth_credentials SET accounts_writer=0 WHERE id='admin'").run();
        await env.DB.prepare("DELETE FROM auth_credentials WHERE role='admin_ro'").run();

        stData.treasurer = {
          memberId: member.id,
          name: member.name,
          username,
          active: true,
          hasPin: true
        };
        stData.secondaryAdmins = [];
        if (!stData.settings) stData.settings = defaultState().settings;
        stData.settings.accountsWriterUsername = username;

        const nextVer = (curState.version || 0) + 1;
        await env.DB
          .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
          .bind(nextVer, JSON.stringify(stripSecretsFromState(stData)), now)
          .run();

        const pinFlags = await getPinResetFlags(env.DB);
        const termsAcceptances = await getTermsAcceptances(env.DB);
        return json({
          ok: true,
          treasurer: stData.treasurer,
          version: nextVer,
          data: sanitizeStateForRole(stData, user, pinFlags, termsAcceptances)
        });
      }

      if (body.type === 'member_pin') {
        const { memberId, pin, mobile, name, isTemp } = body;
        if (!memberId || !pin) return json({ ok: false, error: 'memberId र PIN चाहिन्छ' }, 400);
        const mob = normalizeMobile(mobile);
        const pinHash = await hashSecret(pin);
        await env.DB
          .prepare(
            `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
             VALUES (?, 'member', NULL, ?, ?, ?, ?, ?, 0, 1, ?)
             ON CONFLICT(id) DO UPDATE SET
               mobile=excluded.mobile, name=excluded.name, secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash, active=1, updated_at=excluded.updated_at`
          )
          .bind('mem:' + memberId, mob, memberId, name || memberId, pinHash, pinHash, now)
          .run();
        await setPinResetFlag(env.DB, memberId, !!isTemp);
        const curState = await loadStateRow(env.DB);
        let nxtVer = null;
        if (curState && curState.data && Array.isArray(curState.data.members)) {
          const stMem = curState.data.members.find((m) => m && m.id === memberId);
          if (stMem) {
            stMem.hasPin = true;
            stMem.mustChangePin = !!isTemp;
            nxtVer = (curState.version || 0) + 1;
            await env.DB
              .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
              .bind(nxtVer, JSON.stringify(stripSecretsFromState(curState.data)), now)
              .run();
          }
        }
        return json({ ok: true, isTemp: !!isTemp, version: nxtVer });
      }

      return json({ ok: false, error: 'Unknown credential type' }, 400);
    }

    // 10b. Member Self-Service Change PIN (works both for mandatory Temp PIN change and anytime from Settings)
    if (path === '/member/change-pin' && method === 'POST') {
      if (user.role !== 'member' || !user.memberId) {
        return json({ ok: false, error: 'सदस्य लगइन आवश्यक छ' }, 403);
      }
      const body = await request.json();
      const currentPin = String((body && body.currentPin) || '').trim();
      const newPin = String((body && body.newPin) || '').trim();
      if (!currentPin || !newPin) {
        return json({ ok: false, error: 'पुरानो र नयाँ दुवै PIN हाल्नुहोस्' }, 400);
      }
      if (!/^\d{4}$/.test(newPin)) {
        return json({ ok: false, error: 'नयाँ PIN ठीक ४ अंकको हुनुपर्छ' }, 400);
      }
      if (currentPin === newPin) {
        return json({ ok: false, error: 'नयाँ PIN पुरानो भन्दा फरक हुनुपर्छ' }, 400);
      }
      const row = await env.DB.prepare('SELECT * FROM auth_credentials WHERE id = ? AND active = 1').bind('mem:' + user.memberId).first();
      if (!row) return json({ ok: false, error: 'सदस्य खाता फेला परेन' }, 404);
      const valid = await verifySecret(currentPin, row.secret_hash);
      if (!valid) {
        return json({ ok: false, error: 'पुरानो PIN मिलेन' }, 401);
      }
      const newHash = await hashSecret(newPin);
      const now = new Date().toISOString();
      await env.DB
        .prepare('UPDATE auth_credentials SET secret_hash=?, pin_hash=?, updated_at=? WHERE id=?')
        .bind(newHash, newHash, now, 'mem:' + user.memberId)
        .run();
      await setPinResetFlag(env.DB, user.memberId, false);
      let nextStateVersion = null;
      const curState = await loadStateRow(env.DB);
      if (curState && curState.data && Array.isArray(curState.data.members)) {
        const stMem = curState.data.members.find((m) => m && m.id === user.memberId);
        if (stMem) {
          stMem.hasPin = true;
          stMem.mustChangePin = false;
          stMem.pinChangedAt = now;
          nextStateVersion = (curState.version || 0) + 1;
          await env.DB
            .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
            .bind(nextStateVersion, JSON.stringify(stripSecretsFromState(curState.data)), now)
            .run();
        }
      }
      const jwtSecret = await getJwtSecret(env);
      const updatedUser = Object.assign({}, user, { mustChangePin: false });
      const token = await signJwt(updatedUser, jwtSecret);
      return json({ ok: true, token, user: updatedUser, pinVerifier: newHash, version: nextStateVersion });
    }

    // 11. Chat GET & POST
    if (path === '/chat' && method === 'GET') {
      const chat = await loadChatFromDb(env.DB);
      return json({ ok: true, chat });
    }

    if (path === '/chat' && method === 'POST') {
      const body = await request.json();
      const { id, channel, text, type, billId, time } = body || {};
      if (!text || !String(text).trim()) {
        return json({ ok: false, error: 'सन्देश खाली छ' }, 400);
      }
      const ch = channel || 'group';
      if (ch.startsWith('private:')) {
        return json({ ok: false, error: 'व्यक्तिगत च्याट हटाइएको छ' }, 410);
      }
      const msgId = String(id || 'm' + Date.now() + '_' + randomHex(3));
      const fromId = user.role === 'admin'
        ? (user.username || 'admin')
        : (user.memberId || user.username || user.role || 'user');
      const fromName = (type === 'auto_group' || type === 'system') ? 'समूह सूचना' : (user.name || 'सदस्य');
      const fromRole = (type === 'auto_group' || type === 'system') ? 'system' : user.role;
      const createdAt = time || new Date().toISOString();

      const runRes = await env.DB
        .prepare(
          `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(msgId, ch, fromId, fromName, fromRole, String(text), String(type || 'text'), billId || null, createdAt)
        .run();

      const inserted = !runRes || !runRes.meta || typeof runRes.meta.changes !== 'number' || runRes.meta.changes > 0;
      if (ch === 'group' && inserted && !body.silentPush) {
        const senderKey = user.role === 'admin' ? 'admin' : user.role === 'treasurer' ? 'treasurer' : (user.memberId || null);
        await broadcastPush(
          env,
          {
            title: fromRole === 'system' ? '📢 समूह सूचना' : `💬 ${fromName}`,
            body: String(text).slice(0, 120),
            tag: 'samuha-chat'
          },
          senderKey
        );
      }
      return json({ ok: true, id: msgId, inserted });
    }

    // 11b. Admin or Treasurer Delete Chat Message
    if (path === '/chat/delete' && method === 'POST') {
      if (user.role !== 'admin' && !(user.role === 'treasurer' && user.accountsWriter)) {
        return json({ ok: false, error: 'Admin वा कोषाध्यक्षले मात्र सन्देश मेट्न मिल्छ' }, 403);
      }
      const body = await request.json().catch(() => ({}));
      const msgId = String((body && body.id) || '').trim();
      if (!msgId) return json({ ok: false, error: 'सन्देश ID चाहिन्छ' }, 400);
      await env.DB.prepare('DELETE FROM chat_messages WHERE id = ?').bind(msgId).run();
      return json({ ok: true, id: msgId });
    }

    // 11c. Persistent Per-User Read State (survives logout/login and cross-device)
    if (path === '/user/read-state' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const saved = await saveUserReadState(env.DB, user, body || {});
      return json({ ok: true, readState: saved });
    }

    // 11d. Terms & Conditions Acceptance (Member / Treasurer / Admin — conflict-free persistence)
    if (path === '/terms/accept' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      const currentTermsVer = (state.settings && state.settings.terms && Number(state.settings.terms.version)) || 1;
      const ver = Math.max(1, Number((body && body.version) || currentTermsVer));
      const now = new Date().toISOString();
      const record = {
        version: ver,
        acceptedAt: (body && body.acceptedAt) || now,
        name: user.name || user.username || 'User',
        role: user.role,
        memberId: user.memberId || null
      };
      const keys = [];
      if (user.memberId) keys.push('mem:' + String(user.memberId));
      const uk = userReadKey(user);
      if (uk && !keys.includes(uk)) keys.push(uk);
      const allAcceptances = await recordTermsAcceptances(env.DB, keys, record);

      let nextVer = cur.version || 1;
      if (user.memberId && Array.isArray(state.members)) {
        const idx = state.members.findIndex((m) => m && m.id === user.memberId);
        if (idx >= 0) {
          state.members[idx].termsAcceptedVersion = ver;
          state.members[idx].termsAcceptedAt = record.acceptedAt;
          nextVer = (cur.version || 0) + 1;
          await env.DB
            .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
            .bind(nextVer, JSON.stringify(stripSecretsFromState(state)), now)
            .run();
        }
      }

      return json({
        ok: true,
        acceptance: record,
        termsAcceptance: getUserTermsAcceptance(allAcceptances, user),
        version: nextVer
      });
    }

    // 11e. App Update Changelog Acknowledgement (Agree / Disagree + Suggestion -> visible to Admin)
    if (path === '/app-update/ack' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const version = String((body && body.version) || '').trim().slice(0, 32);
      const decision = body && body.decision === 'disagree' ? 'disagree' : (body && body.decision === 'agree' ? 'agree' : '');
      const note = String((body && body.note) || '').trim().slice(0, 1000);
      if (!version || !decision) {
        return json({ ok: false, error: 'अपडेट संस्करण र सहमत/असहमत छनोट आवश्यक छ' }, 400);
      }
      if (decision === 'disagree' && !note) {
        return json({ ok: false, error: 'असहमत वा सुझाव छ भने कृपया कारण/सुझाव लेख्नुहोस्' }, 400);
      }
      const now = new Date().toISOString();
      const record = {
        version,
        decision,
        note,
        answeredAt: (body && body.answeredAt) || now,
        name: user.name || user.username || 'User',
        role: user.role,
        memberId: user.memberId || null
      };
      const keys = [];
      if (user.memberId) keys.push('mem:' + String(user.memberId));
      const uk = userReadKey(user);
      if (uk && !keys.includes(uk)) keys.push(uk);
      const allAcks = await recordAppUpdateAcks(env.DB, keys, record);

      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      let nextVer = cur.version || 1;
      let stateUpdated = false;
      const pinFlags = await getPinResetFlags(env.DB);
      const termsAcceptances = await getTermsAcceptances(env.DB);

      if (user.role === 'member' || user.role === 'treasurer') {
        const actorId = String(user.memberId || uk || 'user');
        const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeActor = actorId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const sugId = 'upd_' + safeVer + '_' + safeActor;
        const statusText = decision === 'agree' ? '✅ सहमत छु' : '⚠️ असहमत / सुझाव छ';
        const msgText = '[एप अपडेट v' + version + ' · ' + statusText + ']' +
          (note ? (' सुझाव: ' + note) : ' (अपडेट विवरण हेरेर मञ्जुरी दिइयो)');
        const cleanAgreeOnly = decision === 'agree' && !note;

        state.complaints = Array.isArray(state.complaints) ? state.complaints : [];
        const existingIdx = state.complaints.findIndex((c) => c && c.id === sugId);
        const prevItem = existingIdx >= 0 ? state.complaints[existingIdx] : null;
        const item = Object.assign({}, prevItem || {}, {
          id: sugId,
          memberId: user.memberId || actorId,
          memberName: user.name || 'सदस्य',
          text: msgText,
          kind: 'suggestion',
          source: 'app_update',
          updateVersion: version,
          updateDecision: decision,
          time: now,
          read: cleanAgreeOnly,
          replies: (prevItem && Array.isArray(prevItem.replies)) ? prevItem.replies : [],
          auto: false,
          resolved: cleanAgreeOnly
        });
        if (cleanAgreeOnly) {
          item.resolvedAt = now;
          item.resolvedBy = 'सदस्य मञ्जुरी';
        } else {
          delete item.resolvedAt;
          delete item.resolvedBy;
        }
        if (existingIdx >= 0) state.complaints[existingIdx] = item;
        else state.complaints.push(item);

        nextVer = (cur.version || 0) + 1;
        await env.DB
          .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
          .bind(nextVer, JSON.stringify(stripSecretsFromState(state)), now)
          .run();
        stateUpdated = true;

        if (decision === 'disagree' || note) {
          const senderName = user.name || 'सदस्य';
          await sendPushToUserKey(env, 'admin', {
            title: decision === 'disagree' ? ('⚠️ अपडेट v' + version + ' — सदस्य असहमत') : ('💡 अपडेट v' + version + ' सुझाव'),
            body: senderName + ': ' + (note || statusText).slice(0, 95),
            tag: 'app-upd-' + sugId
          });
        }
      }

      const canViewUpdateSummary = user.role === 'admin' || user.role === 'treasurer' || user.role === 'admin_ro';
      return json({
        ok: true,
        ack: record,
        appUpdateAck: getUserAppUpdateAck(allAcks, user),
        version: nextVer,
        ...(canViewUpdateSummary ? { appUpdateAcks: allAcks } : {}),
        ...(stateUpdated ? { data: sanitizeStateForRole(state, user, pinFlags, termsAcceptances) } : {})
      });
    }

    // 12. Member Feedback / Complaints / Suggestions / PIN Requests (appends safely without Admin write lock)
    if (path === '/feedback' && method === 'POST') {
      const body = await request.json();
      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      const now = new Date().toISOString();
      if (body.kind === 'suggestion_vidhan') {
        state.suggestions = state.suggestions || [];
        state.suggestions.push({
          id: body.id || 'sg_' + Date.now(),
          memberId: user.memberId || body.memberId,
          text: String(body.text || ''),
          time: now,
          reply: null
        });
      } else if (body.kind === 'pin_request') {
        state.pinRequests = state.pinRequests || [];
        state.pinRequests.push({
          id: body.id || 'pr_' + Date.now(),
          memberId: user.memberId || body.memberId,
          memberName: user.name || body.memberName,
          mobile: body.mobile || user.mobile,
          newMobile: body.newMobile || null,
          wantPin: !!body.wantPin,
          time: now,
          status: 'pending'
        });
      } else {
        state.complaints = state.complaints || [];
        state.complaints.push({
          id: body.id || 'c_' + Date.now(),
          memberId: user.memberId || body.memberId,
          text: String(body.text || ''),
          kind: body.kind || 'complaint',
          time: now,
          read: false,
          replies: [],
          auto: !!body.auto
        });
      }
      const nextVersion = (cur.version || 0) + 1;
      await env.DB
        .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
        .bind(nextVersion, JSON.stringify(stripSecretsFromState(state)), now)
        .run();
      if (!body.auto && body.kind !== 'pin_request') {
        const senderName = user.name || 'सदस्य';
        const pushPayload = {
          title: body.kind === 'suggestion' ? '💡 सदस्यको नयाँ सुझाव' : '📢 सदस्यको नयाँ गुनासो',
          body: senderName + ': ' + String(body.text || '').slice(0, 90),
          tag: 'feedback-' + (body.id || Date.now())
        };
        await sendPushToUserKey(env, 'admin', pushPayload);
        await sendPushToUserKey(env, 'treasurer', pushPayload);
      } else if (body.kind === 'pin_request') {
        await sendPushToUserKey(env, 'admin', {
          title: '🔢 नयाँ PIN अनुरोध',
          body: (user.name || body.memberName || 'सदस्य') + ' ले PIN अनुरोध पठाउनुभयो।',
          tag: 'pin-req'
        });
      }
      return json({ ok: true, version: nextVersion });
    }

    // 12b. Reply / Resolve Complaint (Primary Admin OR Active Treasurer)
    if (path === '/complaint/reply' && method === 'POST') {
      const canManage = user.role === 'admin' || (user.role === 'treasurer' && user.accountsWriter);
      if (!canManage) {
        return json({ ok: false, error: 'Admin वा कोषाध्यक्षलाई मात्र गुनासो समाधान गर्ने अधिकार छ' }, 403);
      }
      const body = await request.json().catch(() => ({}));
      const complaintId = String((body && body.complaintId) || '').trim();
      const replyText = String((body && body.replyText) || '').trim();
      const hasResolveFlag = body && typeof body.resolve === 'boolean';
      if (!complaintId || (!replyText && !hasResolveFlag)) {
        return json({ ok: false, error: 'गुनासो ID र जवाफ वा समाधान स्थिति आवश्यक छ' }, 400);
      }

      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      const c = (state.complaints || []).find((x) => x && String(x.id) === complaintId);
      if (!c) {
        return json({ ok: false, error: 'गुनासो फेला परेन' }, 404);
      }

      const now = new Date().toISOString();
      const senderRole = user.role === 'treasurer' ? 'treasurer' : 'admin';
      const senderLabel = user.role === 'treasurer' ? 'कोषाध्यक्ष' : 'Admin';
      c.replies = Array.isArray(c.replies) ? c.replies : [];
      if (replyText) {
        c.replies.push({
          id: 'rep_' + Date.now() + '_' + randomHex(2),
          from: senderRole,
          fromName: senderLabel,
          text: replyText,
          time: now,
          readByMember: false
        });
      }
      c.read = true;
      if (hasResolveFlag) {
        c.resolved = !!body.resolve;
        if (body.resolve) {
          c.resolvedAt = now;
          c.resolvedBy = senderLabel;
        } else {
          delete c.resolvedAt;
          delete c.resolvedBy;
        }
      }

      const nextVersion = (cur.version || 0) + 1;
      await env.DB
        .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
        .bind(nextVersion, JSON.stringify(stripSecretsFromState(state)), now)
        .run();

      if (c.memberId) {
        await sendPushToUserKey(env, c.memberId, {
          title: c.resolved ? '✅ तपाईंको गुनासो समाधान भयो' : '💬 गुनासोको जवाफ आयो',
          body: replyText
            ? (senderLabel + ': ' + replyText.slice(0, 100))
            : (senderLabel + ' ले तपाईंको गुनासो समाधान गर्नुभएको छ।'),
          tag: 'complaint-' + c.id
        });
      }

      const pinFlags = await getPinResetFlags(env.DB);
      const termsAcceptances = await getTermsAcceptances(env.DB);
      return json({
        ok: true,
        version: nextVersion,
        complaint: c,
        data: sanitizeStateForRole(state, user, pinFlags, termsAcceptances)
      });
    }

    // 13. Direct R2 Media Upload
    if (path === '/media' && method === 'POST') {
      const { category, idHint, dataUrl } = await request.json();
      const urlOut = await uploadDataUrlToR2(env, category || 'misc', idHint || 'file', dataUrl);
      return json({ ok: true, url: urlOut });
    }

    // 13b. Member Self-Service Passport Photo Upload (or Admin A updating a member) -> R2 + D1
    if (path === '/member/photo' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const dataUrl = String((body && body.dataUrl) || '');
      if (!dataUrl.startsWith('data:image/')) {
        return json({ ok: false, error: 'अमान्य फोटो फर्म्याट' }, 400);
      }
      if (dataUrl.length > 260 * 1024) {
        return json({ ok: false, error: 'फोटो साइज धेरै ठूलो भयो (१०० KB भित्र हुनुपर्छ)' }, 400);
      }
      let targetMemberId = '';
      if (user.role === 'member') {
        targetMemberId = user.memberId || '';
      } else if ((user.role === 'treasurer' && user.accountsWriter) || user.role === 'admin') {
        targetMemberId = String((body && body.memberId) || '');
      } else {
        return json({ ok: false, error: 'फोटो अपलोड अनुमति छैन' }, 403);
      }
      if (!targetMemberId) {
        return json({ ok: false, error: 'सदस्य ID भेटिएन' }, 400);
      }

      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      const idx = (state.members || []).findIndex(m => m && m.id === targetMemberId);
      if (idx < 0) {
        return json({ ok: false, error: 'सदस्य भेटिएन' }, 404);
      }
      if (user.role === 'member' && state.members[idx].photo && state.members[idx].photoLocked !== false) {
        return json({ ok: false, error: 'तपाईंले प्रोफाइल फोटो एक पटक राखिसक्नुभएको छ। बदल्नुपरे Admin बाट रिसेट गराउनुहोस्।' }, 403);
      }

      const urlOut = await uploadDataUrlToR2(env, 'members', `${targetMemberId}-photo-${Date.now()}`, dataUrl);
      state.members[idx].photo = urlOut;
      if (user.role === 'member') {
        state.members[idx].photoLocked = true;
      }
      const now = new Date().toISOString();
      const nextVersion = (cur.version || 0) + 1;
      await env.DB
        .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
        .bind(nextVersion, JSON.stringify(stripSecretsFromState(state)), now)
        .run();

      return json({ ok: true, url: urlOut, photoLocked: !!state.members[idx].photoLocked, version: nextVersion });
    }

    // 13c. Admin Reset Member Photo Lock (ONLY Admin)
    if (path === '/admin/reset-member-photo' && method === 'POST') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'Admin मात्र' }, 403);
      }
      const body = await request.json().catch(() => ({}));
      const memberId = String((body && body.memberId) || '').trim();
      const clearPhoto = !!(body && body.clearPhoto);
      if (!memberId) return json({ ok: false, error: 'सदस्य ID चाहिन्छ' }, 400);
      const cur = await loadStateRow(env.DB);
      const state = cur.data || defaultState();
      const idx = (state.members || []).findIndex(m => m && m.id === memberId);
      if (idx < 0) return json({ ok: false, error: 'सदस्य भेटिएन' }, 404);
      state.members[idx].photoLocked = false;
      if (clearPhoto) state.members[idx].photo = null;
      const now = new Date().toISOString();
      const nextVersion = (cur.version || 0) + 1;
      await env.DB
        .prepare("UPDATE group_state SET version=?, data_json=?, updated_at=? WHERE id='main'")
        .bind(nextVersion, JSON.stringify(stripSecretsFromState(state)), now)
        .run();
      return json({ ok: true, version: nextVersion, photoLocked: false, photo: state.members[idx].photo || null });
    }

    // 14. Web Push Subscription Management
    if (path === '/push/subscribe' && method === 'POST') {
      const sub = await request.json();
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json({ ok: false, error: 'Invalid push subscription' }, 400);
      }
      const userKey = user.role === 'admin' ? 'admin' : user.role === 'treasurer' ? 'treasurer' : user.role === 'admin_ro' ? 'admin_ro' : (user.memberId || 'guest');
      const subKey = userKey + ':' + sub.endpoint.slice(-32);
      await env.DB
        .prepare(
          `INSERT INTO push_subscriptions (sub_key, user_key, role, endpoint, p256dh, auth, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sub_key) DO UPDATE SET
             user_key=excluded.user_key, role=excluded.role, endpoint=excluded.endpoint,
             p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at`
        )
        .bind(subKey, userKey, user.role, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString())
        .run();
      return json({ ok: true });
    }

    if (path === '/push/unsubscribe' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const list = [];
      if (body && body.endpoint) list.push(String(body.endpoint));
      if (body && Array.isArray(body.endpoints)) {
        for (const ep of body.endpoints) {
          if (ep && !list.includes(String(ep))) list.push(String(ep));
        }
      }
      for (const ep of list) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(ep).run();
      }
      return json({ ok: true, removed: list.length });
    }

    if (path === '/push/test' && method === 'POST') {
      const vapid = await getVapidKeys(env);
      const userKey = user.role === 'admin' ? 'admin' : user.role === 'treasurer' ? 'treasurer' : user.role === 'admin_ro' ? 'admin_ro' : (user.memberId || 'guest');
      const rows = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_key = ?').bind(userKey).all();
      let sent = 0;
      for (const s of rows.results || []) {
        const res = await sendWebPush(s, {
          title: '🔔 समूह बचत परीक्षण सूचना',
          body: 'यो मोबाइलमा पुश नोटिफिकेसन ठीक चलिरहेको छ!',
          tag: 'test-push'
        }, vapid);
        if (res.ok) sent++;
      }
      return json({ ok: true, sent });
    }

    // 15. Admin / Treasurer Manual Meeting Reminder Push to ALL subscribed members
    if (path === '/push/remind' && method === 'POST') {
      if (user.role !== 'admin' && !(user.role === 'treasurer' && user.accountsWriter)) {
        return json({ ok: false, error: 'Admin वा कोषाध्यक्ष मात्र' }, 403);
      }
      const body = await request.json().catch(() => ({}));
      const title = String(body.title || '🔔 बचत बैठक रिमाइन्डर');
      const message = String(body.body || 'समूहको बचत बैठक सुरु हुँदैछ — कृपया समयमै उपस्थित हुनुहोला।');
      const nowIso = new Date().toISOString();

      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
           VALUES (?, 'group', 'system', 'समूह सूचना', 'system', ?, 'auto_group', NULL, ?)`
        )
        .bind('rem_man_' + Date.now() + '_' + randomHex(3), title + '\n\n' + message, nowIso)
        .run();

      const vapid = await getVapidKeys(env);
      const rows = await env.DB.prepare('SELECT sub_key, user_key, endpoint, p256dh, auth FROM push_subscriptions').all();
      const subs = rows.results || [];
      const selfKey = user.role === 'admin' ? 'admin' : 'treasurer';
      let sent = 0;
      for (const s of subs) {
        if (s.user_key === selfKey) continue;
        try {
          const res = await sendWebPush(s, { title, body: message, tag: 'meeting-remind' }, vapid);
          if (res.ok) sent++;
          if (res.gone) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
          }
        } catch (e) {}
      }
      return json({ ok: true, sent, totalDevices: subs.length });
    }

    // 16. Closed Month Snapshots (D1 + R2 — Admin ONLY)
    if (path === '/snapshots' && method === 'GET') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'स्न्यापसट ब्याकअप Admin लाई मात्र उपलब्ध छ' }, 403);
      }
      const rows = await env.DB
        .prepare('SELECT month_id, name, year_bs, month_index, r2_backup_key, closed_at FROM month_snapshots ORDER BY closed_at DESC LIMIT 36')
        .all();
      return json({ ok: true, snapshots: rows.results || [] });
    }

    if (path.startsWith('/snapshot/') && method === 'GET') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'स्न्यापसट ब्याकअप Admin लाई मात्र उपलब्ध छ' }, 403);
      }
      const monthId = decodeURIComponent(path.slice('/snapshot/'.length));
      const row = await env.DB
        .prepare('SELECT month_id, name, month_json, r2_backup_key, closed_at FROM month_snapshots WHERE month_id = ?')
        .bind(monthId)
        .first();
      if (!row) return json({ ok: false, error: 'स्न्यापसट भेटिएन' }, 404);
      let fullBackup = null;
      if (row.r2_backup_key && env.MEDIA) {
        try {
          const obj = await env.MEDIA.get(row.r2_backup_key);
          if (obj && obj.body) {
            const txt = typeof obj.body === 'string' ? obj.body : new TextDecoder().decode(obj.body);
            fullBackup = JSON.parse(txt);
          }
        } catch (e) {}
      }
      return json({
        ok: true,
        monthId: row.month_id,
        name: row.name,
        closedAt: row.closed_at,
        backup: fullBackup || JSON.parse(row.month_json)
      });
    }

    // 17. Full Backup Export (Admin & Treasurer)
    if (path === '/export-backup' && method === 'GET') {
      if (user.role !== 'admin' && user.role !== 'treasurer' && user.role !== 'admin_ro') {
        return json({ ok: false, error: 'Admin वा कोषाध्यक्ष मात्र' }, 403);
      }
      const stateRow = await loadStateRow(env.DB);
      const chat = await loadChatFromDb(env.DB);
      const full = Object.assign({}, stateRow.data, { chat });
      return json({ ok: true, backup: full });
    }

    // 17c. Send Test Health Email (Primary Admin ONLY)
    if (path === '/system-health/test-email' && method === 'POST') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'Admin लाई मात्र अनुमति छ' }, 403);
      }
      const stateRow = await loadStateRow(env.DB);
      const st = stateRow.data || defaultState();
      const nepalDate = getNepalNowApi().toISOString().slice(0, 10);
      const res = await sendAdminHealthEmailApi(
        env,
        st,
        [{ title: 'यो प्रणाली स्वास्थ्य इमेल अलर्ट परीक्षण (Test Email) हो — सबै सेटअप ठीक छ।', solution: 'कुनै समस्या छैन।' }],
        nepalDate
      );
      if (!res.sent) {
        return json({ ok: false, error: res.status || 'इमेल पठाउन सकिएन', detail: res.detail || res.error || '', to: res.to || '' }, 400);
      }
      return json({ ok: true, to: res.to, status: res.status });
    }

    // 18. System Health, Real Cloudflare Quota Usage, Diagnostics & Activity Log (Primary Admin ONLY)
    if (path === '/system-health' && method === 'GET') {
      if (user.role !== 'admin') {
        return json({ ok: false, error: 'प्रणाली स्वास्थ्य जाँच Admin लाई मात्र उपलब्ध छ' }, 403);
      }

      const stateRow = await loadStateRow(env.DB);
      const st = stateRow.data || defaultState();
      const pinFlags = await getPinResetFlags(env.DB);
      const termsAcceptances = await getTermsAcceptances(env.DB);

      // Real SQLite / D1 size via PRAGMA page_count * page_size + per-table byte measurements
      let pageCount = 0, pageSize = 4096;
      try {
        const pc = await env.DB.prepare('PRAGMA page_count').first();
        const ps = await env.DB.prepare('PRAGMA page_size').first();
        pageCount = Number((pc && (pc.page_count ?? Object.values(pc)[0])) || 0);
        pageSize = Number((ps && (ps.page_size ?? Object.values(ps)[0])) || 4096);
      } catch (e) {}

      const gsStats = await env.DB.prepare("SELECT LENGTH(data_json) AS bytes, updated_at FROM group_state WHERE id='main'").first().catch(() => null);
      const chatStats = await env.DB.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(text) + LENGTH(id) + LENGTH(from_name)), 0) AS bytes FROM chat_messages").first().catch(() => null);
      const snapStats = await env.DB.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(month_json)), 0) AS bytes FROM month_snapshots").first().catch(() => null);
      const credStats = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM auth_credentials WHERE active = 1").first().catch(() => null);
      const pushStats = await env.DB.prepare("SELECT COUNT(*) AS cnt, COUNT(DISTINCT user_key) AS users FROM push_subscriptions").first().catch(() => null);
      const txnStats = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM processed_txns").first().catch(() => null);
      const secStats = await env.DB.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM system_secrets").first().catch(() => null);

      const d1UsedBytes = pageCount > 0 ? (pageCount * pageSize) : (
        Number((gsStats && gsStats.bytes) || 0) +
        Number((chatStats && chatStats.bytes) || 0) +
        Number((snapStats && snapStats.bytes) || 0) +
        Number((secStats && secStats.bytes) || 0)
      );
      const d1LimitBytes = 5 * 1024 * 1024 * 1024; // Cloudflare D1 Free Plan 5 GB

      // Honest R2 check
      let r2 = { enabled: false, objectCount: 0, totalBytes: 0, truncated: false, limitBytes: 10 * 1024 * 1024 * 1024 };
      if (env.MEDIA && typeof env.MEDIA.list === 'function') {
        r2.enabled = true;
        try {
          const listed = await env.MEDIA.list({ limit: 1000 });
          const objs = (listed && listed.objects) || [];
          r2.objectCount = objs.length;
          r2.totalBytes = objs.reduce((s, o) => s + (Number(o && o.size) || 0), 0);
          r2.truncated = !!(listed && listed.truncated);
        } catch (e) {
          r2.error = e && e.message ? e.message : String(e);
        }
      }

      const inlineScan = scanInlineMediaAndState(st);

      // Real health & accounting diagnostics
      const members = Array.isArray(st.members) ? st.members : [];
      const activeMembers = members.filter((m) => m && m.active !== false);
      const months = Array.isArray(st.months) ? st.months : [];
      const openComplaints = (st.complaints || []).filter((c) => c && !c.auto && !c.resolved);
      const pendingPins = (st.pinRequests || []).filter((r) => r && r.status === 'pending');
      const noPinMembers = activeMembers.filter((m) => !(m.hasPin || m.pin));
      const curTermsVer = (st.settings && st.settings.terms && Number(st.settings.terms.version)) || 1;
      const agreedMembers = activeMembers.filter((m) => {
        const ta = termsAcceptances['mem:' + String(m.id)];
        const ver = Math.max(Number(m.termsAcceptedVersion || 0), Number((ta && ta.version) || 0));
        return ver >= curTermsVer;
      });
      const currentMonth = months.find((m) => m && m.id === st.currentMonthId) || null;
      const sumMemberLoans = activeMembers.reduce((s, m) => s + (Number(m.outstandingLoan) || 0), 0);
      const monthLoanTotal = currentMonth ? (Number(currentMonth.outstandingLoans) || 0) : sumMemberLoans;
      const loanMismatch = currentMonth && currentMonth.status === 'closed'
        ? Math.round((monthLoanTotal - sumMemberLoans) * 100) / 100
        : 0;

      const isBackgroundScan = url.searchParams.get('background') === '1';
      const criticalErrors = evaluateHealthErrorsFromState(st, Number((gsStats && gsStats.bytes) || 0), d1UsedBytes);
      const issues = criticalErrors.map((errItem) => ({
        severity: 'error',
        title: errItem.title,
        detail: errItem.detail,
        solution: errItem.solution,
        action: errItem.action || ''
      }));
      if (openComplaints.length > 0) {
        issues.push({
          severity: 'warn',
          title: openComplaints.length + ' वटा सदस्य गुनासो समाधान बाँकी',
          detail: 'सदस्यहरूले पठाएका गुनासो/सुझावमा जवाफ वा समाधान चिन्ह बाँकी छ।',
          solution: 'गुनासो सूची खोली जवाफ पठाएर ✅ समाधान भयो चिन्ह लगाउनुहोस्।',
          action: 'complaints'
        });
      }
      if (pendingPins.length > 0) {
        issues.push({
          severity: 'warn',
          title: pendingPins.length + ' वटा PIN अनुरोध पेन्डिङ',
          detail: 'सदस्यहरूले लगइन PIN रिसेटको लागि अनुरोध पठाएका छन्।',
          solution: 'PIN अनुरोध खोली अस्थायी PIN सेट गरी सदस्यलाई पठाउनुहोस्।',
          action: 'pins'
        });
      }
      if (noPinMembers.length > 0) {
        issues.push({
          severity: 'warn',
          title: noPinMembers.length + ' जना सक्रिय सदस्यको PIN सेट छैन',
          detail: 'PIN सेट नभएका सदस्यले मोबाइलबाट एप खोल्न सक्दैनन्।',
          solution: 'प्रोफाइल सूचीमा "PIN छैन" फिल्टर गरी अस्थायी PIN बनाइदिनुहोस्।',
          action: 'nopin'
        });
      }
      if (inlineScan.inlineCount > 0 && !r2.enabled) {
        issues.push({
          severity: 'warn',
          title: 'R2 बाइन्डिङ नभएकोले ' + inlineScan.inlineCount + ' वटा मिडिया D1 भित्रै बसेका छन्',
          detail: 'अहिले ' + Math.round(inlineScan.inlineBytes / 1024) + ' KB फोटो/सहि D1 डाटाबेसमा छ (Free Plan 5 GB मा अति थोरै % मात्र छ, समस्या छैन; धेरै सदस्य बढ्दा R2 जोड्न सकिन्छ)।',
          solution: 'भविष्यमा R2 सक्षम भएपछि डेटा सिंक गर्दा ती फाइलहरू स्वतः R2 मा सर्छन्।',
          action: ''
        });
      }
      if (agreedMembers.length < activeMembers.length) {
        issues.push({
          severity: 'warn',
          title: (activeMembers.length - agreedMembers.length) + ' जना सदस्यले सर्त v' + curTermsVer + ' मञ्जुरी गर्न बाँकी',
          detail: 'यी सदस्यले अर्को पटक एप खोल्दा मञ्जुरी स्क्रिन देख्नेछन्।',
          solution: 'सर्त तथा मञ्जुरी ट्र्याकिङबाट सूची हेर्नुहोस्।',
          action: 'terms'
        });
      }
      if (!st.treasurer || !st.treasurer.username) {
        issues.push({
          severity: 'warn',
          title: 'कोषाध्यक्ष नियुक्त भएको छैन',
          detail: 'हिसाब लेख्न सक्रिय सदस्यबाट कोषाध्यक्ष नियुक्त गर्नुपर्छ।',
          solution: 'सेटिङ → कोषाध्यक्ष बाट नियुक्त गर्नुहोस्।',
          action: 'treasurer'
        });
      }
      if (issues.length === 0) {
        issues.push({
          severity: 'ok',
          title: 'सबै प्रणाली र हिसाब १००% स्वस्थ छ',
          detail: 'डाटाबेस, ऋण मिलान, सदस्य PIN, गुनासो र कोषाध्यक्ष व्यवस्था सबै ठीक छ।',
          solution: 'कुनै मर्मत वा एक्सन आवश्यक छैन।',
          action: ''
        });
      }

      // Real chronological activity log (from processed_txns + recent complaints + months + chat announcements)
      const recentTxns = await env.DB
        .prepare('SELECT txn_id, actor, action, applied_version, created_at FROM processed_txns ORDER BY created_at DESC LIMIT 15')
        .all()
        .catch(() => ({ results: [] }));
      const recentSysChat = await env.DB
        .prepare("SELECT id, text, type, created_at FROM chat_messages WHERE channel = 'group' AND (type = 'auto_group' OR from_role = 'system') ORDER BY created_at DESC LIMIT 10")
        .all()
        .catch(() => ({ results: [] }));

      const activities = [];
      for (const tx of recentTxns.results || []) {
        activities.push({
          kind: tx.action === 'close_month' ? 'month' : 'sync',
          title: tx.action === 'close_month' ? '🔒 महिना बन्द र स्न्यापसट सेभ' : '💾 हिसाब डाटा सिंक',
          detail: (tx.actor || 'कोषाध्यक्ष') + ' · v' + (tx.applied_version || ''),
          time: tx.created_at
        });
      }
      for (const c of (st.complaints || []).slice(-10)) {
        if (!c || c.auto) continue;
        const mem = members.find((m) => m && m.id === c.memberId);
        activities.push({
          kind: 'complaint',
          title: c.resolved ? '✅ गुनासो समाधान' : '📢 सदस्य गुनासो प्राप्त',
          detail: (mem ? mem.name : c.memberId) + ': ' + String(c.text || '').slice(0, 60),
          time: c.resolvedAt || c.time
        });
      }
      for (const pr of (st.pinRequests || []).slice(-6)) {
        if (!pr) continue;
        activities.push({
          kind: 'pin',
          title: pr.status === 'pending' ? '🔢 नयाँ PIN अनुरोध' : '✅ PIN अनुरोध स्वीकृत',
          detail: (pr.memberName || pr.memberId) + ' (' + (pr.mobile || '') + ')',
          time: pr.time
        });
      }
      for (const chm of recentSysChat.results || []) {
        activities.push({
          kind: 'chat',
          title: '💬 समूह सूचना पोस्ट',
          detail: String(chm.text || '').split('\\n')[0].slice(0, 65),
          time: chm.created_at
        });
      }
      activities.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

      const nepalNow = getNepalNowApi();
      const nepalDate = nepalNow.toISOString().slice(0, 10);
      const bsNow = adToBsPartsApi(nepalNow);
      const currentHealthKey = bsNow ? ('health_check_' + bsNow.year + '_' + bsNow.monthIndex) : ('health_' + nepalDate);
      const nowIso = new Date(Date.now()).toISOString();
      const errSig = criticalErrors.map((e) => e.code + ':' + e.title).join('|');
      let healthAlertState = await getSecretJson(env.DB, 'health_alert_state');
      let alertAcknowledged = false;

      if (!isBackgroundScan) {
        if (healthAlertState && healthAlertState.active) alertAcknowledged = true;
        healthAlertState = Object.assign({}, healthAlertState || {}, {
          active: false,
          acknowledgedAt: nowIso,
          acknowledgedBy: user.username || 'admin',
          acknowledgedKey: (healthAlertState && healthAlertState.healthKey) || currentHealthKey,
          acknowledgedSignature: errSig
        });
        await setSecretJson(env.DB, 'health_alert_state', healthAlertState);
      } else if (criticalErrors.length > 0) {
        const alreadyAckedMonth = healthAlertState && healthAlertState.acknowledgedKey === currentHealthKey && healthAlertState.acknowledgedSignature === errSig;
        if (!alreadyAckedMonth && !(healthAlertState && healthAlertState.active)) {
          const emailRes = await sendAdminHealthEmailApi(env, st, criticalErrors, nepalDate);
          await sendAdminHealthAlertPush(env, criticalErrors, 1);
          healthAlertState = {
            active: true,
            healthKey: currentHealthKey,
            alertDate: nepalDate,
            detectedAt: nowIso,
            acknowledgedAt: null,
            acknowledgedKey: null,
            acknowledgedSignature: null,
            errorCount: criticalErrors.length,
            errorSignature: errSig,
            summary: criticalErrors[0].title,
            emailStatus: emailRes.status,
            emailTo: emailRes.to || '',
            emailSentAt: emailRes.sent ? nowIso : null,
            lastNotifiedAt: nowIso,
            notifyCount: 1
          };
          await setSecretJson(env.DB, 'health_alert_state', healthAlertState);
        }
      }

      const emailAlert = {
        providerReady: isEmailProviderConfigured(env),
        recipient: getAdminAlertRecipient(env, st),
        lastEmailStatus: (healthAlertState && healthAlertState.emailStatus) || '',
        lastEmailAt: (healthAlertState && healthAlertState.emailSentAt) || null
      };

      return json({
        ok: true,
        alertAcknowledged,
        healthAlertState,
        emailAlert,
        checkedAt: nowIso,
        version: stateRow.version,
        stateUpdatedAt: stateRow.updatedAt,
        cloudflareFreeLimits: {
          plan: 'Cloudflare Free Plan',
          d1StorageBytes: d1LimitBytes,
          d1DailyReads: 5000000,
          d1DailyWrites: 100000,
          r2StorageBytes: 10 * 1024 * 1024 * 1024,
          pagesDailyRequests: 100000
        },
        d1: {
          usedBytes: d1UsedBytes,
          limitBytes: d1LimitBytes,
          groupStateBytes: Number((gsStats && gsStats.bytes) || 0),
          chatCount: Number((chatStats && chatStats.cnt) || 0),
          chatBytes: Number((chatStats && chatStats.bytes) || 0),
          snapshotCount: Number((snapStats && snapStats.cnt) || 0),
          snapshotBytes: Number((snapStats && snapStats.bytes) || 0),
          credentialsCount: Number((credStats && credStats.cnt) || 0),
          pushDevices: Number((pushStats && pushStats.cnt) || 0),
          pushUsers: Number((pushStats && pushStats.users) || 0),
          processedTxns: Number((txnStats && txnStats.cnt) || 0)
        },
        r2,
        inlineMedia: inlineScan,
        stats: {
          activeMembers: activeMembers.length,
          totalMembers: members.length,
          closedMonths: months.filter((m) => m && m.status === 'closed').length,
          currentMonth: currentMonth ? (currentMonth.name + ' (' + currentMonth.status + ')') : 'कुनै महिना खुल्ला छैन',
          openComplaints: openComplaints.length,
          pendingPins: pendingPins.length,
          noPinMembers: noPinMembers.length,
          termsVersion: curTermsVer,
          termsAgreed: agreedMembers.length
        },
        issues,
        activities: activities.slice(0, 25)
      });
    }

    return json({ ok: false, error: 'Route not found: ' + path }, 404);
  } catch (err) {
    console.error('API Error:', err);
    return json({ ok: false, error: err && err.message ? err.message : String(err) }, 500);
  }
}

