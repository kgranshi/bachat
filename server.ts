import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';

const ROOT_DIR = process.cwd();
const REPO_DIR = path.join(ROOT_DIR, 'bachat-repo');
const PUBLIC_PWA_DIR = path.join(REPO_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, '.data');
const DB_FILE = path.join(DATA_DIR, 'bachat.sqlite');
const R2_DIR = path.join(DATA_DIR, 'r2');

function ensureStorageDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(R2_DIR, { recursive: true });
}

type SqlParam = string | number | bigint | Uint8Array | null;

function sanitizeParam(v: unknown): SqlParam {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

class LocalD1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: SqlParam[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.params = args.map(sanitizeParam);
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows, success: true };
  }

  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

class LocalD1Database {
  public raw: DatabaseSync;

  constructor(dbPath: string) {
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    const schemaSql = fs.readFileSync(path.join(REPO_DIR, 'schema.sql'), 'utf-8');
    this.raw.exec(schemaSql);
  }

  prepare(sql: string) {
    return new LocalD1PreparedStatement(this.raw, sql);
  }

  async batch(stmts: LocalD1PreparedStatement[]) {
    this.raw.exec('BEGIN');
    try {
      const results = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }
}

class LocalR2Bucket {
  private root: string;

  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  private resolveKey(key: string) {
    const clean = key.replace(/^\/+/, '').replace(/\.\./g, '_');
    return path.join(this.root, clean);
  }

  async put(key: string, value: Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
    const target = this.resolveKey(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof value === 'string') {
      fs.writeFileSync(target, value, 'utf-8');
    } else {
      fs.writeFileSync(target, Buffer.from(value));
    }
    const metaPath = target + '.meta.json';
    fs.writeFileSync(metaPath, JSON.stringify({ httpMetadata: options?.httpMetadata || {} }), 'utf-8');
  }

  async get(key: string) {
    const target = this.resolveKey(key);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    const body = fs.readFileSync(target);
    let httpMetadata: { contentType?: string } = {};
    const metaPath = target + '.meta.json';
    if (fs.existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        httpMetadata = parsed.httpMetadata || {};
      } catch {
        // ignore invalid metadata
      }
    }
    return { body, httpMetadata };
  }
}

function listRepoFiles(dir: string, base = ''): { path: string; size: number }[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const out: { path: string; size: number }[] = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.wrangler') continue;
    const full = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...listRepoFiles(full, rel));
    } else {
      const st = fs.statSync(full);
      out.push({ path: rel, size: st.size });
    }
  }
  return out;
}

function listR2Objects(dir: string, base = ''): { key: string; size: number }[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: { key: string; size: number }[] = [];
  for (const ent of entries) {
    if (ent.name.endsWith('.meta.json')) continue;
    const full = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...listR2Objects(full, rel));
    } else {
      out.push({ key: rel, size: fs.statSync(full).size });
    }
  }
  return out;
}

