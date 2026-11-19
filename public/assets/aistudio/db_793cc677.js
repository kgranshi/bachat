const DB = {
  KEY: 'group_savings_v1',
  FB_CONFIG_KEY: 'samuha_fb_config',
  DOC_PATH: 'samuha/main',
  CHAT_PATH: 'samuha/chat',

  _cache: null,
  _cloud: false,
  _db: null,
  _unsub: null,
  _applyingRemote: false,
  _saveTimer: null,
  _onRemote: null,
  _onlineBound: false,

  /** हिसाब Firebase मा लेख्ने अधिकार — मुख्य Admin A मात्र */
  canWriteAccounts() {
    try {
      if (typeof Auth === 'undefined' || !Auth.currentUser) return false;
      const u = Auth.currentUser;
      if (u.role === 'admin' && u.accountsWriter === true) return true;
      if (u.role === 'admin_ro') return false;
      if (u.role === 'member') return false;
      // admin तर writer फ्ल्याग छैन → लेख्दैन (सुरक्षित default)
      if (u.role === 'admin') return !!u.accountsWriter;
      return false;
    } catch (e) {
      return false;
    }
  },

  getDefault() {
    return {
      version: 1,
      _updatedAt: 0,
      group: {
        name: 'समूह बचत',
        address: '',
        established: '',
        logo: '💰'
      },
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
      chat: {
        group: [],
        private: {}
      }
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

  save(data) {
    try {
      // गैर-writer ले _updatedAt बढाएर रिमोट जित्ने नहोस्
      const writer = this.canWriteAccounts();
      if (writer) {
        if (!data._updatedAt || !this._applyingRemote) {
          data._updatedAt = Date.now();
        }
      } else if (!data._updatedAt) {
        data._updatedAt = 0;
      }
      this._cache = data;
      localStorage.setItem(this.KEY, JSON.stringify(data));

      if (this._cloud && this._db && !this._applyingRemote) {
        // हिसाब push — मुख्य Admin A मात्र
        if (writer) {
          clearTimeout(this._saveTimer);
          this._saveTimer = setTimeout(() => this._pushCloud(data), 250);
        }
        // च्याट — सबै (सदस्य + admin)
        clearTimeout(this._chatTimer);
        this._chatTimer = setTimeout(() => {
          if (typeof this.pushChatNow === 'function') this.pushChatNow();
        }, 120);
      }
      return true;
    } catch (e) {
      console.error('DB save error', e);
      return false;
    }
  },

  update(fn) {
    const data = this.load();
    fn(data);
    this.save(data);
    return data;
  },

  /** Firebase config: window.FIREBASE_CONFIG वा localStorage */
  getFirebaseConfig() {
    if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) {
      return window.FIREBASE_CONFIG;
    }
    try {
      const raw = localStorage.getItem(this.FB_CONFIG_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  },

  setFirebaseConfig(cfg) {
    localStorage.setItem(this.FB_CONFIG_KEY, JSON.stringify(cfg));
    window.FIREBASE_CONFIG = cfg;
  },

  isCloudEnabled() {
    return !!this._cloud;
  },

  /**
   * क्लाउड सुरु — सबै फोनमा उही डाटा
   * @returns {Promise<string>} status message
   */

  /** सन्देश id बाट जोड्ने — हराउने last-write-wins रोक्न */
  _mergeMsgList(a, b) {
    const map = {};
    (a || []).forEach(m => { if (m && m.id) map[m.id] = m; });
    (b || []).forEach(m => { if (m && m.id) map[m.id] = m; });
    let list = Object.values(map).sort((x, y) => {
      const tx = Date.parse(x.time) || 0;
      const ty = Date.parse(y.time) || 0;
      return tx - ty;
    });
    // अटो सन्देश: उही text भए एउटा मात्र (double सिंक)
    const seenAuto = {};
    list = list.filter(function (m) {
      if (!m) return false;
      const isAuto = m.type === 'auto_group' || m.type === 'system' || m.fromRole === 'system';
      if (!isAuto) return true;
      const key = String(m.text || '');
      if (seenAuto[key]) return false;
      seenAuto[key] = true;
      return true;
    });
    return list;
  },

  _mergeChat(localChat, remoteChat) {
    const L = localChat || { group: [], private: {} };
    const R = remoteChat || { group: [], private: {} };
    const group = this._mergeMsgList(L.group, R.group);
    const privKeys = new Set([
      ...Object.keys(L.private || {}),
      ...Object.keys(R.private || {})
    ]);
    const privateMap = {};
    privKeys.forEach(k => {
      privateMap[k] = this._mergeMsgList(
        (L.private && L.private[k]) || [],
        (R.private && R.private[k]) || []
      );
    });
    const readAt = Object.assign({}, L.readAt || {}, R.readAt || {});
    return { group, private: privateMap, readAt };
  },

  /**
   * लोकल + रिमोट मर्ज
   * - chat / pinRequests / complaints / activityLog: सधैं युनियन (नहराओस्)
   * - बाँकी फिल्ड: जसको _updatedAt ठूलो
   */
  mergeLocalRemote(local, remote) {
    // सुरक्षा: रिमोटमा months छ · लोकल खाली/कम → months रिमोटबाट
    try {
      const lm = (local && local.months) ? local.months.length : 0;
      const rm = (remote && remote.months) ? remote.months.length : 0;
      if (rm > 0 && lm === 0) {
        local = Object.assign({}, local || {}, {
          months: remote.months,
          currentMonthId: remote.currentMonthId,
          members: remote.members || (local && local.members),
          settings: Object.assign({}, (local && local.settings) || {}, remote.settings || {}),
          _updatedAt: remote._updatedAt || (local && local._updatedAt) || 0
        });
      }
    } catch (e) {}

    if (!remote) return local;
    if (!local) return remote;
    const localAt = Number(local._updatedAt) || 0;
    const remoteAt = Number(remote._updatedAt) || 0;
    const base = remoteAt >= localAt
      ? JSON.parse(JSON.stringify(remote))
      : JSON.parse(JSON.stringify(local));
    const other = remoteAt >= localAt ? local : remote;

    base.chat = this._mergeChat(local.chat, remote.chat);

    // requests / complaints — id युनियन
    ['pinRequests', 'complaints', 'activityLog', 'suggestions'].forEach(key => {
      const map = {};
      (other[key] || []).forEach(x => { if (x && x.id) map[x.id] = x; });
      (base[key] || []).forEach(x => { if (x && x.id) map[x.id] = x; });
      if (Object.keys(map).length) base[key] = Object.values(map);
    });

    // members: by id, prefer newer base but keep fields from other if missing
    if (Array.isArray(local.members) || Array.isArray(remote.members)) {
      const mmap = {};
      (other.members || []).forEach(m => { if (m && m.id) mmap[String(m.id)] = m; });
      (base.members || []).forEach(m => {
        if (m && m.id) mmap[String(m.id)] = Object.assign({}, mmap[String(m.id)] || {}, m);
      });
      base.members = this.dedupeMembers(Object.values(mmap));
    }

    // Date.now() नराख्ने — नत्र snapshot लुप हुन्छ
    base._updatedAt = Math.max(localAt, remoteAt);
    return base;
  },

  _contentSig(data) {
    if (!data) return '';
    try {
      const c = data.chat || {};
      const g = (c.group || []).map(m => m.id).join(',');
      const p = Object.keys(c.private || {}).sort().map(k =>
        k + ':' + ((c.private[k] || []).map(m => m.id).join('+'))
      ).join('|');
      return g + '#' + p + '#' + (data._updatedAt || 0);
    } catch (e) {
      return String(data._updatedAt || 0);
    }
  },

  async initCloud(onRemoteChange) {
    const cfg = this.getFirebaseConfig();
    if (!cfg || !cfg.apiKey || !cfg.projectId) {
      return 'no-config';
    }
    if (typeof firebase === 'undefined') {
      return 'no-sdk';
    }

    this._onRemote = onRemoteChange || null;

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(cfg);
      }
      this._db = firebase.firestore();

      // अफलाइन persistence — नेट नभए queue, आएपछि सिंक
      try {
        await this._db.enablePersistence({ synchronizeTabs: true });
      } catch (err) {
        // multiple tabs / unsupported — continue without
        console.warn('Persistence:', err && err.code);
      }

      this._cloud = true;
      const ref = this._db.doc(this.DOC_PATH);

      // Real-time listener
      if (this._unsub) this._unsub();
      this._unsub = ref.onSnapshot(
        (snap) => {
          if (!snap.exists) return;
          const remote = snap.data();
          if (!remote || typeof remote !== 'object') return;

          // Import भर्खर भए remote ले नखोस्
          if (this._importLockUntil && Date.now() < this._importLockUntil) {
            return;
          }

          if (this._applyingRemote || this._pushing) return;

          const local = this.load();
          // main दस्तावेजबाट च्याट नलिने — च्याट सिर्फ samuha/chat बाट
          const remoteNoChat = Object.assign({}, remote);
          delete remoteNoChat.chat;
          const merged = this.mergeLocalRemote(local, remoteNoChat);
          merged.chat = local.chat || { group: [], private: {} };

          const accChanged = JSON.stringify({
            m: local.months, c: local.currentMonthId, a: local.admin, s: local.settings
          }) !== JSON.stringify({
            m: merged.months, c: merged.currentMonthId, a: merged.admin, s: merged.settings
          });
          if (!accChanged && Number(local._updatedAt) >= Number(merged._updatedAt)) {
            return;
          }

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
        (err) => console.error('Firestore listen', err)
      );

      // पहिलो पटक: क्लाउड खाली + स्थानीय छ → अपलोड
      const snap = await ref.get();
      const local = this.load();
      if (!snap.exists) {
        if (local.admin || (local.members && local.members.length) || (local.chat && local.chat.group && local.chat.group.length)) {
          await ref.set(this.stripHeavyForCloud(local));
        }
      } else {
        const remote = snap.data();
        // Browser clear पछि लोकल खाली → क्लाउड नै स्रोत
        const localEmpty = !local.admin && !(local.members && local.members.length);
        let merged;
        if (localEmpty && remote && remote.admin) {
          merged = remote;
        } else {
          merged = this.mergeLocalRemote(local, remote);
        }
        // लोकल signature जोगाउने यदि remote मा 'signed' मात्र छ
        if (local.months && merged.months) {
          try {
            const locSig = {};
            (local.months || []).forEach(function (m) {
              (m.loansGiven || []).forEach(function (l, i) {
                if (l && l.signature && String(l.signature).length > 80) {
                  locSig[m.id + '_' + i] = l.signature;
                }
              });
            });
            (merged.months || []).forEach(function (m) {
              (m.loansGiven || []).forEach(function (l, i) {
                const k = m.id + '_' + i;
                if (locSig[k] && (!l.signature || l.signature === 'signed')) {
                  l.signature = locSig[k];
                }
              });
            });
          } catch (e) {}
        }
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
        // हल्का प्रतिलिपि क्लाउडमा लेख्ने (ठूलो doc सच्याउन)
        try {
          this._pushing = true;
    try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}
          await ref.set(this.stripHeavyForCloud(merged));
        } catch (e) {
          console.warn('initial light push', e);
        } finally {
          this._pushing = false;
        }
      }

      // अलग च्याट दस्तावेज — हिसाब overwrite ले म्यासेज नहराओस्
      try {
        await this._initChatSync();
      } catch (e) {
        console.warn('chat sync', e);
      }

      return 'ok';
    } catch (e) {
      console.error('initCloud', e);
      this._cloud = false;
      return 'error:' + (e.message || String(e));
    }
  },


  /** च्याट मात्र — Firebase Auth चाहिँदैन; कस्टम Auth + Firestore */
  async _initChatSync() {
    if (!this._db) return;
    const cref = this._db.doc(this.CHAT_PATH);

    if (this._unsubChat) {
      try { this._unsubChat(); } catch (e) {}
      this._unsubChat = null;
    }

    // पहिलो पटक रिमोट तान्नु
    try {
      const snap = await cref.get();
      if (snap.exists) {
        this._applyRemoteChat(snap.data());
      } else {
        const local = this.load();
        const ch = local.chat || { group: [], private: {} };
        if ((ch.group && ch.group.length) || (ch.private && Object.keys(ch.private).length)) {
          await cref.set(this._chatPayload(ch));
        }
      }
    } catch (e) {
      console.error('chat init get', e);
    }

    this._unsubChat = cref.onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        try {
          if (snap.metadata && snap.metadata.hasPendingWrites) return;
        } catch (e) {}
        this._applyRemoteChat(snap.data());
      },
      (err) => {
        console.error('Chat listen', err);
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('च्याट सुनिएन: ' + (err.code || err.message || ''), 'error');
        }
      }
    );
  },

  _chatPayload(chat) {
    const ch = chat || { group: [], private: {} };
    // Firestore: undefined हटाउने
    const cleanMsg = (m) => ({
      id: String(m.id || ''),
      fromId: String(m.fromId || ''),
      fromName: String(m.fromName || ''),
      fromRole: String(m.fromRole || ''),
      text: String(m.text || ''),
      type: String(m.type || 'text'),
      time: String(m.time || new Date().toISOString())
    });
    const group = (ch.group || []).filter(m => m && m.id).map(cleanMsg);
    const privateMap = {};
    const priv = ch.private || {};
    Object.keys(priv).forEach((k) => {
      privateMap[String(k)] = (priv[k] || []).filter(m => m && m.id).map(cleanMsg);
    });
    return {
      group: group,
      private: privateMap,
      _updatedAt: Date.now()
    };
  },

  _applyRemoteChat(remoteData) {
    if (!remoteData) return;
    // नयाँ ढाँचा: top-level group/private  वा  पुरानो: chat.group
    let remoteChat;
    if (remoteData.chat && (remoteData.chat.group || remoteData.chat.private)) {
      remoteChat = remoteData.chat;
    } else {
      remoteChat = {
        group: remoteData.group || [],
        private: remoteData.private || {}
      };
    }
    const local = this.load();
    const merged = this._mergeChat(local.chat, remoteChat);
    const before = this._contentSig({ chat: local.chat, _updatedAt: 0 });
    const after = this._contentSig({ chat: merged, _updatedAt: 0 });
    if (before === after) return;
    local.chat = merged;
    this._applyingRemote = true;
    try {
      this._cache = local;
      localStorage.setItem(this.KEY, JSON.stringify(local));
      if (typeof this._onRemote === 'function') {
        this._onRemote(local);
      }
    } finally {
      this._applyingRemote = false;
    }
  },

  /**
   * च्याट तुरुन्त Firestore मा
   * Firebase Auth / currentUser जाँच छैन
   */
  pushChatNow() {
    if (!this._db || !this._cloud) {
      console.warn('pushChatNow: cloud off');
      return Promise.resolve(false);
    }
    const data = this.load();
    const payload = this._chatPayload(data.chat);
    const cref = this._db.doc(this.CHAT_PATH);

    return cref.get()
      .then((snap) => {
        if (snap.exists) {
          const remote = snap.data() || {};
          const remoteChat = (remote.chat && remote.chat.group)
            ? remote.chat
            : { group: remote.group || [], private: remote.private || {} };
          const merged = this._mergeChat(data.chat, remoteChat);
          return this._chatPayload(merged);
        }
        return payload;
      })
      .then((finalPayload) => {
        return cref.set(finalPayload).then(() => {
          // लोकल mirror
          const d = this.load();
          d.chat = {
            group: finalPayload.group || [],
            private: finalPayload.private || {}
          };
          this._applyingRemote = true;
          try {
            this._cache = d;
            localStorage.setItem(this.KEY, JSON.stringify(d));
          } finally {
            this._applyingRemote = false;
          }
          return true;
        });
      })
      .catch((err) => {
        console.error('Chat push', err);
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('च्याट सिंक असफल: ' + (err.code || err.message || 'error'), 'error');
        }
        return false;
      });
  },


  /** क्लाउडका लागि भारी फिल्ड हटाउने (signature/photo) — 1MB सीमा */
  stripHeavyForCloud(data) {
    let o;
    try {
      o = JSON.parse(JSON.stringify(data));
    } catch (e) {
      return data;
    }
    delete o.chat;
    (o.months || []).forEach(function (m) {
      if (!m) return;
      (m.loansGiven || []).forEach(function (l) {
        if (!l) return;
        // सहि काट्दैन — धेरै ठूलो (पुरानो PNG) मात्र placeholder; सानो JPEG राखिन्छ
        if (l.signature && String(l.signature).length > 14000) {
          l.signature = 'signed';
        }
      });
    });
    (o.members || []).forEach(function (mem) {
      if (!mem) return;
      ['photo', 'idPhoto', 'profilePhoto', 'photoData', 'idCard', 'avatar'].forEach(function (k) {
        if (mem[k] && String(mem[k]).length > 200) mem[k] = '';
      });
    });
    if (Array.isArray(o.activityLog) && o.activityLog.length > 80) {
      o.activityLog = o.activityLog.slice(-80);
    }
    if (Array.isArray(o.complaints) && o.complaints.length > 100) {
      o.complaints = o.complaints.slice(-100);
    }
    return o;
  },

  _pushCloud(data) {
    if (!this._db || !this._cloud || this._applyingRemote || this._pushing) return;
    const ref = this._db.doc(this.DOC_PATH);
    const localChatBackup = (data && data.chat) ? data.chat : null;
    let clean = this.stripHeavyForCloud(data);

    this._pushing = true;
    try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}
    ref.get().then((snap) => {
      let toSave = clean;
      if (snap.exists) {
        const remote = snap.data() || {};
        const r2 = this.stripHeavyForCloud(remote);
        toSave = this.mergeLocalRemote(clean, r2);
        toSave = this.stripHeavyForCloud(toSave);
      }
      toSave._updatedAt = Date.now();
      delete toSave.chat;
      try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}
      return ref.set(toSave).then(() => {
        try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saved'); } catch (e) {}
        return true;
      });
    }).catch((err) => {
      console.error('Cloud save', err);
      try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('error', err.message || ''); } catch (e) {}
      if (typeof UI !== 'undefined' && UI.toast) {
        UI.toast('क्लाउड सेभ असफल: ' + (err.code || err.message || ''), 'error');
      }
    }).finally(() => { this._pushing = false; });
  },


  /** नेट फर्किएपछि बाँकी सेभ क्लाउडमा पठाउने */
  bindOnlineSync() {
    if (this._onlineBound) return;
    this._onlineBound = true;
    window.addEventListener('online', () => {
      const data = this.load();
      if (this._cloud && this._db) {
        this._pushCloud(data);
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('नेट आयो · सिंक हुँदैछ...', 'success');
        }
      }
    });
    window.addEventListener('offline', () => {
      try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('offline'); } catch (e) {}
      if (typeof UI !== 'undefined' && UI.toast) {
        UI.toast('अफलाइन · हिसाब फोनमा सेभ हुन्छ', '');
      }
    });
    window.addEventListener('online', () => {
      try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('pending'); } catch (e) {}
    });
  },


  /** मर्ज बिना क्लाउडमा पूरै लेख्ने (import / हिसाब सच्याउने) */

  /** सदस्य दोहोरो हटाउने — id पहिले, त्यसपछि mobile */
  dedupeMembers(members) {
    if (!Array.isArray(members)) return [];
    const byId = {};
    const byMobile = {};
    const out = [];
    members.forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      const id = m.id != null ? String(m.id) : '';
      const mob = m.mobile != null ? String(m.mobile).replace(/\s/g, '') : '';
      if (id && byId[id]) {
        // merge fields into existing
        Object.assign(byId[id], m);
        return;
      }
      if (mob && byMobile[mob]) {
        Object.assign(byMobile[mob], m);
        if (id) byId[id] = byMobile[mob];
        return;
      }
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
    data._updatedAt = Date.now();
    this._importLockUntil = Date.now() + 12000;
    this._cache = data;
    localStorage.setItem(this.KEY, JSON.stringify(data));
    if (this._cloud && this._db && typeof this.pushCloudOverwrite === 'function') {
      return this.pushCloudOverwrite(data).then(function () {
        return { before: before, after: after };
      });
    }
    return Promise.resolve({ before: before, after: after });
  },

  pushCloudOverwrite(data) {
    if (!this.canWriteAccounts()) {
      console.warn('pushCloudOverwrite blocked: not accounts writer');
      return Promise.resolve(false);
    }
    if (!this._db || !this._cloud) {
      return Promise.resolve(false);
    }
    const ref = this._db.doc(this.DOC_PATH);
    const toSave = this.stripHeavyForCloud(data);
    toSave._updatedAt = Date.now();
    delete toSave.chat;
    this._pushing = true;
    try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}
    this._importLockUntil = Date.now() + 12000;
    try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saving'); } catch (e) {}
    return ref.set(toSave)
      .then(() => {
        console.log('Cloud overwrite OK');
        try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('saved'); } catch (e) {}
        return true;
      })
      .catch((err) => {
        console.error('Cloud overwrite', err);
        try { if (typeof UI !== 'undefined' && UI.updateSyncStatus) UI.updateSyncStatus('error'); } catch (e) {}
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('क्लाउड overwrite असफल: ' + (err.code || err.message || ''), 'error');
        }
        return false;
      })
      .finally(() => { this._pushing = false; });
  },

  /**
   * हिसाब मात्र मेट्ने — admin / सदस्य / पासवर्ड / PIN सुरक्षित
   */
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
    data.pinRequests = data.pinRequests || [];
    data.complaints = data.complaints || [];
    data._updatedAt = Date.now();

    this._importLockUntil = Date.now() + 15000;
    this._cache = data;
    localStorage.setItem(this.KEY, JSON.stringify(data));

    if (this._cloud && this._db) {
      return this.pushCloudOverwrite(data).then(() => data);
    }
    return Promise.resolve(data);
  },

  async exportJSON() {
    const data = this.load();
    const fname = `samuha-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fname,
          types: [{
            description: 'JSON Backup',
            accept: { 'application/json': ['.json'] }
          }]
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
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 400);
    return fname;
  },

  importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          let data = JSON.parse(e.target.result);
          if (!data || typeof data !== 'object') {
            reject(new Error('अमान्य JSON'));
            return;
          }
          // पुरानो ब्याकअप पनि स्वीकार
          if (!Array.isArray(data.members)) data.members = data.members || [];
          data.members = this.dedupeMembers(data.members);
          if (!data.version) data.version = 1;
          if (!data.settings) data.settings = this.getDefault().settings;
          if (!data.group) data.group = this.getDefault().group;
          if (!data.months) data.months = [];
          if (!data.migration) data.migration = this.getDefault().migration;

          data._updatedAt = Date.now();
          this._importLockUntil = Date.now() + 15000; // remote मर्जले नखोस्
          this._cache = data;
          localStorage.setItem(this.KEY, JSON.stringify(data));

          // क्लाउड: मर्ज होइन — पूरै overwrite (गलत हिसाब हटाउने)
          if (this._cloud && this._db) {
            this.pushCloudOverwrite(data).catch(function (e) {
              console.error('import overwrite', e);
            });
          }
          resolve(data);
        } catch (err) {
          reject(err.message ? err : new Error('फाइल पढ्न सकिएन'));
        }
      };
      reader.onerror = () => reject(new Error('फाइल पढ्न सकिएन'));
      reader.readAsText(file);
    });
  }
};
/**
 * Accounting Engine
 * All formulas as per final design
 */

