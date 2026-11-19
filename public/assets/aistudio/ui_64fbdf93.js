/**
 * UI Helpers - Toast, Modal, Navigation, Rendering
 */

const UI = {
  toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  },

  _modalStack: [],
  _modalBack: null, // X थिच्दा fresn parent खोल्ने function name

  /**
   * @param {{ root?: boolean, replace?: boolean, back?: string|null }} options
   * root:true = नयाँ प्रवाह, stack खाली
   * replace:true = हालको modal replace (stack नबढाउने) — सेभ पछि list मा फर्कँदा
   * back: X थिच्दा बोलाउने function नाम (जस्तै 'showCollectMember') — पुरानो snapshot होइन, ताजा स्क्रिन
   */
  showModal(title, bodyHtml, footerHtml = '', options = {}) {
    const overlay = document.getElementById('modal-overlay');
    const isOpen = overlay && !overlay.classList.contains('hidden');

    if (options.root) {
      this._modalStack = [];
      this._modalBack = null;
    }

    // replace / back: पुराना सदस्य-फारम snapshot नराख्ने (X ले c→b→a नहोस्)
    if (options.replace) {
      this._modalStack = [];
    }

    // explicit back handler for this screen
    if (Object.prototype.hasOwnProperty.call(options, 'back')) {
      this._modalBack = options.back;
      this._modalStack = [];
    }

    // stack: back/replace नभएको नेस्टेड dialog मात्र
    if (!options.root && !options.replace && isOpen && !options.back && !this._modalBack) {
      const curTitle = document.getElementById('modal-title').textContent;
      if (curTitle !== title) {
        this._modalStack = this._modalStack || [];
        this._modalStack.push({
          title: curTitle,
          body: document.getElementById('modal-body').innerHTML,
          footer: document.getElementById('modal-footer').innerHTML,
          back: null
        });
      }
    }

    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-footer').innerHTML = footerHtml;
    overlay.classList.remove('hidden');
  },

  closeModal() {
    // Member: after viewing passbook/report, ask complaint once on close
    if (typeof _askComplaintOnClose !== 'undefined' && _askComplaintOnClose &&
        typeof Auth !== 'undefined' && Auth.isMember && Auth.isMember()) {
      const info = _askComplaintOnClose;
      _askComplaintOnClose = null;
      this._modalStack = [];
      this._modalBack = null;
      document.getElementById('modal-overlay').classList.add('hidden');
      setTimeout(() => {
        if (typeof askComplaintAfterView === 'function') {
          askComplaintAfterView(info.memberId, info.source);
        }
      }, 150);
      return;
    }

    // X = एक स्टेप: parent function (ताजा सूची) — stack बाट पुरानो सदस्य फारम होइन
    if (this._modalBack) {
      const fnName = this._modalBack;
      this._modalBack = null;
      this._modalStack = [];
      if (typeof fnName === 'function') {
        fnName();
        return;
      }
      if (typeof window[fnName] === 'function') {
        window[fnName]();
        return;
      }
    }

    // सरल नेस्टेड (back नभएको)
    this._modalStack = this._modalStack || [];
    if (this._modalStack.length > 0) {
      const prev = this._modalStack.pop();
      document.getElementById('modal-title').textContent = prev.title;
      document.getElementById('modal-body').innerHTML = prev.body;
      document.getElementById('modal-footer').innerHTML = prev.footer;
      this._modalBack = prev.back || null;
      return;
    }

    document.getElementById('modal-overlay').classList.add('hidden');
  },

  showPinModal(message, callback) {
    document.getElementById('pin-message').textContent = message;
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-modal').classList.remove('hidden');
    window._pinCallback = callback;
    setTimeout(() => document.getElementById('pin-input').focus(), 200);
  },

  closePinModal() {
    document.getElementById('pin-modal').classList.add('hidden');
    window._pinCallback = null;
  },

  confirmPin() {
    const pin = document.getElementById('pin-input').value;
    const data = DB.load();
    const adminPin = (data.admin && data.admin.pin) ? String(data.admin.pin) : '';
    const closePin = (data.settings && data.settings.closePin) ? String(data.settings.closePin) : '';
    if (pin && (pin === adminPin || pin === closePin)) {
      // Save callback BEFORE closing (closePinModal clears it)
      const cb = window._pinCallback;
      window._pinCallback = null;
      document.getElementById('pin-modal').classList.add('hidden');
      if (cb) cb(true);
    } else {
      this.toast('PIN गलत छ', 'error');
    }
  },

  // Nepali-ish datetime (simple approximation using AD for now + Nepali month names)
  
  // Approx AD → BS (Nepali) display
  _adToBs(ad) {
    // Reference: 2024-04-13 ≈ 2081-01-01 BS (approx algorithm)
    const y = ad.getFullYear(), m = ad.getMonth() + 1, d = ad.getDate();
    // Simple offset ~56y 8m 17d - good enough for header display
    let bsY = y + 56;
    let bsM = m + 8;
    let bsD = d + 16;
    if (bsD > 30) { bsD -= 30; bsM++; }
    if (bsM > 12) { bsM -= 12; bsY++; }
    const months = ['','बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पुस','माघ','फाल्गुन','चैत'];
    // Better: use known conversion library-free rough
    // Use nepali-date approximate from epoch
    try {
      // Alternative formula widely used (not 100% calendar-accurate every day)
      const bsMonths = ['बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पुस','माघ','फाल्गुन','चैत'];
      // days from a known anchor: 1943-04-14 = 2000-01-01 BS
      const anchor = Date.UTC(1943, 3, 14);
      const now = Date.UTC(y, m - 1, d);
      let days = Math.floor((now - anchor) / 86400000);
      let by = 2000;
      // month lengths approximate cycle - simplified fixed 30/31 pattern
      const lens = [30,32,31,32,31,30,30,30,29,30,29,30]; // rough
      while (true) {
        const yearLen = lens.reduce((a,b)=>a+b,0) + ((by % 4 === 0) ? 1 : 0);
        if (days >= yearLen) { days -= yearLen; by++; continue; }
        break;
      }
      let bm = 0;
      for (; bm < 12; bm++) {
        let L = lens[bm];
        if (bm === 1 && by % 4 === 0) L++;
        if (days < L) break;
        days -= L;
      }
      return `${bsMonths[bm]} ${days + 1}, ${by}`;
    } catch (e) {
      return ad.toLocaleDateString('ne-NP');
    }
  },