async function startServer() {
  ensureStorageDirs();
  let localDb = new LocalD1Database(DB_FILE);
  let localR2 = new LocalR2Bucket(R2_DIR);

  const workerPath = path.join(REPO_DIR, 'functions', 'api', '[[path]].js');
  const workerMod = (await import(pathToFileURL(workerPath).href)) as {
    onRequest: (ctx: { request: Request; env: Record<string, unknown> }) => Promise<Response>;
  };

  const app = express();

  // ---- Meta / Inspector / Download Endpoints for AI Studio Control Console ----
  app.get('/api/_meta/overview', (_req, res) => {
    try {
      const stateRow = localDb.raw
        .prepare("SELECT version, data_json, updated_at FROM group_state WHERE id = 'main'")
        .get() as { version: number; data_json: string; updated_at: string } | undefined;

      const parsedState = stateRow ? JSON.parse(stateRow.data_json) : null;
      const creds = localDb.raw
        .prepare('SELECT id, role, username, mobile, member_id, name, accounts_writer, active, updated_at FROM auth_credentials ORDER BY role ASC, id ASC')
        .all();
      const snapshots = localDb.raw
        .prepare('SELECT month_id, name, year_bs, month_index, r2_backup_key, closed_at FROM month_snapshots ORDER BY closed_at DESC')
        .all();
      const chatCountRow = localDb.raw.prepare('SELECT COUNT(*) AS cnt FROM chat_messages').get() as { cnt: number };
      const pushCountRow = localDb.raw.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get() as { cnt: number };
      const txnCountRow = localDb.raw.prepare('SELECT COUNT(*) AS cnt FROM processed_txns').get() as { cnt: number };
      const r2Objects = listR2Objects(R2_DIR);
      const repoFiles = listRepoFiles(REPO_DIR);

      res.json({
        ok: true,
        state: stateRow
          ? {
              version: stateRow.version,
              updatedAt: stateRow.updated_at,
              groupName: parsedState?.group?.name || 'समूह बचत',
              activeMembers: Array.isArray(parsedState?.members)
                ? parsedState.members.filter((m: { active?: boolean }) => m.active !== false).length
                : 0,
              monthsCount: Array.isArray(parsedState?.months) ? parsedState.months.length : 0,
              currentMonthId: parsedState?.currentMonthId || null,
            }
          : null,
        credentials: creds,
        snapshots,
        counts: {
          chatMessages: chatCountRow?.cnt || 0,
          pushSubscriptions: pushCountRow?.cnt || 0,
          processedTxns: txnCountRow?.cnt || 0,
          r2Objects: r2Objects.length,
        },
        r2Objects,
        repoFiles,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/_meta/file', (req, res) => {
    const rel = String(req.query.path || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      res.status(400).json({ ok: false, error: 'Invalid path' });
      return;
    }
    const target = path.resolve(REPO_DIR, rel);
    if (!target.startsWith(REPO_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.status(404).json({ ok: false, error: 'File not found' });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isBinary = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico'].includes(ext);
    if (isBinary) {
      res.json({ ok: true, path: rel, binary: true, size: fs.statSync(target).size });
      return;
    }
    res.json({
      ok: true,
      path: rel,
      binary: false,
      size: fs.statSync(target).size,
      content: fs.readFileSync(target, 'utf-8'),
    });
  });

  app.post('/api/_meta/reset', (_req, res) => {
    try {
      localDb.raw.close();
      for (const f of fs.readdirSync(DATA_DIR)) {
        fs.rmSync(path.join(DATA_DIR, f), { recursive: true, force: true });
      }
      ensureStorageDirs();
      localDb = new LocalD1Database(DB_FILE);
      localR2 = new LocalR2Bucket(R2_DIR);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/_meta/download-zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      const files = listRepoFiles(REPO_DIR);
      for (const f of files) {
        const full = path.join(REPO_DIR, f.path);
        zip.file(`bachat/${f.path}`, fs.readFileSync(full));
      }
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="bachat-cloudflare.zip"');
      res.send(buf);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Route all /api/* directly into Cloudflare Pages Function handler ----
  app.use('/api', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
    try {
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) headers.set(k, v.join(', '));
        else headers.set(k, v);
      }
      const method = req.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const rawBody = hasBody && Buffer.isBuffer(req.body) ? req.body : undefined;
      const webReq = new Request(fullUrl, {
        method,
        headers,
        body: rawBody && rawBody.length > 0 ? new Uint8Array(rawBody) : undefined,
      });

      const webRes = await workerMod.onRequest({
        request: webReq,
        env: {
          DB: localDb,
          MEDIA: localR2,
        },
      });

      res.status(webRes.status);
      webRes.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'transfer-encoding') return;
        res.setHeader(key, value);
      });
      const arrBuf = await webRes.arrayBuffer();
      res.send(Buffer.from(arrBuf));
    } catch (err) {
      console.error('Worker bridge error:', err);
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Serve Cloudflare PWA directly at /bachat/ ----
  app.use('/bachat', (req, res, next) => {
    const rawPath = req.originalUrl.split('?')[0];
    if (rawPath === '/bachat') {
      res.redirect(301, '/bachat/');
      return;
    }
    next();
  });
  app.use('/bachat', express.static(PUBLIC_PWA_DIR, { index: 'index.html' }));

  // ---- Vite dev middleware or production static dist ----
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(ROOT_DIR, 'dist'))) {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Samuha Bachat Cloudflare Workbench listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
