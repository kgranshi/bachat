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
    chat: { group: [], private: {} }
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
      memberId: clean.admin.memberId || 'm1',
      hasPin: !!(clean.admin.pin || clean.admin.hasPin)
    };
  }
  if (clean.settings) {
    clean.settings = Object.assign({}, clean.settings, { closePin: '' });
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

function sanitizeStateForRole(state, user) {
  const out = stripSecretsFromState(state);
  if (user.role === 'member') {
    out.pinRequests = (out.pinRequests || []).filter((r) => r.memberId === user.memberId);
    out.complaints = (out.complaints || []).filter((c) => c.memberId === user.memberId);
    out.suggestions = (out.suggestions || []).filter((s) => s.memberId === user.memberId);
    out.secondaryAdmins = [];
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

async function loadChatFromDb(db, user) {
  const rows = await db
    .prepare('SELECT id, channel, from_id, from_name, from_role, text, type, bill_id, created_at FROM chat_messages ORDER BY created_at ASC LIMIT 800')
    .all();
  const group = [];
  const privateMap = {};
  for (const r of rows.results || []) {
    const msg = {
      id: r.id,
      fromId: r.from_id,
      fromName: r.from_name,
      fromRole: r.from_role,
      text: r.text,
      type: r.type,
      billId: r.bill_id || undefined,
      time: r.created_at
    };
    if (r.channel === 'group') {
      group.push(msg);
    } else if (r.channel.startsWith('private:')) {
      const mid = r.channel.slice('private:'.length);
      if (user.role !== 'member' || user.memberId === mid) {
        if (!privateMap[mid]) privateMap[mid] = [];
        privateMap[mid].push(msg);
      }
    }
  }
  return { group: group.slice(-500), private: privateMap };
}

async function syncCredentialsFromBackup(db, rawData) {
  const now = new Date().toISOString();
  const stmts = [];
  if (rawData.admin && rawData.admin.username && rawData.admin.password) {
    const writerName = (rawData.settings && rawData.settings.accountsWriterUsername) || rawData.admin.username;
    const isWriter = rawData.admin.username === writerName ? 1 : 0;
    const passHash = await hashSecret(rawData.admin.password);
    const pinVal = rawData.admin.pin || (rawData.settings && rawData.settings.closePin) || '';
    const pinHash = pinVal ? await hashSecret(pinVal) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
           VALUES ('admin', 'admin', ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             username=excluded.username, mobile=excluded.mobile, member_id=excluded.member_id,
             name=excluded.name, secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash,
             accounts_writer=excluded.accounts_writer, active=1, updated_at=excluded.updated_at`
        )
        .bind(
          rawData.admin.username,
          normalizeMobile(rawData.admin.mobile),
          rawData.admin.memberId || 'm1',
          rawData.admin.name || 'Admin',
          passHash,
          pinHash,
          isWriter,
          now
        )
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

  try {
    if (!path.startsWith('/media/')) {
      await ensureSchema(env.DB);
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
      state.admin = { name, username, password, mobile, pin, memberId: 'm1' };
      state.settings = Object.assign({}, defaultState().settings, state.settings || {}, {
        closePin: pin,
        accountsWriterUsername: username
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
           LIMIT 5`
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
      const pinFlags = matched.role === 'member' ? await getPinResetFlags(env.DB) : {};
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

      return json({
        ok: true,
        token,
        user: userObj,
        pinVerifier: matched.pin_hash || null,
        version: stateRow.version,
        data: sanitizeStateForRole(stateRow.data, userObj),
        chat
      });
    }

    // 6. Import Backup JSON (Allowed either BEFORE first admin exists OR by authenticated Admin A!)
    if (path === '/import-backup' && method === 'POST') {
      const existingAdmin = await env.DB.prepare("SELECT id FROM auth_credentials WHERE role = 'admin' LIMIT 1").first();
      let actor = 'bootstrap';
      if (existingAdmin) {
        const user = await authenticateRequest(request, env);
        if (!user || user.role !== 'admin' || !user.accountsWriter) {
          return json({ ok: false, error: 'Admin A लगइन आवश्यक छ' }, 403);
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

      // 3) Migrate chat messages into chat_messages table
      const chat = working.chat || { group: [], private: {} };
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
      for (const [mid, list] of Object.entries(chat.private || {})) {
        for (const m of list || []) {
          if (!m || !m.id) continue;
          chatStmts.push(
            env.DB
              .prepare(
                `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(
                String(m.id),
                'private:' + mid,
                String(m.fromId || ''),
                String(m.fromName || ''),
                String(m.fromRole || 'system'),
                String(m.text || ''),
                String(m.type || 'text'),
                m.billId ? String(m.billId) : null,
                String(m.time || new Date().toISOString())
              )
          );
        }
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
      const chat = await loadChatFromDb(env.DB, user);
      if (sinceVersion === stateRow.version) {
        return json({ ok: true, unchanged: true, version: stateRow.version, chat });
      }
      return json({
        ok: true,
        unchanged: false,
        version: stateRow.version,
        data: sanitizeStateForRole(stateRow.data, user),
        chat
      });
    }

    // 9. Save State (Admin A ONLY, version-checked & idempotent via txnId)
    if (path === '/state' && method === 'POST') {
      if (user.role !== 'admin' || !user.accountsWriter) {
        return json({ ok: false, error: 'Read-only: हिसाब लेख्ने अधिकार Admin A लाई मात्र छ' }, 403);
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
        data: sanitizeStateForRole(cleanState, user)
      });
    }

    // 10. Manage Credentials (Admin A updates Admin password/PIN, Admin B, or Member PIN)
    if (path === '/admin/credentials' && method === 'POST') {
      if (user.role !== 'admin' || !user.accountsWriter) {
        return json({ ok: false, error: 'Admin A मात्र' }, 403);
      }
      const body = await request.json();
      const now = new Date().toISOString();

      if (body.type === 'admin_profile') {
        const row = await env.DB.prepare("SELECT * FROM auth_credentials WHERE id = 'admin'").first();
        if (!row) return json({ ok: false, error: 'Admin फेला परेन' }, 404);
        const nextUser = body.username || row.username;
        const nextName = body.name || row.name;
        const nextMob = body.mobile ? normalizeMobile(body.mobile) : row.mobile;
        const nextPassHash = body.password ? await hashSecret(body.password) : row.secret_hash;
        const nextPinHash = body.pin ? await hashSecret(body.pin) : row.pin_hash;
        await env.DB
          .prepare(
            `UPDATE auth_credentials SET username=?, name=?, mobile=?, secret_hash=?, pin_hash=?, updated_at=? WHERE id='admin'`
          )
          .bind(nextUser, nextName, nextMob, nextPassHash, nextPinHash, now)
          .run();
        const jwtSecret = await getJwtSecret(env);
        const newUser = Object.assign({}, user, { username: nextUser, name: nextName, mobile: nextMob });
        const token = await signJwt(newUser, jwtSecret);
        return json({ ok: true, token, user: newUser, pinVerifier: nextPinHash });
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
        return json({ ok: true, isTemp: !!isTemp });
      }

      if (body.type === 'member_meta') {
        const { memberId, mobile, name, active } = body;
        const mob = normalizeMobile(mobile);
        await env.DB
          .prepare('UPDATE auth_credentials SET mobile=?, name=?, active=?, updated_at=? WHERE id=?')
          .bind(mob, name || memberId, active === false ? 0 : 1, now, 'mem:' + memberId)
          .run();
        return json({ ok: true });
      }

      if (body.type === 'secondary_add') {
        const { name, username, password, pin } = body;
        if (!username || !password || !pin) return json({ ok: false, error: 'सबै फिल्ड चाहिन्छ' }, 400);
        const passHash = await hashSecret(password);
        const pinHash = await hashSecret(pin);
        await env.DB
          .prepare(
            `INSERT INTO auth_credentials (id, role, username, mobile, member_id, name, secret_hash, pin_hash, accounts_writer, active, updated_at)
             VALUES (?, 'admin_ro', ?, '', NULL, ?, ?, ?, 0, 1, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, secret_hash=excluded.secret_hash, pin_hash=excluded.pin_hash, active=1, updated_at=excluded.updated_at`
          )
          .bind('sec:' + username, username, name || username, passHash, pinHash, now)
          .run();
        return json({ ok: true });
      }

      if (body.type === 'secondary_remove') {
        await env.DB.prepare('DELETE FROM auth_credentials WHERE id = ?').bind('sec:' + body.username).run();
        return json({ ok: true });
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
      const jwtSecret = await getJwtSecret(env);
      const updatedUser = Object.assign({}, user, { mustChangePin: false });
      const token = await signJwt(updatedUser, jwtSecret);
      return json({ ok: true, token, user: updatedUser, pinVerifier: newHash });
    }

    // 11. Chat GET & POST
    if (path === '/chat' && method === 'GET') {
      const chat = await loadChatFromDb(env.DB, user);
      return json({ ok: true, chat });
    }

    if (path === '/chat' && method === 'POST') {
      const body = await request.json();
      const { id, channel, text, type, billId, time } = body || {};
      if (!text || !String(text).trim()) {
        return json({ ok: false, error: 'सन्देश खाली छ' }, 400);
      }
      const ch = channel || 'group';
      if (ch.startsWith('private:') && user.role !== 'admin') {
        return json({ ok: false, error: 'अनुमति छैन' }, 403);
      }
      const msgId = String(id || 'm' + Date.now() + '_' + randomHex(3));
      const fromId = user.role === 'admin' ? (user.memberId || user.username || 'admin') : (user.memberId || user.username || 'user');
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
        const senderKey = user.role === 'admin' ? 'admin' : (user.memberId || null);
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
      return json({ ok: true, version: nextVersion });
    }

    // 13. Direct R2 Media Upload
    if (path === '/media' && method === 'POST') {
      const { category, idHint, dataUrl } = await request.json();
      const urlOut = await uploadDataUrlToR2(env, category || 'misc', idHint || 'file', dataUrl);
      return json({ ok: true, url: urlOut });
    }

    // 14. Web Push Subscription Management
    if (path === '/push/subscribe' && method === 'POST') {
      const sub = await request.json();
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json({ ok: false, error: 'Invalid push subscription' }, 400);
      }
      const userKey = user.role === 'admin' ? 'admin' : user.role === 'admin_ro' ? 'admin_ro' : (user.memberId || 'guest');
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
      const { endpoint } = await request.json().catch(() => ({}));
      if (endpoint) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      }
      return json({ ok: true });
    }

    if (path === '/push/test' && method === 'POST') {
      const vapid = await getVapidKeys(env);
      const userKey = user.role === 'admin' ? 'admin' : user.role === 'admin_ro' ? 'admin_ro' : (user.memberId || 'guest');
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

    // 15. Admin A Manual Meeting Reminder Push to ALL subscribed members (even when their app is closed)
    if (path === '/push/remind' && method === 'POST') {
      if (user.role !== 'admin' || !user.accountsWriter) {
        return json({ ok: false, error: 'Admin A मात्र' }, 403);
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
      let sent = 0;
      for (const s of subs) {
        if (s.user_key === 'admin') continue;
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

    // 16. Closed Month Snapshots (D1 + R2)
    if (path === '/snapshots' && method === 'GET') {
      if (user.role !== 'admin' && user.role !== 'admin_ro') {
        return json({ ok: false, error: 'Admin मात्र' }, 403);
      }
      const rows = await env.DB
        .prepare('SELECT month_id, name, year_bs, month_index, r2_backup_key, closed_at FROM month_snapshots ORDER BY closed_at DESC LIMIT 36')
        .all();
      return json({ ok: true, snapshots: rows.results || [] });
    }

    if (path.startsWith('/snapshot/') && method === 'GET') {
      if (user.role !== 'admin' && user.role !== 'admin_ro') {
        return json({ ok: false, error: 'Admin मात्र' }, 403);
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

    // 17. Full Backup Export
    if (path === '/export-backup' && method === 'GET') {
      if (user.role !== 'admin' && user.role !== 'admin_ro') {
        return json({ ok: false, error: 'Admin मात्र' }, 403);
      }
      const stateRow = await loadStateRow(env.DB);
      const chat = await loadChatFromDb(env.DB, user);
      const full = Object.assign({}, stateRow.data, { chat });
      return json({ ok: true, backup: full });
    }

    return json({ ok: false, error: 'Route not found: ' + path }, 404);
  } catch (err) {
    console.error('API Error:', err);
    return json({ ok: false, error: err && err.message ? err.message : String(err) }, 500);
  }
}
