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
  PENDING_TERMS_KEY: 'gs_pending_terms_accept',

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
      return u.role === 'treasurer' && u.accountsWriter === true;
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
    merged.chat = remoteChat || local.chat || { group: [] };
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
    await this.flushPendingTermsAccept();
    try {
      const since = force ? -1 : this.getServerVersion();
      const res = await this.apiFetch('/state?sinceVersion=' + encodeURIComponent(since), { method: 'GET' });
      if (!res.ok || !res.body || !res.body.ok) return false;
      this._cloud = true;
      const local = this.load();
      const prevGroup = (local.chat && local.chat.group) || [];
      const nextChat = res.body.chat || local.chat;
      const nextGroup = (nextChat && nextChat.group) || [];
      const chatChanged = JSON.stringify(prevGroup) !== JSON.stringify(nextGroup);

      if (res.body.readState) {
        this.applyUserReadState(res.body.readState);
      }
      if (res.body.termsAcceptance) {
        this.applyUserTermsAcceptance(res.body.termsAcceptance);
      }

      if (!res.body.unchanged && res.body.data) {
        this._applyServerPayload(res.body.data, nextChat, res.body.version);
      } else if (nextChat && chatChanged) {
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

  getUserReadKey(userObj) {
    let u = userObj || (typeof Auth !== 'undefined' ? Auth.currentUser : null);
    if (!u) {
      try {
        const s = localStorage.getItem('gs_session');
        if (s) u = JSON.parse(s);
      } catch (e) {}
    }
    if (!u) return '';
    if (u.role === 'member' && u.memberId) return 'mem:' + String(u.memberId);
    if (u.role === 'treasurer' && u.username) return 'trs:' + String(u.username);
    if (u.role === 'admin_ro' && u.username) return 'sec:' + String(u.username);
    return 'admin:' + String(u.username || 'admin');
  },

  getUserReadState(userObj) {
    const key = this.getUserReadKey(userObj);
    if (!key) return {};
    try {
      const raw = localStorage.getItem('gs_read_state_' + key);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  },

  applyUserReadState(serverState, userObj) {
    const key = this.getUserReadKey(userObj);
    if (!key) return {};
    const prev = this.getUserReadState(userObj);
    const srv = (serverState && typeof serverState === 'object') ? serverState : {};
    const next = Object.assign({}, prev);
    if (srv.chatReadAt && (!next.chatReadAt || srv.chatReadAt > next.chatReadAt)) next.chatReadAt = String(srv.chatReadAt);
    if (srv.chatReadId && !next.chatReadId) next.chatReadId = String(srv.chatReadId);
    if (srv.chatReadAt && srv.chatReadId && (!prev.chatReadAt || srv.chatReadAt >= prev.chatReadAt)) next.chatReadId = String(srv.chatReadId);
    if (srv.activityReadAt && (!next.activityReadAt || srv.activityReadAt > next.activityReadAt)) next.activityReadAt = String(srv.activityReadAt);
    if (srv.fbReadAt && (!next.fbReadAt || srv.fbReadAt > next.fbReadAt)) next.fbReadAt = String(srv.fbReadAt);
    const mergedMonths = Array.from(new Set([
      ...(Array.isArray(prev.csReadMonths) ? prev.csReadMonths : []),
      ...(Array.isArray(srv.csReadMonths) ? srv.csReadMonths : [])
    ].map(String)));
    if (mergedMonths.length) next.csReadMonths = mergedMonths.slice(-120);
    try { localStorage.setItem('gs_read_state_' + key, JSON.stringify(next)); } catch (e) {}
    return next;
  },

  async saveUserReadState(patch) {
    const key = this.getUserReadKey();
    if (!key || !patch || typeof patch !== 'object') return {};
    const merged = this.applyUserReadState(patch);
    if (patch.chatReadId && patch.chatReadAt) {
      merged.chatReadId = String(patch.chatReadId);
      try { localStorage.setItem('gs_read_state_' + key, JSON.stringify(merged)); } catch (e) {}
    }
    if (this.getToken() && navigator.onLine) {
      try {
        const res = await this.apiFetch('/user/read-state', {
          method: 'POST',
          body: JSON.stringify(patch)
        });
        if (res.ok && res.body && res.body.readState) {
          return this.applyUserReadState(res.body.readState);
        }
      } catch (e) {}
    }
    return merged;
  },

  getUserTermsAcceptance(userObj) {
    const key = this.getUserReadKey(userObj);
    if (!key) return null;
    try {
      const raw = localStorage.getItem('gs_terms_acc_' + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  applyUserTermsAcceptance(rec, userObj) {
    const key = this.getUserReadKey(userObj);
    if (!key || !rec || typeof rec !== 'object') return null;
    const prev = this.getUserTermsAcceptance(userObj);
    if (prev && Number(prev.version || 0) > Number(rec.version || 0)) {
      return prev;
    }
    const next = {
      version: Number(rec.version || 0),
      acceptedAt: rec.acceptedAt || new Date().toISOString()
    };
    try { localStorage.setItem('gs_terms_acc_' + key, JSON.stringify(next)); } catch (e) {}
    return next;
  },

  async flushPendingTermsAccept() {
    if (!this.getToken() || !navigator.onLine) return false;
    let pending = null;
    try {
      const raw = localStorage.getItem(this.PENDING_TERMS_KEY);
      pending = raw ? JSON.parse(raw) : null;
    } catch (e) { pending = null; }
    if (!pending || !pending.version) return true;
    try {
      const res = await this.apiFetch('/terms/accept', {
        method: 'POST',
        body: JSON.stringify(pending)
      });
      if (res.ok && res.body && res.body.ok) {
        try { localStorage.removeItem(this.PENDING_TERMS_KEY); } catch (e) {}
        if (res.body.termsAcceptance) this.applyUserTermsAcceptance(res.body.termsAcceptance);
        if (res.body.version) this.setServerVersion(res.body.version);
        return true;
      }
    } catch (e) {}
    return false;
  },

  async acceptTerms(version) {
    const ver = Math.max(1, Number(version) || 1);
    const acceptedAt = new Date().toISOString();
    const rec = this.applyUserTermsAcceptance({ version: ver, acceptedAt });
    const mid = typeof Auth !== 'undefined' && Auth.currentUser && Auth.currentUser.memberId;
    if (mid) {
      const data = this.load();
      const mem = (data.members || []).find((m) => m && m.id === mid);
      if (mem) {
        mem.termsAcceptedVersion = ver;
        mem.termsAcceptedAt = acceptedAt;
        this.save(data, { localOnly: true });
      }
    }
    if (!this.getToken() || !navigator.onLine) {
      try { localStorage.setItem(this.PENDING_TERMS_KEY, JSON.stringify({ version: ver, acceptedAt })); } catch (e) {}
      return { ok: true, queued: true, acceptance: rec };
    }
    try {
      const res = await this.apiFetch('/terms/accept', {
        method: 'POST',
        body: JSON.stringify({ version: ver, acceptedAt })
      });
      if (res.ok && res.body && res.body.ok) {
        try { localStorage.removeItem(this.PENDING_TERMS_KEY); } catch (e) {}
        if (res.body.termsAcceptance) this.applyUserTermsAcceptance(res.body.termsAcceptance);
        if (res.body.version) this.setServerVersion(res.body.version);
        return { ok: true, acceptance: res.body.acceptance || rec };
      }
    } catch (e) {}
    try { localStorage.setItem(this.PENDING_TERMS_KEY, JSON.stringify({ version: ver, acceptedAt })); } catch (e) {}
    return { ok: true, queued: true, acceptance: rec };
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

  async replyComplaint(payload) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'जवाफ/समाधान पठाउन इन्टरनेट जडान चाहिन्छ' };
    }
    try {
      const res = await this.apiFetch('/complaint/reply', {
        method: 'POST',
        body: JSON.stringify(payload || {})
      });
      if (res.ok && res.body && res.body.ok) {
        if (res.body.version) this.setServerVersion(res.body.version);
        if (res.body.data) this._applyServerPayload(res.body.data, null, res.body.version);
        return res.body;
      }
      return { ok: false, error: (res.body && res.body.error) || 'जवाफ पठाउन सकिएन' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  async getSystemHealth(opts = {}) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'प्रणाली स्वास्थ्य जाँच्न इन्टरनेट चाहिन्छ' };
    }
    try {
      const qs = opts && opts.background ? '?background=1' : '';
      const res = await this.apiFetch('/system-health' + qs, { method: 'GET' });
      if (res.ok && res.body && res.body.ok) return res.body;
      return { ok: false, error: (res.body && res.body.error) || 'जाँच असफल' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  async sendTestHealthEmail() {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'इमेल जाँच गर्न इन्टरनेट चाहिन्छ' };
    }
    try {
      const res = await this.apiFetch('/system-health/test-email', { method: 'POST', body: JSON.stringify({}) });
      return (res && res.body) || { ok: false, error: 'इमेल पठाउन सकिएन' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
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
          if (res.body.photoLocked !== undefined) mem.photoLocked = !!res.body.photoLocked;
          this.save(cur, { localOnly: true });
        }
        return { ok: true, url: res.body.url, photoLocked: !!res.body.photoLocked, version: res.body.version };
      }
      return { ok: false, error: (res.body && res.body.error) || 'फोटो अपलोड असफल' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  async resetMemberPhoto(memberId, clearPhoto) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'फोटो रिसेट गर्न इन्टरनेट चाहिन्छ' };
    }
    try {
      const res = await this.apiFetch('/admin/reset-member-photo', {
        method: 'POST',
        body: JSON.stringify({ memberId, clearPhoto: !!clearPhoto })
      });
      if (res.ok && res.body && res.body.ok) {
        if (res.body.version) this.setServerVersion(res.body.version);
        const cur = this.load();
        const mem = (cur.members || []).find(m => m.id === memberId);
        if (mem) {
          mem.photoLocked = false;
          if (clearPhoto) mem.photo = null;
          this.save(cur, { localOnly: true });
        }
        return { ok: true, version: res.body.version };
      }
      return { ok: false, error: (res.body && res.body.error) || 'फोटो रिसेट असफल' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  async deleteChatMessage(msgId) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'सन्देश मेट्न इन्टरनेट चाहिन्छ' };
    }
    try {
      const res = await this.apiFetch('/chat/delete', {
        method: 'POST',
        body: JSON.stringify({ id: msgId })
      });
      if (res.ok && res.body && res.body.ok) {
        const cur = this.load();
        if (cur.chat && Array.isArray(cur.chat.group)) {
          cur.chat.group = cur.chat.group.filter(m => m && m.id !== msgId);
          this.save(cur, { localOnly: true });
        }
        return { ok: true };
      }
      return { ok: false, error: (res.body && res.body.error) || 'सन्देश मेट्न सकिएन' };
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

  async saveAdminSettings(patch) {
    if (!this.getToken() || !navigator.onLine) {
      return { ok: false, error: 'सेटिङ सेभ गर्न इन्टरनेट जडान चाहिन्छ' };
    }
    try {
      const res = await this.apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(patch || {})
      });
      if (res.ok && res.body && res.body.ok) {
        if (res.body.version) this.setServerVersion(res.body.version);
        if (res.body.data) this._applyServerPayload(res.body.data, null, res.body.version);
        this._cloud = true;
        try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saved'); } catch (e) {}
        return res.body;
      }
      return { ok: false, error: (res.body && res.body.error) || 'सेटिङ सेभ असफल' };
    } catch (e) {
      return { ok: false, error: 'सर्भरसँग सम्पर्क भएन' };
    }
  },

  bindOnlineSync() {
    if (this._onlineBound) return;
    this._onlineBound = true;
    window.addEventListener('online', () => {
      this._updatePendingIndicator();
      this.flushChatQueue().catch(() => {});
      this.flushPendingTermsAccept().catch(() => {});
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
