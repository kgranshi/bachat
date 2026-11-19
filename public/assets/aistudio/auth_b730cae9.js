/**
 * Authentication & Role Management
 */

const Auth = {
  currentUser: null, // { role: 'admin'|'member', memberId, name, ... }

  isLoggedIn() {
    return !!this.currentUser;
  },

  isAdmin() {
    return this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'admin_ro');
  },
  isAccountsWriter() {
    return this.currentUser && this.currentUser.role === 'admin' && this.currentUser.accountsWriter === true;
  },

  isMember() {
    return this.currentUser && this.currentUser.role === 'member';
  },

  logout() {
    this.currentUser = null;
    localStorage.removeItem('gs_session');
    localStorage.removeItem('gs_last_activity');
    localStorage.removeItem('gs_locked');
  },

  // Restore session — लगआउट नगरेसम्म रहन्छ (१५ मिनेटले लगआउट हुँदैन)
  restoreSession() {
    try {
      const s = localStorage.getItem('gs_session');
      if (!s) return false;
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

  /** Admin PIN वा सदस्य आफ्नो PIN */
  verifyUserPin(pin) {
    const data = DB.load();
    if (!this.currentUser) return false;
    if (this.currentUser.role === 'admin') {
      return pin === (data.admin && data.admin.pin) || pin === (data.settings && data.settings.closePin);
    }
    if (this.currentUser.role === 'admin_ro') {
      const secs = data.secondaryAdmins || [];
      const s = secs.find(x => x.username === this.currentUser.username);
      if (s && s.pin) return pin === s.pin;
      // session मा pin
      if (this.currentUser.pin) return pin === this.currentUser.pin;
      return false;
    }
    const m = data.members.find(x => x.id === this.currentUser.memberId);
    return m && m.pin && pin === m.pin;
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

  // Create first admin account
  createAccount(name, username, password, mobile, pin) {
    const data = DB.load();
    if (data.admin) {
      return { ok: false, msg: 'Admin खाता पहिले नै बनिसकेको छ' };
    }
    if (!name || !username || !password || !mobile || !pin) {
      return { ok: false, msg: 'सबै फिल्ड भर्नुहोस्' };
    }
    if (password.length < 4) {
      return { ok: false, msg: 'Password कम्तिमा ४ अक्षरको हुनुपर्छ' };
    }
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return { ok: false, msg: 'PIN ठीक ४ अंकको हुनुपर्छ' };
    }

    // Create members first
    if (data.members.length === 0) {
      data.members = Accounting.createDefaultMembers();
    }

    // First member becomes the admin person
    const adminMember = data.members[0];
    adminMember.name = name;
    adminMember.mobile = mobile;
    adminMember.pin = pin;

    data.admin = {
      name,
      username,
      password, // plain for simplicity (offline app); in production hash it
      mobile,
      pin,
      memberId: adminMember.id
    };
    data.settings.closePin = pin;

    DB.save(data);
    return { ok: true, msg: 'खाता सफलतापूर्वक बन्यो!' };
  },

  adminLogin(username, password) {
    const data = DB.load();
    if (!data.admin) {
      return { ok: false, msg: 'पहिला खाता बनाउनुहोस्' };
    }
    if (data.admin.username === username && data.admin.password === password) {
      const writerName = (data.settings && data.settings.accountsWriterUsername) || data.admin.username;
      const isWriter = (username === writerName);
      this.currentUser = {
        role: 'admin',
        accountsWriter: isWriter,
        memberId: data.admin.memberId,
        name: data.admin.name,
        username: data.admin.username
      };
      this.saveSession();
      return { ok: true };
    }
    return { ok: false, msg: 'Username वा Password गलत छ' };
  },

  memberLogin(mobile, pin) {
    const data = DB.load();
    const member = data.members.find(m => m.mobile === mobile && m.active);
    if (!member) {
      return { ok: false, msg: 'यो मोबाइल नम्बर भएको सदस्य भेटिएन' };
    }
    if (!member.pin) {
      return { ok: false, msg: 'तपाईंको PIN सेट भएको छैन। Admin बाट PIN माग्नुहोस्।' };
    }
    if (member.pin !== pin) {
      return { ok: false, msg: 'PIN गलत छ' };
    }
    this.currentUser = {
      role: 'member',
      memberId: member.id,
      name: member.name,
      mobile: member.mobile
    };
    this.saveSession();

    // Log activity
    data.activityLog = data.activityLog || [];
    data.activityLog.push({
      type: 'member_login',
      memberId: member.id,
      time: new Date().toISOString()
    });
    DB.save(data);

    return { ok: true };
  },

  
  /**
   * एउटै फारम: पहिले admin username+password, नत्र member mobile+pin
   */
  unifiedLogin(id, secret) {
    id = (id || '').trim();
    secret = (secret || '').trim();
    if (!id || !secret) {
      return { ok: false, msg: 'username/mobile र password/pin हाल्नुहोस्' };
    }
    const data = DB.load();
    // 1) Primary Admin (writer or not by settings)
    if (data.admin) {
      if (data.admin.username === id && data.admin.password === secret) {
        return this.adminLogin(id, secret);
      }
    }
    // 1b) Secondary Admin B — Admin UI · हिसाब read-only सिंक
    const secs = data.secondaryAdmins || [];
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      if (s && s.username === id && s.password === secret && s.active !== false) {
        this.currentUser = {
          role: 'admin_ro',
          accountsWriter: false,
          username: s.username,
          name: s.name || s.username,
          pin: s.pin || '',
          memberId: null
        };
        this.saveSession();
        return { ok: true };
      }
    }
    // 2) Member: mobile match (normalize digits)
    const digits = id.replace(/\D/g, '');
    const res = this.memberLogin(digits.length >= 7 ? digits : id, secret);
    if (res.ok) return res;
    // try full id as mobile string
    if (digits !== id) {
      const res2 = this.memberLogin(id, secret);
      if (res2.ok) return res2;
    }
    return { ok: false, msg: 'लगइन मिलेन · username/password वा mobile/PIN जाँच्नुहोस्' };
  },

  /** सदस्य mobile admin username सँग नबाझोस् */
  isMobileConflictWithAdmin(mobile, excludeMemberId) {
    const data = DB.load();
    if (!data.admin) return false;
    const m = String(mobile || '').trim();
    const au = String(data.admin.username || '').trim();
    const am = String(data.admin.mobile || '').trim();
    if (!m) return false;
    if (m === au || m === am) return true;
    const md = m.replace(/\D/g, '');
    const amd = am.replace(/\D/g, '');
    if (md && (md === au || (amd && md === amd))) return true;
    // अर्को सदस्यको मोबाइल दोहोरिन नदिने
    const other = (data.members || []).find(x =>
      x.active && x.id !== excludeMemberId &&
      (x.mobile === m || (md && String(x.mobile || '').replace(/\D/g, '') === md))
    );
    return !!other;
  },

requestPin(mobile) {
    const data = DB.load();
    const member = data.members.find(m => m.mobile === mobile && m.active);
    if (!member) {
      return { ok: false, msg: 'यो मोबाइल नम्बर भएको सदस्य भेटिएन' };
    }
    data.pinRequests = data.pinRequests || [];
    // Avoid duplicate pending
    if (data.pinRequests.some(r => r.memberId === member.id && r.status === 'pending')) {
      return { ok: false, msg: 'PIN अनुरोध पहिले नै पठाइसक्नुभएको छ' };
    }
    data.pinRequests.push({
      id: 'pr_' + Date.now(),
      memberId: member.id,
      memberName: member.name,
      mobile,
      time: new Date().toISOString(),
      status: 'pending'
    });
    DB.save(data);
    return { ok: true, msg: 'PIN अनुरोध Admin कहाँ पठाइयो' };
  },

  // Admin sets pin for a member
  setMemberPin(memberId, pin) {
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return { ok: false, msg: 'PIN ठीक ४ अंकको हुनुपर्छ' };
    }
    const data = DB.load();
    const member = data.members.find(m => m.id === memberId);
    if (!member) return { ok: false, msg: 'सदस्य भेटिएन' };
    member.pin = pin;
    // Mark requests as approved
    (data.pinRequests || []).forEach(r => {
      if (r.memberId === memberId && r.status === 'pending') {
        r.status = 'approved';
      }
    });
    DB.save(data);
    return { ok: true, msg: 'PIN सेट भयो' };
  }
};
