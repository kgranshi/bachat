/**
 * Cloudflare D1 + R2 Data Layer (replaces Firebase Firestore)
 * - Accounting logic in accounting.js remains 100% untouched.
 * - Offline Outbox Queue ensures zero dropped saves and zero duplicate entries (txnId).
 * - Heavy media (loan signatures, member photos, theme photo, welcome video) offload to R2.
 * - Background polling keeps Admin B & Members synced automatically.
 */

const DB = {
  KEY: 'group_savings_v1',
  TOKEN_KEY: 'gs_token',
  VERSION_KEY: 'gs_server_version',
  PENDING_KEY: 'gs_pending_sync',
  PENDING_CHAT_KEY: 'gs_pending_chat',

  _cache: null,
  _cloud: false,
  _applyingRemote: false,
  _saveTimer: null,
  _flushing: false,
  _flushAgain: false,
  _pollTimer: null,
  _onRemote: null,
  _onlineBound: false,
  _serverVersion: 0,
  _hasAdminOnServer: false,

  apiUrl(path) {
    return '/api' + (path.startsWith('/') ? path : '/' + path);
  },

  getToken() {
    try { return localStorage.getItem(this.TOKEN_KEY) || ''; } catch (e) { return ''; }
  },

  setToken(token) {
    try {
      if (token) localStorage.setItem(this.TOKEN_KEY, token);
      else localStorage.removeItem(this.TOKEN_KEY);
    } catch (e) {}
  },

  getServerVersion() {
    if (this._serverVersion) return this._serverVersion;
    try {
      this._serverVersion = parseInt(localStorage.getItem(this.VERSION_KEY) || '0', 10) || 0;
    } catch (e) { this._serverVersion = 0; }
    return this._serverVersion;
  },

  setServerVersion(v) {
    this._serverVersion = Number(v) || 0;
    try { localStorage.setItem(this.VERSION_KEY, String(this._serverVersion)); } catch (e) {}
  },

  getPendingQueue() {
    try {
      const raw = localStorage.getItem(this.PENDING_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  setPendingQueue(q) {
    try {
      if (!q || !q.length) localStorage.removeItem(this.PENDING_KEY);
      else localStorage.setItem(this.PENDING_KEY, JSON.stringify(q));
    } catch (e) {}
  },

  canWriteAccounts() {
    try {
      if (typeof Auth === 'undefined' || !Auth.currentUser) return false;
      const u = Auth.currentUser;
      return u.role === 'admin' && u.accountsWriter === true;
    } catch (e) {
      return false;
    }
  },

  getDefault() {
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
  },

  load() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) {
        this._cache = this.getDefault();
        return this._cache;
      }
      this._cache = JSON.parse(raw);
      return this._cache;
    } catch (e) {
      console.error('DB load error', e);
      this._cache = this.getDefault();
      return this._cache;
    }
  },

  save(data, meta = {}) {
    try {
      const writer = this.canWriteAccounts();
      if (writer && !this._applyingRemote) {
        data._updatedAt = Date.now();
      }
      this._cache = data;
      try {
        localStorage.setItem(this.KEY, JSON.stringify(data));
      } catch (quotaErr) {
        console.warn('localStorage quota warning', quotaErr);
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('फोन मेमोरी भरियो — पुरानो मिडिया सफा गर्नुहोस्', 'error');
        }
      }

      if (!this._applyingRemote && !meta.localOnly && writer) {
        const q = this.getPendingQueue();
        const txnId = meta.txnId || ('txn_' + Date.now() + '_' + Math.floor(Math.random() * 99999));
        // Coalesce regular saves while preserving explicit closeMonthId / pushNotice
        const last = q[q.length - 1];
        if (last && !last.closedMonthId && !meta.closedMonthId && !last.pushNotice && !meta.pushNotice) {
          last.txnId = txnId;
          last.updatedAt = Date.now();
        } else {
          q.push({
            txnId,
            baseVersion: this.getServerVersion(),
            closedMonthId: meta.closedMonthId || null,
            pushNotice: meta.pushNotice || null,
            forceOverwrite: !!meta.forceOverwrite,
            createdAt: Date.now()
          });
        }
        this.setPendingQueue(q);
        this._updatePendingIndicator();

        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.flushPending(), 180);
      }
      return true;
    } catch (e) {
      console.error('DB save error', e);
      return false;
    }
  },

  update(fn, meta) {
    const data = this.load();
    fn(data);
    this.save(data, meta);
    return data;
  },

  isCloudEnabled() {
    return !!this._cloud;
  },

  _updatePendingIndicator() {
    if (typeof UI === 'undefined' || !UI.updateSyncStatus) return;
    const q = this.getPendingQueue();
    if (!navigator.onLine) {
      UI.updateSyncStatus('offline', q.length ? `${q.length} वटा सिंक बाँकी` : '');
    } else if (q.length > 0) {
      UI.updateSyncStatus('pending', `${q.length} वटा पठाउन बाँकी`);
    } else if (this._cloud) {
      UI.updateSyncStatus('saved');
    }
  },

  async apiFetch(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const token = this.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(this.apiUrl(path), Object.assign({}, options, { headers }));
    let body = null;
    try { body = await res.json(); } catch (e) { body = { ok: false, error: 'HTTP ' + res.status }; }
    return { status: res.status, ok: res.ok, body };
  },

  async checkServerHealth() {
    try {
      const r = await this.apiFetch('/health', { method: 'GET' });
      if (r.body && r.body.ok) {
        this._cloud = true;
        this._hasAdminOnServer = !!r.body.hasAdmin;
        this._lastHealthError = '';
        return r.body;
      }
      this._cloud = false;
      this._lastHealthError = (r.body && r.body.error) || ('HTTP ' + r.status);
      return r.body || { ok: false };
    } catch (e) {
      this._cloud = false;
      this._lastHealthError = 'सर्भर (/api/health) सँग सम्पर्क भएन';
      return { ok: false, offline: true };
    }
  },

  async offloadPendingMedia(data) {
    if (!navigator.onLine || !this.getToken()) return data;
    const uploadIfDataUrl = async (category, idHint, val) => {
      if (!val || typeof val !== 'string' || !val.startsWith('data:')) return val;
      try {
        const res = await this.apiFetch('/media', {
          method: 'POST',
          body: JSON.stringify({ category, idHint, dataUrl: val })
        });
        if (res.ok && res.body && res.body.url) return res.body.url;
      } catch (e) {}
      return val;
    };

    if (data.group) {
      data.group.logoImage = await uploadIfDataUrl('group', 'logo', data.group.logoImage);
      data.group.welcomeVideo = await uploadIfDataUrl('group', 'welcome', data.group.welcomeVideo);
    }
    if (data.settings && data.settings.theme) {
      data.settings.theme.photo = await uploadIfDataUrl('theme', 'bg', data.settings.theme.photo);
    }
    for (const m of data.members || []) {
      if (!m) continue;
      m.photo = await uploadIfDataUrl('members', `${m.id}-photo`, m.photo);
      m.idCardPhoto = await uploadIfDataUrl('members', `${m.id}-id`, m.idCardPhoto);
    }
    for (const mo of data.months || []) {
      if (!mo || !Array.isArray(mo.loansGiven)) continue;
      for (let i = 0; i < mo.loansGiven.length; i++) {
        const l = mo.loansGiven[i];
        if (l && l.signature && l.signature.startsWith('data:')) {
          l.signature = await uploadIfDataUrl('signatures', `${mo.id}-${l.memberId}-${i}`, l.signature);
        }
      }
    }
    return data;
  },

  async flushPending() {
    if (!this.canWriteAccounts() || !this.getToken()) return false;
    if (!navigator.onLine) {
      this._updatePendingIndicator();
      return false;
    }
    if (this._flushing) {
      this._flushAgain = true;
      return false;
    }

    const q = this.getPendingQueue();
    if (!q.length) return true;

    this._flushing = true;
    try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}

    try {
      const data = this.load();
      await this.offloadPendingMedia(data);
      // Save updated R2 URLs locally without re-queueing
      this._applyingRemote = true;
      try {
        this._cache = data;
        localStorage.setItem(this.KEY, JSON.stringify(data));
      } finally {
        this._applyingRemote = false;
      }

      const item = q[q.length - 1];
      const closedMonthId = q.find((x) => x.closedMonthId)?.closedMonthId || null;
      const pushNotice = q.find((x) => x.pushNotice)?.pushNotice || null;
      const forceOverwrite = q.some((x) => x.forceOverwrite);

      const res = await this.apiFetch('/state', {
        method: 'POST',
        body: JSON.stringify({
          txnId: item.txnId,
          baseVersion: item.baseVersion || this.getServerVersion(),
          forceOverwrite,
          closedMonthId,
          pushNotice,
          data
        })
      });

      if (res.ok && res.body && res.body.ok) {
        this.setPendingQueue([]);
        if (res.body.version) this.setServerVersion(res.body.version);
        if (res.body.data) this._applyServerPayload(res.body.data, null, res.body.version);
        this._cloud = true;
        try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saved'); } catch (e) {}
        return true;
      }

      if (res.status === 409 && res.body && res.body.conflict) {
        // Merge unseen member feedback/pinRequests from serverData so member submissions while Admin was offline are never lost
        const srv = res.body.serverData;
        if (srv && typeof srv === 'object') {
          const mergeById = (localArr, srvArr) => {
            const out = Array.isArray(localArr) ? localArr.slice() : [];
            const seen = new Set(out.map((x) => x && x.id).filter(Boolean));
            for (const x of srvArr || []) {
              if (x && x.id && !seen.has(x.id)) {
                out.push(x);
                seen.add(x.id);
              }
            }
            return out;
          };
          data.complaints = mergeById(data.complaints, srv.complaints);
          data.suggestions = mergeById(data.suggestions, srv.suggestions);
          data.pinRequests = mergeById(data.pinRequests, srv.pinRequests);
        }
        if (res.body.serverVersion) this.setServerVersion(res.body.serverVersion);
        const retry = await this.apiFetch('/state', {
          method: 'POST',
          body: JSON.stringify({
            txnId: item.txnId + '_r',
            baseVersion: res.body.serverVersion,
            forceOverwrite: false,
            closedMonthId,
            pushNotice,
            data
          })
        });
        if (retry.ok && retry.body && retry.body.ok) {
          this.setPendingQueue([]);
          if (retry.body.version) this.setServerVersion(retry.body.version);
          if (retry.body.data) this._applyServerPayload(retry.body.data, null, retry.body.version);
          this._cloud = true;
          try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saved'); } catch (e) {}
          return true;
        }
      }

      try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('error', res.body && res.body.error); } catch (e) {}
      return false;
    } catch (err) {
      console.warn('flushPending error', err);
      this._updatePendingIndicator();
      return false;
    } finally {
      this._flushing = false;
      if (this._flushAgain) {
        this._flushAgain = false;
        setTimeout(() => this.flushPending(), 150);
      }
    }
  },

  _applyServerPayload(remoteData, remoteChat, version) {
    const local = this.load();
    const merged = Object.assign({}, this.getDefault(), remoteData || {});
    merged.chat = remoteChat || local.chat || { group: [], private: {} };
    if (version) this.setServerVersion(version);

    this._applyingRemote = true;
    try {
      this._cache = merged;
      localStorage.setItem(this.KEY, JSON.stringify(merged));
      if (typeof this._onRemote === 'function') {
        this._onRemote(merged);
      }
    } finally {
      this._applyingRemote = false;
    }
  },

  async pullLatest(force = false) {
    if (!this.getToken() || !navigator.onLine) return false;
    // Flush local outbox first so we never pull stale data over pending local writes
    if (this.getPendingQueue().length > 0 && this.canWriteAccounts()) {
      await this.flushPending();
      if (this.getPendingQueue().length > 0) return false;
    }
    await this.flushChatQueue();
    try {
      const since = force ? -1 : this.getServerVersion();
      const res = await this.apiFetch('/state?sinceVersion=' + encodeURIComponent(since), { method: 'GET' });
      if (!res.ok || !res.body || !res.body.ok) return false;
      this._cloud = true;
      const local = this.load();
      const prevChatLen = ((local.chat && local.chat.group) || []).length;
      const nextChat = res.body.chat || local.chat;
      const nextChatLen = ((nextChat && nextChat.group) || []).length;

      if (!res.body.unchanged && res.body.data) {
        this._applyServerPayload(res.body.data, nextChat, res.body.version);
      } else if (nextChat && nextChatLen !== prevChatLen) {
        local.chat = nextChat;
        this._applyingRemote = true;
        try {
          this._cache = local;
          localStorage.setItem(this.KEY, JSON.stringify(local));
          if (typeof this._onRemote === 'function') this._onRemote(local);
        } finally {
          this._applyingRemote = false;
        }
      }
      this._updatePendingIndicator();
      return true;
    } catch (e) {
      return false;
    }
  },

  async initCloud(onRemoteChange) {
    this._onRemote = onRemoteChange || null;
    this.bindOnlineSync();
    const health = await this.checkServerHealth();
    if (this.getToken() && navigator.onLine) {
      await this.pullLatest(true);
    }
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && this.getToken() && navigator.onLine) {
          this.pullLatest(false);
        }
      }, 8000);
    }
    return health && health.ok ? 'ok' : 'offline';
  },

  _getPendingChatQueue() {
    try {
      const raw = localStorage.getItem(this.PENDING_CHAT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _setPendingChatQueue(q) {
    try {
      if (!q || !q.length) localStorage.removeItem(this.PENDING_CHAT_KEY);
      else localStorage.setItem(this.PENDING_CHAT_KEY, JSON.stringify(q.slice(-100)));
    } catch (e) {}
  },

  _enqueueChat(msg) {
    if (!msg || !msg.text) return;
    const q = this._getPendingChatQueue();
    if (msg.id && q.some((x) => x && x.id === msg.id)) return;
    q.push(msg);
    this._setPendingChatQueue(q);
  },

  async flushChatQueue() {
    if (!this.getToken() || !navigator.onLine) return false;
    const q = this._getPendingChatQueue();
    if (!q.length) return true;
    const remaining = [];
    for (let i = 0; i < q.length; i++) {
      try {
        const res = await this.apiFetch('/chat', {
          method: 'POST',
          body: JSON.stringify(q[i])
        });
        if (!res.ok || !res.body || !res.body.ok) {
          remaining.push(q[i]);
        }
      } catch (e) {
        remaining.push(q[i]);
      }
    }
    this._setPendingChatQueue(remaining);
    return remaining.length === 0;
  },

  async pushChatMessage(msg) {
    if (!this.getToken()) return false;
    if (!navigator.onLine) {
      this._enqueueChat(msg);
      return false;
    }
    try {
      const res = await this.apiFetch('/chat', {
        method: 'POST',
        body: JSON.stringify(msg)
      });
      if (res.ok && res.body && res.body.ok) return true;
      this._enqueueChat(msg);
      return false;
    } catch (e) {
      this._enqueueChat(msg);
      return false;
    }
  },

  async pushChatNow() {
    const data = this.load();
    const group = (data.chat && data.chat.group) || [];
    const last = group[group.length - 1];
    if (!last) return true;
    return this.pushChatMessage({
      id: last.id,
      channel: 'group',
      text: last.text,
      type: last.type || 'text',
      time: last.time
    });
  },

  async submitMemberFeedback(payload) {
    if (!this.getToken() || !navigator.onLine) return false;
    try {
      const res = await this.apiFetch('/feedback', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res.ok && res.body && res.body.version) {
        this.setServerVersion(res.body.version);
      }
      return !!(res.ok && res.body && res.body.ok);
    } catch (e) {
      return false;
    }
  },

  async uploadMemberPhoto(memberId, dataUrl) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'फोटो अपलोड गर्न इन्टरनेट जडान आवश्यक छ' };
    }
    try {
      const res = await this.apiFetch('/member/photo', {
        method: 'POST',
        body: JSON.stringify({ memberId, dataUrl })
      });
      if (res.ok && res.body && res.body.ok && res.body.url) {
        if (res.body.version) this.setServerVersion(res.body.version);
        const cur = this.load();
        const mem = (cur.members || []).find(m => m.id === memberId);
        if (mem) {
          mem.photo = res.body.url;
          this.save(cur, { localOnly: true });
        }
        return { ok: true, url: res.body.url, version: res.body.version };
      }
      return { ok: false, error: (res.body && res.body.error) || 'फोटो अपलोड असफल' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  async syncCredentialChange(payload) {
    if (!this.getToken() || !navigator.onLine) return { ok: false, offline: true };
    const res = await this.apiFetch('/admin/credentials', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return res.body || { ok: false };
  },

  bindOnlineSync() {
    if (this._onlineBound) return;
    this._onlineBound = true;
    window.addEventListener('online', () => {
      this._updatePendingIndicator();
      this.flushChatQueue().catch(() => {});
      this.flushPending().then((ok) => {
        if (ok && typeof UI !== 'undefined' && UI.toast) {
          UI.toast('नेट आयो · हिसाब सुरक्षित सिंक भयो ✅', 'success');
        }
      });
    });
    window.addEventListener('offline', () => {
      this._updatePendingIndicator();
      if (typeof UI !== 'undefined' && UI.toast) {
        UI.toast('अफलाइन · हिसाब सुरक्षित queue मा बस्छ', '');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.getToken() && navigator.onLine) {
        this.pullLatest(false);
      }
    });
  },

  dedupeMembers(members) {
    if (!Array.isArray(members)) return [];
    const byId = {};
    const byMobile = {};
    const out = [];
    members.forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      const id = m.id != null ? String(m.id) : '';
      const mob = m.mobile != null ? String(m.mobile).replace(/\s/g, '') : '';
      if (id && byId[id]) { Object.assign(byId[id], m); return; }
      if (mob && byMobile[mob]) { Object.assign(byMobile[mob], m); if (id) byId[id] = byMobile[mob]; return; }
      const copy = Object.assign({}, m);
      out.push(copy);
      if (id) byId[id] = copy;
      if (mob) byMobile[mob] = copy;
    });
    return out;
  },

  fixDuplicateMembers() {
    const data = this.load();
    const before = (data.members || []).length;
    data.members = this.dedupeMembers(data.members || []);
    const after = data.members.length;
    this.save(data, { forceOverwrite: true });
    return this.flushPending().then(() => ({ before, after }));
  },

  pushCloudOverwrite(data) {
    this.save(data, { forceOverwrite: true });
    return this.flushPending();
  },

  clearAccountingKeepUsers() {
    const data = this.load();
    const keepAdmin = data.admin ? JSON.parse(JSON.stringify(data.admin)) : null;
    const keepMembers = this.dedupeMembers(Array.isArray(data.members) ? JSON.parse(JSON.stringify(data.members)) : []);
    const keepSettings = data.settings ? JSON.parse(JSON.stringify(data.settings)) : this.getDefault().settings;
    const keepGroup = data.group ? JSON.parse(JSON.stringify(data.group)) : this.getDefault().group;

    data.months = [];
    data.currentMonthId = null;
    data.migrationDone = false;
    data.migration = { cash: 0, loans: {}, advances: {}, kittas: {} };
    data.admin = keepAdmin;
    data.members = keepMembers;
    data.settings = keepSettings;
    data.group = keepGroup;
    data.bills = {};
    data.billSeq = {};
    this.save(data, { forceOverwrite: true });
    return this.flushPending().then(() => data);
  },

  async exportJSON() {
    let data = this.load();
    if (this.getToken() && navigator.onLine) {
      try {
        const res = await this.apiFetch('/export-backup', { method: 'GET' });
        if (res.ok && res.body && res.body.ok && res.body.backup) {
          data = res.body.backup;
        }
      } catch (e) {}
    }
    const fname = `samuha-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const jsonText = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonText], { type: 'application/json' });

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fname,
          types: [{ description: 'JSON Backup', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return fname;
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
          return null;
        }
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
    return fname;
  },

  importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (!data || typeof data !== 'object') {
            reject(new Error('अमान्य JSON'));
            return;
          }
          data.members = this.dedupeMembers(Array.isArray(data.members) ? data.members : []);
          const res = await this.apiFetch('/import-backup', {
            method: 'POST',
            body: JSON.stringify(data)
          });
          if (!res.ok || !res.body || !res.body.ok) {
            reject(new Error((res.body && res.body.error) || 'क्लाउड Import असफल'));
            return;
          }
          if (res.body.version) this.setServerVersion(res.body.version);
          this.setPendingQueue([]);
          if (this.getToken()) {
            await this.pullLatest(true);
          }
          resolve(this.load());
        } catch (err) {
          reject(err && err.message ? err : new Error('फाइल पढ्न सकिएन'));
        }
      };
      reader.onerror = () => reject(new Error('फाइल पढ्न सकिएन'));
      reader.readAsText(file);
    });
  }
};
