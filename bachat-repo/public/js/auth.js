/**
 * Authentication & Role Management (Cloudflare Worker / D1 backed)
 * - Passwords & PINs are NEVER stored in plaintext in the client state.
 * - Offline Admin PIN verification uses a salted PBKDF2 verifier cached only for the active Admin session.
 */

const Auth = {
  currentUser: null,
  PIN_VERIFIER_KEY: 'gs_pin_verifier',

  isLoggedIn() {
    return !!this.currentUser && !!DB.getToken();
  },

  isAdmin() {
    return !!(this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'treasurer' || this.currentUser.role === 'admin_ro'));
  },

  isPrimaryAdmin() {
    return !!(this.currentUser && this.currentUser.role === 'admin');
  },

  isTreasurer() {
    return !!(this.currentUser && this.currentUser.role === 'treasurer');
  },

  isAccountsWriter() {
    return !!(this.currentUser && this.currentUser.role === 'treasurer' && this.currentUser.accountsWriter === true);
  },

  isMember() {
    return this.currentUser && this.currentUser.role === 'member';
  },

  logout() {
    this.currentUser = null;
    DB.setToken('');
    localStorage.removeItem('gs_session');
    localStorage.removeItem('gs_last_activity');
    localStorage.removeItem('gs_locked');
    localStorage.removeItem(this.PIN_VERIFIER_KEY);
    if (typeof DB !== 'undefined' && DB._appUpdateAcks) DB._appUpdateAcks = {};
    try {
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          (regs || []).forEach((r) => {
            if (r && r.pushManager) {
              r.pushManager.getSubscription().then((sub) => { if (sub) sub.unsubscribe().catch(() => {}); }).catch(() => {});
            }
          });
        }).catch(() => {});
      }
    } catch (e) {}
  },

  restoreSession() {
    try {
      const s = localStorage.getItem('gs_session');
      const t = DB.getToken();
      if (!s || !t) return false;
      this.currentUser = JSON.parse(s);
      return true;
    } catch (e) {}
    return false;
  },

  isLocked() {
    return localStorage.getItem('gs_locked') === '1';
  },

  setLocked(on) {
    if (on) localStorage.setItem('gs_locked', '1');
    else localStorage.removeItem('gs_locked');
  },

  saveSession() {
    if (this.currentUser) {
      localStorage.setItem('gs_session', JSON.stringify(this.currentUser));
      localStorage.setItem('gs_last_activity', String(Date.now()));
    }
  },

  touchActivity() {
    if (this.currentUser) {
      localStorage.setItem('gs_last_activity', String(Date.now()));
    }
  },

  setPinVerifier(hash) {
    try {
      if (hash) localStorage.setItem(this.PIN_VERIFIER_KEY, hash);
      else localStorage.removeItem(this.PIN_VERIFIER_KEY);
    } catch (e) {}
  },

  async verifySecretLocal(secret, stored) {
    if (!stored || !stored.startsWith('pbkdf2$')) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const b64Decode = (str) => {
      const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
      const bin = atob(s + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    const salt = b64Decode(parts[1]);
    const expected = b64Decode(parts[2]);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' }, km, 256);
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  },

  /** Works both offline (via PBKDF2 verifier) and online (via /api/verify-pin) */
  async verifyUserPin(pin) {
    if (!this.currentUser || !pin) return false;
    const verifier = localStorage.getItem(this.PIN_VERIFIER_KEY);
    if (verifier) {
      try {
        const ok = await this.verifySecretLocal(String(pin), verifier);
        if (ok) return true;
      } catch (e) {}
    }
    if (navigator.onLine && DB.getToken()) {
      try {
        const r = await DB.apiFetch('/verify-pin', {
          method: 'POST',
          body: JSON.stringify({ pin: String(pin) })
        });
        return !!(r.ok && r.body && r.body.ok);
      } catch (e) {}
    }
    return false;
  },

  async createAccount(name, username, password, mobile, pin) {
    if (!name || !username || !password || !mobile || !pin) {
      return { ok: false, msg: 'सबै फिल्ड भर्नुहोस्' };
    }
    if (password.length < 4) {
      return { ok: false, msg: 'Password कम्तिमा ४ अक्षरको हुनुपर्छ' };
    }
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return { ok: false, msg: 'PIN ठीक ४ अंकको हुनुपर्छ' };
    }
    const members = Accounting.createDefaultMembers();
    const initialState = DB.getDefault();
    initialState.members = members;

    const res = await DB.apiFetch('/bootstrap-admin', {
      method: 'POST',
      body: JSON.stringify({ name, username, password, mobile, pin, initialState })
    });
    if (res.ok && res.body && res.body.ok) {
      return { ok: true, msg: 'खाता सफलतापूर्वक बन्यो!' };
    }
    return { ok: false, msg: (res.body && res.body.error) || 'खाता बनाउन सकिएन' };
  },

  async unifiedLogin(id, secret) {
    id = (id || '').trim();
    secret = (secret || '').trim();
    if (!id || !secret) {
      return { ok: false, msg: 'username/mobile र password/pin हाल्नुहोस्' };
    }
    try {
      const res = await DB.apiFetch('/login', {
        method: 'POST',
        body: JSON.stringify({ id, secret })
      });
      if (!res.ok || !res.body || !res.body.ok) {
        return { ok: false, msg: (res.body && res.body.error) || 'लगइन मिलेन' };
      }
      const { token, user, pinVerifier, version, data, chat, readState, termsAcceptance, appUpdateAck, appUpdateAcks } = res.body;
      DB.setToken(token);
      this.currentUser = user;
      this.setPinVerifier(pinVerifier || '');
      this.saveSession();
      if (typeof DB.applyUserReadState === 'function') {
        DB.applyUserReadState(readState || {}, user);
      }
      if (termsAcceptance && typeof DB.applyUserTermsAcceptance === 'function') {
        DB.applyUserTermsAcceptance(termsAcceptance, user);
      }
      if (appUpdateAck && typeof DB.applyUserAppUpdateAck === 'function') {
        DB.applyUserAppUpdateAck(appUpdateAck, user);
      }
      if (appUpdateAcks && typeof DB.applyAppUpdateSummary === 'function') {
        DB.applyAppUpdateSummary(appUpdateAcks);
      }
      DB._applyServerPayload(data, chat, version);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: 'नेट जडान जाँच्नुहोस् (पहिलो लगइनमा इन्टरनेट चाहिन्छ)' };
    }
  },

  isMobileConflictWithAdmin(mobile, excludeMemberId) {
    const data = DB.load();
    const m = String(mobile || '').trim();
    if (!m) return false;
    const au = String((data.admin && data.admin.username) || '').trim();
    const tu = String((data.treasurer && data.treasurer.username) || '').trim();
    if ((au && m === au) || (tu && m === tu)) return true;
    const md = m.replace(/\D/g, '');
    if (md && ((au && md === au) || (tu && md === tu))) return true;
    const other = (data.members || []).find((x) =>
      x.active && x.id !== excludeMemberId &&
      (x.mobile === m || (md && String(x.mobile || '').replace(/\D/g, '') === md))
    );
    return !!other;
  },

  async setMemberPin(memberId, pin, opts) {
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return { ok: false, msg: 'PIN ठीक ४ अंकको हुनुपर्छ' };
    }
    const data = DB.load();
    const member = data.members.find((m) => m.id === memberId);
    if (!member) return { ok: false, msg: 'सदस्य भेटिएन' };
    if (!member.mobile) return { ok: false, msg: 'पहिले सदस्यको मोबाइल नम्बर सेट गर्नुहोस्' };

    const isTemp = !!(opts && opts.isTemp);
    const credRes = await DB.syncCredentialChange({
      type: 'member_pin',
      memberId: member.id,
      pin,
      mobile: member.mobile,
      name: member.name,
      isTemp
    });
    if (!credRes || !credRes.ok) {
      return { ok: false, msg: (credRes && credRes.error) || 'PIN सेभ असफल (नेट जाँच्नुहोस्)' };
    }

    if (credRes.version && typeof DB.setServerVersion === 'function') {
      DB.setServerVersion(credRes.version);
    }
    member.hasPin = true;
    member.mustChangePin = isTemp;
    (data.pinRequests || []).forEach((r) => {
      if (r.memberId === memberId && r.status === 'pending') r.status = 'approved';
    });
    DB.save(data, { localOnly: true });
    return { ok: true, msg: isTemp ? 'Temp PIN सुरक्षित सेट भयो' : 'PIN सुरक्षित सेट भयो', pin, isTemp };
  },

  async changeOwnPin(currentPin, newPin) {
    if (!this.isMember()) return { ok: false, msg: 'सदस्य लगइन आवश्यक छ' };
    if (!currentPin || !newPin) return { ok: false, msg: 'पुरानो र नयाँ दुवै PIN हाल्नुहोस्' };
    if (!/^\d{4}$/.test(newPin)) return { ok: false, msg: 'नयाँ PIN ठीक ४ अंकको हुनुपर्छ' };
    if (currentPin === newPin) return { ok: false, msg: 'नयाँ PIN पुरानो भन्दा फरक हुनुपर्छ' };
    if (!navigator.onLine) return { ok: false, msg: 'PIN परिवर्तन गर्न इन्टरनेट चाहिन्छ' };

    const res = await DB.apiFetch('/member/change-pin', {
      method: 'POST',
      body: JSON.stringify({ currentPin: String(currentPin), newPin: String(newPin) })
    });
    if (!res.ok || !res.body || !res.body.ok) {
      return { ok: false, msg: (res.body && res.body.error) || 'PIN परिवर्तन असफल' };
    }
    if (res.body.token) DB.setToken(res.body.token);
    if (res.body.user) this.currentUser = res.body.user;
    if (res.body.pinVerifier) this.setPinVerifier(res.body.pinVerifier);
    if (res.body.version && typeof DB.setServerVersion === 'function') {
      DB.setServerVersion(res.body.version);
    }
    this.saveSession();
    try {
      const data = DB.load();
      const m = (data.members || []).find((x) => x.id === (this.currentUser && this.currentUser.memberId));
      if (m) {
        m.hasPin = true;
        m.mustChangePin = false;
        DB.save(data, { localOnly: true });
      }
    } catch (e) {}
    return { ok: true, msg: 'नयाँ PIN सुरक्षित परिवर्तन भयो ✅' };
  }
};
