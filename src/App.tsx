import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  Database,
  Download,
  FileCode2,
  FolderGit2,
  HardDrive,
  Laptop,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';

type TabKey = 'preview' | 'deploy' | 'inspector' | 'files';

interface CredentialRow {
  id: string;
  role: string;
  username: string | null;
  mobile: string | null;
  member_id: string | null;
  name: string | null;
  accounts_writer: number;
  active: number;
  updated_at: string;
}

interface SnapshotRow {
  month_id: string;
  name: string;
  year_bs: number | null;
  month_index: number | null;
  r2_backup_key: string | null;
  closed_at: string;
}

interface OverviewResponse {
  ok: boolean;
  state: {
    version: number;
    updatedAt: string;
    groupName: string;
    activeMembers: number;
    monthsCount: number;
    currentMonthId: string | null;
  } | null;
  credentials: CredentialRow[];
  snapshots: SnapshotRow[];
  counts: {
    chatMessages: number;
    pushSubscriptions: number;
    processedTxns: number;
    r2Objects: number;
  };
  r2Objects: { key: string; size: number }[];
  repoFiles: { path: string; size: number }[];
}

interface FileResponse {
  ok: boolean;
  path: string;
  binary: boolean;
  size: number;
  content?: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('preview');
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop'>('mobile');
  const [iframeKey, setIframeKey] = useState(1);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string>('wrangler.toml');
  const [fileData, setFileData] = useState<FileResponse | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const res = await fetch('/api/_meta/overview');
      const data = (await res.json()) as OverviewResponse;
      if (data.ok) setOverview(data);
    } catch {
      // ignore transient network errors
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const fetchRepoFile = useCallback(async (relPath: string) => {
    setSelectedFile(relPath);
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/_meta/file?path=${encodeURIComponent(relPath)}`);
      const data = (await res.json()) as FileResponse;
      if (data.ok) setFileData(data);
    } catch {
      setFileData(null);
    } finally {
      setLoadingFile(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    fetchRepoFile('wrangler.toml');
  }, [fetchOverview, fetchRepoFile]);

  const handleResetDemoDb = async () => {
    setResetting(true);
    try {
      await fetch('/api/_meta/reset', { method: 'POST' });
      setConfirmReset(false);
      setIframeKey((k) => k + 1);
      await fetchOverview();
    } finally {
      setResetting(false);
    }
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const navItems: { key: TabKey; label: string; sub: string; icon: typeof Smartphone }[] = [
    { key: 'preview', label: 'Live PWA Preview', sub: 'D1 + R2 Simulator', icon: Smartphone },
    { key: 'deploy', label: 'GitHub → Cloudflare', sub: 'Setup & Deploy Guide', icon: Cloud },
    { key: 'inspector', label: 'D1 & R2 Inspector', sub: 'Tables, Auth & Snapshots', icon: Database },
    { key: 'files', label: 'Repo Explorer', sub: 'bachat-repo files', icon: FileCode2 },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#0f172a] flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 bg-white border-b lg:border-b-0 lg:border-r border-[#e2e8f0] flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-[#e2e8f0] flex items-center gap-3">
          <img
            src="/bachat/icon-192.png"
            alt="समूह बचत"
            className="w-10 h-10 rounded-lg object-cover border border-[#e2e8f0]"
          />
          <div className="min-w-0">
            <div className="font-bold text-sm text-[#0f172a] truncate">समूह बचत (Bachat)</div>
            <div className="text-xs text-[#64748b] truncate">Cloudflare Pages + D1 + R2</div>
          </div>
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setActiveTab(item.key);
                  if (item.key === 'inspector') fetchOverview();
                }}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors shrink-0 lg:w-full ${
                  active
                    ? 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]'
                    : 'text-[#334155] hover:bg-[#f1f5f9] border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold leading-tight">{item.label}</div>
                  <div className="text-[11px] text-[#64748b] leading-tight mt-0.5 hidden lg:block">{item.sub}</div>
                </div>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto p-4 border-t border-[#e2e8f0] hidden lg:flex flex-col gap-2.5">
          <div className="rounded-lg bg-[#f8fafc] border border-[#e2e8f0] p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[#64748b]">D1 State Version</span>
              <span className="font-mono font-semibold tabular-nums">
                {overview?.state ? `v${overview.state.version}` : 'Empty'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#64748b]">Credentials</span>
              <span className="font-mono font-semibold tabular-nums">
                {overview?.credentials.length ?? 0}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#64748b]">R2 Objects</span>
              <span className="font-mono font-semibold tabular-nums">
                {overview?.counts.r2Objects ?? 0}
              </span>
            </div>
          </div>

          <a
            href="/api/_meta/download-zip"
            download="bachat-cloudflare.zip"
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg bg-[#0f172a] hover:bg-[#1e293b] text-white text-xs font-semibold transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download GitHub Repo (.zip)
          </a>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Action Bar */}
        <header className="bg-white border-b border-[#e2e8f0] px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-bold text-[#0f172a]">
              {activeTab === 'preview' && 'Live Cloudflare PWA Simulator'}
              {activeTab === 'deploy' && 'GitHub (“bachat”) → Cloudflare Pages Setup'}
              {activeTab === 'inspector' && 'Local D1 SQLite & R2 Media Inspector'}
              {activeTab === 'files' && 'Cloudflare Repository Files (bachat-repo/)'}
            </h1>
            <p className="text-xs text-[#64748b]">
              {activeTab === 'preview' && 'Runs the exact Cloudflare Worker API (functions/api/[[path]].js) and accounting.js formulas locally.'}
              {activeTab === 'deploy' && 'Push bachat-repo to your GitHub repo named "bachat", bind D1 + R2, and import your existing JSON backup.'}
              {activeTab === 'inspector' && 'Inspect real rows stored in schema.sql tables and R2 object blobs.'}
              {activeTab === 'files' && 'Review wrangler.toml, schema.sql, API worker, service worker, and frontend modules.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {activeTab === 'preview' && (
              <>
                <div className="inline-flex rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewportMode('mobile')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${
                      viewportMode === 'mobile' ? 'bg-white text-[#0f172a] shadow-xs' : 'text-[#64748b]'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    Mobile
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewportMode('desktop')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${
                      viewportMode === 'desktop' ? 'bg-white text-[#0f172a] shadow-xs' : 'text-[#64748b]'
                    }`}
                  >
                    <Laptop className="w-3.5 h-3.5" />
                    Full
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setIframeKey((k) => k + 1);
                    fetchOverview();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e2e8f0] bg-white hover:bg-[#f8fafc] text-xs font-medium text-[#334155]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reload App
                </button>

                {!confirmReset ? (
                  <button
                    type="button"
                    onClick={() => setConfirmReset(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#fecaca] bg-[#fef2f2] hover:bg-[#fee2e2] text-xs font-medium text-[#b91c1c]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Local DB
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-1.5 bg-[#fef2f2] border border-[#fca5a5] rounded-lg px-2 py-1">
                    <span className="text-[11px] font-medium text-[#991b1b]">Clear local test DB?</span>
                    <button
                      type="button"
                      disabled={resetting}
                      onClick={handleResetDemoDb}
                      className="px-2 py-0.5 rounded bg-[#dc2626] text-white text-[11px] font-semibold"
                    >
                      {resetting ? '...' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmReset(false)}
                      className="px-2 py-0.5 rounded bg-white border border-[#e2e8f0] text-[11px] text-[#334155]"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}

            <a
              href="/api/_meta/download-zip"
              download="bachat-cloudflare.zip"
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0f172a] text-white text-xs font-semibold"
            >
              <Download className="w-3.5 h-3.5" />
              ZIP
            </a>
          </div>
        </header>

        {/* Tab Bodies */}
        <div className="flex-1 p-4 lg:p-6 overflow-auto">
          {activeTab === 'preview' && (
            <div className="h-full flex flex-col items-center justify-start gap-3">
              <div className="w-full max-w-4xl bg-white border border-[#e2e8f0] rounded-lg px-4 py-2.5 text-xs text-[#475569] flex flex-wrap items-center justify-between gap-2">
                <span>
                  पहिलो पटक परीक्षण गर्दा भित्रको लगइन स्क्रिनबाट{' '}
                  <strong className="text-[#0f172a]">📥 पुरानो JSON ब्याकअप Import</strong> वा{' '}
                  <strong className="text-[#0f172a]">➕ नयाँ Admin खाता</strong> छान्नुहोस्।
                </span>
                <span className="font-mono text-[11px] text-[#059669] bg-[#ecfdf5] border border-[#a7f3d0] px-2 py-0.5 rounded">
                  /bachat/ → /api/* (D1 + R2)
                </span>
              </div>

              <div
                className={`bg-white border border-[#cbd5e1] rounded-2xl overflow-hidden shadow-sm transition-all ${
                  viewportMode === 'mobile'
                    ? 'w-full max-w-[400px] h-[760px]'
                    : 'w-full h-[780px]'
                }`}
              >
                <iframe
                  key={iframeKey}
                  src="/bachat/"
                  title="Samuha Bachat Live Cloudflare PWA"
                  className="w-full h-full border-0 bg-white"
                />
              </div>
            </div>
          )}

          {activeTab === 'deploy' && (
            <div className="max-w-4xl mx-auto space-y-4">
              <div className="bg-white border border-[#e2e8f0] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="p-2.5 rounded-lg bg-[#eff6ff] text-[#2563eb] border border-[#bfdbfe]">
                    <FolderGit2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="font-bold text-sm text-[#0f172a]">
                      Step 1: Create GitHub Repository Named <code className="text-[#2563eb]">bachat</code>
                    </h2>
                    <p className="text-xs text-[#475569] mt-1">
                      Download the deployment ZIP package (which contains all files from{' '}
                      <code className="font-mono">bachat-repo/</code>) and push them to a new GitHub repository named{' '}
                      <strong>bachat</strong>.
                    </p>
                  </div>
                </div>
                <a
                  href="/api/_meta/download-zip"
                  download="bachat-cloudflare.zip"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#2563eb] hover:bg-[#1d4ed8] text-white text-xs font-semibold shrink-0"
                >
                  <Download className="w-4 h-4" />
                  Download bachat-cloudflare.zip
                </a>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#0f172a]">
                    <Database className="w-4 h-4 text-[#0d9488]" />
                    Step 2: Create Cloudflare D1 & R2
                  </div>
                  <ol className="text-xs text-[#334155] space-y-2 list-decimal pl-4">
                    <li>
                      Cloudflare Dashboard → <strong>Storage & Databases → D1 SQL Database</strong> → Create database named{' '}
                      <code className="font-mono bg-[#f1f5f9] px-1 rounded">bachat-db</code>.
                    </li>
                    <li>
                      Open <strong>Console</strong> inside <code className="font-mono">bachat-db</code> and execute the entire{' '}
                      <code className="font-mono bg-[#f1f5f9] px-1 rounded">schema.sql</code> file.
                    </li>
                    <li>
                      Go to <strong>R2 Object Storage → Create bucket</strong> named{' '}
                      <code className="font-mono bg-[#f1f5f9] px-1 rounded">bachat-media</code>.
                    </li>
                    <li>
                      Copy the D1 <code className="font-mono">database_id</code> into{' '}
                      <code className="font-mono">wrangler.toml</code> and{' '}
                      <code className="font-mono">cron-worker/wrangler.toml</code>.
                    </li>
                  </ol>
                </div>

                <div className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#0f172a]">
                    <Cloud className="w-4 h-4 text-[#2563eb]" />
                    Step 3: Connect GitHub to Cloudflare Pages
                  </div>
                  <ol className="text-xs text-[#334155] space-y-2 list-decimal pl-4">
                    <li>
                      Cloudflare Dashboard → <strong>Workers & Pages → Create → Pages → Connect to Git</strong> → select{' '}
                      <code className="font-mono bg-[#f1f5f9] px-1 rounded">bachat</code>.
                    </li>
                    <li>
                      Build command: <em>leave blank</em>. Build output directory:{' '}
                      <code className="font-mono bg-[#f1f5f9] px-1 rounded">public</code>.
                    </li>
                    <li>
                      After first deploy, open <strong>Settings → Functions → Bindings</strong> and add:
                      <ul className="list-disc pl-4 mt-1 space-y-1">
                        <li>
                          D1 database binding: <code className="font-mono font-semibold">DB</code> →{' '}
                          <code className="font-mono">bachat-db</code>
                        </li>
                        <li>
                          R2 bucket binding: <code className="font-mono font-semibold">MEDIA</code> →{' '}
                          <code className="font-mono">bachat-media</code>
                        </li>
                      </ul>
                    </li>
                    <li>Trigger <strong>Retry deployment</strong> so Pages Functions activate the bindings.</li>
                  </ol>
                </div>
              </div>

              <div className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#0f172a]">
                    <ShieldCheck className="w-4 h-4 text-[#059669]" />
                    Step 4: Import Old JSON Backup & Enable 2nd Friday Cron
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      copyText(
                        'git-cmds',
                        'git init\ngit add .\ngit commit -m "Samuha Bachat Cloudflare migration"\ngit branch -M main\ngit remote add origin https://github.com/YOUR_USERNAME/bachat.git\ngit push -u origin main'
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#e2e8f0] text-xs font-medium text-[#334155] hover:bg-[#f8fafc]"
                  >
                    {copiedId === 'git-cmds' ? <Check className="w-3.5 h-3.5 text-[#059669]" /> : <Copy className="w-3.5 h-3.5" />}
                    Copy Git Commands
                  </button>
                </div>
                <p className="text-xs text-[#475569]">
                  जब Cloudflare Pages लिंक खुल्छ, लगइन स्क्रिनमै <strong>“📥 पुरानो JSON ब्याकअप Import”</strong> बटन देखिन्छ। पहिले सेभ गरेको JSON फाइल छान्नुहोस् — पुराना महिना, सदस्य, कित्ता, ऋण, रसिद, पासवर्ड, PIN, सहि फोटो र च्याट सबै स्वतः D1 र R2 मा आयात हुन्छन्।
                </p>
                <pre className="bg-[#0f172a] text-[#e2e8f0] rounded-lg p-3.5 text-xs overflow-x-auto leading-relaxed">
{`# Inside extracted bachat/ folder:
git init
git add .
git commit -m "Samuha Bachat Cloudflare migration"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bachat.git
git push -u origin main

# Optional: Deploy 2nd-Friday 6:00 PM NPT automatic reminder worker
cd cron-worker && npx wrangler deploy`}
                </pre>
              </div>
            </div>
          )}

          {activeTab === 'inspector' && (
            <div className="max-w-5xl mx-auto space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-[#64748b]">
                  Live snapshot from local SQLite D1 simulator (<code className="font-mono">.data/bachat.sqlite</code>)
                </div>
                <button
                  type="button"
                  onClick={fetchOverview}
                  disabled={loadingOverview}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e2e8f0] bg-white text-xs font-medium hover:bg-[#f8fafc]"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingOverview ? 'animate-spin' : ''}`} />
                  Refresh Tables
                </button>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="bg-white border border-[#e2e8f0] rounded-xl p-4">
                  <div className="text-xs text-[#64748b]">Group State Version</div>
                  <div className="text-xl font-bold font-mono tabular-nums mt-1">
                    {overview?.state ? `v${overview.state.version}` : '—'}
                  </div>
                  <div className="text-[11px] text-[#64748b] mt-1 truncate">
                    {overview?.state?.groupName || 'Not initialized'}
                  </div>
                </div>
                <div className="bg-white border border-[#e2e8f0] rounded-xl p-4">
                  <div className="text-xs text-[#64748b]">Active Members / Months</div>
                  <div className="text-xl font-bold font-mono tabular-nums mt-1">
                    {overview?.state?.activeMembers ?? 0} / {overview?.state?.monthsCount ?? 0}
                  </div>
                  <div className="text-[11px] text-[#64748b] mt-1">
                    Open month: {overview?.state?.currentMonthId || 'None'}
                  </div>
                </div>
                <div className="bg-white border border-[#e2e8f0] rounded-xl p-4">
                  <div className="text-xs text-[#64748b]">Chat / Processed Txns</div>
                  <div className="text-xl font-bold font-mono tabular-nums mt-1">
                    {overview?.counts.chatMessages ?? 0} / {overview?.counts.processedTxns ?? 0}
                  </div>
                  <div className="text-[11px] text-[#64748b] mt-1">
                    Push subs: {overview?.counts.pushSubscriptions ?? 0}
                  </div>
                </div>
                <div className="bg-white border border-[#e2e8f0] rounded-xl p-4">
                  <div className="text-xs text-[#64748b]">R2 Media & Archives</div>
                  <div className="text-xl font-bold font-mono tabular-nums mt-1">
                    {overview?.counts.r2Objects ?? 0} files
                  </div>
                  <div className="text-[11px] text-[#64748b] mt-1">
                    Closed snapshots: {overview?.snapshots.length ?? 0}
                  </div>
                </div>
              </div>

              {/* Credentials Table */}
              <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#e2e8f0] flex items-center justify-between">
                  <div className="text-xs font-bold text-[#0f172a] flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#2563eb]" />
                    auth_credentials (PBKDF2 Hashed — Secrets Never Exposed)
                  </div>
                  <span className="text-[11px] font-mono text-[#64748b]">
                    {overview?.credentials.length ?? 0} rows
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-[#f8fafc] text-[#64748b] border-b border-[#e2e8f0]">
                      <tr>
                        <th className="px-4 py-2.5 font-semibold">ID</th>
                        <th className="px-4 py-2.5 font-semibold">Role</th>
                        <th className="px-4 py-2.5 font-semibold">Name</th>
                        <th className="px-4 py-2.5 font-semibold">Username / Mobile</th>
                        <th className="px-4 py-2.5 font-semibold">Writer (Admin A)</th>
                        <th className="px-4 py-2.5 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e2e8f0]">
                      {!overview?.credentials.length ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-6 text-center text-[#64748b]">
                            No credentials yet — create an Admin account or import a JSON backup in Live Preview.
                          </td>
                        </tr>
                      ) : (
                        overview.credentials.map((c) => (
                          <tr key={c.id} className="hover:bg-[#f8fafc]">
                            <td className="px-4 py-2 font-mono text-[11px]">{c.id}</td>
                            <td className="px-4 py-2 font-mono text-[11px]">{c.role}</td>
                            <td className="px-4 py-2 font-medium">{c.name || '—'}</td>
                            <td className="px-4 py-2 font-mono text-[11px]">
                              {c.username || c.mobile || '—'}
                            </td>
                            <td className="px-4 py-2">
                              {c.accounts_writer === 1 ? 'Yes (Writer)' : 'Read-only'}
                            </td>
                            <td className="px-4 py-2">{c.active ? 'Active' : 'Inactive'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Closed Month Snapshots & R2 Objects */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#e2e8f0] text-xs font-bold text-[#0f172a]">
                    month_snapshots (Immutable Closed Months)
                  </div>
                  <div className="divide-y divide-[#e2e8f0] max-h-64 overflow-y-auto">
                    {!overview?.snapshots.length ? (
                      <div className="px-4 py-6 text-xs text-center text-[#64748b]">No closed months yet</div>
                    ) : (
                      overview.snapshots.map((s) => (
                        <div key={s.month_id} className="px-4 py-2.5 text-xs flex items-center justify-between gap-2">
                          <div>
                            <div className="font-semibold text-[#0f172a]">{s.name || s.month_id}</div>
                            <div className="text-[11px] font-mono text-[#64748b]">
                              {s.r2_backup_key || 'D1 snapshot only'}
                            </div>
                          </div>
                          <span className="font-mono text-[11px] text-[#64748b]">{s.closed_at.slice(0, 10)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#e2e8f0] text-xs font-bold text-[#0f172a] flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-[#0d9488]" />
                    R2 Storage Objects (.data/r2)
                  </div>
                  <div className="divide-y divide-[#e2e8f0] max-h-64 overflow-y-auto">
                    {!overview?.r2Objects.length ? (
                      <div className="px-4 py-6 text-xs text-center text-[#64748b]">No R2 files uploaded yet</div>
                    ) : (
                      overview.r2Objects.map((obj) => (
                        <div key={obj.key} className="px-4 py-2 text-xs flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] truncate">{obj.key}</span>
                          <span className="font-mono text-[11px] text-[#64748b] shrink-0">
                            {formatBytes(obj.size)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'files' && (
            <div className="max-w-6xl mx-auto grid lg:grid-cols-12 gap-4 h-[740px]">
              <div className="lg:col-span-4 bg-white border border-[#e2e8f0] rounded-xl flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-[#e2e8f0] flex items-center justify-between">
                  <span className="text-xs font-bold text-[#0f172a]">bachat-repo/ Files</span>
                  <span className="text-[11px] font-mono text-[#64748b]">
                    {overview?.repoFiles.length ?? 0} files
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-[#f1f5f9]">
                  {(overview?.repoFiles || []).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => fetchRepoFile(f.path)}
                      className={`w-full px-4 py-2 text-left text-xs flex items-center justify-between gap-2 hover:bg-[#f8fafc] ${
                        selectedFile === f.path ? 'bg-[#eff6ff] text-[#1d4ed8] font-semibold' : 'text-[#334155]'
                      }`}
                    >
                      <span className="font-mono text-[11px] truncate">{f.path}</span>
                      <span className="font-mono text-[10px] text-[#64748b] shrink-0">
                        {formatBytes(f.size)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-8 bg-white border border-[#e2e8f0] rounded-xl flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-[#e2e8f0] flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-[#0f172a] truncate">
                    {selectedFile}
                  </span>
                  {fileData && !fileData.binary && fileData.content && (
                    <button
                      type="button"
                      onClick={() => copyText('file-src', fileData.content || '')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#e2e8f0] text-xs font-medium text-[#334155] hover:bg-[#f8fafc]"
                    >
                      {copiedId === 'file-src' ? <Check className="w-3.5 h-3.5 text-[#059669]" /> : <Copy className="w-3.5 h-3.5" />}
                      Copy
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-auto bg-[#0f172a] text-[#e2e8f0] p-4">
                  {loadingFile ? (
                    <div className="text-xs text-[#94a3b8]">Loading file...</div>
                  ) : fileData?.binary ? (
                    <div className="text-xs text-[#94a3b8]">
                      Binary asset ({formatBytes(fileData.size)}) — included in ZIP download.
                    </div>
                  ) : (
                    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
                      {fileData?.content || ''}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