updateDateTime() {
    const el = document.getElementById('nepali-datetime');
    if (!el) return;
    const now = new Date();
    const days = ['आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहिबार', 'शुक्रबार', 'शनिबार'];
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const bsMonths = ['बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पुस','माघ','फाल्गुन','चैत'];
    // BS year -> [month lengths x12], Baisakh 1 AD as [y,m,d] (m=1-12)
    // Sources: official-style calendars 2080–2085
    const BS_DATA = {
      2080: { start: [2023,4,14], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
      2081: { start: [2024,4,13], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
      2082: { start: [2025,4,14], lens: [31,32,31,32,31,30,30,30,29,30,29,31] },
      2083: { start: [2026,4,14], lens: [31,31,32,31,31,31,30,30,29,30,30,30] },
      2084: { start: [2027,4,14], lens: [31,32,31,32,31,30,30,30,29,30,30,30] },
      2085: { start: [2028,4,13], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
      2086: { start: [2029,4,14], lens: [31,32,31,32,31,30,30,30,29,30,29,31] }
    };
    function adToBsStr(dt) {
      const y = dt.getFullYear(), m = dt.getMonth()+1, d = dt.getDate();
      const utc = Date.UTC(y, m-1, d);
      let chosen = null, bsY = null;
      for (const [yr, info] of Object.entries(BS_DATA)) {
        const s = info.start;
        const startUtc = Date.UTC(s[0], s[1]-1, s[2]);
        const yearLen = info.lens.reduce((a,b)=>a+b, 0);
        const endUtc = startUtc + yearLen * 86400000;
        if (utc >= startUtc && utc < endUtc) {
          chosen = info; bsY = parseInt(yr, 10); break;
        }
      }
      if (!chosen) {
        // fallback rough
        return d + '/' + m + '/' + y + ' ई.';
      }
      const s = chosen.start;
      let daysCount = Math.round((utc - Date.UTC(s[0], s[1]-1, s[2])) / 86400000);
      let bm = 0;
      for (; bm < 12; bm++) {
        if (daysCount < chosen.lens[bm]) break;
        daysCount -= chosen.lens[bm];
      }
      return bsMonths[bm] + ' ' + (daysCount + 1) + ', ' + bsY;
    }
    el.textContent = days[now.getDay()] + ' · ' + adToBsStr(now) + ' · ' + time;
  },

  updateSyncStatus(state, detail) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const map = {
      offline: { t: '📴 अफलाइन', c: 'sync-status sync-offline' },
      pending: { t: '⏳ सेभ हुँदै…', c: 'sync-status sync-pending' },
      saving: { t: '☁️ पठाउँदै…', c: 'sync-status sync-saving' },
      saved: { t: '✅ सेभ भयो', c: 'sync-status sync-saved' },
      error: { t: '⚠️ सिंक त्रुटि', c: 'sync-status sync-error' },
      idle: { t: '⚪ —', c: 'sync-status' }
    };
    const m = map[state] || map.idle;
    el.textContent = m.t;
    el.className = m.c;
    if (detail) el.title = detail;
  },

  updateHeader(data) {
    document.getElementById('header-group-name').textContent = data.group.name || 'समूह बचत';
    const logoEl = document.getElementById('header-logo');
    if (logoEl) {
      if (data.group && data.group.logoImage) {
        logoEl.innerHTML = '<img src="' + data.group.logoImage + '" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover"/>';
      } else {
        // फिक्स हल्का लोगो — क्लाउड/हिसाबमा असर छैन
        logoEl.innerHTML = '<img src="./logo-group.png" alt="" width="36" height="36" style="border-radius:8px;object-fit:cover"/>';
      }
    }
    const meta = [];
    if (data.group.address) meta.push(data.group.address);
    if (data.group.established) meta.push('स्थापना: ' + data.group.established);
    document.getElementById('header-group-meta').textContent = meta.join(' · ') || 'समूह प्रोफाइलबाट सेट गर्नुहोस्';

    const month = Accounting.getCurrentMonth(data);
    const statusEl = document.getElementById('month-status');
    if (!month) {
      statusEl.textContent = '⚪ महिना खुल्ला छैन';
      statusEl.className = 'month-status';
    } else if (month.status === 'open') {
      statusEl.textContent = '🟢 ' + month.name + ' · खुल्ला';
      statusEl.className = 'month-status status-open';
    } else if (month.status === 'collection_closed') {
      statusEl.textContent = '🟡 ' + month.name + ' · कलेक्सन बन्द';
      statusEl.className = 'month-status status-collection-closed';
    } else {
      statusEl.textContent = '🔴 ' + month.name + ' · बन्द';
      statusEl.className = 'month-status status-month-closed';
    }
    // सिंक अवस्था नबिगार्ने — DB ले अपडेट गर्छ
    if (!navigator.onLine) this.updateSyncStatus('offline');
  },

  updateHome(data) {
    try {
      const raw = localStorage.getItem('group_savings_v1');
      if (raw) data = JSON.parse(raw);
    } catch (e) {}

    const snap = Accounting.getSnapshot(data);
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = Accounting.formatNum(val); };
    setTxt('home-assets', snap.assets);
    setTxt('home-loans', snap.loans);
    setTxt('home-cash', snap.cash);
    setTxt('home-member-count', snap.members);
    setTxt('home-kitta-count', snap.kitta);
    setTxt('home-per-kitta', snap.perKitta);

    const banner = document.getElementById('mig-banner');
    if (banner) {
      if (data.migration && data.migration.hideAfterFirst) {
        banner.classList.add('hidden');
      } else if (data.migrationDone && (snap.migCash > 0 || snap.migLoans > 0 || snap.kitta > 0)) {
        banner.classList.remove('hidden');
        banner.innerHTML = '✅ माइग्रेशन: नगद ' + Accounting.formatNum(snap.migCash) +
          ' · ऋण ' + Accounting.formatNum(snap.migLoans) +
          ' · कित्ता ' + Accounting.formatNum(snap.kitta) +
          ' · प्रति कित्ता ' + Accounting.formatNum(snap.perKitta);
      } else if (data.migrationDone) {
        banner.classList.remove('hidden');
        banner.innerHTML = '⚠️ माइग्रेशन सेभ छ तर सबै 0 — अगाडिको हिसाबमा कित्ता/नगद हाल्नुहोस्';
      } else {
        banner.classList.add('hidden');
      }
    }
  },

  // Render member list HTML
  renderMemberList(members, onClickFnName, showBadges = true) {
    if (!members.length) {
      return '<div class="empty-state"><div class="icon">👥</div>कुनै सदस्य छैन</div>';
    }
    const data = DB.load();
    return members.map(m => {
      let badges = '';
      if (showBadges) {
        const assets = Accounting.memberAssets(data, m);
        if (m.kitta > 0) badges += `<span class="member-badge badge-kitta">${m.kitta} कित्ता</span> `;
        if (assets > 0) badges += `<span class="member-badge badge-kitta">💎 ${Accounting.formatNum(assets)}</span> `;
        if (m.outstandingLoan > 0) badges += `<span class="member-badge badge-loan">ऋण ${Accounting.formatNum(m.outstandingLoan)}</span> `;
        if (m.advance > 0) badges += `<span class="member-badge badge-advance">अग्रिम ${Accounting.formatNum(m.advance)}</span> `;
        if (m.due > 0) badges += `<span class="member-badge badge-due">बाँकी ${Accounting.formatNum(m.due)}</span> `;
      }
      const initial = (m.name || '?').charAt(0);
      return `
        <div class="member-item" onclick="${onClickFnName}('${m.id}')">
          <div class="member-avatar">${initial}</div>
          <div class="member-info">
            <div class="member-name">${m.name}</div>
            <div class="member-meta">${m.mobile || 'मोबाइल नभएको'} ${badges}</div>
          </div>
        </div>`;
    }).join('');
  }
};

// Global helpers for HTML onclick
function closeModal() {
    try { if (typeof stopQrScan === "function") stopQrScan(); } catch (e) {} UI.closeModal(); }
function closePinModal() { UI.closePinModal(); }
function confirmPin() { UI.confirmPin(); }
