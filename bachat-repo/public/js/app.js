/**
 * Main Application Logic
 */

let APP_DATA = null;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  try { applyAppTheme(DB.load()); } catch (e) {}
  setTimeout(initApp, 600);
});

const INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes

function resetActivity() {
  Auth.touchActivity();
}

async function initApp() {
  let health = { ok: false, hasAdmin: false };
  try {
    if (typeof startCloudSync === 'function') {
      health = await Promise.race([
        DB.checkServerHealth(),
        new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), 8000))
      ]);
    }
  } catch (e) {
    console.warn('health check', e);
  }

  APP_DATA = DB.load();
  if (Auth.restoreSession()) {
    try {
      await Promise.race([
        startCloudSync(),
        new Promise((r) => setTimeout(() => r('timeout'), 8000))
      ]);
    } catch (e) {}
    APP_DATA = DB.load();
  }

  // Update datetime every 30s
  UI.updateDateTime();
  setInterval(UI.updateDateTime, 30000);

  // १५ मिनेट निष्क्रिय = लक (लगइन मै), लगआउट होइन
  ['click', 'touchstart', 'keypress', 'scroll'].forEach(evt => {
    document.addEventListener(evt, resetActivity, { passive: true });
  });
  setInterval(() => {
    if (!Auth.isLoggedIn()) return;
    if (Auth.isLocked && Auth.isLocked()) return;
    const lastAct = parseInt(localStorage.getItem('gs_last_activity') || '0', 10);
    if (lastAct && (Date.now() - lastAct > INACTIVITY_MS)) {
      lockAppSession();
    }
  }, 30000);

  if (Auth.restoreSession()) {
    applyAppTheme(DB.load());
    showMainApp();
    const lastAct = parseInt(localStorage.getItem('gs_last_activity') || '0', 10);
    if ((Auth.isLocked && Auth.isLocked()) ||
        (lastAct && (Date.now() - lastAct > INACTIVITY_MS))) {
      lockAppSession();
    } else {
      Auth.touchActivity();
    }
  } else {
    showLoginScreen();
  }

  document.getElementById('loading-screen').classList.remove('active');
}

function showLoginScreen() {
  try { applyAppTheme(DB.load()); } catch (e) {}
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('login-screen').classList.add('active');

  const firstSetupBox = document.getElementById('first-setup-box');
  let diag = document.getElementById('cloud-diag-box');
  if (!diag && firstSetupBox && firstSetupBox.parentNode) {
    diag = document.createElement('div');
    diag.id = 'cloud-diag-box';
    diag.className = 'hidden';
    diag.style.cssText = 'margin-top:12px;padding:10px;border-radius:10px;background:#fff3cd;color:#664d03;font-size:0.78rem;line-height:1.45;text-align:left;';
    firstSetupBox.parentNode.insertBefore(diag, firstSetupBox);
  }
  if (firstSetupBox) {
    if (DB._cloud && !DB._hasAdminOnServer) {
      firstSetupBox.classList.remove('hidden');
      if (diag) diag.classList.add('hidden');
    } else if (!DB._cloud && DB._lastHealthError) {
      firstSetupBox.classList.add('hidden');
      if (diag) {
        diag.classList.remove('hidden');
        diag.textContent = '⚠️ सर्भर जाँच (/api/health): ' + DB._lastHealthError + ' — Cloudflare Pages मा DB/MEDIA Binding र D1 टेबलहरू जाँच गर्नुहोस्।';
      }
    } else {
      firstSetupBox.classList.add('hidden');
      if (diag) diag.classList.add('hidden');
    }
  }
  backToLoginOptions();
}

function showMainApp() {
  try { applyAppTheme(DB.load()); } catch (e) {}
  try { startScheduleTimers(); } catch (e) {}
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('main-screen').classList.add('active');
  APP_DATA = DB.load();
  UI.updateHeader(APP_DATA);
  UI.updateHome(APP_DATA);
  renderHomeByRole();
  updateNavForRole();
  switchTab('home');
  setTimeout(function () {
    if (typeof startCloudSync === 'function') {
      startCloudSync().catch(function (e) { console.warn(e); });
    }
  }, 400);
  setTimeout(function () {
    if (Auth.isMember && Auth.isMember()) {
      runMemberOnboardingGate();
    } else if (typeof syncWebPushSubscription === 'function' && typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        syncWebPushSubscription(true).catch(function () {});
      } else if (Notification.permission === 'default' && 'PushManager' in window && navigator.serviceWorker) {
        try {
          const prompted = sessionStorage.getItem('gs_push_hint');
          if (!prompted) {
            sessionStorage.setItem('gs_push_hint', '1');
            UI.toast('🔔 बचत सूचनाका लागि सेटिङ → पुश सूचना खोल्नुहोस्', '');
          }
        } catch (e) {}
      }
    }
  }, 900);
  if (typeof renderProfileTab === 'function' && (!Auth.isMember || !Auth.isMember())) {
    renderProfileTab();
  }
  renderSettingsTab();
  renderVidhanTab();

  if (Auth.isAdmin()) {
    const pending = (APP_DATA.pinRequests || []).filter(r => r.status === 'pending');
    const unread = (APP_DATA.complaints || []).filter(c => !c.read).length;
    if (pending.length > 0 || unread > 0) {
      setTimeout(() => UI.toast(`📩 PIN: ${pending.length} · गुनासो: ${unread}`, 'success'), 500);
    }
  }
}

// ===== सदस्य अनबोर्डिङ (१. अनिवार्य Temp PIN परिवर्तन → २. अनिवार्य Push अनुमति/चेतावनी → ३. Skip मिल्ने गाइड) =====
function runMemberOnboardingGate() {
  if (!Auth.isMember || !Auth.isMember() || !Auth.currentUser) return;
  const mid = Auth.currentUser.memberId || 'm';
  // १. अस्थायी PIN अनिवार्य परिवर्तन
  if (Auth.currentUser.mustChangePin) {
    showMandatoryPinChangeModal();
    return;
  }
  // २. पुश नोटिफिकेसन अनुमति गेट
  const pushAckKey = 'gs_push_gate_done_' + mid;
  const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
  if (perm === 'granted') {
    try { localStorage.setItem(pushAckKey, 'granted'); } catch (e) {}
    if (typeof syncWebPushSubscription === 'function') syncWebPushSubscription(true).catch(function () {});
  } else if (!localStorage.getItem(pushAckKey)) {
    showPushPermissionGateModal();
    return;
  }
  // ३. पहिलो पटक सदस्य एप गाइड (Skip गर्न मिल्ने)
  const tourKey = 'gs_member_tour_done_' + mid;
  if (!localStorage.getItem(tourKey)) {
    showMemberGuideTour(0, false);
  }
}

function showMandatoryPinChangeModal() {
  const html = `
    <div style="background:#fff3cd;border-left:4px solid #fd7e14;padding:10px 12px;border-radius:8px;font-size:0.84rem;margin-bottom:12px">
      🔐 <strong>सुरक्षा सूचना:</strong> Admin ले तपाईंलाई अस्थायी (Temp) PIN दिनुभएको छ। अगाडि बढ्नुअघि तुरुन्तै आफ्नो गोप्य ४ अंकको नयाँ PIN बनाउनुहोस्।
    </div>
    <div class="form-group"><label>अहिलेको अस्थायी (Temp) PIN</label>
      <input type="password" id="ob-cur-pin" maxlength="4" inputmode="numeric" placeholder="Admin ले पठाएको ४ अंक">
    </div>
    <div class="form-group"><label>नयाँ ४ अंकको गोप्य PIN</label>
      <input type="password" id="ob-new-pin" maxlength="4" inputmode="numeric" placeholder="आफैँ सम्झिने ४ अंक">
    </div>
    <div class="form-group"><label>नयाँ PIN फेरि लेख्नुहोस्</label>
      <input type="password" id="ob-new-pin2" maxlength="4" inputmode="numeric" placeholder="फेरि त्यही ४ अंक">
    </div>
    <button type="button" class="btn btn-primary btn-block" onclick="submitMandatoryPinChange()">✅ नयाँ PIN सेभ गरी अगाडि बढ्नुहोस्</button>
    <button type="button" class="btn btn-outline btn-block mt-1" onclick="UI._noClose=false;doLogout()">🚪 लगआउट</button>
  `;
  UI.showModal('🔐 पहिलो लगइन: PIN परिवर्तन अनिवार्य', html, '', { root: true, noClose: true });
}

async function submitMandatoryPinChange() {
  const cur = (document.getElementById('ob-cur-pin').value || '').trim();
  const np1 = (document.getElementById('ob-new-pin').value || '').trim();
  const np2 = (document.getElementById('ob-new-pin2').value || '').trim();
  if (np1 !== np2) return UI.toast('नयाँ PIN दुवै ठाउँमा मिलेन', 'error');
  const res = await Auth.changeOwnPin(cur, np1);
  if (!res.ok) return UI.toast(res.msg, 'error');
  UI.toast(res.msg, 'success');
  UI._noClose = false;
  closeModal();
  setTimeout(runMemberOnboardingGate, 200);
}

function diagnosePushUnavailableReason() {
  const ua = (navigator && navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isInApp = /FBAN|FBAV|Messenger|Instagram|Line|MicroMessenger/i.test(ua);
  if (isInApp) {
    return 'तपाईं Facebook/Messenger भित्रको इन-एप ब्राउजरबाट खोल्नुभएको रहेछ — यहाँ सूचना (Notification) चल्दैन। कृपया माथि ⋮ थिचेर <strong>"Open in Chrome / Browser"</strong> बाट खोल्नुहोस्।';
  }
  if (isIOS && !isStandalone) {
    return 'iPhone/iPad मा सिधै Safari भित्र Notification चल्दैन। पहिले तलको <strong>Share (⬆️) → Add to Home Screen</strong> गर्नुहोस्, र होम स्क्रिनको आइकनबाट खोलेर Allow गर्नुहोस्।';
  }
  if (typeof Notification === 'undefined' || !('PushManager' in window)) {
    return 'यो ब्राउजर वा डिभाइसमा Web Push सुविधा उपलब्ध छैन। Chrome वा Safari (Home Screen) बाट खोल्नुहोस्।';
  }
  if (Notification.permission === 'denied') {
    return 'तपाईंको ब्राउजरमा सूचना <strong>Block</strong> गरिएको छ। ठेगाना बारको छेउमा भएको 🔒 / सेटिङ आइकन → Permissions → <strong>Notifications = Allow</strong> गर्नुहोस्।';
  }
  return 'अहिले सूचना अनुमति प्राप्त भएन। पछि Settings → पुश सूचना बाट चालु गर्न सक्नुहुन्छ।';
}

function showPushPermissionGateModal() {
  const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
  const unsupported = perm === 'denied' || perm === 'unsupported' || !('PushManager' in window);
  const reasonBox = unsupported
    ? `<div style="background:#f8d7da;color:#842029;padding:10px;border-radius:8px;font-size:0.82rem;margin:10px 0">⚠️ <strong>किन मिलेन / कसरी गर्ने:</strong><br>${diagnosePushUnavailableReason()}</div>`
    : '';
  const html = `
    <div style="font-size:0.88rem;line-height:1.5;margin-bottom:10px">
      🔔 <strong>बचत बैठक र रसिदको घण्टी ("टिङ-टिङ") सुन्न</strong> सूचना अनुमति अनिवार्य छ — यसो गर्दा एप बन्द भए पनि बैठकको दिन र बचत खुल्दा तुरुन्तै खबर आउँछ।
    </div>
    ${reasonBox}
    <div id="push-gate-warn" class="hidden" style="background:#fff3cd;color:#664d03;padding:10px;border-radius:8px;font-size:0.82rem;margin:10px 0"></div>
    ${!unsupported ? `<button type="button" class="btn btn-success btn-block" onclick="attemptPushGateAllow()">🔔 सूचना (Notification) Allow गर्नुहोस्</button>` : ''}
    <button type="button" id="push-gate-skip-btn" class="btn btn-warning btn-block mt-1 ${unsupported ? '' : 'hidden'}" onclick="acknowledgePushWarningAndEnter()">⚠️ सूचना बिना चेतावनी बुझेर भित्र जानुहोस्</button>
  `;
  UI.showModal('🔔 अनिवार्य सूचना अनुमति', html, '', { root: true, noClose: true });
}

async function attemptPushGateAllow() {
  let granted = false;
  try {
    granted = await ensureNotificationPermission();
  } catch (e) {
    granted = false;
  }
  if (granted) {
    const subOk = await syncWebPushSubscription(false);
    const mid = (Auth.currentUser && Auth.currentUser.memberId) || 'm';
    try { localStorage.setItem('gs_push_gate_done_' + mid, 'granted'); } catch (e) {}
    UI.toast(subOk ? 'पुश सूचना सक्रिय भयो ✅' : 'सूचना अनुमति सक्रिय ✅', 'success');
    UI._noClose = false;
    closeModal();
    setTimeout(runMemberOnboardingGate, 200);
    return;
  }
  const warn = document.getElementById('push-gate-warn');
  const skipBtn = document.getElementById('push-gate-skip-btn');
  if (warn) {
    warn.classList.remove('hidden');
    warn.innerHTML = '⚠️ <strong>सावधान! सूचना Allow भएन:</strong> ' + diagnosePushUnavailableReason() +
      '<br><br>सूचना नखोलेसम्म बैठकको अटो "टिङ-टिङ" घण्टी आउने छैन।';
  }
  if (skipBtn) skipBtn.classList.remove('hidden');
}

function acknowledgePushWarningAndEnter() {
  const mid = (Auth.currentUser && Auth.currentUser.memberId) || 'm';
  try { localStorage.setItem('gs_push_gate_done_' + mid, 'warned'); } catch (e) {}
  UI._noClose = false;
  closeModal();
  setTimeout(runMemberOnboardingGate, 200);
}

function showMemberGuideTour(step, force) {
  const steps = [
    {
      title: '🏠 १/४ · होम र मेरो हिसाब',
      body: 'होमको माथि <strong>समूहको कुल कोस</strong> (सम्पत्ति, नगद, ऋण, प्रति कित्ता) र तल तपाईंको <strong>सदस्य कार्ड</strong> देखिन्छ। रातो/पहेँलो <strong>अनिवार्य रकम</strong> मा थिच्दा बचत/ब्याज/जरिवाना पूरा विवरण खुल्छ।'
    },
    {
      title: '👤 २/४ · प्रोफाइल, फोटो र पासबुक',
      body: 'होममा देखिने तपाईंको <strong>नाम / प्रोफाइल कार्ड</strong> मा थिच्दा पूरा विवरण, <strong>पासपोर्ट फोटो अपलोड</strong> र भित्रैबाट <strong>📖 पासबुक, 📋 कलेक्सन, 📊 रिपोर्ट</strong> सबै खुल्छ।'
    },
    {
      title: '💬 ३/४ · छलफल चौतारी र गुनासो',
      body: 'होमको <strong>💬 छलफल चौतारी</strong> मा बैठक सूचना र समूह कुराकानी हुन्छ। हिसाबमा शंका लागे पासबुक बन्द गर्दा वा <strong>⚙️ सेटिङ → सुझाव तथा गुनासो</strong> बाट Admin लाई पठाउन मिल्छ।'
    },
    {
      title: '📱 ४/४ · एप सेभ र PIN सुरक्षा',
      body: 'सजिलै खोल्न Chrome को माथि <strong>⋮ → Add to Home screen</strong> (वा ★ Bookmark) गर्नुहोस्। तलको <strong>⚙️ सेटिङ</strong> बाट तपाईंले जुनसुकै बेला आफ्नो PIN फेर्न र सूचना जाँच गर्न सक्नुहुन्छ।'
    }
  ];
  const idx = Math.max(0, Math.min(steps.length - 1, Number(step) || 0));
  const cur = steps[idx];
  const mid = (Auth.currentUser && Auth.currentUser.memberId) || 'm';
  const markDone = () => {
    try { localStorage.setItem('gs_member_tour_done_' + mid, '1'); } catch (e) {}
    closeModal();
  };
  window._finishMemberTour = markDone;
  const html = `
    <div style="background:#f0f7ff;border:1px solid #cfe2ff;border-radius:12px;padding:14px;line-height:1.55;font-size:0.9rem;margin-bottom:12px">
      <div class="fw-bold mb-1" style="color:#0a58ca;font-size:1rem">${cur.title}</div>
      <div>${cur.body}</div>
    </div>
    <div style="display:flex;gap:8px">
      ${idx > 0 ? `<button type="button" class="btn btn-outline" style="flex:1" onclick="showMemberGuideTour(${idx - 1}, true)">← अघिल्लो</button>` : `<button type="button" class="btn btn-light" style="flex:1" onclick="window._finishMemberTour()">⏭️ Skip (छोड्नुहोस्)</button>`}
      ${idx < steps.length - 1 ? `<button type="button" class="btn btn-primary" style="flex:1" onclick="showMemberGuideTour(${idx + 1}, true)">अर्को →</button>` : `<button type="button" class="btn btn-success" style="flex:1" onclick="window._finishMemberTour()">✅ बुझेँ, सुरु गरौँ</button>`}
    </div>
    ${idx > 0 ? `<button type="button" class="btn btn-light btn-sm btn-block mt-1" onclick="window._finishMemberTour()">⏭️ गाइड बन्द गर्नुहोस् (Skip)</button>` : ''}
  `;
  UI.showModal('🎓 एप चलाउने सरल तरिका', html, '', { replace: true });
}

function renderHomeByRole() {
  const adminHome = document.getElementById('home-admin');
  const memberHome = document.getElementById('home-member');
  if (Auth.isAdmin()) {
    adminHome.classList.remove('hidden');
    memberHome.classList.add('hidden');
    // Admin खुला महिना प्रगति बक्स
    const data = DB.load();
    const cur = Accounting.getCurrentMonth(data);
    let progEl = document.getElementById('admin-open-progress');
    if (!progEl && adminHome) {
      progEl = document.createElement('div');
      progEl.id = 'admin-open-progress';
      const actionCards = adminHome.querySelector('.action-cards');
      if (actionCards) adminHome.insertBefore(progEl, actionCards);
      else adminHome.appendChild(progEl);
    }
    if (progEl) {
      if (cur && (cur.status === 'open' || cur.status === 'collection_closed')) {
        const activeCount = (data.members || []).filter(m => m.active).length;
        const paidCount = Object.values(cur.collections || {}).filter(c => (Number(c.totalPaid) || 0) > 0).length;
        const cashCollected = Object.values(cur.collections || {}).reduce((s, c) => s + (Number(c.totalPaid) || 0), 0);
        progEl.innerHTML = `<div class="section-card" onclick="openCollection()" style="cursor:pointer;padding:10px 14px;margin-bottom:10px;background:#f0f7ff;border:1px solid #b6d4fe;display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="font-size:0.84rem">📥 <strong>${cur.name}:</strong> ${paidCount}/${activeCount} सदस्य असुली</div>
          <div style="font-size:0.84rem;font-weight:700;color:#0a58ca">रु. ${Accounting.formatNum(cashCollected)} ▸</div>
        </div>`;
      } else {
        progEl.innerHTML = '';
      }
    }
  } else {
    adminHome.classList.add('hidden');
    memberHome.classList.remove('hidden');
    renderMemberHome(memberHome);
  }
}

function showMemberMandatoryBreakdown() {
  const data = DB.load();
  const member = data.members.find(m => m.id === (Auth.currentUser && Auth.currentUser.memberId));
  if (!member) return;
  const month = Accounting.getCurrentMonth(data);
  const refMonth = month || Accounting.getPreviousMonth(data) || { status: 'open' };
  const man = Accounting.calcMandatory(member, data, refMonth);
  const effLoan = Accounting.getEffectiveMemberLoan(data, member, month);
  const effAdv = Accounting.getEffectiveMemberAdvance(data, member, month);
  const html = `
    <div class="report-card mb-2">
      <div class="report-row"><span class="label">💾 मासिक बचत (${member.kitta} कित्ता)</span><span class="value">रु. ${Accounting.formatNum(man.saving)}</span></div>
      <div class="report-row"><span class="label">📈 ऋण ब्याज (${(data.settings && data.settings.interestRate) || 0}%)</span><span class="value">रु. ${Accounting.formatNum(man.interest)}</span></div>
      <div class="report-row"><span class="label">⚠️ जरिवाना</span><span class="value">रु. ${Accounting.formatNum(man.fine)}</span></div>
      <div class="report-row"><span class="label">📉 अघिल्लो बाँकी (Due)</span><span class="value" style="color:${man.previousDue>0?'#dc3545':''}">रु. ${Accounting.formatNum(man.previousDue)}</span></div>
      <div class="report-row"><span class="label fw-bold">कुल अनिवार्य (अग्रिम अघि)</span><span class="value fw-bold">रु. ${Accounting.formatNum(man.totalGross)}</span></div>
      <div class="report-row"><span class="label">💚 अग्रिमबाट कट्टा</span><span class="value" style="color:#0d6efd">− रु. ${Accounting.formatNum(man.advanceCover)}</span></div>
      <div class="report-row highlight"><span class="label">💵 नगद तिर्नुपर्ने जम्मा</span><span class="value fw-bold" style="color:#0d6efd">रु. ${Accounting.formatNum(man.total)}</span></div>
    </div>
    <div class="report-card">
      <div class="report-row"><span class="label">🤝 हाल बाँकी ऋण</span><span class="value" style="color:${effLoan>0?'#dc3545':''}">रु. ${Accounting.formatNum(effLoan)}</span></div>
      <div class="report-row"><span class="label">💚 हाल बाँकी अग्रिम</span><span class="value" style="color:#0d6efd">रु. ${Accounting.formatNum(effAdv)}</span></div>
    </div>
    <p class="text-muted mt-2" style="font-size:0.78rem">यो हिसाब तपाईंको कित्ता, अघिल्लो महिनाको ऋण र नियमअनुसार स्वतः गणना गरिएको हो।</p>
  `;
  UI.showModal('🧾 अनिवार्य रकमको पूरा विवरण', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function renderMemberHome(container) {
  const data = DB.load();
  const member = data.members.find(m => m.id === Auth.currentUser.memberId);
  if (!member) { container.innerHTML = '<div class="empty-state">सदस्य भेटिएन</div>'; return; }

  const snap = Accounting.getSnapshot(data);
  const myAssets = Accounting.memberAssets(data, member);
  const month = Accounting.getCurrentMonth(data);
  const effLoan = Accounting.getEffectiveMemberLoan(data, member, month);
  const effAdv = Accounting.getEffectiveMemberAdvance(data, member, month);

  let mandHtml = '';
  try {
    const refMonth = month || Accounting.getPreviousMonth(data) || { status: 'open' };
    const man = Accounting.calcMandatory(member, data, refMonth);
    const label = month ? 'अनिवार्य' : 'अर्को कलेक्सन अनिवार्य';
    mandHtml =
      '<div class="mt-2" style="cursor:pointer" onclick="event.stopPropagation();showMemberMandatoryBreakdown()">' +
      '<span class="member-badge badge-due" style="font-size:0.9rem;padding:5px 10px">' +
      label + ' रु. <strong>' + Accounting.formatNum(man.total) + '</strong> · <span style="text-decoration:underline">विवरण ▾</span>' +
      '</span></div>';
  } catch (e) {}

  const chatUnread = groupChatUnreadCount(data);
  const chatBadge = chatUnread > 0 ? ' <span class="badge-unread">' + chatUnread + ' नयाँ</span>' : '';
  const avatarHtml = member.photo
    ? `<img src="${member.photo}" alt="" class="member-passport-photo"/>`
    : `<div class="member-avatar" style="width:56px;height:66px;border-radius:10px;font-size:1.4rem">${member.name.charAt(0)}</div>`;

  container.innerHTML = `
    <div class="section-card" style="padding:8px 10px;margin-bottom:8px;background:#f8faff;border:1px solid #dce7f7">
      <div style="font-size:0.72rem;font-weight:700;color:#495057;margin-bottom:5px">🏛️ समूहको कोस (प्रत्यक्ष पारदर्शी हिसाब)</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;text-align:center">
        <div style="background:#fff;padding:5px 3px;border-radius:8px;border:1px solid #e9ecef">
          <div style="font-size:0.65rem;color:#6f42c1">💎 कुल कोस</div>
          <div style="font-weight:700;font-size:0.8rem">${Accounting.formatNum(snap.assets)}</div>
        </div>
        <div style="background:#fff;padding:5px 3px;border-radius:8px;border:1px solid #e9ecef">
          <div style="font-size:0.65rem;color:#198754">💵 नगद</div>
          <div style="font-weight:700;font-size:0.8rem">${Accounting.formatNum(snap.cash)}</div>
        </div>
        <div style="background:#fff;padding:5px 3px;border-radius:8px;border:1px solid #e9ecef">
          <div style="font-size:0.65rem;color:#fd7e14">🤝 ऋण</div>
          <div style="font-weight:700;font-size:0.8rem">${Accounting.formatNum(snap.loans)}</div>
        </div>
        <div style="background:#fff;padding:5px 3px;border-radius:8px;border:1px solid #e9ecef">
          <div style="font-size:0.65rem;color:#0891b2">💰 प्र.कित्ता</div>
          <div style="font-weight:700;font-size:0.8rem">${Accounting.formatNum(snap.perKitta)}</div>
        </div>
      </div>
    </div>

    <div class="section-card" onclick="openMemberOwnProfileModal()" style="padding:12px;margin-bottom:10px;cursor:pointer" title="पूरा प्रोफाइल, पासबुक, कलेक्सन र रिपोर्ट हेर्न थिच्नुहोस्">
      <div class="flex gap-2" style="align-items:center">
        ${avatarHtml}
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
            <div class="fw-bold" style="font-size:1.08rem;line-height:1.2">${member.name}</div>
            <span style="font-size:0.72rem;color:#0d6efd;font-weight:600;white-space:nowrap">प्रोफाइल ▸</span>
          </div>
          <div class="text-muted" style="font-size:0.78rem;margin-top:2px">📱 ${member.mobile || '-'} · PIN: ${(member.hasPin || member.pin) ? '****' : 'सेट छैन'}</div>
          <div class="mt-1">
            <span class="member-badge badge-kitta">${member.kitta} कित्ता</span>
            <span class="member-badge badge-kitta">💎 शेयर ${Accounting.formatNum(myAssets)}</span>
          </div>
          <div class="mt-1">
            ${effLoan > 0 ? `<span class="member-badge badge-loan">ऋण ${Accounting.formatNum(effLoan)}</span> ` : ''}
            ${effAdv > 0 ? `<span class="member-badge badge-advance">अग्रिम ${Accounting.formatNum(effAdv)}</span> ` : ''}
            ${member.due > 0 ? `<span class="member-badge badge-due">बाँकी ${Accounting.formatNum(member.due)}</span>` : ''}
          </div>
          ${mandHtml}
        </div>
      </div>
    </div>

    <button class="btn btn-success btn-lg btn-block" onclick="openGroupChatFromHome()">💬 छलफल चौतारी${chatBadge}</button>
  `;
}

function openMemberOwnProfileModal(options = {}) {
  const data = DB.load();
  const memberId = Auth.currentUser && Auth.currentUser.memberId;
  const member = (data.members || []).find(m => m.id === memberId);
  if (!member) return UI.toast('सदस्य भेटिएन', 'error');

  const snap = Accounting.getSnapshot(data);
  const myAssets = Accounting.memberAssets(data, member);
  const month = Accounting.getCurrentMonth(data);
  const effLoan = Accounting.getEffectiveMemberLoan(data, member, month);
  const effAdv = Accounting.getEffectiveMemberAdvance(data, member, month);
  const csUnread = memberCollectionSummaryUnreadCount(member.id, data);
  const csBadge = csUnread > 0 ? ` <span class="badge-unread">${csUnread}</span>` : '';
  const pinLabel = member.mustChangePin
    ? '⏳ Temp PIN (फेर्न बाँकी)'
    : ((member.hasPin || member.pin) ? '✅ सेट छ' : '❌ सेट छैन');
  const photoLocked = !!(member.photo && member.photoLocked !== false);

  const avatarHtml = member.photo
    ? `<img src="${member.photo}" alt="" class="member-passport-photo" style="width:72px;height:90px"/>`
    : `<div class="member-avatar" style="width:72px;height:90px;border-radius:10px;font-size:1.7rem">${member.name.charAt(0)}</div>`;

  const idCard = member.idCardPhoto
    ? `<div style="margin-top:8px"><div class="text-muted" style="font-size:0.78rem">🪪 परिचय पत्र</div><img src="${member.idCardPhoto}" style="max-width:100%;max-height:130px;border-radius:8px;margin-top:4px"/></div>`
    : '';

  const photoActionHtml = photoLocked
    ? `<div style="font-size:0.76rem;color:#6c757d;background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:6px 10px;text-align:center;margin-top:8px">🔒 पासपोर्ट फोटो सेट भइसक्यो (फेर्नुपरे Admin बाट रिसेट गर्नुहोस्)</div>`
    : `<button type="button" class="btn btn-light btn-sm btn-block mt-2" onclick="openPassportPhotoUpload('${member.id}')">📷 पासपोर्ट फोटो राख्नुहोस् (मान्छेको अनुहार मात्र)</button>`;

  const myComplaints = (data.complaints || []).filter(c => c.memberId === member.id && !c.auto);
  let complaintHtml = '';
  if (myComplaints.length) {
    complaintHtml = myComplaints.slice().reverse().map(c => {
      let replies = (c.replies || []).map(r =>
        `<div style="margin:6px 0 0 12px;padding:6px 10px;background:#f0f7ff;border-radius:8px;font-size:0.84rem">
          <strong>${r.from === 'admin' ? 'Admin' : 'तपाईं'}:</strong> ${r.text}
        </div>`).join('');
      return `<div class="section-card" style="padding:10px;margin-bottom:8px">
        <div class="text-muted" style="font-size:0.74rem">${new Date(c.time).toLocaleString()}</div>
        <div style="font-size:0.88rem">${c.text}</div>${replies}
      </div>`;
    }).join('');
  }

  const html = `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
      ${avatarHtml}
      <div style="flex:1;min-width:0">
        <div class="fw-bold" style="font-size:1.12rem">${member.name}</div>
        <div class="text-muted" style="font-size:0.8rem">📱 ${member.mobile || '-'}</div>
        ${member.address ? `<div class="text-muted" style="font-size:0.78rem">🏠 ${member.address}</div>` : ''}
        <div style="margin-top:4px"><span class="member-badge badge-kitta">${member.kitta} कित्ता</span> <span class="member-badge badge-kitta">💎 ${Accounting.formatNum(myAssets)}</span></div>
      </div>
    </div>
    ${photoActionHtml}

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:12px 0">
      <button type="button" class="btn btn-purple btn-sm" style="padding:9px 4px;font-size:0.82rem" onclick="showPassbook('${member.id}')">📖 पासबुक</button>
      <button type="button" class="btn btn-info btn-sm" style="padding:9px 4px;font-size:0.82rem" onclick="showMemberOwnCollectionSummary()">📋 कलेक्सन${csBadge}</button>
      <button type="button" class="btn btn-primary btn-sm" style="padding:9px 4px;font-size:0.82rem" onclick="openMemberReports()">📊 रिपोर्ट</button>
    </div>

    <div class="report-card">
      <div class="report-row"><span class="label">📱 मोबाइल</span><span class="value">${member.mobile || '-'}</span></div>
      <div class="report-row"><span class="label">🏠 ठेगाना</span><span class="value">${member.address || '-'}</span></div>
      <div class="report-row"><span class="label">📝 परिचय / नोट</span><span class="value" style="font-size:0.84rem">${member.bio || '-'}</span></div>
      <div class="report-row"><span class="label">🎫 जम्मा कित्ता</span><span class="value fw-bold">${member.kitta}</span></div>
      <div class="report-row highlight"><span class="label">💎 शेयर सम्पत्ति</span><span class="value fw-bold">${Accounting.formatNum(myAssets)}</span></div>
      <div class="report-row"><span class="label">💰 प्रति कित्ता मूल्य</span><span class="value">${Accounting.formatNum(snap.perKitta)}</span></div>
      <div class="report-row"><span class="label">🤝 हाल बाँकी ऋण</span><span class="value">${Accounting.formatNum(effLoan)}</span></div>
      <div class="report-row"><span class="label">💚 हाल अग्रिम</span><span class="value">${Accounting.formatNum(effAdv)}</span></div>
      <div class="report-row"><span class="label">📉 तिर्न बाँकी</span><span class="value">${Accounting.formatNum(member.due || 0)}</span></div>
      <div class="report-row"><span class="label">🔢 PIN अवस्था</span><span class="value">${pinLabel}</span></div>
      <div class="report-row" style="cursor:pointer" onclick="showMemberMandatoryBreakdown()"><span class="label">🧾 अनिवार्य हिसाब</span><span class="value" style="color:#0d6efd">विवरण ▾</span></div>
      ${idCard}
    </div>

    ${complaintHtml ? '<div class="section-title mt-2">📢 मेरा गुनासो / जवाफ</div>' + complaintHtml : ''}
  `;

  UI.showModal(
    '👤 मेरो प्रोफाइल',
    html,
    '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>',
    options.replace ? { replace: true } : { root: true }
  );
}

function memberFeedbackUnread(memberId, data) {
  try {
    const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
    const fbReadAt = rs.fbReadAt || '';
    const list = (data.complaints || []).filter(c => c.memberId === memberId && !c.auto);
    let n = 0;
    list.forEach(function (c) {
      (c.replies || []).forEach(function (r) {
        if (r.from === 'admin' && !r.readByMember && (!fbReadAt || (r.time && r.time > fbReadAt))) n++;
      });
    });
    return n;
  } catch (e) { return 0; }
}

function appOwnerCardHtml(data) {
  const o = (data.settings && data.settings.appOwner) || {};
  const photo = o.photo || './owner-photo.jpg';
  if (!o.name && !o.mobile && !o.email && !o.website) {
    return '<div class="ao-card ao-empty">visiting card · not set</div>';
  }
  function esc(s) { return String(s || '').replace(/</g, ''); }
  function row(label, val, href) {
    if (!val) return '';
    const t = esc(val);
    const inner = href
      ? ('<a href="' + href + '" target="_blank" rel="noopener">' + t + '</a>')
      : t;
    return '<div class="ao-row"><span class="ao-k">' + label + '</span><span class="ao-v">' + inner + '</span></div>';
  }
  const web = o.website || '';
  const webHref = web ? (web.indexOf('http') === 0 ? web : 'https://' + web) : '';
  const fb = o.facebook || '';
  const fbHref = fb ? (fb.indexOf('http') === 0 ? fb : 'https://facebook.com/' + fb.replace(/^@/, '')) : '';
  const wa = o.whatsapp || '';
  const waHref = wa ? 'https://wa.me/' + String(wa).replace(/\D/g, '') : '';
  return (
    '<div class="ao-card">' +
      '<div class="ao-accent"></div>' +
      '<div class="ao-inner">' +
        '<div class="ao-top">' +
          '<img class="ao-photo" src="' + photo + '" alt="" width="64" height="64" onerror="this.style.display=\'none\'"/>' +
          '<div class="ao-id">' +
            '<div class="ao-label">App Owner</div>' +
            '<div class="ao-name">' + esc(o.name || '—') + '</div>' +
            (o.title ? '<div class="ao-title">' + esc(o.title) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ao-body">' +
          row('Mobile', o.mobile, o.mobile ? 'tel:' + o.mobile : '') +
          row('Email', o.email, o.email ? 'mailto:' + o.email : '') +
          row('Web', web, webHref) +
          row('Facebook', fb, fbHref) +
          row('WhatsApp', wa, waHref) +
          row('Address', o.address, '') +
          (o.note ? '<div class="ao-note">' + esc(o.note) + '</div>' : '') +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function openMemberFeedbackHub() {
  const data = DB.load();
  const memberId = Auth.currentUser && Auth.currentUser.memberId;
  if (!memberId) return;
  const list = (data.complaints || []).filter(c => c.memberId === memberId).slice().reverse();
  // mark admin replies as read persistently (D1 + localStorage)
  list.forEach(function (c) {
    (c.replies || []).forEach(function (r) {
      if (r.from === 'admin') r.readByMember = true;
    });
  });
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (typeof DB.saveUserReadState === 'function') {
    DB.saveUserReadState({ fbReadAt: new Date().toISOString() });
  }
  try { renderSettingsTab(); } catch (e) {}

  let rows = '';
  if (!list.length) {
    rows = '<div class="empty-state" style="padding:16px">अहिलेसम्म गुनासो/सुझाव छैन</div>';
  } else {
    list.forEach(function (c) {
      const time = c.time ? new Date(c.time).toLocaleString('ne-NP') : '';
      const kind = c.auto ? '✅ स्वतः' : (c.kind === 'suggestion' ? '💡 सुझाव' : '📢 गुनासो');
      let replies = '';
      (c.replies || []).forEach(function (r) {
        const who = r.from === 'admin' ? 'Admin' : 'तपाईं';
        replies += '<div style="margin-top:6px;padding:8px;background:#f0f7ff;border-radius:8px;font-size:0.82rem">' +
          '<strong>' + who + '</strong>: ' + (r.text || '') +
          (r.time ? '<div class="text-muted" style="font-size:0.72rem">' + new Date(r.time).toLocaleString('ne-NP') + '</div>' : '') +
          '</div>';
      });
      rows += '<div class="section-card" style="margin-bottom:8px;padding:10px">' +
        '<div class="text-muted" style="font-size:0.72rem">' + kind + ' · ' + time + '</div>' +
        '<div style="font-size:0.9rem;margin-top:4px">' + (c.text || '') + '</div>' +
        replies + '</div>';
    });
  }

  const html =
    '<div class="form-group"><label>नयाँ सुझाव / गुनासो</label>' +
    '<textarea id="fb-text" rows="3" placeholder="लेख्नुहोस्..."></textarea></div>' +
    '<div style="display:flex;gap:8px;margin-bottom:12px">' +
    '<button type="button" class="btn btn-primary btn-block" onclick="submitMemberFeedback(\'suggestion\')">💡 सुझाव पठाउनुहोस्</button>' +
    '<button type="button" class="btn btn-warning btn-block" onclick="submitMemberFeedback(\'complaint\')">📢 गुनासो पठाउनुहोस्</button>' +
    '</div>' +
    '<div class="section-title">इतिहास / जवाफ</div>' + rows;

  UI.showModal('📢 सुझाव तथा गुनासो', html, '<button class="btn btn-outline" onclick="closeModal();renderHomeByRole()">बन्द</button>');
}

async function submitMemberFeedback(kind) {
  const text = (document.getElementById('fb-text') && document.getElementById('fb-text').value || '').trim();
  if (!text) return UI.toast('केही लेख्नुहोस्', 'error');
  const data = DB.load();
  const memberId = Auth.currentUser.memberId;
  const item = {
    id: 'c_' + Date.now(),
    memberId: memberId,
    text: text,
    kind: kind || 'complaint',
    time: new Date().toISOString(),
    read: false,
    replies: [],
    auto: false
  };
  data.complaints = data.complaints || [];
  data.complaints.push(item);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({ id: item.id, kind: item.kind, text: item.text });
  }
  UI.toast(kind === 'suggestion' ? 'सुझाव पठाइयो' : 'गुनासो पठाइयो', 'success');
  openMemberFeedbackHub();
}


function memberCollectionSummaryUnreadCount(memberId, data) {
  try {
    const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
    let read = Array.isArray(rs.csReadMonths) ? rs.csReadMonths : [];
    if (!read.length) {
      try { read = JSON.parse(localStorage.getItem('gs_cs_read_' + memberId) || '[]'); } catch (e) { read = []; }
    }
    const closed = (data.months || []).filter(m => m.status === 'closed');
    let n = 0;
    closed.forEach(function (m) {
      if ((m.collections || {})[memberId] && read.indexOf(m.id) < 0) n++;
    });
    return n;
  } catch (e) { return 0; }
}

function markGroupChatRead(msgs) {
  try {
    const arr = Array.isArray(msgs) ? msgs : [];
    const last = arr.length ? arr[arr.length - 1] : null;
    const nowIso = new Date().toISOString();
    const readAt = (last && last.time && last.time > nowIso) ? last.time : nowIso;
    if (typeof DB.saveUserReadState === 'function') {
      DB.saveUserReadState({
        chatReadAt: readAt,
        chatReadId: last && last.id ? String(last.id) : ''
      });
    }
    if (last && last.id) {
      localStorage.setItem('gs_group_chat_read_id', String(last.id));
    }
  } catch (e) {}
}

function groupChatUnreadCount(data) {
  try {
    data = _ensureChat(data || DB.load());
    const msgs = data.chat.group || [];
    if (!msgs.length) return 0;
    const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
    const me = (typeof _chatSender === 'function') ? _chatSender() : {};
    const lastId = rs.chatReadId || localStorage.getItem('gs_group_chat_read_id') || '';
    const readAt = rs.chatReadAt || '';
    if (!lastId && !readAt) {
      const others = msgs.filter(m => !(m.fromId === me.id && m.fromRole === me.role));
      return Math.min(others.length, 9);
    }
    let idx = -1;
    if (lastId) {
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].id === lastId) { idx = i; break; }
      }
    }
    let count = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      if (m.fromId === me.id && m.fromRole === me.role) continue;
      if (idx >= 0) {
        if (i > idx && (!readAt || !m.time || m.time > readAt)) count++;
      } else if (readAt) {
        if (m.time && m.time > readAt) count++;
      }
    }
    return Math.min(count, 99);
  } catch (e) { return 0; }
}

function showMemberOwnCollectionSummary() {
  const data = DB.load();
  const memberId = Auth.currentUser && Auth.currentUser.memberId;
  const member = data.members.find(m => m.id === memberId);
  if (!member) return UI.toast('सदस्य भेटिएन', 'error');
  const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
  const legacyKey = 'gs_cs_read_' + memberId;
  let legacyRead = [];
  try { legacyRead = JSON.parse(localStorage.getItem(legacyKey) || '[]'); } catch (e) { legacyRead = []; }
  const read = Array.from(new Set([...(Array.isArray(rs.csReadMonths) ? rs.csReadMonths : []), ...legacyRead]));
  const newlyRead = [];
  const months = (data.months || []).filter(m => m.status === 'closed' || (m.collections && m.collections[memberId]));
  // नयाँ महिना माथि
  months.sort(function (a, b) {
    if ((a.yearBS || 0) !== (b.yearBS || 0)) return (b.yearBS || 0) - (a.yearBS || 0);
    if ((a.monthIndex || 0) !== (b.monthIndex || 0)) return (b.monthIndex || 0) - (a.monthIndex || 0);
    return (Date.parse(b.closedAt || 0) || 0) - (Date.parse(a.closedAt || 0) || 0);
  });
  let html = '<p class="text-muted" style="font-size:0.82rem">बिल सूची · थिचेर खोल्नुहोस्</p>';
  if (!months.length) {
    html += '<div class="empty-state">अहिलेसम्म कलेक्सन छैन</div>';
  } else {
    months.forEach(function (mo) {
      const c = (mo.collections || {})[memberId];
      var billId = (mo.memberBills && mo.memberBills[memberId]) || null;
      if (!billId && data.bills) {
        Object.keys(data.bills).forEach(function (bid) {
          var b = data.bills[bid];
          if (b && b.memberId === memberId && b.monthId === mo.id) billId = bid;
        });
      }
      const isNew = (c || billId) && read.indexOf(mo.id) < 0;
      const badge = isNew ? ' <span class="badge-unread">नयाँ</span>' : '';
      html += '<div class="section-card" style="margin-bottom:8px;padding:10px' + (isNew ? ';border:1px solid #0d6efd' : '') + '">';
      html += '<div class="fw-bold" style="font-size:0.95rem">' + (mo.name || '') + badge + '</div>';
      if (billId) {
        var bill = data.bills && data.bills[billId];
        var billLabel = billId;
        if (bill && bill.totalPaid != null) billLabel = billId + ' · रु. ' + Accounting.formatNum(bill.totalPaid);
        html += '<button type="button" class="btn btn-primary btn-block mt-1" style="font-size:0.85rem;text-align:left" onclick="viewBill(\'' + billId + '\')">🧾 ' + billLabel + '</button>';
      } else if (c) {
        html += '<div class="text-muted" style="font-size:0.82rem;margin-top:4px">जम्मा तिरेको रु. ' + Accounting.formatNum(c.totalPaid||0) + ' · बिल तयार हुँदा यहाँ खुल्छ</div>';
      } else {
        html += '<div class="text-muted" style="font-size:0.82rem">कलेक्सन/बिल छैन</div>';
      }
      html += '</div>';
      if ((c || billId) && read.indexOf(mo.id) < 0) {
        read.push(mo.id);
        newlyRead.push(mo.id);
      }
    });
    if (newlyRead.length && typeof DB.saveUserReadState === 'function') {
      DB.saveUserReadState({ csReadMonths: read });
    }
    try { localStorage.setItem(legacyKey, JSON.stringify(read)); } catch (e) {}
  }
  if (Auth.isMember && Auth.isMember()) {
    _askComplaintOnClose = { memberId: memberId, source: 'कलेक्सन सारांश' };
  }
  UI.showModal('📋 मेरो कलेक्सन सारांश', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function openGroupChatFromHome(options = {}) {
  window._chatMode = 'group';
  const data = _ensureChat(DB.load());
  const msgs = data.chat.group || [];
  markGroupChatRead(msgs);
  const me = _chatSender();
  const canDelete = Auth.isAccountsWriter && Auth.isAccountsWriter();
  let bubbles = '';
  if (!msgs.length) {
    bubbles = '<div class="text-muted text-center" style="padding:16px">अहिलेसम्म सन्देश छैन</div>';
  } else {
    bubbles = msgs.map(function (m) {
      const mine = m.fromId === me.id && m.fromRole === me.role;
      const sys = m.fromRole === 'system' || m.type === 'auto_group';
      const time = m.time ? new Date(m.time).toLocaleString('ne-NP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const delBtn = canDelete && m.id
        ? '<button type="button" onclick="event.stopPropagation();deleteGroupChatMessage(\'' + escapeHtmlChat(m.id) + '\', true)" style="border:none;background:none;color:#dc3545;cursor:pointer;font-size:0.75rem;margin-left:6px;padding:0" title="मेटाउनुहोस्">🗑️</button>'
        : '';
      return '<div class="chat-row ' + (sys ? 'sys' : (mine ? 'mine' : 'theirs')) + '">' +
        '<div class="chat-bubble' + (sys ? ' chat-sys' : '') + '">' +
        (!mine && !sys ? '<div class="chat-from">' + escapeHtmlChat(m.fromName || '') + '</div>' : '') +
        (sys ? '<div class="chat-from">📢 समूह सूचना</div>' : '') +
        '<div class="chat-text">' + escapeHtmlChat(m.text || '').replace(/\n/g, '<br>') + '</div>' +
        '<div class="chat-time">' + time + delBtn + '</div></div></div>';
    }).join('');
  }
  const canSend = true;
  const html = '<div id="group-chat-box" style="max-height:50vh;overflow-y:auto;padding:8px">' + bubbles + '</div>' +
    (canSend ? '<div class="flex gap-1 mt-2"><input type="text" id="home-chat-input" placeholder="सन्देश..." style="flex:1" onkeydown="if(event.key===\'Enter\')sendGroupChatFromHome()">' +
      '<button class="btn btn-primary" onclick="sendGroupChatFromHome()">पठाउनुहोस्</button></div>' : '');
  UI.showModal('💬 छलफल चौतारी', html, '<button class="btn btn-outline" onclick="closeModal();renderHomeByRole()">बन्द</button>', options.replace ? { replace: true } : {});
  setTimeout(function () {
    const box = document.getElementById('group-chat-box');
    if (box) box.scrollTop = box.scrollHeight;
  }, 80);
}

function sendGroupChatFromHome() {
  const input = document.getElementById('home-chat-input');
  const text = (input && input.value || '').trim();
  if (!text) return UI.toast('सन्देश लेख्नुहोस्', 'error');
  let data = DB.load();
  postGroupMessage(text, 'text', data);
  DB.save(data);
  if (typeof DB.pushChatNow === 'function') {
    try { DB.pushChatNow(); } catch (e) {}
  }
  openGroupChatFromHome({ replace: true });
}


function openMemberReports() {
  const html = `
    <button class="btn btn-primary btn-block mb-1" onclick="showMonthlyReport()">📅 मासिक रिपोर्ट</button>
    <button class="btn btn-info btn-block mb-1" onclick="showYearlyReport()">📊 वार्षिक रिपोर्ट</button>
  `;
  UI.showModal('📊 रिपोर्ट', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function showMemberActivityPopup() {
  const data = DB.load();
  const memberId = Auth.currentUser && Auth.currentUser.memberId;
  if (!memberId) return;
  const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
  const lastSeen = rs.activityReadAt || '';
  const activities = [];

  if (lastSeen) {
    (data.months || []).forEach(mo => {
      const c = (mo.collections || {})[memberId];
      if (c && c.time && c.time > lastSeen) {
        activities.push(`${mo.name}: तिरेको ${Accounting.formatNum(c.totalPaid || 0)}`);
      }
      (mo.loansGiven || []).forEach(l => {
        if (l.memberId === memberId && l.time && l.time > lastSeen) {
          activities.push(`${mo.name}: ऋण लिएको ${Accounting.formatNum(l.amount)}`);
        }
      });
    });

    // Unread complaint replies newer than lastSeen
    (data.complaints || []).filter(c => c.memberId === memberId).forEach(c => {
      (c.replies || []).forEach(r => {
        if (r.from === 'admin' && !r.readByMember && r.time && r.time > lastSeen) {
          activities.push('Admin जवाफ: ' + r.text.substring(0, 40));
        }
      });
    });
  }

  // Persist current checkpoint to both localStorage & D1 so old activity never pops up again after logout/login
  if (typeof DB.saveUserReadState === 'function') {
    DB.saveUserReadState({ activityReadAt: new Date().toISOString() });
  }

  if (activities.length === 0) return;
  const html = '<div class="section-title">🔔 नयाँ गतिविधि</div>' +
    activities.slice(0, 10).map(a => `<div class="report-row"><span class="label">${a}</span></div>`).join('');
  UI.showModal('🔔 सूचना', html, '<button class="btn btn-primary" onclick="closeModal()">ठीक छ</button>');
}

// ========== LOGIN UI ==========
function backToLoginOptions() {
  const lo = document.getElementById('login-options');
  const ca = document.getElementById('create-account-form');
  if (lo) lo.classList.remove('hidden');
  if (ca) ca.classList.add('hidden');
}

function showCreateAccount() {
  if (DB._hasAdminOnServer) {
    UI.toast('Admin खाता पहिले नै छ · लगइन गर्नुहोस्', 'error');
    return;
  }
  const lo = document.getElementById('login-options');
  const ca = document.getElementById('create-account-form');
  if (lo) lo.classList.add('hidden');
  if (ca) ca.classList.remove('hidden');
}

function triggerInitialBackupImport() {
  const inp = document.getElementById('initial-import-file');
  if (inp) inp.click();
}

async function doInitialBackupImport(e) {
  const file = e && e.target && e.target.files && e.target.files[0];
  if (!file) return;
  e.target.value = '';
  try {
    UI.toast('पुरानो ब्याकअप Import हुँदैछ…', '');
    await DB.importJSON(file);
    await DB.checkServerHealth();
    showLoginScreen();
    UI.toast('ब्याकअप Import सफल ✅ अब पहिलेको username/password ले लगइन गर्नुहोस्', 'success');
  } catch (err) {
    UI.toast('Import असफल: ' + (err && err.message ? err.message : err), 'error');
  }
}

async function createAccount() {
  const name = document.getElementById('ca-name').value.trim();
  const username = document.getElementById('ca-username').value.trim();
  const password = document.getElementById('ca-password').value;
  const password2 = document.getElementById('ca-password2').value;
  const mobile = document.getElementById('ca-mobile').value.trim();
  const pin = document.getElementById('ca-pin').value;
  const pin2 = document.getElementById('ca-pin2').value;

  if (password !== password2) return UI.toast('Password मिल्दैन', 'error');
  if (pin !== pin2) return UI.toast('PIN मिल्दैन', 'error');

  const res = await Auth.createAccount(name, username, password, mobile, pin);
  if (res.ok) {
    UI.toast(res.msg, 'success');
    await DB.checkServerHealth();
    const loginRes = await Auth.unifiedLogin(username, password);
    if (loginRes.ok) {
      Auth.setLocked(false);
      Auth.touchActivity();
      playWelcomeThenMain();
    } else {
      showLoginScreen();
    }
  } else {
    UI.toast(res.msg, 'error');
  }
}

async function unifiedLogin() {
  const id = (document.getElementById('login-id') && document.getElementById('login-id').value || '').trim();
  const secret = (document.getElementById('login-secret') && document.getElementById('login-secret').value || '');
  const btn = document.getElementById('login-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ जाँच हुँदैछ…'; }
  try {
    const res = await Auth.unifiedLogin(id, secret);
    if (res.ok) {
      Auth.setLocked(false);
      Auth.touchActivity();
      playWelcomeThenMain();
    } else {
      UI.toast(res.msg, 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔓 लगइन'; }
  }
}

// ========== TABS ==========
function switchTab(tab) {
  if (Auth.isMember && Auth.isMember() && (tab === 'profile' || tab === 'chat')) {
    tab = 'home';
  }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById('tab-' + tab);
  if (pane) pane.classList.add('active');

  if (tab === 'chat') renderChatTab();
  if (tab === 'profile') renderProfileTab();
  if (tab === 'settings') renderSettingsTab();
  if (tab === 'vidhan') renderVidhanTab();
  if (tab === 'home') {
    APP_DATA = DB.load();
    UI.updateHome(APP_DATA);
    UI.updateHeader(APP_DATA);
    renderHomeByRole();
  }
}

/** सदस्य लगइनमा च्याट र प्रोफाइल ट्याब लुकाउने (होमको कार्डमै प्रोफाइल र छलफल चौतारी छ) */
function updateNavForRole() {
  const profileBtn = document.querySelector('.nav-btn[data-tab="profile"]');
  const chatBtn = document.querySelector('.nav-btn[data-tab="chat"]');
  if (Auth.isMember && Auth.isMember()) {
    if (profileBtn) profileBtn.style.display = 'none';
    if (chatBtn) chatBtn.style.display = 'none';
  } else {
    if (profileBtn) profileBtn.style.display = '';
    if (chatBtn) chatBtn.style.display = '';
  }
}

// ========== HOME ACTIONS ==========
function showAssetsDetail() {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  const prev = Accounting.getPreviousMonth(data);
  let html = '<div class="report-card">';
  if (month) {
    Accounting.recalcMonth(month, data);
    html += `
      <div class="report-row"><span class="label">📅 महिना</span><span class="value">${month.name}</span></div>
      <div class="report-row"><span class="label">💎 सम्पत्ति (८)</span><span class="value">${Accounting.formatNum(month.finalAssets)}</span></div>
      <div class="report-row"><span class="label">🤝 लगानी (११)</span><span class="value">${Accounting.formatNum(month.outstandingLoans)}</span></div>
      <div class="report-row highlight"><span class="label">💵 नगद (१२)</span><span class="value">${Accounting.formatNum(month.cashInHand)}</span></div>
      <div class="report-row"><span class="label">सुरु मौज्दात</span><span class="value">${Accounting.formatNum(month.startAssets)}</span></div>
      <div class="report-row"><span class="label">खुद आम्दानी</span><span class="value">${Accounting.formatNum(month.netIncome)}</span></div>
    `;
  } else if (prev) {
    html += `
      <div class="report-row"><span class="label">अन्तिम बन्द महिना</span><span class="value">${prev.name}</span></div>
      <div class="report-row"><span class="label">💎 सम्पत्ति</span><span class="value">${Accounting.formatNum(prev.finalAssets)}</span></div>
      <div class="report-row"><span class="label">🤝 लगानी</span><span class="value">${Accounting.formatNum(prev.outstandingLoans)}</span></div>
      <div class="report-row highlight"><span class="label">💵 नगद</span><span class="value">${Accounting.formatNum(prev.cashInHand)}</span></div>
    `;
  } else {
    html += '<div class="empty-state">अहिलेसम्म कुनै महिना सुरु भएको छैन</div>';
  }
  html += '</div>';
  UI.showModal('💎 सम्पत्ति विवरण', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function showMembersSummary() {
  const data = DB.load();
  const active = data.members.filter(m => m.active);
  const html = `
    <div class="report-card mb-2">
      <div class="report-row"><span class="label">👥 जम्मा सदस्य</span><span class="value">${Accounting.totalMembers(data)}</span></div>
      <div class="report-row"><span class="label">🎫 जम्मा कित्ता</span><span class="value">${Accounting.totalKitta(data)}</span></div>
      <div class="report-row highlight"><span class="label">💰 प्रति कित्ता मूल्य</span><span class="value">${Accounting.formatNum(
        (() => {
          const m = Accounting.getCurrentMonth(data) || Accounting.getPreviousMonth(data);
          if (!m) {
            if (data.migrationDone) {
              const loans = Object.values(data.migration.loans||{}).reduce((s,v)=>s+v,0);
              const assets = (data.migration.cash||0) + loans;
              const k = Accounting.totalKitta(data);
              return k > 0 ? Math.round(assets / k) : 0;
            }
            return 0;
          }
          return Accounting.perKittaValue(data, m);
        })()
      )}</span></div>
    </div>
    <div class="section-title">सदस्य सूची</div>
    ${UI.renderMemberList(active, 'viewMemberFromHome')}
  `;
  UI.showModal('👥 सदस्य सारांश', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function viewMemberFromHome(id) {
  closeModal();
  switchTab('profile');
  setTimeout(() => openMemberDetail(id), 200);
}

// ========== COLLECTION ==========
function openCollection() {
  if (!Auth.isAdmin()) return UI.toast('Admin मात्र कलेक्सन गर्न सक्नुहुन्छ', 'error');
  const data = DB.load();
  let month = Accounting.getCurrentMonth(data);
  let html = '';

  if (!month) {
    html = `
      <div class="empty-state">
        <div class="icon">📅</div>
        <p>कुनै महिना खुल्ला छैन</p>
        <button class="btn btn-primary btn-block mt-2" onclick="startNewMonth()">▶️ नयाँ महिना सुरु गर्नुहोस्</button>
      </div>
    `;
  } else {
    Accounting.recalcMonth(month, data);
    const collected = Object.keys(month.collections || {}).length;
    const total = data.members.filter(m => m.active).length;

    html = `
      <div class="collection-header">
        <div class="stat-pill"><div class="num">${month.name}</div><div class="lbl">महिना</div></div>
        <div class="stat-pill"><div class="num">${collected}/${total}</div><div class="lbl">कलेक्सन</div></div>
        <div class="stat-pill"><div class="num">${month.status === 'open' ? '🟢 खुल्ला' : month.status === 'collection_closed' ? '🟡 बन्द' : '🔴 सकियो'}</div><div class="lbl">स्थिति</div></div>
      </div>
      <div class="report-card mb-2">
        <div class="report-row"><span class="label">सुरु मौज्दात</span><span class="value fw-bold">${Accounting.formatNum(month.startAssets)}</span></div>
        <div class="report-row"><span class="label">अन्तिम मौज्दात</span><span class="value">${Accounting.formatNum(month.finalAssets)}</span></div>
      </div>
    `;

    if (month.status === 'open') {
      html += `
        <button class="btn btn-success btn-block mb-1" onclick="showCollectMember()">📥 कलेक्सन गर्नुहोस्</button>
        <button class="btn btn-danger btn-block mb-1" onclick="showExpenseForm()">💸 खर्च लेख्नुहोस्</button>
        <button class="btn btn-primary btn-block mb-1" onclick="showOtherIncomeForm()">💰 अन्य आम्दानी</button>
        <button class="btn btn-warning btn-block mb-1" onclick="doCloseCollection()">🔒 कलेक्सन बन्द गर्नुहोस्</button>
      `;
    } else if (month.status === 'collection_closed') {
      html += `<div class="text-center text-muted mb-2">कलेक्सन बन्द भयो। अब क्रम:
        <br>१. कित्ता/सदस्य परिवर्तन (प्रोफाइल)
        <br>२. ऋण लगानी
        <br>३. महिना बन्द</div>
        <button class="btn btn-danger btn-block mb-1" onclick="showExpenseForm()">💸 खर्च लेख्नुहोस्</button>
        <button class="btn btn-primary btn-block mb-1" onclick="showOtherIncomeForm()">💰 अन्य आम्दानी</button>
        <button class="btn btn-orange btn-block mb-1" onclick="closeModal(); openLoans();">🤝 ऋण लगानीमा जानुहोस्</button>
        <button class="btn btn-danger btn-block mb-1" onclick="doCloseMonth()">🔒 महिना बन्द गर्नुहोस्</button>`;
    }
    html += `<button class="btn btn-outline btn-block mt-1" onclick="openCashTallyModal()">💵 नगद गन्ने / मिलान (Cash Tally)</button>`;
  }

  UI.showModal('📥 मासिक कलेक्सन', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>', { root: true });
}

function openCashTallyModal() {
  const data = DB.load();
  const snap = Accounting.getSnapshot(data);
  const denoms = [1000, 500, 100, 50, 20, 10, 5, 1];
  const rows = denoms.map(d => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="flex:0 0 85px;font-weight:600">रु. ${d} ×</div>
      <input type="number" min="0" inputmode="numeric" class="tally-inp" data-denom="${d}" value="0" oninput="recalcCashTally(${snap.cash})" style="flex:1;padding:6px 10px;border:1px solid #ced4da;border-radius:8px">
      <div id="tally-sub-${d}" style="flex:0 0 80px;text-align:right;font-size:0.85rem">0</div>
    </div>
  `).join('');
  const html = `
    <div class="report-card mb-2">
      <div class="report-row highlight"><span class="label">💻 सिस्टम अनुसार कोसमा नगद</span><span class="value fw-bold">रु. ${Accounting.formatNum(snap.cash)}</span></div>
    </div>
    ${rows}
    <div class="report-card mt-2" id="tally-result-box">
      <div class="report-row"><span class="label">✋ गनिएको कुल नगद</span><span class="value fw-bold" id="tally-total">रु. 0</span></div>
      <div class="report-row"><span class="label">फरक (गनिएको − सिस्टम)</span><span class="value fw-bold" id="tally-diff">${-Math.round(snap.cash)}</span></div>
    </div>
  `;
  UI.showModal('💵 नगद गन्ने / मिलान', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
  recalcCashTally(snap.cash);
}

function recalcCashTally(expectedCash) {
  let total = 0;
  document.querySelectorAll('.tally-inp').forEach(inp => {
    const d = Number(inp.getAttribute('data-denom')) || 0;
    const q = Math.max(0, Number(inp.value) || 0);
    const sub = d * q;
    total += sub;
    const subEl = document.getElementById('tally-sub-' + d);
    if (subEl) subEl.textContent = Accounting.formatNum(sub);
  });
  const totEl = document.getElementById('tally-total');
  const diffEl = document.getElementById('tally-diff');
  const diff = Math.round(total - (Number(expectedCash) || 0));
  if (totEl) totEl.textContent = 'रु. ' + Accounting.formatNum(total);
  if (diffEl) {
    diffEl.textContent = diff === 0 ? '✅ ठ्याक्कै मिल्यो (0)' : (diff > 0 ? `+${diff} (बढी)` : `${diff} (कम)`);
    diffEl.style.color = diff === 0 ? '#198754' : '#dc3545';
  }
}

function confirmReopenMonth() {
  UI.toast('बन्द महिना खोल्ने सुविधा हटाइएको छ (दोहोरो entry रोक्न)', 'error');
}

function doReopenMonth() {
  UI.toast('बन्द महिना खोल्ने सुविधा हटाइएको छ', 'error');
}

function fixStartAssets() {
  UI.showPinModal('सबै महिना: सुरु = अघिल्लो अन्तिम · एउटै नियम (PIN)', () => {
    const data = DB.load();
    Accounting.rebuildMonthChain(data);
    DB.save(data);
    UI.updateHome(data);
    const cur = Accounting.getCurrentMonth(data);
    const msg = cur
      ? (cur.name + ' सुरु मौज्दात: ' + Accounting.formatNum(cur.startAssets))
      : 'सबै महिनाको शृंखला मिल्यो';
    UI.toast(msg, 'success');
    openCollection();
  });
}

function startNewMonth() {
  const data = DB.load();
  if (data.currentMonthId) {
    return UI.toast('पहिले हालको महिना बन्द गर्नुहोस्', 'error');
  }
  UI.showPinModal('⚠️ नयाँ महिना सुरु गर्न PIN चाहिन्छ', () => {
    _doStartNewMonth();
  });
}

function _doStartNewMonth() {
  const data = DB.load();
  let monthIndex = 0;
  let yearBS = 2082;
  const closed = Accounting.getClosedMonthsSorted(data);
  if (closed.length > 0) {
    const last = closed[closed.length - 1];
    // Ensure last month finalAssets is correct before chaining
    Accounting.recalcMonth(last, data);
    monthIndex = (last.monthIndex + 1) % 12;
    yearBS = last.yearBS;
    if (monthIndex === 0) yearBS++;
  } else {
    const now = new Date();
    yearBS = now.getFullYear() + 57;
    monthIndex = 0;
  }

  const month = Accounting.createMonth(data, monthIndex, yearBS);
  data.months.push(month);
  data.currentMonthId = month.id;

  if (closed.length === 0 && data.migrationDone) {
    Accounting.applyMigration(data);
  }

  // Ensure chain: this month start = previous final
  Accounting.rebuildMonthChain(data);

  notifyMonthStarted(data, month);
  DB.save(data, {
    pushNotice: {
      title: '📢 ' + (month.name || 'नयाँ महिना') + ' बचत सुरु भयो',
      body: 'समूहको बचत बैठक सुरु भएको छ — कृपया समयमै सहभागी हुनुहोला।'
    }
  });
  UI.updateHome(data);
  UI.toast(month.name + ' सुरु · मौज्दात ' + Accounting.formatNum(month.startAssets), 'success');
  closeModal();
  UI.updateHeader(data);
  openCollection();
}

function renderCollectStatusList(members, month) {
  const data = DB.load();
  return members.map(m => {
    const c = month.collections[m.id];
    const man = Accounting.calcMandatory(m, data, month);
    let status;
    if (c) {
      status = `<span style="color:#198754;font-weight:700">✅ ${Accounting.formatNum(c.totalPaid)}</span>`;
    } else if (man.total === 0 && man.advanceCover > 0) {
      status = `<span style="color:#0d6efd">अग्रिमले पुग्छ</span>`;
    } else {
      status = `<span style="color:#dc3545">💵 ${Accounting.formatNum(man.total)}</span>`;
    }
    return `<div class="member-item" onclick="selectCollectMember('${m.id}')">
      <div class="member-avatar">${m.name.charAt(0)}</div>
      <div class="member-info"><div class="member-name">${m.name}</div>
      <div class="member-meta">${m.kitta} कित्ता${man.previousDue > 0 ? ' · बाँकी ' + Accounting.formatNum(man.previousDue) : ''}${man.advance > 0 ? ' · अग्रिम ' + Accounting.formatNum(man.advance) : ''}</div></div>
      <div style="text-align:right;font-size:0.85rem">${status}</div>
    </div>`;
  }).join('');
}

function showCollectMember(preselectId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'open') {
    return UI.toast('कलेक्सन खुल्ला छैन', 'error');
  }

  const active = data.members.filter(m => m.active);
  let opts = '<option value="">— सदस्य छान्नुहोस् —</option>';
  let legend = `<div style="font-size:0.75rem;margin-bottom:8px;display:flex;gap:10px;flex-wrap:wrap">
    <span style="color:#0d6efd;font-weight:700">● बचत भइसकेको</span>
    <span style="color:#e6a800;font-weight:700">● अग्रिमले पुग्छ</span>
    <span style="color:#dc3545;font-weight:700">● बाँकी / तिर्नुपर्ने</span>
  </div>`;
  active.forEach(m => {
    const c = month.collections[m.id];
    const man = Accounting.calcMandatory(m, data, month);
    let color, tag;
    if (c) {
      color = '#0d6efd';
      tag = ' ✅ ' + Accounting.formatNum(c.totalPaid);
    } else if (man.total === 0 && man.advanceCover > 0) {
      color = '#e6a800';
      tag = ' ⚡ अग्रिमले पुग्छ';
    } else {
      color = '#dc3545';
      tag = ' · तिर्नुपर्ने ' + Accounting.formatNum(man.total);
    }
    opts += `<option value="${m.id}" style="color:${color};font-weight:600">${m.name} (${m.kitta} कित्ता)${tag}</option>`;
  });

  let html = `
    <button class="btn btn-danger btn-block mb-1" onclick="showExpenseForm()">💸 खर्च लेख्नुहोस्</button>
    <button class="btn btn-primary btn-block mb-1" onclick="showOtherIncomeForm()">💰 अन्य आम्दानी</button>
    <hr style="margin:12px 0;border:none;border-top:1px solid #e0e0e0">
    ${legend}
    <div class="form-group">
      <label>👤 सदस्य खोज्नुहोस् / छान्नुहोस्</label>
      <input type="text" id="collect-search" placeholder="नाम टाइप गर्नुहोस्..." oninput="filterCollectDropdown()" style="margin-bottom:6px">
      <select id="collect-member-select" size="8" style="width:100%;font-size:0.95rem;padding:6px" onchange="onCollectMemberPick()">
        ${opts}
      </select>
    </div>
    <div id="collect-pick-hint" class="text-muted text-center" style="font-size:0.85rem">सदस्य छानेपछि कलेक्सन फारम खुल्छ</div>
  `;
  UI.showModal('📥 कलेक्सन गर्नुहोस्', html, '<button class="btn btn-outline" onclick="openCollection()">← फर्कनुहोस्</button>', { replace: true, back: 'openCollection' });

  if (preselectId) {
    setTimeout(() => {
      const sel = document.getElementById('collect-member-select');
      if (sel) { sel.value = preselectId; selectCollectMember(preselectId); }
    }, 100);
  }
}

function filterCollectDropdown() {
  const q = (document.getElementById('collect-search').value || '').trim().toLowerCase();
  const sel = document.getElementById('collect-member-select');
  if (!sel) return;
  Array.from(sel.options).forEach((opt, i) => {
    if (i === 0) { opt.hidden = false; return; }
    opt.hidden = q && !opt.text.toLowerCase().includes(q);
  });
}

function onCollectMemberPick() {
  const id = document.getElementById('collect-member-select').value;
  if (id) selectCollectMember(id);
}

function showExpenseForm() {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status === 'closed') return UI.toast('महिना बन्द भइसक्यो', 'error');

  const list = (month.expenseDetails || []).map(d =>
    `<div class="report-row"><span class="label">${d.note || d.type || 'खर्च'}</span><span class="value" style="color:#dc3545">− ${Accounting.formatNum(d.amount)}</span></div>`
  ).join('') || '<div class="text-muted text-center">अहिलेसम्म खर्च छैन</div>';

  const html = `
    <div class="section-title">💸 खर्च · ${month.name}</div>
    <div class="report-card mb-2">${list}</div>
    <div class="form-group"><label>रकम</label><input type="number" id="exp-amount" placeholder="खर्च रकम"></div>
    <div class="form-group"><label>कैफियत / कारण</label><input type="text" id="exp-note" placeholder="जस्तै: चिया, भाडा, स्टेशनरी"></div>
    <p class="text-muted" style="font-size:0.8rem">असर: नगद घट्छ · मौज्दात घट्छ · रिपोर्ट ६. खर्च बढ्छ</p>
    <button class="btn btn-danger btn-block" onclick="saveExpense()">✅ खर्च सेभ (PIN)</button>
  `;
  UI.showModal('💸 खर्च', html, '<button class="btn btn-outline" onclick="showCollectMember()">← फर्कनुहोस्</button>', { replace: true, back: 'showCollectMember' });
}

function saveExpense() {
  const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
  const note = (document.getElementById('exp-note').value || '').trim();
  if (amount <= 0) return UI.toast('रकम लेख्नुहोस्', 'error');
  if (!note) return UI.toast('कैफियत लेख्नुहोस्', 'error');

  UI.showPinModal('खर्च रु. ' + Accounting.formatNum(amount) + ' सेभ गर्न PIN', () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    if (!month || month.status === 'closed') return UI.toast('महिना बन्द', 'error');
    month.expenseDetails = month.expenseDetails || [];
    month.expenseDetails.push({
      type: 'general',
      amount,
      note,
      time: new Date().toISOString()
    });
    Accounting.recalcMonth(month, data);
    DB.save(data);
    UI.updateHome(data);
    UI.toast('खर्च सेभ · मौज्दात/नगद घट्यो', 'success');
    showExpenseForm();
  });
}

function showOtherIncomeForm() {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status === 'closed') return UI.toast('महिना बन्द भइसक्यो', 'error');

  const list = (month.otherIncomeDetails || []).map(d =>
    `<div class="report-row"><span class="label">${d.note || d.type || 'अन्य'}</span><span class="value" style="color:#198754">+ ${Accounting.formatNum(d.amount)}</span></div>`
  ).join('') || '<div class="text-muted text-center">अहिलेसम्म अन्य आम्दानी छैन</div>';

  const html = `
    <div class="section-title">💰 अन्य आम्दानी · ${month.name}</div>
    <div class="report-card mb-2">${list}</div>
    <div class="form-group"><label>रकम</label><input type="number" id="oi-amount" placeholder="आम्दानी रकम"></div>
    <div class="form-group"><label>कैफियत / स्रोत</label><input type="text" id="oi-note" placeholder="जस्तै: दान, अतिरिक्त..."></div>
    <p class="text-muted" style="font-size:0.8rem">असर: नगद बढ्छ · मौज्दात बढ्छ · रिपोर्ट ४. अन्य आम्दानी बढ्छ</p>
    <button class="btn btn-primary btn-block" onclick="saveOtherIncome()">✅ आम्दानी सेभ (PIN)</button>
  `;
  UI.showModal('💰 अन्य आम्दानी', html, '<button class="btn btn-outline" onclick="showCollectMember()">← फर्कनुहोस्</button>', { replace: true, back: 'showCollectMember' });
}

function saveOtherIncome() {
  const amount = parseFloat(document.getElementById('oi-amount').value) || 0;
  const note = (document.getElementById('oi-note').value || '').trim();
  if (amount <= 0) return UI.toast('रकम लेख्नुहोस्', 'error');
  if (!note) return UI.toast('कैफियत लेख्नुहोस्', 'error');

  UI.showPinModal('अन्य आम्दानी रु. ' + Accounting.formatNum(amount) + ' सेभ गर्न PIN', () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    if (!month || month.status === 'closed') return UI.toast('महिना बन्द', 'error');
    month.otherIncomeDetails = month.otherIncomeDetails || [];
    month.otherIncomeDetails.push({
      type: 'general',
      amount,
      note,
      time: new Date().toISOString()
    });
    Accounting.recalcMonth(month, data);
    DB.save(data);
    UI.updateHome(data);
    UI.toast('आम्दानी सेभ · मौज्दात/नगद बढ्यो', 'success');
    showOtherIncomeForm();
  });
}

function filterCollectList() {
  const q = (document.getElementById('collect-search').value || '').trim().toLowerCase();
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  const filtered = data.members.filter(m => m.active && m.name.toLowerCase().includes(q));
  document.getElementById('collect-member-list').innerHTML = renderCollectStatusList(filtered, month);
}

function selectCollectMember(memberId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  const member = data.members.find(m => m.id === memberId);
  if (!member) return;

  const mandatory = Accounting.calcMandatory(member, data, month);
  const already = month.collections[memberId];

  let html = `
    <div class="section-title">${member.name} · ${member.kitta} कित्ता</div>
    <div class="pay-summary">
      <div class="pay-row"><span>💾 बचत</span><span class="amount">${Accounting.formatNum(mandatory.saving)}</span></div>
      <div class="pay-row"><span>📈 ब्याज</span><span class="amount">${Accounting.formatNum(mandatory.interest)}</span></div>
      <div class="pay-row"><span>⚠️ जरिवाना</span><span class="amount">${Accounting.formatNum(mandatory.fine)}</span></div>
      <div class="pay-row"><span>📉 अघिल्लो बाँकी</span><span class="amount" style="color:${mandatory.previousDue > 0 ? '#dc3545' : ''}">${Accounting.formatNum(mandatory.previousDue)}</span></div>
      <div class="pay-row"><span>जम्मा (अग्रिम अघि)</span><span class="amount">${Accounting.formatNum(mandatory.totalGross)}</span></div>
      <div class="pay-row"><span>💚 अग्रिम कट्टा</span><span class="amount" style="color:#0d6efd">− ${Accounting.formatNum(mandatory.advanceCover)}</span></div>
      <div class="pay-row total"><span>💵 नगद तिर्नुपर्ने</span><span class="amount" style="color:#0d6efd">${Accounting.formatNum(mandatory.total)}</span></div>
      <div class="pay-row"><span>🤝 बाँकी ऋण</span><span class="amount" style="color:${(member.outstandingLoan||0) > 0 ? '#dc3545' : ''}">${Accounting.formatNum(member.outstandingLoan || 0)}</span></div>
      <div class="pay-row"><span>💚 बाँकी अग्रिम</span><span class="amount" style="color:#0d6efd">${Accounting.formatNum(member.advance || 0)}</span></div>
    </div>
  `;

  if (already) {
    html += `<div class="text-success mb-2">✅ पहिले नै नगद रु. ${Accounting.formatNum(already.totalPaid)} उठाइसकिएको
      ${(already.fromAdvance || 0) > 0 ? ' · अग्रिमबाट ' + Accounting.formatNum(already.fromAdvance) : ''}</div>`;
    html += `<button class="btn btn-danger btn-block mb-1" onclick="removeCollection('${memberId}')">🗑️ कलेक्सन हटाउनुहोस्</button>`;
  }

  const defaultAmt = already ? already.totalPaid : mandatory.total;
  html += `
    <div class="form-group">
      <label>💵 यो पटक तिरेको नगद रकम</label>
      <input type="number" id="pay-amount" placeholder="नगद रकम" value="${defaultAmt}">
      <div class="text-muted" style="font-size:0.8rem;margin-top:4px">अग्रिम स्वतः कट्टा हुन्छ · 0 लेखे कलेक्सन रद्द</div>
    </div>
    <button class="btn btn-success btn-block" onclick="saveCollection('${memberId}')">✅ बचत गर्नुहोस्</button>
  `;

  UI.showModal('📥 कलेक्सन - ' + member.name, html, '<button class="btn btn-outline" onclick="showCollectMember()">← फर्कनुहोस्</button>', { replace: true, back: 'showCollectMember' });
}

function saveCollection(memberId) {
  const amount = parseFloat(document.getElementById('pay-amount').value) || 0;
  if (amount < 0) return UI.toast('रकम गलत', 'error');

  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'open') return UI.toast('कलेक्सन बन्द भइसक्यो', 'error');

  if (amount === 0) {
    delete month.collections[memberId];
    Accounting.recalcMonth(month, data);
    DB.save(data);
    UI.updateHome(data);
    UI.toast('कलेक्सन रद्द भयो', 'success');
    showCollectMember();
    return;
  }

  const member = data.members.find(m => m.id === memberId);
  const mandatory = Accounting.calcMandatory(member, data, month);
  const hasLoan = (member.outstandingLoan || 0) > 0;

  const allocMandatory = {
    saving: mandatory.saving,
    interest: mandatory.interest,
    fine: mandatory.fine,
    previousDue: mandatory.previousDue,
    total: mandatory.totalGross
  };
  // अग्रिम पहिले कट्टा, बाँकी नगदले
  const allocated = Accounting.allocatePayment(
    member, amount, allocMandatory, hasLoan, mandatory.advanceCover
  );
  if (mandatory.advanceCover > 0) allocated.coveredByAdvance = true;
  month.collections[memberId] = { ...allocated, time: new Date().toISOString() };

  Accounting.recalcMonth(month, data);
  notifyCollectionPrivate(data, member, month.collections[memberId], month);
  DB.save(data);
  UI.updateHome(data); // entry सँगै होम अपडेट
  UI.toast('कलेक्सन सेभ भयो', 'success');
  showCollectMember();
}

function removeCollection(memberId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'open') return UI.toast('कलेक्सन बन्द भइसक्यो', 'error');
  delete month.collections[memberId];
  Accounting.recalcMonth(month, data);
  DB.save(data);
  UI.updateHome(data);
  UI.toast('कलेक्सन हटाइयो', 'success');
  showCollectMember();
}

function doCloseCollection() {
  UI.showPinModal('⚠️ कलेक्सन बन्द गर्न PIN चाहिन्छ। नतिरेका सदस्यको रकम बाँकीमा जान्छ र पछि edit हुँदैन!', () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    Accounting.closeCollection(data, month);
    DB.save(data);
    UI.toast('कलेक्सन बन्द भयो', 'success');
    UI.updateHeader(data);
    openCollection();
  });
}

// ========== LOANS ==========
function openLoans() {
  if (!Auth.isAdmin()) return UI.toast('Admin मात्र ऋण व्यवस्थापन गर्न सक्नुहुन्छ', 'error');
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);

  let html = '';

  // New loan at top
  if (month && month.status === 'collection_closed') {
    html += `<button class="btn btn-orange btn-block mb-2" onclick="showGiveLoan()">➕ नयाँ ऋण लगानी गर्नुहोस्</button>`;
  } else if (month && month.status === 'open') {
    html += `<div class="text-muted text-center mb-2">कलेक्सन बन्द भएपछि मात्र ऋण दिन सकिन्छ</div>`;
  } else if (month && month.status === 'closed') {
    html += `<div class="text-muted text-center mb-2">यो महिना बन्द भइसक्यो</div>`;
  } else {
    html += `<div class="text-muted text-center mb-2">पहिले महिना सुरु र कलेक्सन बन्द गर्नुहोस्</div>`;
  }

  // Outstanding list
  html += '<div class="section-title">📋 उठ्न बाँकी ऋण सूची</div>';
  const withLoan = data.members.filter(m => m.active && (m.outstandingLoan || 0) > 0);
  if (withLoan.length === 0) {
    html += '<div class="empty-state"><div class="icon">✅</div>कुनै बाँकी ऋण छैन</div>';
  } else {
    let total = 0;
    html += withLoan.map(m => {
      total += m.outstandingLoan;
      return `<div class="member-item">
        <div class="member-avatar">${m.name.charAt(0)}</div>
        <div class="member-info">
          <div class="member-name">${m.name}</div>
          <div class="member-meta">${m.kitta} कित्ता</div>
        </div>
        <div class="fw-bold text-danger">${Accounting.formatNum(m.outstandingLoan)}</div>
      </div>`;
    }).join('');
    html += `<div class="report-row highlight mt-2"><span class="label">जम्मा उठ्न बाँकी</span><span class="value">${Accounting.formatNum(total)}</span></div>`;
  }

  // This month's loans
  if (month && month.loansGiven && month.loansGiven.length) {
    html += '<div class="section-title mt-2">यस महिना दिइएका ऋण</div>';
    month.loansGiven.forEach(l => {
      const m = data.members.find(x => x.id === l.memberId);
      const noteLine = l.note ? `<div class="member-meta">📝 ${l.note}</div>` : '';
      html += `<div class="member-item">
        <div class="member-info"><div class="member-name">${m ? m.name : l.memberId}</div>
        <div class="member-meta">${new Date(l.time).toLocaleString('ne-NP')}</div>${noteLine}</div>
        <div class="fw-bold">${Accounting.formatNum(l.amount)}</div>
      </div>`;
    });
  }

  // Close month button
  if (month && month.status === 'collection_closed') {
    html += `<button class="btn btn-danger btn-block mt-2" onclick="doCloseMonth()">🔒 महिना बन्द गर्नुहोस्</button>`;
  }

  UI.showModal('🤝 ऋण तथा लगानी', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>', { root: true });
}

function showGiveLoan() {
  const data = DB.load();
  const active = data.members.filter(m => m.active);
  const html = `
    <div class="search-box">
      <input type="text" id="loan-search" placeholder="नाम खोज्नुहोस्..." oninput="filterLoanList()">
    </div>
    <div id="loan-member-list">
      ${UI.renderMemberList(active, 'selectLoanMember')}
    </div>
  `;
  UI.showModal('🤝 ऋण दिने सदस्य', html, '<button class="btn btn-outline" onclick="openLoans()">← फर्कनुहोस्</button>', { replace: true, back: 'openLoans' });
}

function filterLoanList() {
  const q = (document.getElementById('loan-search').value || '').trim().toLowerCase();
  const data = DB.load();
  const filtered = data.members.filter(m => m.active && m.name.toLowerCase().includes(q));
  document.getElementById('loan-member-list').innerHTML = UI.renderMemberList(filtered, 'selectLoanMember');
}

function selectLoanMember(memberId) {
  const data = DB.load();
  const member = data.members.find(m => m.id === memberId);
  const html = `
    <div class="section-title">${member.name}</div>
    <div class="form-group">
      <label>💵 ऋण रकम</label>
      <input type="number" id="loan-amount" placeholder="रकम">
    </div>
    <div class="form-group">
      <label>📝 उद्देश्य / म्याद / साक्षी (वैकल्पिक)</label>
      <input type="text" id="loan-note" placeholder="जस्तै: पसल/खेती · ६ महिना · साक्षी ...">
    </div>
    <div class="form-group">
      <label>✍️ सदस्यको सहि (अनिवार्य)</label>
      <div class="sig-pad-wrap">
        <canvas id="sig-canvas" width="320" height="160"></canvas>
      </div>
      <div class="sig-actions">
        <button class="btn btn-light btn-sm" onclick="clearSignature()">🗑️ मेट्नुहोस्</button>
      </div>
    </div>
    <button class="btn btn-orange btn-block" onclick="saveLoan('${memberId}')">✅ ऋण लगानी गर्नुहोस्</button>
  `;
  UI.showModal('🤝 ऋण - ' + member.name, html, '<button class="btn btn-outline" onclick="showGiveLoan()">← फर्कनुहोस्</button>', { replace: true, back: 'showGiveLoan' });
  initSignaturePad();
}

let sigPad = null;
function initSignaturePad() {
  const canvas = document.getElementById('sig-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  let drawing = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function start(e) { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function move(e) { e.preventDefault(); if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
  canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  sigPad = { canvas, ctx, hasDrawn: false };
  canvas.addEventListener('mousedown', () => { if (sigPad) sigPad.hasDrawn = true; });
  canvas.addEventListener('touchstart', () => { if (sigPad) sigPad.hasDrawn = true; });
}

function scanSignatureToPad(input) {
  const file = input.files && input.files[0];
  if (!file || !sigPad || !sigPad.canvas) return;
  const img = new Image();
  img.onload = function () {
    const c = sigPad.canvas;
    const ctx = sigPad.ctx;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    // fit contain
    const sc = Math.min(c.width / img.width, c.height / img.height);
    const w = img.width * sc, h = img.height * sc;
    ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    sigPad.hasDrawn = true;
    UI.toast('सहि स्क्यान भयो', 'success');
  };
  img.src = URL.createObjectURL(file);
}
function clearSignature() {
  if (!sigPad) return;
  sigPad.ctx.clearRect(0, 0, sigPad.canvas.width, sigPad.canvas.height);
  sigPad.hasDrawn = false;
}


/** सहि: ठूलो भए पनि रिजोलुसन घटाएर हल्का JPEG — काट्दैन, प्रिन्टमा देखिन्छ */
function compressSignatureFromPad(sigPad) {
  try {
    if (!sigPad || !sigPad.canvas) return '';
    return compressSignatureCanvas(sigPad.canvas, 160, 0.45);
  } catch (e) {
    try { return sigPad.canvas.toDataURL('image/jpeg', 0.35); } catch (e2) { return ''; }
  }
}

function compressSignatureCanvas(src, maxW, quality) {
  maxW = maxW || 160;
  quality = quality != null ? quality : 0.45;
  const scale = Math.min(1, maxW / (src.width || maxW));
  const w = Math.max(48, Math.round((src.width || 160) * scale));
  const h = Math.max(24, Math.round((src.height || 70) * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  let out = c.toDataURL('image/jpeg', quality);
  // अझ ठूलो भए फेरि कम्प्रेस
  if (out.length > 12000) {
    out = c.toDataURL('image/jpeg', 0.28);
  }
  return out;
}

/** भएको dataURL सहि पनि हल्का पार्ने (पुरानो ठूलो PNG) */
function lightenSignatureDataUrl(sig) {
  if (!sig || String(sig).indexOf('data:image') !== 0) return sig || '';
  if (String(sig).length <= 10000) return sig;
  try {
    return new Promise(function () {}); // sync path below
  } catch (e) {}
  return sig;
}

function lightenSignatureSync(sig) {
  if (!sig) return '';
  if (String(sig).indexOf('data:image') !== 0) return sig;
  if (String(sig).length <= 10000) return sig;
  try {
    const img = new Image();
    // sync compress via canvas only works if already loaded — try Image with src
    // For strip path we use DB side length check; here for display/print keep as is if mid-size
  } catch (e) {}
  return sig;
}


function renderTinySignature(sig, forPrint) {
  if (!sig) return '<span class="text-muted" style="font-size:0.75rem">—</span>';
  const s = String(sig);
  if (s.indexOf('data:image') === 0 || s.indexOf('/api/media/') === 0 || s.indexOf('http') === 0) {
    const h = forPrint ? '36px' : '22px';
    const w = forPrint ? '110px' : '72px';
    return '<img src="' + s + '" alt="सहि" style="height:' + h + ';max-width:' + w + ';object-fit:contain;border:1px solid #ccc;border-radius:4px;background:#fff;vertical-align:middle"/>';
  }
  if (sig === 'signed' || sig === '✓') {
    return '<span style="font-size:0.78rem;color:#198754">✓ सहि भएको</span>';
  }
  return '<span class="text-muted" style="font-size:0.75rem">—</span>';
}

function saveLoan(memberId) {
  const amount = parseFloat(document.getElementById('loan-amount').value) || 0;
  if (amount <= 0) return UI.toast('रकम लेख्नुहोस्', 'error');
  if (!sigPad || !sigPad.hasDrawn) return UI.toast('सहि अनिवार्य छ', 'error');

  const note = (document.getElementById('loan-note') && document.getElementById('loan-note').value || '').trim();
  const signature = compressSignatureFromPad(sigPad);
  UI.showPinModal('⚠️ ऋण लगानी गर्न PIN चाहिन्छ। रकम: ' + amount, () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    const member = data.members.find(m => m.id === memberId);
    Accounting.recalcMonth(month, data);
    if (amount > month.cashInHand) {
      return UI.toast('नगद पर्याप्त छैन (उपलब्ध: ' + Accounting.formatNum(month.cashInHand) + ')', 'error');
    }
    const entry = { memberId, amount, signature, time: new Date().toISOString() };
    if (note) entry.note = note;
    month.loansGiven.push(entry);
    member.outstandingLoan = (member.outstandingLoan || 0) + amount;
    Accounting.recalcMonth(month, data);
    notifyLoanPrivate(data, member, amount);
    DB.save(data);
    UI.toast('ऋण लगानी भयो', 'success');
    openLoans();
  });
}

function doCloseMonth() {
  UI.showPinModal('⚠️ महिना बन्द गरेपछि यो महिनाको हिसाब सच्याउन मिल्दैन!', () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    Accounting.closeMonth(data, month);
    try { issueMonthCloseReceipts(data, month); } catch (e) { console.warn(e); }
    notifyMonthClosed(data, month);
    DB.save(data, {
      closedMonthId: month.id,
      pushNotice: {
        title: '🧾 ' + (month.name || 'महिना') + ' बन्द भयो',
        body: 'हिसाब बन्द भई डिजिटल रसिद र पासबुक अपडेट भएको छ।'
      }
    });
    UI.toast(month.name + ' बन्द भयो · बिल पठाइयो', 'success');
    UI.updateHeader(data);
    UI.updateHome(data);
    closeModal();
    setTimeout(function () {
      try {
        if (typeof doExportBackup === 'function') {
          doExportBackup();
          UI.toast('📦 ब्याकअप फाइल डाउनलोड — सुरक्षित सेभ गर्नुहोस्', 'success');
        }
      } catch (e) { console.warn(e); }
    }, 600);
  });
}

// ========== REPORTS ==========
function openReports() {
  const html = `
    <button class="btn btn-primary btn-block mb-1" onclick="showMonthlyReport()">📅 मासिक रिपोर्ट</button>
    <button class="btn btn-success btn-block mb-1" onclick="showCollectionSummary()">📋 कलेक्सन सारांश</button>
    <button class="btn btn-info btn-block mb-1" onclick="showYearlyReport()">📊 वार्षिक रिपोर्ट</button>
  `;
  UI.showModal('📊 हिसाब तथा रिपोर्ट', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>', { root: true });
}

function showMonthlyReport() {
  const data = DB.load();
  const months = data.months.filter(m => m.status === 'closed' || m.id === data.currentMonthId);
  if (months.length === 0) {
    return UI.toast('कुनै रिपोर्ट उपलब्ध छैन', 'error');
  }

  let html = '<div class="form-group"><label>महिना छान्नुहोस्</label><select id="report-month" onchange="renderSelectedMonthly()">';
  months.slice().reverse().forEach(m => {
    html += `<option value="${m.id}">${m.name} (${m.status})</option>`;
  });
  html += '</select></div><div id="monthly-report-body"></div>';
  html += '<button class="btn btn-primary btn-block mt-2" onclick="printReportImage(\'monthly-report-body\')">🖨️ इमेज प्रिन्ट</button>';

  // Member: ask complaint when closing after viewing
  if (Auth.isMember()) {
    _askComplaintOnClose = { memberId: Auth.currentUser.memberId, source: 'मासिक रिपोर्ट' };
    UI.showModal('📅 मासिक रिपोर्ट', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
  } else {
    _askComplaintOnClose = null;
    UI.showModal('📅 मासिक रिपोर्ट', html, '<button class="btn btn-outline" onclick="openReports()">← फर्कनुहोस्</button>', { replace: true, back: 'openReports' });
  }
  renderSelectedMonthly();
}

function fmtDateOnly(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-GB');
}
function fmtTimeOnly(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function renderSelectedMonthly() {
  const id = document.getElementById('report-month').value;
  const data = DB.load();
  if (data.migrationDone) Accounting.syncOpenMonthFromMigration(data);
  const month = data.months.find(m => m.id === id);
  if (!month) return;
  Accounting.recalcMonth(month, data);
  const perKitta = Accounting.perKittaValue(data, month);

  const advCash = month.advanceFromCash || 0;
  const otherBase = month.otherIncome || 0;
  const otherTotal = otherBase + advCash;
  const totalIncome = (month.savingsCollected || 0) + (month.interestCollected || 0) + otherTotal;
  const netIncome = totalIncome - (month.expenses || 0);

  // detailKey: which rows open detail view
  const rows = [
    { label: '१. सुरु मौज्दात', val: month.startAssets },
    { label: '२. प्राप्त बचत', val: month.savingsCollected, detail: 'saving' },
    { label: '३. प्राप्त ब्याज', val: month.interestCollected, detail: 'interest' },
    { label: '४. अन्य आम्दानी', val: otherTotal, detail: 'other' },
    { label: '५. जम्मा आम्दानी', val: totalIncome },
    { label: '६. खर्च', val: month.expenses, detail: 'expense' },
    { label: '७. खुद आम्दानी', val: netIncome, hl: true },
    { label: '८. अन्तिम मौज्दात', val: month.finalAssets },
    { label: '९. उठेको सावा', val: month.principalCollected, detail: 'principal' },
    { label: '१०. गरिएको लगानी', val: month.newLoansGiven, detail: 'loans' },
    { label: '११. उठ्न बाँकी लगानी', val: month.outstandingLoans, red: true },
    { label: '१२. कोसमा नगद', val: month.cashInHand },
    { label: '१३. सदस्य अग्रिम दायित्व (हटाएर)', val: month.totalAdvances || 0 },
    { label: '१४. सदस्य शेयर कोस (खुद)', val: month.netShareAssets != null ? month.netShareAssets : month.finalAssets },
    { label: '१५. जम्मा सदस्य', val: month.totalMembers },
    { label: '१६. जम्मा कित्ता', val: month.totalKitta },
    { label: 'प्रति कित्ता मूल्य', val: perKitta, hl: true }
  ];

  let html = `<div class="print-area" id="print-monthly"><h2>${data.group.name}</h2>
    <div class="print-meta">${month.name} · मासिक रिपोर्ट</div>
    <div class="print-meta" style="font-size:0.8rem">${fmtDateOnly(month.collectionClosedAt || month.closedAt)}</div>
    <div class="print-meta" style="font-size:0.78rem;color:#666">
      कलेक्सन बन्द: ${fmtTimeOnly(month.collectionClosedAt)} &nbsp;·&nbsp; महिना बन्द: ${fmtTimeOnly(month.closedAt)}
    </div>`;
  rows.forEach(r => {
    const hl = r.hl ? ' highlight' : '';
    const valStyle = r.red ? 'color:#dc3545' : '';
    if (r.detail) {
      html += `<div class="report-row${hl}" style="cursor:pointer;background:#f8fafc" onclick="showReportDetail('${month.id}','${r.detail}')">
        <span class="label">${r.label} <span style="color:#0d6efd;font-size:0.75rem">▸ विवरण</span></span>
        <span class="value fw-bold" style="${valStyle}">${Accounting.formatNum(r.val)}</span>
      </div>`;
    } else {
      html += `<div class="report-row${hl}"><span class="label">${r.label}</span><span class="value fw-bold" style="${valStyle}">${Accounting.formatNum(r.val)}</span></div>`;
    }
  });
  html += '</div>';
  document.getElementById('monthly-report-body').innerHTML = html;
}

function showReportDetail(monthId, type) {
  const data = DB.load();
  const month = data.months.find(m => m.id === monthId);
  if (!month) return;
  const nameOf = (id) => (data.members.find(x => x.id === id) || {}).name || id;
  let title = '';
  let body = '<div class="table-wrap"><table><thead><tr><th>विवरण</th><th>रकम</th><th>कैफियत</th></tr></thead><tbody>';
  let total = 0;

  if (type === 'saving' || type === 'interest' || type === 'principal') {
    title = type === 'saving' ? 'प्राप्त बचत' : type === 'interest' ? 'प्राप्त ब्याज' : 'उठेको सावा';
    const key = type === 'saving' ? 'saving' : type === 'interest' ? 'interest' : 'principal';
    Object.keys(month.collections || {}).forEach(mid => {
      const c = month.collections[mid];
      const paid = c.totalPaid || 0;
      if (paid <= 0) return; // advance-only not counted
      const amt = c[key] || 0;
      if (amt <= 0) return;
      total += amt;
      body += `<tr><td>${nameOf(mid)}</td><td class="fw-bold">${Accounting.formatNum(amt)}</td><td></td></tr>`;
    });
  } else if (type === 'other') {
    title = 'अन्य आम्दानी';
    (month.otherIncomeDetails || []).forEach(d => {
      total += d.amount || 0;
      body += `<tr><td>${d.note || d.type || 'अन्य'}</td><td class="fw-bold">${Accounting.formatNum(d.amount)}</td><td>${d.type || ''}</td></tr>`;
    });
    if ((month.advanceFromCash || 0) > 0) {
      total += month.advanceFromCash;
      body += `<tr><td>अतिरिक्त नगद (अग्रिम)</td><td class="fw-bold">${Accounting.formatNum(month.advanceFromCash)}</td><td>नगद बढी</td></tr>`;
    }
  } else if (type === 'expense') {
    title = 'खर्च';
    (month.expenseDetails || []).forEach(d => {
      total += d.amount || 0;
      body += `<tr><td>${d.note || d.type || 'खर्च'}</td><td class="fw-bold">${Accounting.formatNum(d.amount)}</td><td>${d.type || ''}</td></tr>`;
    });
  } else if (type === 'loans') {
    title = 'गरिएको लगानी';
    (month.loansGiven || []).forEach(l => {
      total += l.amount || 0;
      const t = l.time ? fmtTimeOnly(l.time) : '';
      const info = [t, l.note || ''].filter(Boolean).join(' · ');
      body += `<tr><td>${nameOf(l.memberId)}</td><td class="fw-bold">${Accounting.formatNum(l.amount)}</td><td>${info}</td></tr>`;
    });
  }

  body += `<tr style="font-weight:700;background:#f0f7ff"><td>जम्मा</td><td>${Accounting.formatNum(total)}</td><td></td></tr>`;
  body += '</tbody></table></div>';
  if (total === 0) body = '<div class="empty-state">यस महिना कुनै रेकर्ड छैन</div>';

  UI.showModal('🔎 ' + title, body, '<button class="btn btn-outline" onclick="showMonthlyReport()">← फर्कनुहोस्</button>');
}

function showCollectionSummary() {
  const data = DB.load();
  const months = data.months.filter(m => m.status === 'closed' || m.id === data.currentMonthId);
  if (months.length === 0) return UI.toast('कुनै महिना छैन', 'error');

  let html = '<div class="form-group"><label>महिना छान्नुहोस्</label><select id="summary-month" onchange="renderCollectionSummary()">';
  months.slice().reverse().forEach(m => {
    html += `<option value="${m.id}">${m.name} (${m.status})</option>`;
  });
  html += '</select></div><div id="collection-summary-body"></div>';
  html += '<button class="btn btn-primary btn-block mt-2" onclick="printReportImage(\'print-summary\')">🖨️ इमेज प्रिन्ट</button>';

  UI.showModal('📋 कलेक्सन सारांश', html, '<button class="btn btn-outline" onclick="openReports()">← फर्कनुहोस्</button>');
  renderCollectionSummary();
}

function renderCollectionSummary() {
  const id = document.getElementById('summary-month').value;
  const data = DB.load();
  const month = data.months.find(m => m.id === id);
  if (!month) return;

  let html = `<div class="print-area" id="print-summary"><h2>${data.group.name}</h2>
    <div class="print-meta">${month.name} · कलेक्सन सारांश</div>
    <div class="print-meta" style="font-size:0.8rem">${fmtDateOnly(month.collectionClosedAt || month.closedAt)}</div>
    <div class="print-meta" style="font-size:0.78rem;color:#666">
      कलेक्सन बन्द: ${fmtTimeOnly(month.collectionClosedAt)} &nbsp;·&nbsp; महिना बन्द: ${fmtTimeOnly(month.closedAt)}
    </div>
    <div class="table-wrap"><table style="font-size:0.78rem">
      <thead><tr>
        <th>नाम / नगद</th><th>बचत</th><th>ब्याज</th><th>जरि.</th>
        <th>सावा</th><th>ऋण</th><th>बाँकी</th><th>अग्रिम</th><th style="font-size:0.65rem">बुझिलिने</th>
      </tr></thead><tbody>`;

  let tPaid = 0, tSav = 0, tInt = 0, tFine = 0, tPrin = 0, tTaken = 0, tLoan = 0, tAdv = 0;
  data.members.filter(m => m.active).forEach(m => {
    const c = month.collections[m.id] || {};
    const taken = (month.loansGiven || []).filter(l => l.memberId === m.id).reduce((s, l) => s + l.amount, 0);
    const snap = month.memberSnapshots[m.id] || {};
    const loanBal = snap.outstandingLoan !== undefined ? snap.outstandingLoan : (m.outstandingLoan || 0);
    const adv = snap.advance !== undefined ? snap.advance : (m.advance || 0);

    const fromAdv = (c.fromAdvance || 0) > 0 || c.coveredByAdvance;
    const noCash = (c.totalPaid || 0) <= 0;
    let sav = c.saving || 0, int_ = c.interest || 0, fine = c.fine || 0, prin = c.principal || 0;
    let note = '';
    if (fromAdv && noCash) {
      sav = 0; int_ = 0; fine = 0; prin = 0;
      note = 'अग्रिमबाट';
    } else if (fromAdv && !noCash) {
      note = '+अग्रिम';
    } else if (noCash && !fromAdv) {
      note = 'नतिरेको';
    }

    const paid = c.totalPaid || 0;
    tPaid += paid; tSav += sav; tInt += int_; tFine += fine; tPrin += prin;
    tTaken += taken; tLoan += loanBal; tAdv += adv;

    const loanStyle = loanBal > 0 ? 'color:#dc3545;font-weight:700' : '';
    const advStyle = adv > 0 ? 'color:#0d6efd;font-weight:700' : '';
    const cashStr = paid > 0
      ? `<span style="color:#0d6efd;font-weight:700">${Accounting.formatNum(paid)}</span>`
      : (note ? `<span style="font-size:0.7rem;color:#888">${note}</span>` : '');

    html += `<tr>
      <td style="max-width:110px"><div style="font-weight:600">${m.name}</div><div>${cashStr}</div></td>
      <td>${Accounting.formatNum(sav)}</td>
      <td>${Accounting.formatNum(int_)}</td>
      <td>${Accounting.formatNum(fine)}</td>
      <td>${Accounting.formatNum(prin)}</td>
      <td>${Accounting.formatNum(taken)}</td>
      <td style="${loanStyle}">${Accounting.formatNum(loanBal)}</td>
      <td style="${advStyle}">${Accounting.formatNum(adv)}</td>
      <td style="font-size:0.62rem;line-height:1.15;max-width:80px;word-break:break-all">
        ${c.receivedBy ? '<div>' + c.receivedBy + '</div>' : ''}
        ${(() => {
          const loans = (month.loansGiven || []).filter(l => l.memberId === m.id);
          if (!loans.length) return '';
          return loans.map(l => {
            const sig = renderTinySignature(l.signature);
            return '<div style="margin-top:2px">ऋण:' + (sig || (m.name.slice(0,6))) + '</div>';
          }).join('');
        })()}
        ${(() => {
          const bid = month.memberBills && month.memberBills[m.id];
          if (!bid) return '';
          return '<div style="margin-top:4px"><button type="button" class="btn btn-sm btn-outline" style="font-size:0.65rem;padding:2px 6px" onclick="viewBill(\'' + bid + '\')">🧾 बिल</button></div>';
        })()}
      </td>
    </tr>`;
  });
  html += `<tr style="font-weight:700;background:#f0f7ff">
    <td>जम्मा<br><span style="color:#0d6efd">${Accounting.formatNum(tPaid)}</span></td>
    <td>${Accounting.formatNum(tSav)}</td>
    <td>${Accounting.formatNum(tInt)}</td>
    <td>${Accounting.formatNum(tFine)}</td>
    <td>${Accounting.formatNum(tPrin)}</td>
    <td>${Accounting.formatNum(tTaken)}</td>
    <td style="color:#dc3545">${Accounting.formatNum(tLoan)}</td>
    <td style="color:#0d6efd">${Accounting.formatNum(tAdv)}</td>
    <td></td>
  </tr>`;
  html += '</tbody></table></div></div>';

  const el = document.getElementById('collection-summary-body');
  if (el) el.innerHTML = html;
}

function showYearlyReport() {
  const data = DB.load();
  const closed = data.months.filter(m => m.status === 'closed');
  if (closed.length === 0) return UI.toast('बन्द महिना छैन', 'error');

  let html = `<div class="print-area" id="print-yearly"><h2>${data.group.name}</h2>
    <div class="print-meta">वार्षिक सारांश</div>
    <div class="table-wrap"><table style="font-size:0.72rem">
      <thead><tr>
        <th>महिना</th>
        <th>सुरु मौज्दात</th>
        <th>आम्दानी</th>
        <th>खर्च</th>
        <th>अन्तिम मौज्दात</th>
        <th>उठ्न बाँकी ऋण</th>
        <th>कोसमा नगद</th>
      </tr></thead><tbody>`;
  closed.forEach(m => {
    const income = (Number(m.savingsCollected)||0) + (Number(m.interestCollected)||0) +
      (Number(m.otherIncome)||0) + (Number(m.advanceFromCash)||0);
    const exp = Number(m.expenses) || 0;
    html += `<tr>
      <td>${m.name}</td>
      <td>${Accounting.formatNum(m.startAssets)}</td>
      <td>${Accounting.formatNum(income)}</td>
      <td>${Accounting.formatNum(exp)}</td>
      <td>${Accounting.formatNum(m.finalAssets)}</td>
      <td style="color:#dc3545">${Accounting.formatNum(m.outstandingLoans)}</td>
      <td>${Accounting.formatNum(m.cashInHand)}</td>
    </tr>`;
  });
  html += '</tbody></table></div></div>';
  html += '<button class="btn btn-primary btn-block mt-2" onclick="printReportImage(\'print-yearly\')">🖨️ इमेज प्रिन्ट</button>';

  UI.showModal('📊 वार्षिक रिपोर्ट', html, '<button class="btn btn-outline" onclick="openReports()">← फर्कनुहोस्</button>');
}

function printReportImage(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return UI.toast('प्रिन्ट गर्न सकिएन', 'error');
  const baseHref = (typeof location !== 'undefined' && location.origin) ? (location.origin + '/') : './';
  const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><base href="${baseHref}"><title>रिपोर्ट</title>
    <style>
      body{font-family:sans-serif;padding:16px;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .report-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #ccc}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th,td{border:1px solid #ccc;padding:4px 5px;text-align:right;vertical-align:middle}
      th{background:#eee} td:first-child,th:first-child{text-align:left}
      h2{text-align:center} .print-meta{text-align:center;margin-bottom:12px;color:#555}
      img{max-width:110px;max-height:36px;object-fit:contain;background:#fff;vertical-align:middle}
      button{display:none!important}
    </style></head><body>${el.innerHTML}</body></html>`;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  iframe.srcdoc = htmlDoc;
  iframe.onload = function () {
    const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    const imgs = doc ? Array.from(doc.querySelectorAll('img')) : [];
    const waitImgs = imgs.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((res) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      });
    });
    const doPrint = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        UI.toast('प्रिन्ट डायलग खुलेन', 'error');
      }
      setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 3000);
    };
    Promise.race([
      Promise.all(waitImgs),
      new Promise((res) => setTimeout(res, 1500))
    ]).then(() => setTimeout(doPrint, 80));
  };
  document.body.appendChild(iframe);
}

// ========== PROFILE TAB ==========
function renderProfileTab() {
  const container = document.getElementById('profile-content');
  if (!container) return;
  if (!Auth.isLoggedIn()) {
    container.innerHTML = '<div class="empty-state">लगइन गर्नुहोस्</div>';
    return;
  }

  if (Auth.isMember()) {
    container.innerHTML = '';
    return;
  }
  renderAdminProfile(container);
}

function requestProfileChange() {
  const html = `
    <p class="text-muted mb-2">Admin लाई PIN वा मोबाइल परिवर्तनको अनुरोध पठाइन्छ।</p>
    <div class="form-group"><label>नयाँ मोबाइल (खाली राखे नबदलिने)</label><input type="tel" id="req-mobile" placeholder="98xxxxxxxx"></div>
    <div class="form-group"><label>नयाँ PIN अनुरोध?</label>
      <select id="req-pin"><option value="no">होइन</option><option value="yes">हो, नयाँ PIN चाहियो</option></select>
    </div>
    <button class="btn btn-primary btn-block" onclick="submitProfileRequest()">📤 अनुरोध पठाउनुहोस्</button>
  `;
  UI.showModal('🔢 परिवर्तन अनुरोध', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function submitProfileRequest() {
  const mobile = document.getElementById('req-mobile').value.trim();
  const wantPin = document.getElementById('req-pin').value === 'yes';
  const data = DB.load();
  const req = {
    id: 'pr_' + Date.now(),
    memberId: Auth.currentUser.memberId,
    memberName: Auth.currentUser.name,
    mobile: mobile || Auth.currentUser.mobile,
    newMobile: mobile || null,
    wantPin,
    time: new Date().toISOString(),
    status: 'pending'
  };
  data.pinRequests = data.pinRequests || [];
  data.pinRequests.push(req);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({
      id: req.id,
      kind: 'pin_request',
      mobile: req.mobile,
      newMobile: req.newMobile,
      wantPin: req.wantPin
    });
  }
  UI.toast('अनुरोध पठाइयो', 'success');
  closeModal();
}

function renderAdminProfile(container) {
  const data = DB.load();
  const showMigration = !data.migration.hideAfterFirst;
  const activeMembers = (data.members || []).filter(m => m.active);
  const loanCnt = activeMembers.filter(m => Accounting.getEffectiveMemberLoan(data, m) > 0).length;
  const dueCnt = activeMembers.filter(m => (Number(m.due) || 0) > 0).length;
  const noPinCnt = activeMembers.filter(m => !(m.hasPin || m.pin)).length;
  const fbCnt = activeMembers.filter(m => memberUnreadFeedbackCount(m.id, data) > 0).length;
  window._profileFilter = window._profileFilter || 'all';

  container.innerHTML = `
    <div class="section-card">
      <div class="section-title">👤 Admin प्रोफाइल</div>
      <div class="report-row"><span class="label">नाम</span><span class="value">${data.admin.name}</span></div>
      <div class="report-row"><span class="label">Username</span><span class="value">${data.admin.username}</span></div>
      <div class="report-row"><span class="label">मोबाइल</span><span class="value">${data.admin.mobile}</span></div>
      <button class="btn btn-light btn-sm mt-1" onclick="editAdminProfile()">✏️ परिवर्तन</button>
    </div>

    <div class="section-card">
      <div class="section-title">👥 सदस्य व्यवस्थापन (${activeMembers.length} जना)</div>
      <button class="btn btn-success btn-block mb-1" onclick="showNewMemberForm()">➕ नयाँ सदस्य प्रवेश</button>
      <div class="search-box">
        <input type="text" id="profile-member-search" placeholder="नाम वा मोबाइल खोज्नुहोस्..." oninput="filterProfileMembers()">
      </div>
      <div id="profile-filter-bar" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
        <button type="button" class="btn btn-sm ${window._profileFilter==='all'?'btn-primary':'btn-light'}" onclick="setProfileFilter('all')">सबै (${activeMembers.length})</button>
        <button type="button" class="btn btn-sm ${window._profileFilter==='loan'?'btn-primary':'btn-light'}" onclick="setProfileFilter('loan')">🤝 ऋण (${loanCnt})</button>
        <button type="button" class="btn btn-sm ${window._profileFilter==='due'?'btn-primary':'btn-light'}" onclick="setProfileFilter('due')">📉 बाँकी (${dueCnt})</button>
        <button type="button" class="btn btn-sm ${window._profileFilter==='nopin'?'btn-primary':'btn-light'}" onclick="setProfileFilter('nopin')">🔢 PIN छैन (${noPinCnt})</button>
        ${fbCnt > 0 ? `<button type="button" class="btn btn-sm ${window._profileFilter==='feedback'?'btn-primary':'btn-light'}" onclick="setProfileFilter('feedback')">📢 गुनासो (${fbCnt})</button>` : ''}
      </div>
      <div id="profile-member-list"></div>
    </div>

    ${showMigration ? `
    <div class="section-card" style="border:2px solid #fd7e14">
      <div class="section-title">📂 अगाडिको हिसाब प्रविष्टि</div>
      <p class="text-muted mb-1" style="font-size:0.85rem">पुरानो समूहको नगद, ऋण र अग्रिम यहाँ हाल्नुहोस्। पहिलो महिना बन्द भएपछि यो लुक्नेछ।</p>
      <button class="btn btn-orange btn-block" onclick="openMigration()">📥 अगाडिको हिसाब हाल्नुहोस्</button>
    </div>
    ` : ''}
  `;
  setTimeout(function () { filterProfileMembers(); }, 50);
}

function setProfileFilter(mode) {
  window._profileFilter = mode || 'all';
  const container = document.getElementById('profile-content');
  if (container && !Auth.isMember()) renderAdminProfile(container);
  else filterProfileMembers();
}

function memberUnreadFeedbackCount(memberId, data) {
  return (data.complaints || []).filter(function (c) {
    return c.memberId === memberId && !c.auto && !c.read;
  }).length;
}

function renderProfileMemberListHtml(members, data) {
  if (!members.length) return '<div class="text-muted text-center" style="padding:12px">भेटिएन</div>';
  return members.map(function (m) {
    const n = memberUnreadFeedbackCount(m.id, data);
    const effLoan = Accounting.getEffectiveMemberLoan(data, m);
    const hasPin = !!(m.hasPin || m.pin);
    const badge = n > 0 ? '<span class="badge-unread">' + n + ' नयाँ</span>' : '';
    const pinTag = m.mustChangePin
      ? '<span class="member-badge badge-advance">⏳ Temp PIN</span>'
      : (hasPin ? '<span class="member-badge badge-kitta">PIN ✅</span>' : '<span class="member-badge badge-due">PIN छैन</span>');
    const loanTag = effLoan > 0 ? `<span class="member-badge badge-loan">ऋण ${Accounting.formatNum(effLoan)}</span> ` : '';
    const dueTag = (Number(m.due) || 0) > 0 ? `<span class="member-badge badge-due">बाँकी ${Accounting.formatNum(m.due)}</span> ` : '';
    const initial = (m.name || '?').charAt(0);
    const avatarHtml = m.photo
      ? '<img src="' + m.photo + '" alt="" class="member-avatar" style="object-fit:cover;object-position:top center"/>'
      : '<div class="member-avatar">' + initial + '</div>';
    return (
      '<div class="member-item" onclick="openMemberDetail(\'' + m.id + '\')">' +
        avatarHtml +
        '<div class="member-info">' +
          '<div class="member-name">' + m.name + ' ' + badge + '</div>' +
          '<div class="member-meta">' + (m.mobile || 'मोबाइल छैन') + ' · ' + (m.kitta || 0) + ' कित्ता ' + loanTag + dueTag + pinTag + '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function filterProfileMembers() {
  const inp = document.getElementById('profile-member-search');
  const q = (inp && inp.value || '').trim().toLowerCase();
  const data = DB.load();
  const el = document.getElementById('profile-member-list');
  if (!el) return;
  const mode = window._profileFilter || 'all';
  const filtered = (data.members || []).filter(function (m) {
    if (!m.active) return false;
    if (mode === 'loan' && Accounting.getEffectiveMemberLoan(data, m) <= 0) return false;
    if (mode === 'due' && (Number(m.due) || 0) <= 0) return false;
    if (mode === 'nopin' && (m.hasPin || m.pin)) return false;
    if (mode === 'feedback' && memberUnreadFeedbackCount(m.id, data) <= 0) return false;
    if (!q) return true;
    return (m.name || '').toLowerCase().includes(q) || (m.mobile || '').toLowerCase().includes(q);
  });
  el.innerHTML = renderProfileMemberListHtml(filtered, data);
}

function refreshProfileMemberListAfterRead() {
  try {
    const input = document.getElementById('profile-member-search');
    if (input) filterProfileMembers();
  } catch (e) {}
}


function editMemberExtra(memberId) {
  const data = DB.load();
  const m = data.members.find(x => x.id === memberId);
  if (!m) return;
  const html = `
    <div class="section-title">${m.name}</div>
    <div class="form-group"><label>📷 प्रोफाइल फोटो</label><input type="file" id="me-photo" accept="image/*"></div>
    <div class="form-group"><label>🪪 परिचय पत्र फोटो</label><input type="file" id="me-idcard" accept="image/*"></div>
    <div class="form-group"><label>🏠 ठेगाना</label><input type="text" id="me-address" value="${m.address||''}"></div>
    <div class="form-group"><label>📝 परिचय / अन्य</label><textarea id="me-bio" rows="3">${m.bio||''}</textarea></div>
    <button class="btn btn-primary btn-block" onclick="saveMemberExtra('${memberId}')">💾 सेभ</button>
  `;
  UI.showModal('सदस्य विवरण', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">← फर्कनुहोस्</button>');
}

function saveMemberExtra(memberId) {
  const data = DB.load();
  const m = data.members.find(x => x.id === memberId);
  if (!m) return;
  m.address = (document.getElementById('me-address').value || '').trim();
  m.bio = (document.getElementById('me-bio').value || '').trim();
  let pending = 0;
  function done() {
    pending--;
    if (pending > 0) return;
    DB.save(data);
    UI.toast('सेभ भयो', 'success');
    openMemberDetail(memberId);
  }
  const pf = document.getElementById('me-photo') && document.getElementById('me-photo').files[0];
  const idf = document.getElementById('me-idcard') && document.getElementById('me-idcard').files[0];
  if (!pf && !idf) {
    DB.save(data);
    UI.toast('सेभ भयो', 'success');
    openMemberDetail(memberId);
    return;
  }
  if (pf) {
    pending++;
    readFileAsDataURL(pf, 400000, function (url) { if (url) m.photo = url; done(); });
  }
  if (idf) {
    pending++;
    readFileAsDataURL(idf, 500000, function (url) { if (url) m.idCardPhoto = url; done(); });
  }
}

function openMemberDetail(memberId, options = {}) {
  const data = DB.load();
  const member = data.members.find(m => m.id === memberId);
  if (!member) return;
  window._openMemberDetailId = memberId;

  // गुनासो/सुझाव खोल्दा read — सूचीबाट badge हट्छ
  let marked = false;
  (data.complaints || []).forEach(function (c) {
    if (c.memberId === memberId && !c.auto && !c.read) {
      c.read = true;
      marked = true;
    }
  });
  if (marked) {
    DB.save(data);
    try { refreshProfileMemberListAfterRead(); } catch (e) {}
  }

  const snap = Accounting.getSnapshot(data);
  const myAssets = Accounting.memberAssets(data, member);
  const effLoan = Accounting.getEffectiveMemberLoan(data, member);
  const effAdv = Accounting.getEffectiveMemberAdvance(data, member);
  const pinLabel = member.mustChangePin
    ? '⏳ Temp PIN (फेर्न बाँकी)'
    : ((member.hasPin || member.pin) ? '✅ सदस्यले सेट गर्यो' : '❌ सेट छैन');

  const photo = member.photo ? `<img src="${member.photo}" class="member-passport-photo" style="width:68px;height:85px;margin-bottom:8px"/>` : '';
  const idCard = member.idCardPhoto ? `<img src="${member.idCardPhoto}" style="max-width:100%;max-height:120px;border-radius:8px;margin-top:6px"/>` : '';
  let html = `
    <div class="section-title">${member.name}</div>
    <div style="text-align:center">${photo}</div>
    <div class="report-card">
      <div class="report-row"><span class="label">📱 मोबाइल</span><span class="value">${member.mobile || '-'}</span></div>
      <div class="report-row"><span class="label">🏠 ठेगाना</span><span class="value">${member.address || '-'}</span></div>
      <div class="report-row"><span class="label">📝 परिचय</span><span class="value" style="font-size:0.85rem">${member.bio || '-'}</span></div>
      <div class="report-row"><span class="label">🎫 कित्ता</span><span class="value fw-bold">${member.kitta}</span></div>
      <div class="report-row highlight"><span class="label">💎 सम्पत्ति (हिस्सा)</span><span class="value fw-bold">${Accounting.formatNum(myAssets)}</span></div>
      <div class="report-row"><span class="label">💰 प्रति कित्ता</span><span class="value">${Accounting.formatNum(snap.perKitta)}</span></div>
      <div class="report-row"><span class="label">🤝 बाँकी ऋण</span><span class="value">${Accounting.formatNum(effLoan)}</span></div>
      <div class="report-row"><span class="label">💚 अग्रिम</span><span class="value">${Accounting.formatNum(effAdv)}</span></div>
      <div class="report-row"><span class="label">📉 बाँकी</span><span class="value">${Accounting.formatNum(member.due||0)}</span></div>
      <div class="report-row"><span class="label">🔢 PIN</span><span class="value">${pinLabel}</span></div>
      ${idCard ? '<div style="margin-top:8px"><div class="text-muted" style="font-size:0.8rem">परिचय पत्र</div>'+idCard+'</div>' : ''}
    </div>
  `;
  const memComplaints = (data.complaints || []).filter(c => c.memberId === memberId);
  if (memComplaints.length) {
    html += `<div class="section-title mt-2">📢 गुनासो / प्रतिक्रिया (${memComplaints.length})</div>`;
    memComplaints.slice().reverse().forEach(c => {
      const replies = (c.replies || []).map(r =>
        `<div style="margin:4px 0 0 10px;padding:6px 8px;background:#f0f7ff;border-radius:8px;font-size:0.8rem">
          <strong>${r.from === 'admin' ? 'Admin' : 'सदस्य'}:</strong> ${r.text}
        </div>`).join('');
      html += `<div class="section-card" style="padding:10px;margin-bottom:8px">
        <div class="text-muted" style="font-size:0.72rem">${new Date(c.time).toLocaleString()}${c.auto ? ' · स्वतः' : ''}</div>
        <div style="font-size:0.9rem">${c.text}</div>
        ${replies}
        ${Auth.isAdmin() && !c.auto ? `<button class="btn btn-sm btn-info mt-1" onclick="openReplyComplaintForm('${c.id}')">💬 जवाफ</button>` : ''}
      </div>`;
    });
  } else if (Auth.isAdmin()) {
    html += `<div class="text-muted text-center mt-2" style="font-size:0.85rem">यस सदस्यको गुनासो छैन</div>`;
  }

  if (Auth.isAdmin()) {
    const canResetPhoto = Auth.isAccountsWriter && Auth.isAccountsWriter() && (member.photo || member.photoLocked);
    html += `
      <button class="btn btn-primary btn-block mb-1 mt-2" onclick="editMember('${memberId}')">✏️ सम्पादन</button>
      ${canResetPhoto ? `<button class="btn btn-light btn-block mb-1" style="border:1px solid #ced4da" onclick="promptResetMemberPhotoLock('${memberId}')">🔓 फोटो रिसेट (सदस्यले फेरि राख्न मिल्ने)</button>` : ''}
      <button class="btn btn-success btn-block mb-1" onclick="showAddKitta('${memberId}')">➕ कित्ता थप्नुहोस्</button>
      <button class="btn btn-warning btn-block mb-1" onclick="showReduceKitta('${memberId}')">➖ कित्ता घटाउनुहोस्</button>
      <button class="btn btn-info btn-block mb-1" onclick="showSetPin('${memberId}')">🎲 Temp PIN / WhatsApp निमन्त्रणा</button>
      <button class="btn btn-purple btn-block mb-1" onclick="showPassbook('${memberId}')">📖 पासबुक</button>
      <button class="btn btn-danger btn-block" onclick="confirmExitMember('${memberId}')">🚪 समूहबाट बाहिरिनुहोस्</button>
    `;
  } else {
    html += `
      <button class="btn btn-purple btn-block mt-2" onclick="showPassbook('${memberId}')">📖 पासबुक</button>
    `;
  }

  UI.showModal('👤 ' + member.name, html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>', options.replace ? { replace: true } : {});
}

function promptResetMemberPhotoLock(memberId) {
  const data = DB.load();
  const m = (data.members || []).find(x => x.id === memberId);
  if (!m) return;
  const html = `
    <p style="font-size:0.88rem;margin-bottom:12px">
      <strong>${m.name}</strong> लाई प्रोफाइल फोटो पुनः अपलोड गर्न अनुमति दिन चाहनुहुन्छ?
    </p>
    <button type="button" class="btn btn-primary btn-block mb-1" onclick="runResetMemberPhotoLock('${memberId}', false)">🔓 फोटो अनलक मात्र गर्नुहोस् (नयाँ राखेपछि फेरि लक)</button>
    <button type="button" class="btn btn-danger btn-block" onclick="runResetMemberPhotoLock('${memberId}', true)">🗑️ पुरानो फोटो मेटाएर अनलक गर्नुहोस्</button>
  `;
  UI.showModal('🔓 फोटो रिसेट', html, `<button class="btn btn-outline" onclick="openMemberDetail('${memberId}')">← फर्कनुहोस्</button>`);
}

async function runResetMemberPhotoLock(memberId, clearPhoto) {
  const res = await DB.resetMemberPhoto(memberId, clearPhoto);
  if (!res || !res.ok) {
    return UI.toast((res && res.error) || 'फोटो रिसेट असफल', 'error');
  }
  UI.toast('सदस्य फोटो अनलक भयो ✅ अब सदस्यले नयाँ फोटो राख्न मिल्छ', 'success');
  closeModal();
  openMemberDetail(memberId, { replace: true });
  renderProfileTab();
}

function editMember(memberId) {
  const data = DB.load();
  const m = data.members.find(x => x.id === memberId);
  if (!m) return;
  const html = `
    <div class="form-group"><label>नाम</label><input type="text" id="em-name" value="${m.name || ''}"></div>
    <div class="form-group"><label>मोबाइल</label><input type="tel" id="em-mobile" value="${m.mobile||''}"></div>
    <div class="form-group"><label>🏠 ठेगाना</label><input type="text" id="em-address" value="${m.address||''}"></div>
    <div class="form-group"><label>📝 परिचय / अन्य</label><textarea id="em-bio" rows="3">${m.bio||''}</textarea></div>
    <div class="form-group"><label>📷 प्रोफाइल फोटो (पासपोर्ट क्रप &lt; 85 KB)</label>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        ${m.photo ? '<img src="'+m.photo+'" class="member-passport-photo"/>' : ''}
        <button type="button" class="btn btn-light btn-sm" onclick="openPassportPhotoUpload('${memberId}')">✂️ पासपोर्ट क्रप अपलोड</button>
      </div>
      <input type="file" id="em-photo" accept="image/*">
    </div>
    <div class="form-group"><label>🪪 परिचय पत्र फोटो (स्वतः कम्प्रेस)</label><input type="file" id="em-idcard" accept="image/*">
      ${m.idCardPhoto ? '<img src="'+m.idCardPhoto+'" style="max-height:60px;margin-top:6px;border-radius:6px"/>' : ''}
    </div>
    <button class="btn btn-primary btn-block" onclick="saveMemberEdit('${memberId}')">💾 सेभ</button>
  `;
  UI.showModal('✏️ सम्पादन', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">← फर्कनुहोस्</button>');
}

function saveMemberEdit(memberId) {
  const name = document.getElementById('em-name').value.trim();
  const mobile = document.getElementById('em-mobile').value.trim();
  if (!name) return UI.toast('नाम चाहिन्छ', 'error');
  if (mobile && Auth.isMobileConflictWithAdmin && Auth.isMobileConflictWithAdmin(mobile, memberId)) {
    return UI.toast('यो मोबाइल/username Admin वा अर्को सदस्यसँग बाझिन्छ — अर्को नम्बर हाल्नुहोस्', 'error');
  }
  const data = DB.load();
  const m = data.members.find(x => x.id === memberId);
  if (!m) return;
  m.name = name;
  m.mobile = mobile;
  m.address = (document.getElementById('em-address').value || '').trim();
  m.bio = (document.getElementById('em-bio').value || '').trim();

  const pf = document.getElementById('em-photo') && document.getElementById('em-photo').files[0];
  const idf = document.getElementById('em-idcard') && document.getElementById('em-idcard').files[0];

  async function finish() {
    DB.save(data);
    if (Auth.isAccountsWriter()) {
      await DB.syncCredentialChange({
        type: 'member_meta',
        memberId: m.id,
        mobile: m.mobile,
        name: m.name,
        active: m.active !== false
      });
    }
    UI.toast('सेभ भयो', 'success');
    openMemberDetail(memberId);
    if (typeof renderProfileTab === 'function') renderProfileTab();
  }

  let pending = 0;
  function one() {
    pending--;
    if (pending <= 0) finish();
  }
  if (pf) {
    pending++;
    compressImageFile(pf, { targetBytes: 85000, maxW: 360, maxH: 450, passport: true }, function (url) {
      if (url) m.photo = url;
      one();
    });
  }
  if (idf) {
    pending++;
    compressImageFile(idf, { targetBytes: 95000, maxW: 800, maxH: 600, passport: false }, function (url) {
      if (url) m.idCardPhoto = url;
      one();
    });
  }
  if (pending === 0) finish();
}

function generateRandomPin() {
  const bad = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'];
  let p = '4827';
  for (let i = 0; i < 20; i++) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const cand = String(1000 + (arr[0] % 9000));
    if (bad.indexOf(cand) < 0) { p = cand; break; }
  }
  return p;
}

function showSetPin(memberId) {
  const data = DB.load();
  const member = data.members.find(m => m.id === memberId);
  if (!member) return;
  if (!member.mobile) {
    return UI.toast('पहिले ✏️ सम्पादन बाट सदस्यको मोबाइल नम्बर राख्नुहोस्', 'error');
  }
  const rnd = generateRandomPin();
  const html = `
    <p class="text-muted" style="font-size:0.84rem;margin-bottom:10px">
      <strong>${escapeHtmlChat(member.name)}</strong> (📱 ${escapeHtmlChat(member.mobile)}) को लागि अस्थायी (Temp) PIN बनाउनुहोस्। सेट भएपछि सिधै WhatsApp निमन्त्रणा पठाउन मिल्छ।
    </p>
    <div class="form-group">
      <label>नयाँ ४ अंकको PIN (स्वतः तयार पारिएको)</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="set-pin" maxlength="4" inputmode="numeric" value="${rnd}" style="flex:1;font-weight:700;letter-spacing:3px;text-align:center">
        <button type="button" class="btn btn-light" onclick="document.getElementById('set-pin').value=generateRandomPin()">🎲 अर्को</button>
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:0.84rem;margin-bottom:12px;cursor:pointer">
      <input type="checkbox" id="set-pin-temp" checked style="width:18px;height:18px">
      पहिलो लगइनमा सदस्यले आफैँ नयाॅ PIN फेर्नुपर्ने (Temp PIN)
    </label>
    <button type="button" class="btn btn-primary btn-block" onclick="doSetPin('${memberId}')">✅ PIN सेट गरी WhatsApp सन्देश बनाउनुहोस्</button>
  `;
  UI.showModal('🎲 Temp PIN / निमन्त्रणा', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">←</button>');
}

async function doSetPin(memberId) {
  const pin = (document.getElementById('set-pin').value || '').trim();
  const isTemp = !!(document.getElementById('set-pin-temp') && document.getElementById('set-pin-temp').checked);
  const res = await Auth.setMemberPin(memberId, pin, { isTemp });
  UI.toast(res.msg, res.ok ? 'success' : 'error');
  if (res.ok) {
    showMemberInviteModal(memberId, pin, isTemp);
  }
}

function formatWhatsAppPhone(mobile) {
  let d = String(mobile || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && (d.startsWith('98') || d.startsWith('97') || d.startsWith('96'))) {
    return '977' + d;
  }
  return d;
}

function showMemberInviteModal(memberId, pin, isTemp) {
  const data = DB.load();
  const member = data.members.find(m => m.id === memberId);
  if (!member) return;
  const gName = (data.group && data.group.name) || 'समूह बचत';
  const appUrl = (typeof location !== 'undefined' && location.origin) ? (location.origin + '/') : '';
  const msg =
    `🙏 नमस्कार ${member.name} ज्यू,\n` +
    `तपाईंको मोबाइल नम्बर (${member.mobile}) '${gName}' डिजिटल बचत एपमा दर्ता भएको छ।\n\n` +
    `🔑 लगइन विवरण:\n` +
    `• लिन्क: ${appUrl}\n` +
    `• मोबाइल (Username): ${member.mobile}\n` +
    `• ${isTemp ? 'अस्थायी (Temp) PIN' : 'PIN'}: ${pin}\n\n` +
    `📲 पहिलो पटक चलाउने तरिका:\n` +
    `१) माथिको लिन्क Chrome (iPhone भए Safari) मा खोलेर मोबाइल र ${isTemp ? 'Temp PIN' : 'PIN'} हाली Login गर्नुहोस्।\n` +
    (isTemp ? `२) भित्र पस्नासाथ पहिले आफ्नो सम्झिने नयाॅ ४ अंकको गोप्य PIN अनिवार्य सेट गर्नुहोस्।\n` : `२) सेटिङबाट चाहेको बेला PIN फेर्न सक्नुहुन्छ।\n`) +
    `३) त्यसपछि आउने सूचना (Notification) अनिवार्य 'Allow' गर्नुहोस् — बैठक र बचत घण्टी मोबाइलमा बज्छ।\n` +
    `४) एप सेभ गर्न: Chrome को माथि ⋮ थिची 'Add to Home screen / Install' गर्नुहोस् (वा ★ Bookmark गर्नुहोस्) ताकि अर्को पटक सिधै खोल्न सकियोस्।\n\n` +
    `धन्यवाद — ${gName}`;

  const waNum = formatWhatsAppPhone(member.mobile);
  const waHref = waNum
    ? `https://wa.me/${waNum}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;

  window._lastInviteText = msg;
  const html = `
    <div style="font-size:0.84rem;color:#198754;font-weight:600;margin-bottom:8px">✅ PIN (${escapeHtmlChat(pin)}) सुरक्षित सेभ भयो! अब सदस्यलाई WhatsApp पठाउनुहोस्:</div>
    <textarea id="invite-msg-box" rows="9" style="width:100%;font-size:0.82rem;padding:10px;border:1px solid #ced4da;border-radius:10px;line-height:1.45">${escapeHtmlChat(msg)}</textarea>
    <a href="${waHref}" target="_blank" rel="noopener noreferrer" class="btn btn-success btn-block mt-2" style="text-decoration:none">📤 WhatsApp मा सिधै पठाउनुहोस्</a>
    <button type="button" class="btn btn-primary btn-block mt-1" onclick="copyMemberInviteMsg()">📋 सन्देश Copy गर्नुहोस्</button>
  `;
  UI.showModal('📲 सदस्य निमन्त्रणा (WhatsApp)', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">← सदस्य प्रोफाइल</button>');
}

function copyMemberInviteMsg() {
  const box = document.getElementById('invite-msg-box');
  const txt = (box && box.value) || window._lastInviteText || '';
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => UI.toast('सन्देश Copy भयो ✅', 'success')).catch(() => {
      if (box) { box.select(); document.execCommand('copy'); UI.toast('सन्देश Copy भयो ✅', 'success'); }
    });
  } else if (box) {
    box.select();
    document.execCommand('copy');
    UI.toast('सन्देश Copy भयो ✅', 'success');
  }
}

function showAddKitta(memberId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  // Only allowed after collection closed, before month close
  if (!month || month.status !== 'collection_closed') {
    return UI.toast('कलेक्सन बन्द भएपछि र महिना बन्द हुनुअघि मात्र कित्ता थप्न मिल्छ', 'error');
  }
  const perKitta = Accounting.perKittaValue(data, month) || data.settings.monthlySaving;
  const html = `
    <p>हाल प्रति कित्ता मूल्य: <strong>${Accounting.formatNum(perKitta)}</strong></p>
    <div class="form-group"><label>थप्ने कित्ता संख्या</label><input type="number" id="add-kitta-num" min="1" value="1"></div>
    <div class="form-group"><label>तिर्नुपर्ने रकम (स्वतः)</label><input type="number" id="add-kitta-amount" readonly></div>
    <button class="btn btn-success btn-block" onclick="doAddKitta('${memberId}')">✅ कित्ता थप्नुहोस्</button>
  `;
  UI.showModal('➕ कित्ता थप', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">←</button>');
  const updateAmt = () => {
    const n = parseInt(document.getElementById('add-kitta-num').value) || 0;
    document.getElementById('add-kitta-amount').value = n * perKitta;
  };
  document.getElementById('add-kitta-num').oninput = updateAmt;
  updateAmt();
}

function doAddKitta(memberId) {
  const num = parseInt(document.getElementById('add-kitta-num').value) || 0;
  const amount = parseFloat(document.getElementById('add-kitta-amount').value) || 0;
  if (num <= 0) return UI.toast('संख्या गलत', 'error');
  UI.showPinModal('⚠️ कित्ता थप गर्न PIN चाहिन्छ। रकम: ' + amount, () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    const member = data.members.find(m => m.id === memberId);
    member.kitta += num;
    month.otherIncomeDetails.push({
      type: 'kitta_add', memberId, amount,
      note: member.name + ' - ' + num + ' कित्ता थप',
      time: new Date().toISOString()
    });
    Accounting.recalcMonth(month, data);
    DB.save(data);
    UI.toast(num + ' कित्ता थपियो', 'success');
    openMemberDetail(memberId);
    UI.updateHome(data);
  });
}

function showReduceKitta(memberId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'collection_closed') {
    return UI.toast('कलेक्सन बन्द भएपछि मात्र कित्ता घटाउन मिल्छ', 'error');
  }
  const member = data.members.find(m => m.id === memberId);
  const perKitta = Accounting.perKittaValue(data, month) || data.settings.monthlySaving;
  const feePct = data.settings.kittaReduceFee || 2;

  const html = `
    <p>हाल कित्ता: <strong>${member.kitta}</strong> · प्रति कित्ता: <strong>${Accounting.formatNum(perKitta)}</strong></p>
    <div class="form-group"><label>घटाउने कित्ता</label><input type="number" id="red-kitta-num" min="1" max="${member.kitta}" value="1"></div>
    <div class="form-group"><label>कुल मूल्य</label><input type="number" id="red-kitta-gross" readonly></div>
    <div class="form-group"><label>शुल्क (${feePct}%)</label><input type="number" id="red-kitta-fee" readonly></div>
    <div class="form-group"><label>सदस्यले पाउने</label><input type="number" id="red-kitta-net" readonly></div>
    <button class="btn btn-warning btn-block" onclick="doReduceKitta('${memberId}')">✅ कित्ता घटाउनुहोस्</button>
  `;
  UI.showModal('➖ कित्ता घटाउने', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">←</button>');

  const update = () => {
    const n = parseInt(document.getElementById('red-kitta-num').value) || 0;
    const gross = n * perKitta;
    const fee = Math.round(gross * feePct / 100);
    document.getElementById('red-kitta-gross').value = gross;
    document.getElementById('red-kitta-fee').value = fee;
    document.getElementById('red-kitta-net').value = gross - fee;
  };
  document.getElementById('red-kitta-num').oninput = update;
  update();
}

function doReduceKitta(memberId) {
  const num = parseInt(document.getElementById('red-kitta-num').value) || 0;
  const net = parseFloat(document.getElementById('red-kitta-net').value) || 0;
  if (num <= 0) return UI.toast('संख्या गलत', 'error');
  UI.showPinModal('⚠️ कित्ता घटाउन PIN चाहिन्छ। फिर्ता: ' + net, () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    const member = data.members.find(m => m.id === memberId);
    if (num > member.kitta) return UI.toast('कित्ता पर्याप्त छैन', 'error');
    member.kitta -= num;
    month.expenseDetails.push({
      type: 'kitta_reduce', memberId, amount: net,
      note: member.name + ' - ' + num + ' कित्ता घटाएको',
      time: new Date().toISOString()
    });
    Accounting.recalcMonth(month, data);
    DB.save(data);
    UI.toast(num + ' कित्ता घटाइयो, रु. ' + Accounting.formatNum(net) + ' फिर्ता', 'success');
    openMemberDetail(memberId);
    UI.updateHome(data);
  });
}

function confirmExitMember(memberId) {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'collection_closed') {
    return UI.toast('कलेक्सन बन्द भएपछि मात्र बाहिरिन मिल्छ', 'error');
  }
  const member = data.members.find(m => m.id === memberId);
  if ((member.outstandingLoan || 0) > 0) {
    return UI.toast('पहिले ऋण चुक्ता गर्नुहोस्', 'error');
  }
  const perKitta = Accounting.perKittaValue(data, month) || data.settings.monthlySaving;
  const feePct = data.settings.exitFee || 3;
  const gross = member.kitta * perKitta;
  const fee = Math.round(gross * feePct / 100);
  const net = gross - fee;

  const html = `
    <p><strong>${member.name}</strong> लाई समूहबाट बाहिरिने?</p>
    <div class="report-card">
      <div class="report-row"><span class="label">कित्ता</span><span class="value">${member.kitta}</span></div>
      <div class="report-row"><span class="label">कुल मूल्य</span><span class="value">${Accounting.formatNum(gross)}</span></div>
      <div class="report-row"><span class="label">शुल्क (${feePct}%)</span><span class="value">${Accounting.formatNum(fee)}</span></div>
      <div class="report-row highlight"><span class="label">फिर्ता रकम</span><span class="value">${Accounting.formatNum(net)}</span></div>
    </div>
    <button class="btn btn-danger btn-block" onclick="doExitMember('${memberId}', ${net})">🚪 बाहिरिनुहोस्</button>
  `;
  UI.showModal('🚪 बाहिरिने', html, '<button class="btn btn-outline" onclick="openMemberDetail(\''+memberId+'\')">←</button>');
}

function doExitMember(memberId, net) {
  UI.showPinModal('⚠️ सदस्य बाहिरिन PIN चाहिन्छ। फिर्ता: ' + net, async () => {
    const data = DB.load();
    const month = Accounting.getCurrentMonth(data);
    const member = data.members.find(m => m.id === memberId);
    month.expenseDetails.push({
      type: 'member_exit', memberId, amount: net,
      note: member.name + ' बाहिरिए', time: new Date().toISOString()
    });
    member.active = false;
    member.kitta = 0;
    Accounting.recalcMonth(month, data);
    DB.save(data);
    if (Auth.isAccountsWriter()) {
      await DB.syncCredentialChange({
        type: 'member_meta',
        memberId: member.id,
        mobile: member.mobile,
        name: member.name,
        active: false
      });
    }
    UI.toast('सदस्य बाहिरिए, रु. ' + Accounting.formatNum(net) + ' फिर्ता', 'success');
    closeModal();
    renderProfileTab();
    UI.updateHome(data);
  });
}

function showNewMemberForm() {
  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);
  if (!month || month.status !== 'collection_closed') {
    return UI.toast('कलेक्सन बन्द भएपछि मात्र नयाँ सदस्य थप्न मिल्छ', 'error');
  }
  const perKitta = Accounting.perKittaValue(data, month) || data.settings.monthlySaving;

  // Find inactive or create new
  const html = `
    <div class="form-group"><label>नाम</label><input type="text" id="nm-name" placeholder="पूरा नाम"></div>
    <div class="form-group"><label>मोबाइल</label><input type="tel" id="nm-mobile" placeholder="98xxxxxxxx"></div>
    <div class="form-group"><label>कित्ता संख्या</label><input type="number" id="nm-kitta" min="1" value="1"></div>
    <p>प्रति कित्ता: <strong>${Accounting.formatNum(perKitta)}</strong></p>
    <div class="form-group"><label>तिर्नुपर्ने रकम</label><input type="number" id="nm-amount" readonly></div>
    <button class="btn btn-success btn-block" onclick="doAddNewMember()">✅ प्रवेश गराउनुहोस्</button>
  `;
  UI.showModal('➕ नयाँ सदस्य', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
  const upd = () => {
    const n = parseInt(document.getElementById('nm-kitta').value) || 0;
    document.getElementById('nm-amount').value = n * perKitta;
  };
  document.getElementById('nm-kitta').oninput = upd;
  upd();
}

async function doAddNewMember() {
  const name = document.getElementById('nm-name').value.trim();
  const mobile = document.getElementById('nm-mobile').value.trim();
  const kitta = parseInt(document.getElementById('nm-kitta').value) || 0;
  const amount = parseFloat(document.getElementById('nm-amount').value) || 0;
  if (!name || kitta <= 0) return UI.toast('नाम र कित्ता चाहिन्छ', 'error');

  const data = DB.load();
  const month = Accounting.getCurrentMonth(data);

  // Reuse inactive slot or create new
  let member = data.members.find(m => !m.active);
  if (!member) {
    member = {
      id: 'm' + (data.members.length + 1),
      name, mobile, hasPin: false, kitta: 0, photo: null, active: true,
      joinedMonthId: month.id, outstandingLoan: 0, advance: 0, due: 0,
      assetHistory: [], loanHistory: []
    };
    data.members.push(member);
  } else {
    member.name = name;
    member.mobile = mobile;
    member.active = true;
    member.joinedMonthId = month.id;
    member.outstandingLoan = 0;
    member.advance = 0;
    member.due = 0;
  }
  member.kitta = kitta;

  month.otherIncomeDetails.push({
    type: 'new_member',
    memberId: member.id,
    amount,
    note: name + ' - नयाँ प्रवेश (' + kitta + ' कित्ता)',
    time: new Date().toISOString()
  });
  Accounting.recalcMonth(month, data);
  DB.save(data);
  if (Auth.isAccountsWriter() && mobile) {
    await DB.syncCredentialChange({
      type: 'member_meta',
      memberId: member.id,
      mobile,
      name,
      active: true
    });
  }
  UI.toast(name + ' प्रवेश भयो', 'success');
  closeModal();
  renderProfileTab();
  UI.updateHome(data);
}

// After viewing passbook/report, member is asked about complaints on CLOSE
let _askComplaintOnClose = null; // { memberId, source }

function showPassbook(memberId) {
  // Open passbook first; ask complaint only when closing (member only)
  if (Auth.isMember() && Auth.currentUser.memberId === memberId) {
    _askComplaintOnClose = { memberId, source: 'पासबुक' };
  } else {
    _askComplaintOnClose = null;
  }
  renderPassbookContent(memberId);
}

function askComplaintAfterView(memberId, source) {
  const html = `
    <p>${source} हेर्नुभयो। के तपाईंलाई कुनै शंका / गुनासो छ?</p>
    <button class="btn btn-warning btn-block mb-1" onclick="complaintAfterYes('${memberId}','${source}')">हो, गुनासो छ</button>
    <button class="btn btn-success btn-block mb-1" onclick="complaintAfterNo('${memberId}','${source}')">छैन, गुनासो छैन</button>
  `;
  UI.showModal('📢 गुनासो', html, '');
}

function complaintAfterYes(memberId, source) {
  const html = `
    <div class="form-group"><label>गुनासो / शंका लेख्नुहोस्</label>
      <textarea id="pb-complaint" rows="3" placeholder="लेख्नुहोस्..."></textarea>
    </div>
    <button class="btn btn-warning btn-block" onclick="submitComplaintAfter('${memberId}','${source}')">📤 पठाउनुहोस्</button>
  `;
  UI.showModal('📢 गुनासो लेख्नुहोस्', html, '<button class="btn btn-outline" onclick="askComplaintAfterView(\''+memberId+'\',\''+source+'\')">←</button>');
}

async function complaintAfterNo(memberId, source) {
  const data = DB.load();
  const item = {
    id: 'c_' + Date.now(),
    memberId,
    text: 'गुनासो छैन (' + source + ' हेरेपछि)',
    time: new Date().toISOString(),
    read: false,
    replies: [],
    auto: true
  };
  data.complaints = data.complaints || [];
  data.complaints.push(item);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({ id: item.id, kind: 'complaint', text: item.text, auto: true });
  }
  UI.toast('धन्यवाद', 'success');
  closeModal();
}

async function submitComplaintAfter(memberId, source) {
  const text = document.getElementById('pb-complaint').value.trim();
  if (!text) return UI.toast('केही लेख्नुहोस्', 'error');
  const data = DB.load();
  const item = {
    id: 'c_' + Date.now(),
    memberId,
    text: '[' + source + '] ' + text,
    time: new Date().toISOString(),
    read: false,
    replies: []
  };
  data.complaints = data.complaints || [];
  data.complaints.push(item);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({ id: item.id, kind: 'complaint', text: item.text });
  }
  UI.toast('गुनासो पठाइयो', 'success');
  closeModal();
}

function renderPassbookContent(memberId) {
  const data = DB.load();
  const member = data.members.find(m => m.id === memberId);
  const snap = Accounting.getSnapshot(data);
  const myAssets = Accounting.memberAssets(data, member);
  const curMonth = Accounting.getCurrentMonth(data);
  const effLoan = Accounting.getEffectiveMemberLoan(data, member, curMonth);
  const effAdv = Accounting.getEffectiveMemberAdvance(data, member, curMonth);

  let assetRows = (member.assetHistory || []).slice();
  let loanRows = (member.loanHistory || []).slice();

  // Live update for open month (before close)
  if (curMonth && curMonth.status !== 'closed') {
    const prevA = assetRows.length ? assetRows[assetRows.length - 1].total : 0;
    assetRows.push({
      monthName: curMonth.name + ' (चलिरहेको)',
      prev: prevA,
      added: myAssets - prevA,
      total: myAssets
    });
    const taken = (curMonth.loansGiven || []).filter(l => l.memberId === memberId).reduce((s, l) => s + l.amount, 0);
    const repaid = (curMonth.collections && curMonth.collections[memberId] && curMonth.collections[memberId].principal) || 0;
    const prevL = loanRows.length ? loanRows[loanRows.length - 1].balance
      : (effLoan - taken + repaid);
    loanRows.push({
      monthName: curMonth.name + ' (चलिरहेको)',
      prev: prevL,
      taken,
      repaid,
      balance: effLoan
    });
  }

  // मासिक भुक्तानी विवरण तालिका (थिच्दा पूरा बिल/विवरण खुल्छ)
  const payMonths = (data.months || []).filter(m => m.status === 'closed' || (m.collections && m.collections[memberId]));
  let payHtml = '';
  if (!payMonths.length) {
    payHtml = '<tr><td colspan="6">अहिलेसम्म भुक्तानी रेकर्ड छैन</td></tr>';
  } else {
    payHtml = payMonths.map(mo => {
      const c = (mo.collections && mo.collections[memberId]) || {};
      const statusTag = mo.status === 'closed' ? '' : ' *';
      return `<tr style="cursor:pointer" onclick="showMemberMonthPaymentDetail('${mo.id}','${memberId}')">
        <td style="color:#0d6efd;text-decoration:underline">${mo.name}${statusTag}</td>
        <td>${Accounting.formatNum(c.saving || 0)}</td>
        <td>${Accounting.formatNum(c.interest || 0)}</td>
        <td>${Accounting.formatNum(c.principal || 0)}</td>
        <td>${Accounting.formatNum(c.fine || 0)}</td>
        <td class="fw-bold">${Accounting.formatNum(c.totalPaid || 0)}</td>
      </tr>`;
    }).join('');
  }

  let html = `<div class="print-area" id="print-passbook">
    <h2>${data.group.name}</h2>
    <div class="print-meta">पासबुक · ${member.name}</div>
    <div class="report-card mb-2">
      <div class="report-row"><span class="label">🎫 कित्ता</span><span class="value fw-bold">${member.kitta}</span></div>
      <div class="report-row highlight"><span class="label">💎 हालको सम्पत्ति (हिस्सा)</span><span class="value fw-bold">${Accounting.formatNum(myAssets)}</span></div>
      <div class="report-row"><span class="label">💰 प्रति कित्ता</span><span class="value">${Accounting.formatNum(snap.perKitta)}</span></div>
      <div class="report-row"><span class="label">🤝 बाँकी ऋण</span><span class="value">${Accounting.formatNum(effLoan)}</span></div>
      <div class="report-row"><span class="label">💚 अग्रिम</span><span class="value">${Accounting.formatNum(effAdv)}</span></div>
    </div>
    <h3>💵 मासिक भुक्तानी विवरण <span style="font-size:0.75rem;color:#666;font-weight:400">(महिना थिचेर रसिद हेर्नुहोस्)</span></h3>
    <div class="table-wrap"><table style="font-size:0.76rem"><thead><tr><th>महिना</th><th>बचत</th><th>ब्याज</th><th>सावा</th><th>जरि.</th><th>नगद</th></tr></thead><tbody>
    ${payHtml}
    </tbody></table></div>
    <h3 class="mt-2">💎 सम्पत्ति इतिहास</h3>
    <div class="table-wrap"><table><thead><tr><th>महिना</th><th>पहिले</th><th>थप</th><th>जम्मा</th></tr></thead><tbody>`;
  if (!assetRows.length) {
    html += '<tr><td colspan="4">अहिलेसम्म रेकर्ड छैन</td></tr>';
  } else {
    assetRows.forEach(h => {
      html += `<tr><td>${h.monthName}</td><td>${Accounting.formatNum(h.prev)}</td><td>${Accounting.formatNum(h.added)}</td><td class="fw-bold">${Accounting.formatNum(h.total)}</td></tr>`;
    });
  }
  html += `</tbody></table></div>
    <h3 class="mt-2">🤝 ऋण इतिहास</h3>
    <div class="table-wrap"><table><thead><tr><th>महिना</th><th>पहिले</th><th>लिएको</th><th>तिरेको</th><th>बाँकी</th></tr></thead><tbody>`;
  if (!loanRows.length) {
    html += '<tr><td colspan="5">अहिलेसम्म रेकर्ड छैन</td></tr>';
  } else {
    loanRows.forEach(h => {
      html += `<tr><td>${h.monthName}</td><td>${Accounting.formatNum(h.prev)}</td><td>${Accounting.formatNum(h.taken)}</td><td>${Accounting.formatNum(h.repaid)}</td><td class="fw-bold">${Accounting.formatNum(h.balance)}</td></tr>`;
    });
  }
  html += '</tbody></table></div></div>';
  html += '<button class="btn btn-primary btn-block mt-2" onclick="printReportImage(\'print-passbook\')">🖨️ प्रिन्ट</button>';

  UI.showModal('📖 पासबुक - ' + member.name, html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function showMemberMonthPaymentDetail(monthId, memberId) {
  const data = DB.load();
  const mo = (data.months || []).find(m => m.id === monthId);
  const member = (data.members || []).find(m => m.id === memberId);
  if (!mo || !member) return;
  const bid = mo.memberBills && mo.memberBills[memberId];
  if (bid && data.bills && data.bills[bid]) {
    viewBill(bid);
    return;
  }
  const c = (mo.collections && mo.collections[memberId]) || {};
  const taken = (mo.loansGiven || []).filter(l => l.memberId === memberId).reduce((s, l) => s + (l.amount || 0), 0);
  const html = `
    <div class="report-card">
      <div class="report-row"><span class="label">महिना</span><span class="value fw-bold">${mo.name} (${mo.status})</span></div>
      <div class="report-row"><span class="label">बचत</span><span class="value">रु. ${Accounting.formatNum(c.saving || 0)}</span></div>
      <div class="report-row"><span class="label">ब्याज</span><span class="value">रु. ${Accounting.formatNum(c.interest || 0)}</span></div>
      <div class="report-row"><span class="label">सावा</span><span class="value">रु. ${Accounting.formatNum(c.principal || 0)}</span></div>
      <div class="report-row"><span class="label">जरिवाना</span><span class="value">रु. ${Accounting.formatNum(c.fine || 0)}</span></div>
      <div class="report-row"><span class="label">अघिल्लो बाँकी तिरेको</span><span class="value">रु. ${Accounting.formatNum(c.previousDue || 0)}</span></div>
      <div class="report-row"><span class="label">नयाॅ अग्रिम थप</span><span class="value">रु. ${Accounting.formatNum(c.advance || 0)}</span></div>
      <div class="report-row"><span class="label">अग्रिमबाट कट्टा</span><span class="value">रु. ${Accounting.formatNum(c.fromAdvance || 0)}</span></div>
      <div class="report-row highlight"><span class="label">जम्मा नगद तिरेको</span><span class="value fw-bold">रु. ${Accounting.formatNum(c.totalPaid || 0)}</span></div>
      ${taken > 0 ? `<div class="report-row"><span class="label">यस महिना लिएको ऋण</span><span class="value">रु. ${Accounting.formatNum(taken)}</span></div>` : ''}
    </div>
  `;
  UI.showModal('🧾 ' + member.name + ' · ' + mo.name, html, '<button class="btn btn-outline" onclick="closeModal()">← फर्कनुहोस्</button>');
}

// ========== MIGRATION ==========
function openMigration() {
  const data = DB.load();
  if (!data.migration) data.migration = { cash: 0, loans: {}, advances: {}, kittas: {} };
  if (!data.migration.kittas) data.migration.kittas = {};
  if (!data.migration.loans) data.migration.loans = {};
  if (!data.migration.advances) data.migration.advances = {};

  const html = `
    <p class="text-muted mb-2" style="font-size:0.85rem">पुरानो हिसाब: नगद + प्रत्येक सदस्यको <strong>कित्ता</strong>, ऋण र अग्रिम हाल्नुहोस्। सेभपछि होममा देखिन्छ।</p>
    <div class="form-group">
      <label>💵 हालको जम्मा नगद</label>
      <input type="number" id="mig-cash" value="${data.migration.cash || 0}">
    </div>
    <div class="section-title">सदस्यअनुसार कित्ता · ऋण · अग्रिम</div>
    <div id="mig-members">
      ${data.members.filter(m => m.active).map(m => `
        <div class="section-card" style="padding:10px">
          <div class="fw-bold mb-1">${m.name}</div>
          <div class="flex gap-1">
            <div class="form-group" style="flex:1;margin:0">
              <label>🎫 कित्ता</label>
              <input type="number" data-mig-kitta="${m.id}" value="${data.migration.kittas[m.id] !== undefined ? data.migration.kittas[m.id] : (m.kitta || 0)}" min="0">
            </div>
            <div class="form-group" style="flex:1;margin:0">
              <label>ऋण</label>
              <input type="number" data-mig-loan="${m.id}" value="${data.migration.loans[m.id] || 0}">
            </div>
            <div class="form-group" style="flex:1;margin:0">
              <label>अग्रिम</label>
              <input type="number" data-mig-adv="${m.id}" value="${data.migration.advances[m.id] || 0}">
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-orange btn-block mt-2" onclick="saveMigration()">💾 सेभ गर्नुहोस्</button>
  `;
  UI.showModal('📂 अगाडिको हिसाब', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function saveMigration() {
  const cashEl = document.getElementById('mig-cash');
  if (!cashEl) return UI.toast('फारम भेटिएन — फेरि खोल्नुहोस्', 'error');

  const cash = parseFloat(cashEl.value) || 0;
  const kittas = {};
  const loans = {};
  const advances = {};

  document.querySelectorAll('[data-mig-kitta]').forEach(inp => {
    kittas[inp.getAttribute('data-mig-kitta')] = parseInt(inp.value, 10) || 0;
  });
  document.querySelectorAll('[data-mig-loan]').forEach(inp => {
    const v = parseFloat(inp.value) || 0;
    if (v > 0) loans[inp.getAttribute('data-mig-loan')] = v;
  });
  document.querySelectorAll('[data-mig-adv]').forEach(inp => {
    const v = parseFloat(inp.value) || 0;
    if (v > 0) advances[inp.getAttribute('data-mig-adv')] = v;
  });

  const totalLoans = Object.values(loans).reduce((s, v) => s + v, 0);
  const totalKitta = Object.values(kittas).reduce((s, v) => s + v, 0);
  const totalAssets = cash + totalLoans;

  if (cash === 0 && totalLoans === 0 && totalKitta === 0) {
    return UI.toast('कम्तिमा नगद वा कित्ता वा ऋण हाल्नुहोस्', 'error');
  }

  UI.showPinModal('सेभ गर्न PIN दिनुहोस्', () => {
    try {
      const data = DB.load();
      data.migration = {
        cash: cash,
        loans: loans,
        advances: advances,
        kittas: kittas,
        hideAfterFirst: false
      };
      data.migrationDone = true;

      // Single apply: members + open month + passbook seed
      Accounting.applyMigration(data);

      localStorage.setItem(DB.KEY, JSON.stringify(data));
      localStorage.setItem('gs_mig_backup', JSON.stringify({ cash, loans, advances, kittas, totalAssets, totalLoans, totalKitta }));

      const raw = localStorage.getItem(DB.KEY);
      const check = JSON.parse(raw);
      if (!check.migrationDone || Number(check.migration.cash) !== cash) {
        UI.showModal('❌ सेभ असफल',
          '<p>डाटा स्टोरेजमा बसेन। Chrome बाट फाइल खोल्नुहोस्।</p>',
          '<button class="btn btn-primary" onclick="closeModal()">ठीक छ</button>');
        return;
      }

      APP_DATA = check;
      closeModal();
      UI.updateHome(check);
      UI.updateHeader(check);
      renderHomeByRole();
      renderProfileTab();

      const confHtml = `
        <div class="report-card">
          <div class="report-row highlight"><span class="label">💵 नगद</span><span class="value fw-bold">${Accounting.formatNum(check.migration.cash)}</span></div>
          <div class="report-row"><span class="label">🤝 जम्मा ऋण</span><span class="value fw-bold">${Accounting.formatNum(totalLoans)}</span></div>
          <div class="report-row"><span class="label">🎫 जम्मा कित्ता</span><span class="value fw-bold">${Accounting.formatNum(totalKitta)}</span></div>
          <div class="report-row highlight"><span class="label">💎 सम्पत्ति</span><span class="value fw-bold">${Accounting.formatNum(totalAssets)}</span></div>
        </div>
        <p class="text-center mt-2">होममा पनि यही देखिनुपर्छ।</p>
        <p class="text-muted text-center" style="font-size:0.85rem">अब <strong>मासिक असुली</strong> बाट नयाँ महिना सुरु गर्नुहोस्।</p>
      `;
      UI.showModal('✅ माइग्रेशन सफल', confHtml,
        '<button class="btn btn-primary" onclick="closeModal(); switchTab(\'home\')">होममा जानुहोस्</button>');
    } catch (err) {
      UI.showModal('❌ त्रुटि', '<p>' + (err.message || String(err)) + '</p>',
        '<button class="btn btn-primary" onclick="closeModal()">ठीक छ</button>');
    }
  });
}

// ========== PIN REQUESTS & COMPLAINTS ==========


// ========== CHAT + AUTO MESSAGES ==========
function _chatId() {
  return 'm' + Date.now() + '_' + Math.floor(Math.random() * 9999);
}
function _chatSender() {
  // कस्टम लगइन मात्र — Firebase Authentication कहिल्यै प्रयोग नगर्ने
  try {
    if (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin()) {
      const d = DB.load();
      const name = (d.admin && d.admin.name) || (Auth.currentUser && Auth.currentUser.name) || 'Admin';
      const id = (d.admin && d.admin.memberId) || (Auth.currentUser && Auth.currentUser.username) || 'admin';
      return { id: String(id), name: String(name), role: 'admin' };
    }
    if (typeof Auth !== 'undefined' && Auth.isMember && Auth.isMember() && Auth.currentUser) {
      const d = DB.load();
      const mid = Auth.currentUser.memberId;
      const m = (d.members || []).find(x => x.id === mid);
      const name = (m && m.name) || Auth.currentUser.name || 'सदस्य';
      return { id: String(mid), name: String(name), role: 'member' };
    }
  } catch (e) {
    console.warn('_chatSender', e);
  }
  return { id: 'system', name: 'प्रणाली', role: 'system' };
}
function _ensureChat(data) {
  if (!data.chat) data.chat = { group: [], private: {} };
  if (!Array.isArray(data.chat.group)) data.chat.group = [];
  if (!data.chat.private) data.chat.private = {};
  return data;
}
function escapeHtmlChat(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function postGroupMessage(text, type, data, opts) {
  data = _ensureChat(data || DB.load());
  const t = type || 'text';
  // अटो सन्देश दोहोरो नजाओस् (PIN दोब्बर / सिंक मर्ज)
  if (t === 'auto_group' || t === 'system') {
    const recent = (data.chat.group || []).slice(-15);
    const dup = recent.some(function (m) {
      return m && (m.type === 'auto_group' || m.type === 'system' || m.fromRole === 'system') &&
        String(m.text || '') === String(text || '');
    });
    if (dup) return data;
  }
  const sender = (t === 'system' || t === 'auto_group')
    ? { id: 'system', name: 'समूह सूचना', role: 'system' }
    : _chatSender();
  const msgObj = {
    id: _chatId(),
    fromId: sender.id,
    fromName: sender.name,
    fromRole: sender.role,
    text: text,
    type: t,
    time: new Date().toISOString()
  };
  data.chat.group.push(msgObj);
  if (data.chat.group.length > 500) data.chat.group = data.chat.group.slice(-500);
  if (typeof DB !== 'undefined' && DB.getToken && DB.getToken() && typeof DB.pushChatMessage === 'function') {
    DB.pushChatMessage({
      id: msgObj.id,
      channel: 'group',
      text: msgObj.text,
      type: msgObj.type,
      time: msgObj.time,
      silentPush: !!(opts && opts.silentPush)
    }).catch(function () {});
  }
  return data;
}
function postPrivateMessage(memberId, text, type, data) {
  data = _ensureChat(data || DB.load());
  if (!data.chat.private[memberId]) data.chat.private[memberId] = [];
  const sender = type === 'auto_private'
    ? { id: 'system', name: 'समूह सूचना', role: 'system' }
    : _chatSender();
  const msgObj = {
    id: _chatId(),
    fromId: sender.id,
    fromName: sender.name,
    fromRole: sender.role,
    text: text,
    type: type || 'text',
    time: new Date().toISOString()
  };
  data.chat.private[memberId].push(msgObj);
  if (data.chat.private[memberId].length > 300) {
    data.chat.private[memberId] = data.chat.private[memberId].slice(-300);
  }
  if (typeof DB !== 'undefined' && DB.getToken && DB.getToken() && typeof DB.pushChatMessage === 'function') {
    DB.pushChatMessage({
      id: msgObj.id,
      channel: 'private:' + memberId,
      text: msgObj.text,
      type: msgObj.type,
      time: msgObj.time
    }).catch(function () {});
  }
  return data;
}

function notifyMonthStarted(data, month) {
  const text =
    '📢 बचत सन्कलन सुरु\n\n' +
    'महिना: ' + (month.name || '') + '\n' +
    'समूहको बचत / कलेक्सन बैठक सुरु भइसकेको छ।\n' +
    'कृपया समयमै उपस्थित भई मासिक बचत बुझाउनुहोला।\n\n' +
    'धन्यवाद।';
  postGroupMessage(text, 'auto_group', data, { silentPush: true });
}

function notifyCollectionPrivate(data, member, allocated, month) {
  /* महिना बन्दपछि डिजिटल रसिद — बीचमा नोटिफिकेसन पठाइँदैन */
}

function notifyLoanPrivate(data, member, amount) {
  /* महिना बन्दपछि डिजिटल रसिदमा समावेश */
}

function notifyMonthClosed(data, month) {
  const text =
    '🙏 धन्यवाद\n\n' +
    (month.name || '') + ' को हिसाब बन्द भएको छ।\n' +
    'यस महिनाको सहयोगका लागि सबै सदस्यलाई धन्यवाद।\n\n' +
    'पासबुक / रिपोर्ट जाँच्नुहोस्।\n' +
    'कुनै गुनासो भए लेख्नुहोस्।';
  postGroupMessage(text, 'auto_group', data, { silentPush: true });
}

function renderChatTab() {
  const el = document.getElementById('chat-content');
  if (!el) return;
  const data = _ensureChat(DB.load());
  const me = _chatSender();
  const isAdmin = Auth.isAdmin && Auth.isAdmin();
  const canDelete = Auth.isAccountsWriter && Auth.isAccountsWriter();
  const mode = 'group'; // व्यक्तिगत हटाइयो

  window._chatMode = 'group';
  let tabs = `
    <div style="margin-bottom:10px;font-weight:600;font-size:0.95rem">👥 समूह कुराकानी</div>
  `;

  if (mode === 'group') {
    const msgs = data.chat.group || [];
    if (document.getElementById('tab-chat') && document.getElementById('tab-chat').classList.contains('active')) {
      markGroupChatRead(msgs);
    }
    let bubbles = '';
    if (!msgs.length) {
      bubbles = '<div class="empty-state" style="padding:20px"><div class="icon">💬</div>समूह च्याट खाली छ</div>';
    } else {
      bubbles = msgs.map(m => {
        const mine = me.role !== 'system' && m.fromId === me.id && m.fromRole === me.role;
        const sys = m.fromRole === 'system' || m.type === 'auto_group';
        const time = m.time ? new Date(m.time).toLocaleString('ne-NP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const delBtn = canDelete && m.id
          ? '<button type="button" onclick="event.stopPropagation();deleteGroupChatMessage(\'' + escapeHtmlChat(m.id) + '\', false)" style="border:none;background:none;color:#dc3545;cursor:pointer;font-size:0.75rem;margin-left:6px;padding:0" title="मेटाउनुहोस्">🗑️</button>'
          : '';
        return '<div class="chat-row ' + (sys ? 'sys' : (mine ? 'mine' : 'theirs')) + '">' +
          '<div class="chat-bubble' + (sys ? ' chat-sys' : '') + '">' +
          (!mine && !sys ? '<div class="chat-from">' + (m.fromRole === 'admin' ? '🔐 ' : '👤 ') + escapeHtmlChat(m.fromName) + '</div>' : '') +
          (sys ? '<div class="chat-from">📢 समूह सूचना</div>' : '') +
          '<div class="chat-text">' + escapeHtmlChat(m.text).replace(/\n/g, '<br>') + '</div>' +
          '<div class="chat-time">' + time + delBtn + '</div></div></div>';
      }).join('');
    }
    el.innerHTML = tabs +
      '<div class="section-title">👥 समूह कुराकानी</div>' +
      '<div class="chat-messages" id="chat-messages">' + bubbles + '</div>' +
      '<div class="chat-compose">' +
      '<input type="text" id="chat-input" placeholder="सन्देश लेख्नुहोस्..." onkeydown="if(event.key===\'Enter\')sendGroupChat()">' +
      '<button class="btn btn-primary" onclick="sendGroupChat()">पठाउनुहोस्</button></div>';
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
    return;
  }

  // —— व्यक्तिगत ——
  if (isAdmin) {
    const pins = (data.pinRequests || []).filter(r => r.status === 'pending');
    const complaints = data.complaints || [];
    const active = data.members.filter(m => m.active);
    let rows = '';
    active.forEach(m => {
      const priv = privateUnreadCount(data, m.id, true);
      const pinN = pins.filter(r => r.memberId === m.id).length;
      const compN = complaints.filter(c => c.memberId === m.id && !c.read).length;
      const total = priv + pinN + compN;
      const allP = data.chat.private[m.id] || [];
      const last = allP[allP.length - 1];
      const prev = last ? escapeHtmlChat((last.text || '').slice(0, 36)) + (last.text && last.text.length > 36 ? '…' : '') : 'सन्देश छैन';
      const badge = total
        ? '<span style="background:#dc3545;color:#fff;border-radius:10px;padding:2px 8px;font-size:0.75rem">' + total + '</span>'
        : '';
      rows += '<div class="member-item" onclick="openPersonalBox(\'' + m.id + '\')">' +
        '<div class="member-avatar">' + m.name.charAt(0) + '</div>' +
        '<div class="member-info"><div class="member-name">' + escapeHtmlChat(m.name) + '</div>' +
        '<div class="text-muted" style="font-size:0.78rem">' + prev + '</div></div>' + badge + '</div>';
    });
    el.innerHTML = tabs +
      '<div class="section-title">🔐 व्यक्तिगत (सदस्य छान्नुहोस्)</div>' +
      '<p class="text-muted" style="font-size:0.82rem;margin-bottom:8px">च्याट · PIN · गुनासो एउटै बाकसमा</p>' +
      (rows || '<div class="empty-state">सदस्य छैन</div>');
    return;
  }

  // सदस्य: Admin सँग सिधै
  const mid = Auth.currentUser && Auth.currentUser.memberId;
  if (mid) {
    el.innerHTML = tabs +
      '<div class="section-title">🔐 Admin सँग कुराकानी</div>' +
      '<button class="btn btn-success btn-block mb-2" onclick="openPersonalBox(\'' + mid + '\')">💬 बाकस खोल्नुहोस् (सन्देश · PIN · गुनासो)</button>' +
      '<p class="text-muted" style="font-size:0.85rem">कलेक्सन/ऋणका अटो सन्देश र Admin सँगको कुरा यहाँ</p>';
  } else {
    el.innerHTML = tabs + '<div class="empty-state">लगइन आवश्यक</div>';
  }
}


function privateUnreadCount(data, memberId, forAdmin) {
  if (!data.chat) data.chat = { group: [], private: {} };
  if (!data.chat.readAt) data.chat.readAt = {};
  const msgs = data.chat.private[memberId] || [];
  const key = forAdmin ? ('a_' + memberId) : ('m_' + memberId);
  const since = Number(data.chat.readAt[key]) || 0;
  return msgs.filter(m => {
    const tm = new Date(m.time || 0).getTime();
    if (tm <= since) return false;
    if (forAdmin) return m.from !== 'admin';
    return m.from === 'admin';
  }).length;
}

function markPrivateRead(memberId, forAdmin) {
  const data = DB.load();
  if (!data.chat) data.chat = { group: [], private: {} };
  if (!data.chat.readAt) data.chat.readAt = {};
  const key = forAdmin ? ('a_' + memberId) : ('m_' + memberId);
  data.chat.readAt[key] = Date.now();
  DB.save(data);
}

function setChatMode(mode) {
  window._chatMode = 'group'; // व्यक्तिगत हटाइयो
  renderChatTab();
}

function deleteGroupChatMessage(msgId, fromModal) {
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) {
    return UI.toast('Admin A ले मात्र सन्देश मेट्न मिल्छ', 'error');
  }
  const data = DB.load();
  const msg = ((data.chat && data.chat.group) || []).find(m => m && m.id === msgId);
  const preview = msg && msg.text ? escapeHtmlChat(msg.text.slice(0, 80)) : '';
  const html = `
    <p style="font-size:0.88rem;margin-bottom:8px">के यो सन्देश सबै सदस्यको च्याटबाट सधैँका लागि मेटाउने हो?</p>
    ${preview ? `<div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:8px;font-size:0.82rem;margin-bottom:12px">${preview}</div>` : ''}
    <button type="button" class="btn btn-danger btn-block" onclick="confirmDeleteGroupChatMessage('${escapeHtmlChat(msgId)}', ${!!fromModal})">🗑️ हो, सन्देश मेटाउनुहोस्</button>
  `;
  UI.showModal('🗑️ सन्देश मेटाउने', html, '<button type="button" class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function confirmDeleteGroupChatMessage(msgId, fromModal) {
  const res = await DB.deleteChatMessage(msgId);
  if (!res || !res.ok) {
    return UI.toast((res && res.error) || 'सन्देश मेट्न सकिएन', 'error');
  }
  UI.toast('सन्देश मेटियो ✅', 'success');
  closeModal();
  if (fromModal) {
    openGroupChatFromHome({ replace: true });
  } else {
    renderChatTab();
  }
  renderHomeByRole();
}

function sendGroupChat() {
  const input = document.getElementById('chat-input');
  const text = (input && input.value || '').trim();
  if (!text) return UI.toast('सन्देश लेख्नुहोस्', 'error');
  const sender = _chatSender();
  if (sender.role === 'system') return UI.toast('लगइन आवश्यक', 'error');
  let data = DB.load();
  postGroupMessage(text, 'text', data);
  DB.save(data);
  if (input) input.value = '';
  renderChatTab();
  if (typeof DB.pushChatNow === 'function') {
    DB.pushChatNow().then(function (ok) {
      if (ok) UI.toast('पठाइयो · सिंक', 'success');
    });
  }
}

function openPrivateChat(memberId) {
  openPersonalBox(memberId);
}

/** व्यक्तिगत च्याट हटाइएको */
function openAdminPersonalHub() {
  UI.toast('व्यक्तिगत बाकस हटाइएको छ · समूह च्याट मात्र', 'error');
}

function openPersonalBox(memberId) {
  UI.toast('व्यक्तिगत च्याट हटाइएको छ · समूह कुराकानी / कलेक्सन सारांश प्रयोग गर्नुहोस्', 'error');
}

function sendPrivateChat(memberId) {
  const input = document.getElementById('priv-input');
  const text = (input && input.value || '').trim();
  if (!text) return UI.toast('सन्देश लेख्नुहोस्', 'error');
  let data = DB.load();
  postPrivateMessage(memberId, text, 'text', data);
  DB.save(data);
  openPersonalBox(memberId);
  if (typeof DB.pushChatNow === 'function') {
    DB.pushChatNow().then(function (ok) {
      UI.toast(ok ? 'पठाइयो · सिंक' : 'पठाइयो (लोकल) · सिंक जाँच्नुहोस्', ok ? 'success' : 'error');
    });
  } else {
    UI.toast('पठाइयो', 'success');
  }
}


function showPinRequests() {
  const data = DB.load();
  const list = data.pinRequests || [];
  let html = '';
  if (list.length === 0) {
    html = '<div class="empty-state">कुनै अनुरोध छैन</div>';
  } else {
    list.slice().reverse().forEach(r => {
      html += `<div class="section-card" style="cursor:pointer" onclick="resolvePinRequest('${r.id}')">
        <div class="fw-bold">${r.memberName}</div>
        <div class="text-muted">${r.mobile} · ${new Date(r.time).toLocaleString()}</div>
        <div class="mt-1">${r.status === 'pending' ? '⏳ थिचेर समाधान गर्नुहोस्' : '✅ स्वीकृत'}</div>
      </div>`;
    });
  }
  UI.showModal('🔢 PIN अनुरोध', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function resolvePinRequest(reqId) {
  const data = DB.load();
  const r = (data.pinRequests || []).find(x => x.id === reqId);
  if (!r || r.status !== 'pending') return openMemberDetail(r.memberId);
  // Go directly to set PIN for that member
  closeModal();
  showSetPin(r.memberId);
}

function showComplaints() {
  const data = DB.load();
  const list = data.complaints || [];
  let html = '';
  if (list.length === 0) {
    html = '<div class="empty-state">कुनै गुनासो छैन</div>';
  } else {
    list.slice().reverse().forEach(c => {
      const m = data.members.find(x => x.id === c.memberId);
      const badge = c.read ? '' : ' <span class="member-badge badge-due">नयाँ</span>';
      html += `<div class="section-card" style="cursor:pointer" onclick="openComplaintDetail('${c.id}')">
        <div class="fw-bold">${m ? m.name : c.memberId}${badge}</div>
        <div class="text-muted">${new Date(c.time).toLocaleString()}</div>
        <p class="mt-1">${c.text.substring(0, 60)}${c.text.length > 60 ? '...' : ''}</p>
      </div>`;
    });
  }
  UI.showModal('📢 गुनासोहरू', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function openComplaintDetail(cId) {
  const data = DB.load();
  const c = (data.complaints || []).find(x => x.id === cId);
  if (!c) return;
  c.read = true;
  DB.save(data);
  const m = data.members.find(x => x.id === c.memberId);
  let replies = (c.replies || []).map(r =>
    `<div style="margin:8px 0;padding:8px 12px;background:${r.from==='admin'?'#e7f1ff':'#f8f9fa'};border-radius:10px;font-size:0.9rem">
      <strong>${r.from === 'admin' ? 'Admin' : (m?m.name:'सदस्य')}:</strong> ${r.text}
      <div class="text-muted" style="font-size:0.7rem">${new Date(r.time).toLocaleString()}</div>
    </div>`).join('');

  const html = `
    <div class="fw-bold">${m ? m.name : c.memberId}</div>
    <div class="text-muted mb-1">${new Date(c.time).toLocaleString()}</div>
    <div class="section-card">${c.text}</div>
    ${replies}
    ${Auth.isAdmin() ? `
      <div class="form-group mt-2"><label>जवाफ लेख्नुहोस्</label>
        <textarea id="complaint-reply" rows="2" placeholder="जवाफ..."></textarea>
      </div>
      <button class="btn btn-primary btn-block" onclick="replyComplaint('${cId}')">📤 जवाफ पठाउनुहोस्</button>
    ` : ''}
  `;
  UI.showModal('📢 गुनासो', html, '<button class="btn btn-outline" onclick="showComplaints()">← फर्कनुहोस्</button>');
}

function openReplyComplaintForm(cId) {
  const html = `
    <div class="form-group"><label>जवाफ लेख्नुहोस्</label>
      <textarea id="complaint-reply" rows="3" placeholder="Admin जवाफ..."></textarea>
    </div>
    <button class="btn btn-primary btn-block" onclick="replyComplaint('${cId}')">📤 जवाफ पठाउनुहोस्</button>
  `;
  const data = DB.load();
  const c = (data.complaints || []).find(x => x.id === cId);
  const mid = c && c.memberId;
  UI.showModal('💬 जवाफ', html, mid
    ? '<button class="btn btn-outline" onclick="openMemberDetail(\'' + mid + '\')">← प्रोफाइल</button>'
    : '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function replyComplaint(cId) {
  const text = document.getElementById('complaint-reply').value.trim();
  if (!text) return UI.toast('जवाफ लेख्नुहोस्', 'error');
  const data = DB.load();
  const c = (data.complaints || []).find(x => x.id === cId);
  if (!c) return;
  c.replies = c.replies || [];
  c.replies.push({ from: 'admin', text, time: new Date().toISOString(), readByMember: false });
  c.read = true;
  DB.save(data);
  UI.toast('जवाफ पठाइयो', 'success');
  if (c.memberId) openMemberDetail(c.memberId);
  else openComplaintDetail(cId);
}

function showComplaintForm() {
  const html = `
    <div class="form-group">
      <label>तपाईंको गुनासो / सुझाव</label>
      <textarea id="complaint-text" rows="4" placeholder="लेख्नुहोस्..."></textarea>
    </div>
    <button class="btn btn-warning btn-block" onclick="submitComplaint()">📤 पठाउनुहोस्</button>
  `;
  UI.showModal('📢 गुनासो', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function submitComplaint() {
  const text = document.getElementById('complaint-text').value.trim();
  if (!text) return UI.toast('केही लेख्नुहोस्', 'error');
  const data = DB.load();
  const item = {
    id: 'c_' + Date.now(),
    memberId: Auth.currentUser.memberId,
    text,
    time: new Date().toISOString(),
    read: false,
    replies: []
  };
  data.complaints = data.complaints || [];
  data.complaints.push(item);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({ id: item.id, kind: 'complaint', text: item.text });
  }
  UI.toast('गुनासो पठाइयो', 'success');
  closeModal();
}

function editAdminProfile() {
  const data = DB.load();
  const html = `
    <div class="form-group"><label>नाम</label><input type="text" id="ea-name" value="${data.admin.name}"></div>
    <div class="form-group"><label>Username</label><input type="text" id="ea-user" value="${data.admin.username}"></div>
    <div class="form-group"><label>नयाँ Password (खाली राखे नबदलिने)</label><input type="password" id="ea-pass"></div>
    <div class="form-group"><label>मोबाइल</label><input type="tel" id="ea-mobile" value="${data.admin.mobile}"></div>
    <div class="form-group"><label>नयाँ PIN (खाली राखे नबदलिने)</label><input type="password" id="ea-pin" maxlength="4"></div>
    <button class="btn btn-primary btn-block" onclick="saveAdminProfile()">💾 सेभ</button>
  `;
  UI.showModal('✏️ Admin प्रोफाइल', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function saveAdminProfile() {
  const data = DB.load();
  const nextName = document.getElementById('ea-name').value.trim() || data.admin.name;
  const nextUser = document.getElementById('ea-user').value.trim() || data.admin.username;
  const pass = document.getElementById('ea-pass').value;
  const nextMobile = document.getElementById('ea-mobile').value.trim() || data.admin.mobile;
  const pin = document.getElementById('ea-pin').value;
  if (pin && (pin.length !== 4 || !/^\d{4}$/.test(pin))) {
    return UI.toast('PIN ४ अंकको हुनुपर्छ', 'error');
  }

  const credRes = await DB.syncCredentialChange({
    type: 'admin_profile',
    name: nextName,
    username: nextUser,
    password: pass || undefined,
    mobile: nextMobile,
    pin: pin || undefined
  });
  if (!credRes || !credRes.ok) {
    return UI.toast((credRes && credRes.error) || 'क्लाउड सेभ असफल — नेट जाँच्नुहोस्', 'error');
  }

  if (credRes.token) DB.setToken(credRes.token);
  if (credRes.user) Auth.currentUser = credRes.user;
  if (credRes.pinVerifier) Auth.setPinVerifier(credRes.pinVerifier);
  Auth.saveSession();

  data.admin.name = nextName;
  data.admin.username = nextUser;
  data.admin.mobile = nextMobile;
  if (pin) data.admin.hasPin = true;
  delete data.admin.password;
  delete data.admin.pin;
  if (data.settings) {
    data.settings.closePin = '';
    data.settings.accountsWriterUsername = nextUser;
  }
  const m = data.members.find(x => x.id === data.admin.memberId);
  if (m) { m.name = nextName; m.mobile = nextMobile; }
  DB.save(data);
  UI.toast('सेभ भयो', 'success');
  closeModal();
  renderProfileTab();
}

// ========== SETTINGS ==========
function renderSettingsTab() {
  const container = document.getElementById('settings-content');
  if (!Auth.isAdmin()) {
    const dataM = DB.load();
    const myId = (Auth.currentUser && Auth.currentUser.memberId) || '';
    const fbN = myId ? memberFeedbackUnread(myId, dataM) : 0;
    const fbBadge = fbN > 0 ? ' <span class="badge-unread">' + fbN + ' जवाफ</span>' : '';
    container.innerHTML = `
      <div class="section-card">
        <div class="section-title">⚙️ सेटिङ</div>
        <button class="btn btn-primary btn-block mb-1" onclick="showChangeOwnPinModal()">🔐 मेरो PIN परिवर्तन गर्नुहोस्</button>
        <button class="btn btn-warning btn-block mb-1" onclick="openMemberFeedbackHub()">📢 सुझाव तथा गुनासो${fbBadge}</button>
        <button class="btn btn-success btn-block mb-1" onclick="enablePushFromSettings()">🔔 पुश सूचना (Notification)</button>
        <button class="btn btn-outline btn-block mb-1" onclick="showMemberGuideTour(0, true)">❓ एप चलाउने गाइड</button>
        <button class="btn btn-danger btn-block mb-2" onclick="doLogout()">🚪 लगआउट</button>
      </div>
      ${appOwnerCardHtml(dataM)}
    `;
    return;
  }

  const data = DB.load();
  container.innerHTML = `
    <div class="section-card">
      <div class="section-title">⚙️ सेटिङ</div>
      <ul class="settings-list">
        <li class="settings-item" onclick="editAccountsWriter()">
          <div class="settings-icon" style="background:#fff3cd">✍️</div>
          <div class="settings-text"><div class="title">हिसाब सिंक (Admin A)</div><div class="desc">कुन Admin ले क्लाउडमा लेख्ने</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="editSecondaryAdmin()">
          <div class="settings-icon" style="background:#e2e3ff">👁️</div>
          <div class="settings-text"><div class="title">Admin B (हेर्ने)</div><div class="desc">लगइन Admin · हिसाब overwrite गर्दैन</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="editAppOwner()">
          <div class="settings-icon" style="background:#cfe2ff">🪪</div>
          <div class="settings-text"><div class="title">App Owner card</div><div class="desc">member settings card</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="showShareAppQr()">
          <div class="settings-icon" style="background:#d1e7dd">📱</div>
          <div class="settings-text"><div class="title">Share app</div><div class="desc">QR code · open link</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="editGroupProfile()">
          <div class="settings-icon" style="background:#e7f1ff">🏛️</div>
          <div class="settings-text"><div class="title">समूह प्रोफाइल</div><div class="desc">नाम, ठेगाना, स्थापना मिति</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="showCloudSetup()">
          <div class="settings-icon" style="background:#cfe2ff">☁️</div>
          <div class="settings-text"><div class="title">क्लाउड सिंक (Cloudflare)</div><div class="desc">D1 / R2 स्थिति र म्यानुअल सिंक</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="enablePushFromSettings()">
          <div class="settings-icon" style="background:#d1e7dd">🔔</div>
          <div class="settings-text"><div class="title">पुश सूचना (Web Push)</div><div class="desc">ब्याकग्राउन्ड सूचना अनुमति र बैठक रिमाइन्डर</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="runAccountingAuditCheck()">
          <div class="settings-icon" style="background:#d1e7dd">🧮</div>
          <div class="settings-text"><div class="title">हिसाब मिलान अडिट</div><div class="desc">सम्पत्ति, नगद, ऋण र सदस्य हिसाब क्रस-चेक</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="openSnapshotBackups()">
          <div class="settings-icon" style="background:#e2e3ff">🗂️</div>
          <div class="settings-text"><div class="title">बन्द महिना स्न्यापसट (R2)</div><div class="desc">प्रत्येक बन्द महिनाको सुरक्षित ब्याकअप</div></div>
          <div class="settings-arrow">›</div>
        </li>

        <li class="settings-item" onclick="editRates()">
          <div class="settings-icon" style="background:#d1e7dd">💰</div>
          <div class="settings-text"><div class="title">दर र शुल्क</div><div class="desc">बचत, ब्याज, जरिवाना, कित्ता शुल्क</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="showAppGuide()">
          <div class="settings-icon" style="background:#fff3cd">📖</div>
          <div class="settings-text"><div class="title">एप गाइड / सूत्र</div><div class="desc">सबै हिसाब सूत्रहरू</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="doExportBackup()">
          <div class="settings-icon" style="background:#cff4fc">📤</div>
          <div class="settings-text"><div class="title">Export ब्याकअप</div><div class="desc">JSON फाइल डाउनलोड / सेभ</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="triggerImport()">
          <div class="settings-icon" style="background:#e0cffc">📥</div>
          <div class="settings-text"><div class="title">Import ब्याकअप</div><div class="desc">JSON · क्लाउड पूरै overwrite</div></div>
          <div class="settings-arrow">›</div>
        </li>
        <li class="settings-item" onclick="doLogout()">
          <div class="settings-icon" style="background:#f8d7da">🚪</div>
          <div class="settings-text"><div class="title">लगआउट</div><div class="desc">एपबाट बाहिरिनुहोस्</div></div>
          <div class="settings-arrow">›</div>
        </li>
      </ul>
    </div>
    <input type="file" id="import-file" accept=".json" class="hidden" onchange="doImport(event)">
  `;
}

function showChangeOwnPinModal() {
  const html = `
    <p class="text-muted" style="font-size:0.84rem;margin-bottom:10px">नयाँ PIN राखेपछि पुरानो PIN चल्दैन (इन्टरनेट आवश्यक)।</p>
    <div class="form-group"><label>अहिलेको (पुरानो) PIN</label>
      <input type="password" id="cp-old" maxlength="4" inputmode="numeric" placeholder="४ अंक">
    </div>
    <div class="form-group"><label>नयाँ PIN (४ अंक)</label>
      <input type="password" id="cp-new1" maxlength="4" inputmode="numeric" placeholder="नयाँ ४ अंक">
    </div>
    <div class="form-group"><label>नयाँ PIN फेरि लेख्नुहोस्</label>
      <input type="password" id="cp-new2" maxlength="4" inputmode="numeric" placeholder="फेरि त्यही ४ अंक">
    </div>
    <button type="button" class="btn btn-primary btn-block" onclick="submitChangeOwnPin()">✅ PIN परिवर्तन गर्नुहोस्</button>
  `;
  UI.showModal('🔐 मेरो PIN परिवर्तन', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function submitChangeOwnPin() {
  const oldP = (document.getElementById('cp-old').value || '').trim();
  const n1 = (document.getElementById('cp-new1').value || '').trim();
  const n2 = (document.getElementById('cp-new2').value || '').trim();
  if (n1 !== n2) return UI.toast('नयाँ PIN मिलेन', 'error');
  const res = await Auth.changeOwnPin(oldP, n1);
  UI.toast(res.msg, res.ok ? 'success' : 'error');
  if (res.ok) closeModal();
}



function editAccountsWriter() {
  if (!(Auth.isAdmin && Auth.isAdmin())) return UI.toast('Admin मात्र', 'error');
  if (Auth.currentUser && Auth.currentUser.role === 'admin_ro') {
    return UI.toast('Admin B ले यो बदल्न सक्दैन · Admin A चाहिन्छ', 'error');
  }
  const data = DB.load();
  const cur = (data.settings && data.settings.accountsWriterUsername) || (data.admin && data.admin.username) || '';
  const html = `
    <p class="text-muted" style="font-size:0.82rem">यस username ले मात्र हिसाब Cloudflare D1 मा लेख्छ (Admin A)। अरू Admin/सदस्य पढ्ने मात्र।</p>
    <div class="form-group"><label>Admin A username</label>
      <input type="text" id="aw-user" value="${cur}" placeholder="${(data.admin && data.admin.username) || ''}">
    </div>
    <button class="btn btn-primary btn-block" onclick="saveAccountsWriter()">💾 सेभ</button>
  `;
  UI.showModal('✍️ हिसाब सिंक Admin A', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}
function saveAccountsWriter() {
  const data = DB.load();
  if (!data.settings) data.settings = {};
  const v = (document.getElementById('aw-user').value || '').trim();
  if (!v) return UI.toast('username चाहिन्छ', 'error');
  data.settings.accountsWriterUsername = v;
  DB.save(data);
  if (Auth.currentUser && Auth.currentUser.role === 'admin') {
    Auth.currentUser.accountsWriter = (v === (data.admin && data.admin.username));
    Auth.saveSession();
  }
  UI.toast('Admin A सेट भयो · फेरि लगइन गर्नुहोस्', 'success');
  closeModal();
}
function editSecondaryAdmin() {
  if (!(Auth.isAdmin && Auth.isAdmin())) return UI.toast('Admin मात्र', 'error');
  if (Auth.currentUser && Auth.currentUser.role === 'admin_ro') {
    return UI.toast('Admin B ले यो बदल्न सक्दैन', 'error');
  }
  const data = DB.load();
  const list = data.secondaryAdmins || [];
  let rows = list.map(function (s, i) {
    return '<div class="section-card" style="padding:8px;margin-bottom:6px">' +
      '<div class="fw-bold">' + (s.name || s.username) + '</div>' +
      '<div class="text-muted" style="font-size:0.8rem">@' + s.username + ((s.hasPin || s.pin) ? ' · PIN सेट' : ' · PIN छैन') + '</div>' +
      '<button type="button" class="btn btn-danger btn-sm mt-1" onclick="removeSecondaryAdmin(' + i + ')">हटाउनुहोस्</button></div>';
  }).join('') || '<div class="text-muted">अहिले Admin B छैन</div>';
  const html = `
    <p class="text-muted" style="font-size:0.82rem">Admin B: Admin जस्तै लगइन · हिसाब क्लाउडमा लेख्दैन · A को हिसाब आफैं देखिन्छ</p>
    ${rows}
    <hr>
    <div class="form-group"><label>नाम</label><input type="text" id="sa-name" placeholder="नाम"></div>
    <div class="form-group"><label>username</label><input type="text" id="sa-user" placeholder="unique username"></div>
    <div class="form-group"><label>password</label><input type="password" id="sa-pass" placeholder="password"></div>
    <div class="form-group"><label>PIN (४ अंक) · लगआउट/लक</label><input type="password" id="sa-pin" maxlength="4" inputmode="numeric" placeholder="४ अंक"></div>
    <div class="form-group"><label>PIN Confirm</label><input type="password" id="sa-pin2" maxlength="4" inputmode="numeric" placeholder="फेरि PIN"></div>
    <button class="btn btn-primary btn-block" onclick="addSecondaryAdmin()">➕ Admin B थप्नुहोस्</button>
  `;
  UI.showModal('👁️ Admin B', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}
async function addSecondaryAdmin() {
  const name = (document.getElementById('sa-name').value || '').trim();
  const username = (document.getElementById('sa-user').value || '').trim();
  const password = (document.getElementById('sa-pass').value || '').trim();
  const pin = (document.getElementById('sa-pin') && document.getElementById('sa-pin').value || '').trim();
  const pin2 = (document.getElementById('sa-pin2') && document.getElementById('sa-pin2').value || '').trim();
  if (!username || !password) return UI.toast('username र password चाहिन्छ', 'error');
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) return UI.toast('PIN ठीक ४ अंकको हुनुपर्छ', 'error');
  if (pin !== pin2) return UI.toast('PIN मिल्दैन', 'error');
  const data = DB.load();
  if (data.admin && data.admin.username === username) {
    return UI.toast('मुख्य Admin username सँग मिल्नु हुँदैन', 'error');
  }
  data.secondaryAdmins = data.secondaryAdmins || [];
  if (data.secondaryAdmins.some(function (s) { return s.username === username; })) {
    return UI.toast('यो username पहिले नै छ', 'error');
  }
  const credRes = await DB.syncCredentialChange({
    type: 'secondary_add',
    name: name || username,
    username,
    password,
    pin
  });
  if (!credRes || !credRes.ok) {
    return UI.toast((credRes && credRes.error) || 'Admin B थप्न सकिएन', 'error');
  }
  data.secondaryAdmins.push({ name: name || username, username: username, active: true, hasPin: true });
  DB.save(data);
  UI.toast('Admin B थपियो', 'success');
  editSecondaryAdmin();
}
async function removeSecondaryAdmin(i) {
  const data = DB.load();
  data.secondaryAdmins = data.secondaryAdmins || [];
  const item = data.secondaryAdmins[i];
  if (item && item.username) {
    await DB.syncCredentialChange({ type: 'secondary_remove', username: item.username });
  }
  data.secondaryAdmins.splice(i, 1);
  DB.save(data);
  UI.toast('हटाइयो', 'success');
  editSecondaryAdmin();
}

function editAppOwner() {
  if (!(Auth.isAdmin && Auth.isAdmin())) return UI.toast('Admin only', 'error');
  const data = DB.load();
  const o = (data.settings && data.settings.appOwner) || {};
  const html = `
    <p class="text-muted" style="font-size:0.78rem;margin-bottom:8px">Shown on member settings · empty fields hide · english / small text</p>
    <div class="form-group"><label>name *</label><input type="text" id="ao-name" value="${o.name||''}" placeholder="full name"></div>
    <div class="form-group"><label>title</label><input type="text" id="ao-title" value="${o.title||''}" placeholder="app owner · developer"></div>
    <div class="form-group"><label>mobile</label><input type="tel" id="ao-mobile" value="${o.mobile||''}" placeholder="98xxxxxxxx"></div>
    <div class="form-group"><label>email</label><input type="email" id="ao-email" value="${o.email||''}" placeholder="optional"></div>
    <div class="form-group"><label>website</label><input type="text" id="ao-website" value="${o.website||''}" placeholder="https://..."></div>
    <div class="form-group"><label>facebook</label><input type="text" id="ao-facebook" value="${o.facebook||''}" placeholder="page or profile url"></div>
    <div class="form-group"><label>whatsapp</label><input type="tel" id="ao-whatsapp" value="${o.whatsapp||''}" placeholder="with country code"></div>
    <div class="form-group"><label>address</label><input type="text" id="ao-address" value="${o.address||''}" placeholder="optional"></div>
    <div class="form-group"><label>note</label><textarea id="ao-note" rows="2" placeholder="short note">${o.note||''}</textarea></div>
    <p class="text-muted" style="font-size:0.72rem">photo: default light image in app (owner-photo.jpg). custom upload not stored in cloud to keep sync light.</p>
    <button class="btn btn-primary btn-block" onclick="saveAppOwner()">save</button>
  `;
  UI.showModal('app owner card', html, '<button class="btn btn-outline" onclick="closeModal()">close</button>');
}

function saveAppOwner() {
  const data = DB.load();
  if (!data.settings) data.settings = {};
  data.settings.appOwner = {
    name: (document.getElementById('ao-name').value || '').trim(),
    title: (document.getElementById('ao-title').value || '').trim(),
    mobile: (document.getElementById('ao-mobile').value || '').trim(),
    email: (document.getElementById('ao-email').value || '').trim(),
    website: (document.getElementById('ao-website').value || '').trim(),
    facebook: (document.getElementById('ao-facebook').value || '').trim(),
    whatsapp: (document.getElementById('ao-whatsapp').value || '').trim(),
    address: (document.getElementById('ao-address').value || '').trim(),
    note: (document.getElementById('ao-note').value || '').trim(),
    photo: './owner-photo.jpg'
  };
  DB.save(data);
  UI.toast('app owner saved', 'success');
  closeModal();
}

function showShareAppQr() {
  if (!(Auth.isAdmin && Auth.isAdmin())) return UI.toast('Admin only', 'error');
  const url = (location.origin + location.pathname).replace(/\/index\.html$/i, '/').replace(/\/$/, '/') || location.href;
  const full = location.href.split('#')[0].split('?')[0];
  const link = full;
  const qr = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=' + encodeURIComponent(link);
  const html = `
    <p style="font-size:0.85rem;text-align:center;margin-bottom:10px">scan with any phone camera / QR app</p>
    <div style="text-align:center">
      <img src="${qr}" alt="QR" width="220" height="220" style="border-radius:12px;border:1px solid #dee2e6;background:#fff"/>
    </div>
    <p style="font-size:0.72rem;word-break:break-all;margin-top:10px;text-align:center;color:#555">${link}</p>
    <button type="button" class="btn btn-primary btn-block mt-2" onclick="navigator.clipboard.writeText('${link.replace(/'/g, "\'")}').then(()=>UI.toast('link copied','success')).catch(()=>UI.toast('copy manually','error'))">copy link</button>
  `;
  UI.showModal('share app', html, '<button class="btn btn-outline" onclick="closeModal()">close</button>');
}


function editGroupProfile() {
  const data = DB.load();
  const g = data.group || {};
  const th = (data.settings && data.settings.theme) || {};
  const html = `
    <div class="form-group"><label>समूह नाम</label><input type="text" id="gp-name" value="${g.name||''}"></div>
    <div class="form-group"><label>ठेगाना</label><input type="text" id="gp-address" value="${g.address||''}"></div>
    <div class="form-group"><label>स्थापना मिति</label><input type="text" id="gp-est" value="${g.established||''}" placeholder="उदा: २०७५ साउन"></div>
    <div class="form-group"><label>लोगो इमोजी</label><input type="text" id="gp-logo" value="${g.logo||'💰'}" maxlength="4"></div>
    <div class="form-group">
      <label>📷 लोगो फोटो (ग्यालरी)</label>
      <input type="file" id="gp-logo-file" accept="image/*">
      ${g.logoImage ? '<img src="'+g.logoImage+'" style="max-height:64px;margin-top:6px;border-radius:8px"/>' : ''}
      ${g.logoImage ? '<button type="button" class="btn btn-light btn-sm mt-1" onclick="clearGroupLogoImage()">फोटो हटाउनुहोस्</button>' : ''}
    </div>
    <div class="form-group">
      <label>🎬 स्वागत भिडियो (१०–१२ सेकेन्ड, वैकल्पिक)</label>
      <input type="file" id="gp-welcome-video" accept="video/*">
      <p class="text-muted" style="font-size:0.72rem">लगइन पछि लोडिङमा बज्छ। ठूलो फाइल नराख्नुहोस्।</p>
      ${g.welcomeVideo ? '<span class="text-success" style="font-size:0.8rem">भिडियो सेभ छ</span> <button type="button" class="btn btn-light btn-sm" onclick="clearWelcomeVideo()">हटाउनुहोस्</button>' : ''}
    </div>
    <div class="section-title" style="margin-top:12px">🎨 थिम (हिसाब पढ्न मिल्ने)</div>
    <div class="form-group"><label>मुख्य रङ</label><input type="color" id="gp-theme-color" value="${th.color||'#1a5f4a'}"></div>
    <div class="form-group">
      <label>बैकग्राउन्ड फोटो (हल्का)</label>
      <input type="file" id="gp-theme-photo" accept="image/*">
      ${th.photo ? '<img src="'+th.photo+'" style="max-height:48px;margin-top:6px;border-radius:8px;opacity:0.7"/>' : ''}
    </div>
    <div class="form-group"><label>फोटो पारदर्शिता (०.०५–०.३५)</label>
      <input type="number" id="gp-theme-opacity" min="0.05" max="0.35" step="0.05" value="${th.opacity!=null?th.opacity:0.12}">
    </div>
    <button class="btn btn-primary btn-block" onclick="saveGroupProfile()">💾 सेभ</button>
  `;
  UI.showModal('👥 समूह प्रोफाइल / थिम', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

function clearGroupLogoImage() {
  const data = DB.load();
  data.group.logoImage = '';
  DB.save(data);
  UI.toast('लोगो फोटो हटाइयो', 'success');
  editGroupProfile();
}

function clearWelcomeVideo() {
  const data = DB.load();
  data.group.welcomeVideo = '';
  DB.save(data);
  UI.toast('भिडियो हटाइयो', 'success');
  editGroupProfile();
}

function dataUrlByteSize(dataUrl) {
  if (!dataUrl) return 0;
  const i = dataUrl.indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

function encodeCanvasUnderLimit(srcDrawFn, initW, initH, targetBytes) {
  let w = initW, h = initH;
  const qualities = [0.82, 0.72, 0.62, 0.52, 0.42, 0.34];
  let best = '';
  for (let step = 0; step < 3; step++) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    srcDrawFn(ctx, w, h);
    for (let qi = 0; qi < qualities.length; qi++) {
      const url = c.toDataURL('image/jpeg', qualities[qi]);
      best = url;
      if (dataUrlByteSize(url) <= targetBytes) return url;
    }
    w = Math.round(w * 0.78);
    h = Math.round(h * 0.78);
  }
  return best;
}

function compressImageFile(file, opts, cb) {
  if (!file) return cb(null);
  const targetBytes = (opts && opts.targetBytes) || 85000;
  const maxW = (opts && opts.maxW) || 360;
  const maxH = (opts && opts.maxH) || 450;
  const passport = !!(opts && opts.passport);
  const objUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function () {
    URL.revokeObjectURL(objUrl);
    let outW = maxW, outH = maxH;
    if (!passport) {
      const sc = Math.min(1, maxW / img.width, maxH / img.height);
      outW = Math.max(120, Math.round(img.width * sc));
      outH = Math.max(120, Math.round(img.height * sc));
    }
    const out = encodeCanvasUnderLimit(function (ctx, w, h) {
      if (passport) {
        const aspect = w / h;
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (img.width / img.height > aspect) {
          sw = img.height * aspect;
          sx = (img.width - sw) / 2;
        } else {
          sh = img.width / aspect;
          sy = Math.max(0, (img.height - sh) * 0.25);
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      } else {
        ctx.drawImage(img, 0, 0, w, h);
      }
    }, outW, outH, targetBytes);
    cb(out);
  };
  img.onerror = function () {
    URL.revokeObjectURL(objUrl);
    cb(null);
  };
  img.src = objUrl;
}

function openPassportPhotoUpload(memberId) {
  const data = DB.load();
  const member = (data.members || []).find(m => m.id === memberId);
  if (Auth.isMember && Auth.isMember() && member && member.photo && member.photoLocked !== false) {
    return UI.toast('तपाईंले फोटो एक पटक राखिसक्नुभएको छ। बदल्नुपरे Admin बाट रिसेट गराउनुहोस्।', 'error');
  }
  let inp = document.getElementById('passport-photo-picker');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'passport-photo-picker';
    inp.accept = 'image/*';
    inp.className = 'hidden';
    document.body.appendChild(inp);
  }
  inp.value = '';
  inp.onchange = function (ev) {
    const file = ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(objUrl);
      showPassportCropModal(memberId, img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(objUrl);
      UI.toast('यो फोटो पढ्न सकिएन', 'error');
    };
    img.src = objUrl;
  };
  inp.click();
}

function showPassportCropModal(memberId, img) {
  const cw = 240, ch = 300; // 4:5 passport preview
  const baseScale = Math.max(cw / img.width, ch / img.height);
  const state = {
    img,
    memberId,
    cw,
    ch,
    baseScale,
    zoom: 1,
    offX: (cw - img.width * baseScale) / 2,
    offY: Math.max(cw * -0.5, Math.min(0, (ch - img.height * baseScale) * 0.28))
  };
  window._ppCrop = state;

  const html = `
    <p class="text-muted text-center" style="font-size:0.8rem;margin-bottom:8px">
      औंलाले फोटो तानेर अनुहार फ्रेमभित्र मिलाउनुहोस् — पासपोर्ट साइज (&lt; 85 KB) मा स्वतः सानो भएर सेभ हुन्छ।
    </p>
    <div style="display:flex;justify-content:center;margin-bottom:10px">
      <canvas id="pp-crop-canvas" width="${cw}" height="${ch}" style="border-radius:12px;border:2px solid #0d6efd;touch-action:none;cursor:grab;background:#f8f9fa"></canvas>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:0.82rem">🔍 जुम</span>
      <input type="range" id="pp-zoom-range" min="1" max="3" step="0.05" value="1" style="flex:1" oninput="updatePassportZoom(this.value)">
      <button type="button" class="btn btn-light btn-sm" onclick="resetPassportCrop()">रिसेट</button>
    </div>
    <button type="button" id="pp-save-btn" class="btn btn-success btn-block" onclick="saveCroppedPassportPhoto()">✅ क्रप गरी सेभ गर्नुहोस्</button>
  `;
  UI.showModal('📷 पासपोर्ट फोटो क्रप', html, '<button type="button" class="btn btn-outline" onclick="closeModal()">रद्द</button>');

  const canvas = document.getElementById('pp-crop-canvas');
  if (!canvas) return;
  let dragging = false, lx = 0, ly = 0;
  function ptr(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }
  function down(e) { e.preventDefault(); dragging = true; const p = ptr(e); lx = p.x; ly = p.y; }
  function move(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = ptr(e);
    state.offX += (p.x - lx);
    state.offY += (p.y - ly);
    lx = p.x; ly = p.y;
    clampPassportCrop(state);
    drawPassportPreview();
  }
  function up() { dragging = false; }
  canvas.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', up);
  clampPassportCrop(state);
  drawPassportPreview();
}

function clampPassportCrop(st) {
  const sc = st.baseScale * st.zoom;
  const dw = st.img.width * sc;
  const dh = st.img.height * sc;
  if (dw <= st.cw) st.offX = (st.cw - dw) / 2;
  else st.offX = Math.min(0, Math.max(st.cw - dw, st.offX));
  if (dh <= st.ch) st.offY = (st.ch - dh) / 2;
  else st.offY = Math.min(0, Math.max(st.ch - dh, st.offY));
}

function drawPassportPreview() {
  const st = window._ppCrop;
  const canvas = document.getElementById('pp-crop-canvas');
  if (!st || !canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, st.cw, st.ch);
  const sc = st.baseScale * st.zoom;
  ctx.drawImage(st.img, st.offX, st.offY, st.img.width * sc, st.img.height * sc);

  // Subtle dashed passport head/frame guide (preview only)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.ellipse(st.cw / 2, st.ch * 0.42, st.cw * 0.27, st.ch * 0.25, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function updatePassportZoom(val) {
  const st = window._ppCrop;
  if (!st) return;
  const newZ = Math.max(1, Math.min(3, parseFloat(val) || 1));
  const oldSc = st.baseScale * st.zoom;
  const newSc = st.baseScale * newZ;
  const cx = st.cw / 2, cy = st.ch / 2;
  st.offX = cx - ((cx - st.offX) / oldSc) * newSc;
  st.offY = cy - ((cy - st.offY) / oldSc) * newSc;
  st.zoom = newZ;
  clampPassportCrop(st);
  drawPassportPreview();
}

function resetPassportCrop() {
  const st = window._ppCrop;
  if (!st) return;
  st.zoom = 1;
  const zr = document.getElementById('pp-zoom-range');
  if (zr) zr.value = '1';
  st.offX = (st.cw - st.img.width * st.baseScale) / 2;
  st.offY = (st.ch - st.img.height * st.baseScale) * 0.28;
  clampPassportCrop(st);
  drawPassportPreview();
}

function analyzePassportFacePixels(data, w, h) {
  let sumL = 0, sumL2 = 0, total = 0;
  let headCount = 0, skinHead = 0, coreCount = 0, skinCore = 0;
  let skinSumL = 0, skinSumL2 = 0;
  let eyeDark = 0, eyeCount = 0;
  const lum = new Float32Array(w * h);

  const y0 = Math.floor(h * 0.16), y1 = Math.ceil(h * 0.68);
  const x0 = Math.floor(w * 0.24), x1 = Math.ceil(w * 0.76);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      lum[y * w + x] = Y;

      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        sumL += Y;
        sumL2 += Y * Y;
        total++;

        const nx = (x / w - 0.50) / 0.25;
        const ny = (y / h - 0.42) / 0.23;
        if (nx * nx + ny * ny <= 1.0) {
          headCount++;
          const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          const isSkin = (
            Y >= 38 && Y <= 246 &&
            Cb >= 74 && Cb <= 130 &&
            Cr >= 131 && Cr <= 178 &&
            (Cr - Cb) >= 12 &&
            r >= g - 5 &&
            r > b + 6
          );
          if (isSkin) {
            skinHead++;
            skinSumL += Y;
            skinSumL2 += Y * Y;
          }
          const cnx = (x / w - 0.50) / 0.14;
          const cny = (y / h - 0.45) / 0.14;
          if (cnx * cnx + cny * cny <= 1.0) {
            coreCount++;
            if (isSkin) skinCore++;
          }
        }
      }
    }
  }

  if (!total || !headCount || !coreCount) {
    return { ok: false, reason: 'फोटो पढ्न सकिएन।' };
  }
  const meanL = sumL / total;
  const stdL = Math.sqrt(Math.max(0, sumL2 / total - meanL * meanL));
  if (meanL < 32 || meanL > 240 || stdL < 14) {
    return { ok: false, reason: 'फोटो धेरै अँध्यारो, सेतो वा खाली देखियो — स्पष्ट अनुहार भएको फोटो छान्नुहोस्।' };
  }

  const skinRatioHead = skinHead / headCount;
  const skinRatioCore = skinCore / coreCount;
  if (skinRatioHead < 0.24 || skinRatioCore < 0.30) {
    return { ok: false, reason: 'यो फोटोमा मान्छेको अनुहार (Passport Portrait) देखिएन। कागज, दृश्य वा अन्य वस्तु स्वीकार हुँदैन।' };
  }

  const skinMeanL = skinSumL / Math.max(1, skinHead);
  const skinStdL = Math.sqrt(Math.max(0, skinSumL2 / Math.max(1, skinHead) - skinMeanL * skinMeanL));
  if (skinStdL < 7.5) {
    return { ok: false, reason: 'फोटो वास्तविक अनुहार जस्तो देखिएन — स्पष्ट मान्छेको फोटो छान्नुहोस्।' };
  }

  // Eye / eyebrow contrast band inside face oval (y: 0.30..0.44, x: 0.33..0.67)
  const ey0 = Math.floor(h * 0.30), ey1 = Math.ceil(h * 0.44);
  const ex0 = Math.floor(w * 0.33), ex1 = Math.ceil(w * 0.67);
  for (let y = ey0; y < ey1; y++) {
    for (let x = ex0; x < ex1; x++) {
      eyeCount++;
      if (lum[y * w + x] < skinMeanL - Math.max(14, skinStdL * 0.7)) {
        eyeDark++;
      }
    }
  }
  const eyeRatio = eyeDark / Math.max(1, eyeCount);
  if (eyeRatio < 0.035 || eyeRatio > 0.65) {
    return { ok: false, reason: 'अनुहार (आँखा/नाँक/मुख) फ्रेमभित्र स्पष्ट मिलेन — कृपया सिधा पासपोर्ट फोटो मिलाउनुहोस्।' };
  }

  // Bilateral horizontal symmetry across center vertical axis inside head oval
  const sy0 = Math.floor(h * 0.24), sy1 = Math.ceil(h * 0.60);
  const sdx0 = Math.max(2, Math.floor(w * 0.03)), sdx1 = Math.floor(w * 0.20);
  const cx = Math.floor(w / 2);
  let leftMean = 0, rightMean = 0, symN = 0;
  for (let y = sy0; y < sy1; y++) {
    for (let dx = sdx0; dx <= sdx1; dx++) {
      leftMean += lum[y * w + (cx - dx)];
      rightMean += lum[y * w + (cx + dx)];
      symN++;
    }
  }
  leftMean /= Math.max(1, symN);
  rightMean /= Math.max(1, symN);
  let cov = 0, varL = 0, varR = 0;
  for (let y = sy0; y < sy1; y++) {
    for (let dx = sdx0; dx <= sdx1; dx++) {
      const dl = lum[y * w + (cx - dx)] - leftMean;
      const dr = lum[y * w + (cx + dx)] - rightMean;
      cov += dl * dr;
      varL += dl * dl;
      varR += dr * dr;
    }
  }
  const symCorr = cov / Math.max(1e-6, Math.sqrt(varL * varR));
  if (symCorr < 0.32) {
    return { ok: false, reason: 'फोटोमा सिधा मान्छेको अनुहार फ्रेममा मिलेन। गोलो फ्रेमभित्र अनुहार सिधा पारेर क्रप गर्नुहोस्।' };
  }

  return { ok: true, method: 'heuristic', skinRatioHead, skinRatioCore, eyeRatio, symCorr };
}

async function verifyHumanPassportFace(canvas) {
  if (!canvas || !canvas.width || !canvas.height) {
    return { ok: false, reason: 'फोटो उपलब्ध छैन।' };
  }
  if (typeof window.FaceDetector === 'function') {
    try {
      const fd = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 4 });
      const faces = await fd.detect(canvas);
      if (!faces || faces.length === 0) {
        return { ok: false, reason: 'फोटोमा मान्छेको अनुहार भेटिएन — कृपया मान्छेको स्पष्ट पासपोर्ट फोटो मात्र राख्नुहोस्।' };
      }
      if (faces.length > 1) {
        return { ok: false, reason: 'फोटोमा एकभन्दा बढी मान्छे देखिए। कृपया १ जनाको पासपोर्ट फोटो मात्र राख्नुहोस्।' };
      }
      const box = faces[0].boundingBox;
      if (!box || box.width < canvas.width * 0.20 || box.height < canvas.height * 0.16) {
        return { ok: false, reason: 'अनुहार धेरै सानो देखियो — जुम गरेर अनुहार फ्रेमको बीचमा मिलाउनुहोस्।' };
      }
      const fcx = (box.x + box.width / 2) / canvas.width;
      const fcy = (box.y + box.height / 2) / canvas.height;
      if (fcx < 0.15 || fcx > 0.85 || fcy < 0.12 || fcy > 0.85) {
        return { ok: false, reason: 'अनुहार फ्रेमको बीचमा मिलाउनुहोस्।' };
      }
      return { ok: true, method: 'native' };
    } catch (e) {}
  }

  const sw = 120, sh = 150;
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0, sw, sh);
  const imgData = ctx.getImageData(0, 0, sw, sh);
  return analyzePassportFacePixels(imgData.data, sw, sh);
}

async function saveCroppedPassportPhoto() {
  const st = window._ppCrop;
  if (!st) return;
  const btn = document.getElementById('pp-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ अनुहार र साइज जाँच हुँदैछ...'; }

  // Render clean un-guided 320x400 canvas for human-face verification
  const checkCanvas = document.createElement('canvas');
  checkCanvas.width = 320;
  checkCanvas.height = 400;
  const cctx = checkCanvas.getContext('2d');
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(0, 0, 320, 400);
  const ratioCheck = 320 / st.cw;
  cctx.drawImage(st.img, st.offX * ratioCheck, st.offY * ratioCheck, st.img.width * st.baseScale * st.zoom * ratioCheck, st.img.height * st.baseScale * st.zoom * ratioCheck);

  const faceCheck = await verifyHumanPassportFace(checkCanvas);
  if (!faceCheck || !faceCheck.ok) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ क्रप गरी सेभ गर्नुहोस्'; }
    return UI.toast((faceCheck && faceCheck.reason) || 'मान्छेको स्पष्ट अनुहार भएको पासपोर्ट फोटो मात्र राख्नुहोस्', 'error');
  }

  if (btn) { btn.textContent = '⏳ कम्प्रेस र अपलोड हुँदैछ...'; }

  const outDataUrl = encodeCanvasUnderLimit(function (ctx, w, h) {
    const ratio = w / st.cw;
    const sc = st.baseScale * st.zoom * ratio;
    ctx.drawImage(st.img, st.offX * ratio, st.offY * ratio, st.img.width * sc, st.img.height * sc);
  }, 320, 400, 82000);

  const kb = Math.max(1, Math.round(dataUrlByteSize(outDataUrl) / 1024));
  const data = DB.load();
  const m = (data.members || []).find(x => x.id === st.memberId);
  if (!m) return;

  if (DB.isCloudEnabled && DB.isCloudEnabled() && navigator.onLine) {
    const up = await DB.uploadMemberPhoto(st.memberId, outDataUrl);
    if (!up || !up.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '✅ क्रप गरी सेभ गर्नुहोस्'; }
      return UI.toast((up && up.error) || 'फोटो सेभ भएन', 'error');
    }
  } else if (Auth.isAccountsWriter()) {
    m.photo = outDataUrl;
    DB.save(data);
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '✅ क्रप गरी सेभ गर्नुहोस्'; }
    return UI.toast('फोटो पठाउन इन्टरनेट चाहिन्छ', 'error');
  }

  UI.toast('पासपोर्ट फोटो सेभ भयो (' + kb + ' KB) ✅', 'success');
  renderHomeByRole();
  if (Auth.isMember && Auth.isMember()) {
    openMemberOwnProfileModal({ replace: true });
  } else {
    renderProfileTab();
    openMemberDetail(st.memberId, { replace: true });
  }
}

function readFileAsDataURL(file, maxBytes, cb) {
  if (!file) return cb(null);
  if (maxBytes && file.size > maxBytes) {
    UI.toast('फाइल धेरै ठूलो (अधिकतम ' + Math.round(maxBytes/1024) + ' KB)', 'error');
    return cb(null);
  }
  const r = new FileReader();
  r.onload = () => cb(r.result);
  r.onerror = () => cb(null);
  r.readAsDataURL(file);
}

function saveGroupProfile() {
  const data = DB.load();
  if (!data.group) data.group = {};
  if (!data.settings) data.settings = {};
  if (!data.settings.theme) data.settings.theme = {};

  data.group.name = (document.getElementById('gp-name').value || '').trim() || data.group.name;
  data.group.address = (document.getElementById('gp-address').value || '').trim();
  data.group.established = (document.getElementById('gp-est').value || '').trim();
  data.group.logo = (document.getElementById('gp-logo').value || '').trim() || '💰';
  data.settings.theme.color = document.getElementById('gp-theme-color').value || '#1a5f4a';
  data.settings.theme.opacity = Math.min(0.35, Math.max(0.05, parseFloat(document.getElementById('gp-theme-opacity').value) || 0.12));

  const logoFile = document.getElementById('gp-logo-file') && document.getElementById('gp-logo-file').files[0];
  const themeFile = document.getElementById('gp-theme-photo') && document.getElementById('gp-theme-photo').files[0];
  const vidFile = document.getElementById('gp-welcome-video') && document.getElementById('gp-welcome-video').files[0];

  function finish() {
    DB.save(data);
    applyAppTheme(data);
    UI.updateHeader(data);
    UI.toast('सेभ भयो', 'success');
    closeModal();
  }

  let pending = 0;
  function oneDone() { pending--; if (pending <= 0) finish(); }

  if (logoFile) {
    pending++;
    readFileAsDataURL(logoFile, 400000, function (url) {
      if (url) data.group.logoImage = url;
      oneDone();
    });
  }
  if (themeFile) {
    pending++;
    readFileAsDataURL(themeFile, 500000, function (url) {
      if (url) data.settings.theme.photo = url;
      oneDone();
    });
  }
  if (vidFile) {
    pending++;
    readFileAsDataURL(vidFile, 2500000, function (url) {
      if (url) data.group.welcomeVideo = url;
      oneDone();
    });
  }
  if (pending === 0) finish();
}

function applyAppTheme(data) {
  try {
    const th = (data && data.settings && data.settings.theme) || {};
    if (th.color) {
      document.documentElement.style.setProperty('--primary', th.color);
    }
    let overlay = document.getElementById('app-theme-bg');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'app-theme-bg';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;transition:opacity .3s;';
      document.body.insertBefore(overlay, document.body.firstChild);
    }
    // content above bg
    ['login-screen','main-screen','loading-screen'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) { el.style.position = 'relative'; el.style.zIndex = '1'; }
    });
    if (th.photo) {
      overlay.style.backgroundImage = 'url(' + th.photo + ')';
      overlay.style.opacity = String(th.opacity != null ? th.opacity : 0.18);
    } else {
      overlay.style.backgroundImage = 'none';
      overlay.style.opacity = '0';
    }
    // soft scrim so text readable on login
    var scrim = document.getElementById('app-theme-scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'app-theme-scrim';
      scrim.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.55),rgba(255,255,255,0.75));';
      overlay.after(scrim);
    }
    scrim.style.display = th.photo ? 'block' : 'none';
  } catch (e) {}
}



function requestPushBeforeDashboard(done) {
  done = typeof done === 'function' ? done : function () {};
  window._pushLoginDone = done;
  try {
    if (typeof Notification === 'undefined') {
      done();
      return;
    }
    if (Notification.permission === 'granted') {
      setTimeout(function () {
        if (typeof syncWebPushSubscription === 'function') syncWebPushSubscription(true).catch(function () {});
      }, 300);
      done();
      return;
    }
    if (Notification.permission === 'denied') {
      UI.showModal(
        '🔔 सूचना',
        '<p style="font-size:0.9rem">ब्राउजरले सूचना रोकेको छ। ठेगाना बार → साइट सेटिङ → Notifications → <strong>Allow</strong>।</p>' +
        '<button type="button" class="btn btn-primary btn-block" onclick="closeModal(); finishPushLoginGate()">अगाडि बढ्ने</button>',
        ''
      );
      return;
    }
    UI.showModal(
      '🔔 सूचना अनुमति आवश्यक',
      '<p style="font-size:0.9rem;margin-bottom:12px">च्याट/सूचनाका लागि अनुमति चाहिन्छ।<br>तल थिचेर ब्राउजरमा <strong>Allow</strong> छान्नुहोस्।</p>' +
      '<button type="button" class="btn btn-success btn-block btn-lg" onclick="confirmPushAllowFromLogin()">✅ अनुमति दिनुहोस्</button>',
      ''
    );
  } catch (e) {
    console.warn(e);
    done();
  }
}

function finishPushLoginGate() {
  var d = window._pushLoginDone;
  window._pushLoginDone = null;
  if (typeof d === 'function') d();
}

async function confirmPushAllowFromLogin() {
  try {
    if (typeof closeModal === 'function') closeModal();
    if (typeof Notification !== 'undefined') {
      var p = await Notification.requestPermission();
      if (p === 'granted') {
        UI.toast('सूचना अनुमति OK', 'success');
        if (typeof syncWebPushSubscription === 'function') await syncWebPushSubscription(true);
      } else {
        UI.toast('अनुमति पूरा भएन — सेटिङबाट पछि', 'error');
      }
    }
  } catch (e) {
    console.warn(e);
  }
  finishPushLoginGate();
}

function playWelcomeThenMain() {
  // लगइन पछि — ड्यासबोर्ड अघि सूचना अनुमति
  requestPushBeforeDashboard(function () {
    playWelcomeThenMainInner();
  });
}

function playWelcomeThenMainInner() {
  const data = DB.load();
  const vid = data.group && data.group.welcomeVideo;
  if (!vid) {
    showMainApp();
    return;
  }
  let wrap = document.getElementById('welcome-video-overlay');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'welcome-video-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;align-items:center;justify-content:center';
    document.body.appendChild(wrap);
  }
  wrap.innerHTML = '<video id="welcome-vid" playsinline autoplay style="max-width:100%;max-height:100%"></video>';
  const v = document.getElementById('welcome-vid');
  v.src = vid;
  const done = () => {
    wrap.remove();
    showMainApp();
  };
  v.onended = done;
  v.onerror = done;
  setTimeout(done, 13000); // max ~13s
  v.play().catch(done);
}

function editRates() {
  if (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin()) {
    if (!window._pinOkRates) {
      return UI.showPinModal('दर/शुल्क खोल्न PIN चाहिन्छ', () => {
        window._pinOkRates = true;
        editRates();
        setTimeout(() => { window._pinOkRates = false; }, 500);
      });
    }
  }

  const data = DB.load();
  const s = data.settings;
  const html = `
    <div class="form-group"><label>प्रति कित्ता मासिक बचत (रु.)</label><input type="number" id="rt-saving" value="${s.monthlySaving}"></div>
    <div class="form-group"><label>मासिक ब्याज %</label><input type="number" id="rt-interest" value="${s.interestRate}" step="0.1"></div>
    <div class="form-group"><label>जरिवाना %</label><input type="number" id="rt-fine" value="${s.fineRate}" step="0.1"></div>
    <div class="form-group"><label>कित्ता घटाउँदा शुल्क %</label><input type="number" id="rt-reduce" value="${s.kittaReduceFee}" step="0.1"></div>
    <div class="form-group"><label>बाहिरिँदा शुल्क %</label><input type="number" id="rt-exit" value="${s.exitFee}" step="0.1"></div>
    <button class="btn btn-primary btn-block" onclick="saveRates()">💾 सेभ</button>
  `;
  UI.showModal('💰 दर र शुल्क', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

function saveRates() {
  UI.showPinModal('⚠️ दर/शुल्क परिवर्तन गर्न PIN चाहिन्छ', () => {
    const data = DB.load();
    data.settings.monthlySaving = parseFloat(document.getElementById('rt-saving').value) || 0;
    data.settings.interestRate = parseFloat(document.getElementById('rt-interest').value) || 0;
    data.settings.fineRate = parseFloat(document.getElementById('rt-fine').value) || 0;
    data.settings.kittaReduceFee = parseFloat(document.getElementById('rt-reduce').value) || 0;
    data.settings.exitFee = parseFloat(document.getElementById('rt-exit').value) || 0;
    DB.save(data);
    UI.toast('सेभ भयो', 'success');
    closeModal();
  });
}

function showAppGuide() {
  const html = `
    <div class="report-card" style="font-size:0.85rem;max-height:60vh;overflow:auto">
      <p><strong>अकाउन्टिङ सूत्र:</strong></p>
      <p>१. सुरु मौज्दात = अघिल्लो महिनाको अन्तिम मौज्दात</p>
      <p>२. प्राप्त बचत = यो महिनाको नगद बचत</p>
      <p>३. प्राप्त ब्याज = अघिल्लो महिनाको बाँकी सावा × मासिक ब्याज%</p>
      <p>४. अन्य आम्दानी = नयाँ सदस्य/कित्ता थप आदि</p>
      <p>५. जम्मा आम्दानी = २+३+४</p>
      <p>६. खर्च = खर्च + कित्ता घटाउँदा/बाहिरिँदा खुद रकम</p>
      <p>७. खुद आम्दानी = ५−६</p>
      <p>८. अन्तिम मौज्दात = १+७</p>
      <p>९. उठेको सावा = यो महिना तिरेको सावा</p>
      <p>१०. गरिएको लगानी = यो महिना दिइएको ऋण</p>
      <p>११. उठ्न बाँकी = अघिल्लो ११ − ९ + १०</p>
      <p>१२. कोसमा नगद = ८ − ११</p>
      <p>प्रति कित्ता मूल्य = ८ ÷ जम्मा कित्ता</p>
      <hr>
      <p><strong>महिना क्रम:</strong> सुरु → कलेक्सन → कलेक्सन बन्द → कित्ता/सदस्य परिवर्तन → ऋण → महिना बन्द</p>
      <p><strong>ब्याज:</strong> अघिल्लो महिनाको अन्तिम बाँकीमा मात्र। नयाँ ऋण अर्को महिनादेखि।</p>
    </div>
  `;
  UI.showModal('📖 एप गाइड', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function doExportBackup() {
  const canPick = typeof window.showSaveFilePicker === 'function';
  UI.showModal('📤 Export ब्याकअप',
    canPick
      ? `<p><strong>सेभ लोकेसन छान्नुहोस्</strong></p>
         <p>अर्को स्क्रिनमा फोल्डर छानेर <strong>Save</strong> थिच्नुहोस् — फाइल त्यहीँ सेभ हुन्छ।</p>
         <button class="btn btn-primary btn-block" onclick="runExportBackup()">📁 लोकेसन छानेर सेभ गर्नुहोस्</button>`
      : `<p><strong>फाइल सेभ</strong></p>
         <p>यस ब्राउजरमा फोल्डर-पिकर नहुन सक्छ। सेभ थिचेपछि लोकेसन छान्न मिल्ने भए छान्नुहोस्।</p>
         <button class="btn btn-primary btn-block" onclick="runExportBackup()">💾 सेभ / डाउनलोड</button>`,
    '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function runExportBackup() {
  try {
    const fname = await DB.exportJSON();
    if (fname === null) {
      UI.toast('सेभ रद्द भयो', 'error');
      return;
    }
    closeModal();
    UI.toast('सेभ भयो: ' + fname, 'success');
  } catch (e) {
    UI.toast('सेभ असफल: ' + (e.message || e), 'error');
  }
}


/** हिसाब मात्र मेट्ने — Admin/सदस्य सुरक्षित */

function fixDuplicateMembersNow() {
  if (!(Auth.isAdmin && Auth.isAdmin())) return UI.toast('Admin मात्र', 'error');
  UI.showPinModal('दोहोरो सदस्य हटाउन PIN', function () {
    if (!DB.fixDuplicateMembers) return UI.toast('फंक्शन छैन', 'error');
    DB.fixDuplicateMembers().then(function (r) {
      APP_DATA = DB.load();
      UI.toast('सदस्य: ' + r.before + ' → ' + r.after + ' (दोहोरो हटाइयो)', 'success');
      try { showMainApp(); } catch (e) {}
    }).catch(function (e) {
      UI.toast('असफल: ' + (e && e.message || e), 'error');
    });
  });
}

function confirmClearAccountingOnly() {
  try {
    if (!(typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin())) {
      return UI.toast('Admin मात्र', 'error');
    }
    if (typeof UI.showPinModal !== 'function') {
      return runClearAccountingOnly();
    }
    UI.showPinModal('हिसाब मात्र मेट्न PIN', function () {
      UI.showModal(
        '🧹 हिसाब मात्र मेट्ने',
        '<p style="font-size:0.9rem;margin-bottom:12px">' +
          'महिना र माइग्रेसन हिसाब <strong>मेटिन्छ</strong>।<br>' +
          'Admin, सदस्य, पासवर्ड, PIN <strong>रहन्छन्</strong>।<br><br>' +
          'त्यसपछि original JSON Import गर्नुहोस्।' +
        '</p>' +
        '<button type="button" class="btn btn-danger btn-block" onclick="runClearAccountingOnly()">हो, हिसाब मेट्ने</button>',
        '<button type="button" class="btn btn-outline" onclick="closeModal()">रद्द</button>'
      );
    });
  } catch (e) {
    console.error(e);
    UI.toast('त्रुटि: ' + (e.message || e), 'error');
  }
}

function runClearAccountingOnly() {
  try {
    if (typeof closeModal === 'function') closeModal();
    if (typeof UI !== 'undefined' && UI.closePinModal) {
      try { UI.closePinModal(); } catch (e) {}
    }
    if (!DB || typeof DB.clearAccountingKeepUsers !== 'function') {
      return UI.toast('clearAccounting फंक्शन छैन — नयाँ ZIP deploy गर्नुहोस्', 'error');
    }
    UI.toast('हिसाब मेट्दै...', '');
    Promise.resolve(DB.clearAccountingKeepUsers())
      .then(function () {
        APP_DATA = DB.load();
        UI.toast('हिसाब मेटियो · अब JSON Import गर्नुहोस्', 'success');
        try { showMainApp(); } catch (e2) {
          try { UI.updateHome(APP_DATA); } catch (e3) {}
        }
      })
      .catch(function (err) {
        console.error(err);
        UI.toast('असफल: ' + (err && err.message ? err.message : err), 'error');
      });
  } catch (e) {
    console.error(e);
    UI.toast('त्रुटि: ' + (e.message || e), 'error');
  }
}

function triggerImport() {
  if (!(Auth.isAdmin && Auth.isAdmin())) {
    return UI.toast('Admin मात्र Import गर्न सक्नुहुन्छ', 'error');
  }
  UI.showPinModal('Import: पहिलो PIN', function () {
    UI.showModal(
      '⚠️ Import चेतावनी',
      '<p style="font-size:0.9rem;margin-bottom:12px">' +
        '<strong>गलत JSON</strong> Import गर्दा हालको हिसाब <strong>बिग्रिन सक्छ</strong>।<br><br>' +
        '• सही original / ब्याकअप फाइल मात्र छान्नुहोस्<br>' +
        '• Import पछि क्लाउडमा पनि overwrite हुन्छ<br>' +
        '• पहिले Export ब्याकअप राख्नुहोस्' +
      '</p>' +
      '<button type="button" class="btn btn-danger btn-block" onclick="importConfirmSecondPin()">बुझेँ · अगाडि (दोहोरो PIN)</button>',
      '<button type="button" class="btn btn-outline" onclick="closeModal()">रद्द</button>'
    );
  });
}

function importConfirmSecondPin() {
  closeModal();
  UI.showPinModal('Import: दोस्रो पटक PIN कन्फर्म', function () {
    UI.showModal(
      '📥 फाइल छान्नुहोस्',
      '<p style="font-size:0.85rem">अब ब्याकअप JSON फाइल छान्नुहोस्।</p>' +
      '<button type="button" class="btn btn-primary btn-block" onclick="pickImportFileNow()">📂 फाइल छान्नुहोस्</button>',
      '<button type="button" class="btn btn-outline" onclick="closeModal()">रद्द</button>'
    );
  });
}

function pickImportFileNow() {
  closeModal();
  var el = document.getElementById('import-file');
  if (el) el.click();
}

function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  DB.importJSON(file).then(() => {
    UI.toast('Import सफल · क्लाउड overwrite', 'success');
    APP_DATA = DB.load();
    showMainApp();
    try { UI.updateSyncStatus && UI.updateSyncStatus('saved'); } catch (err) {}
  }).catch(err => UI.toast('Import असफल: ' + (err.message || err), 'error'));
}

function doLogout() {
  const html = `
    <p style="font-size:0.9rem;margin-bottom:10px">⚠️ <strong>लगआउट</strong> गर्दा यो फोनमा सत्र सकिन्छ र सूचना बन्द हुन्छ। अर्काको मोबाइल भए ठिक।</p>
    <div class="form-group"><label>आफ्नो PIN (४ अंक)</label>
      <input type="password" id="logout-pin" inputmode="numeric" maxlength="4" placeholder="****">
    </div>
    <button class="btn btn-danger btn-block" onclick="confirmLogoutWithPin()">लगआउट पुष्टि</button>
  `;
  UI.showModal('🚪 लगआउट', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function confirmLogoutWithPin() {
  const pin = (document.getElementById('logout-pin') && document.getElementById('logout-pin').value) || '';
  const ok = await Auth.verifyUserPin(pin);
  if (!ok) return UI.toast('PIN गलत', 'error');
  try { await clearPushOnLogout(); } catch (e) {}
  window._pushLastGroupId = null;
  Auth.logout();
  hideLockScreen();
  closeModal();
  showLoginScreen();
  UI.toast('लगआउट भयो', 'success');
}

async function clearPushOnLogout() {
  try {
    if (!navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await DB.apiFetch('/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    }
  } catch (e) {}
}

function lockAppSession() {
  if (!Auth.isLoggedIn()) return;
  Auth.setLocked(true);
  showLockScreen();
}

function showLockScreen() {
  let el = document.getElementById('session-lock-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'session-lock-overlay';
    el.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:24px 20px;max-width:320px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2)">
        <div style="font-size:2rem;margin-bottom:8px">🔒</div>
        <div style="font-weight:700;margin-bottom:4px">एप लक भयो</div>
        <p style="font-size:0.85rem;color:#666;margin-bottom:12px">१५ मिनेट नचलाएको / सुरक्षार्थ। लगइन मै छ — PIN हालेर खोल्नुहोस्।</p>
        <input type="password" id="lock-pin-input" inputmode="numeric" maxlength="4" placeholder="PIN (४ अंक)"
          style="width:100%;padding:12px;font-size:1.2rem;text-align:center;border:2px solid #0d6efd;border-radius:10px;letter-spacing:8px">
        <button type="button" class="btn btn-primary btn-block" style="margin-top:12px" onclick="unlockAppSession()">🔓 खोल्नुहोस्</button>
      </div>`;
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(el);
    const inp = document.getElementById('lock-pin-input');
    if (inp) {
      inp.onkeydown = function (e) { if (e.key === 'Enter') unlockAppSession(); };
      setTimeout(() => inp.focus(), 200);
    }
  } else {
    el.style.display = 'flex';
    const inp = document.getElementById('lock-pin-input');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 200); }
  }
}

function hideLockScreen() {
  const el = document.getElementById('session-lock-overlay');
  if (el) el.style.display = 'none';
}

async function unlockAppSession() {
  const pin = (document.getElementById('lock-pin-input') && document.getElementById('lock-pin-input').value) || '';
  const ok = await Auth.verifyUserPin(pin);
  if (!ok) {
    return UI.toast('PIN गलत', 'error');
  }
  Auth.setLocked(false);
  Auth.touchActivity();
  hideLockScreen();
  UI.toast('खुल्यो', 'success');
}

// ========== VIDHAN (Rules & Meetings) ==========

function getDefaultVidhanRules() {
  return [
    { id: 'vr1', title: '१. उद्देश्य', detail: 'यस समूहको उद्देश्य सदस्यहरूबाट नियमित बचत जम्मा गरी आपसी समझदारीमा ऋण/लगानी दिने र आम्दानी–नाफा सबै कित्ताअनुसार बराबर बाँड्ने हो।' },
    { id: 'vr2', title: '२. सदस्यता', detail: 'बचत गर्ने व्यक्ति मात्र यस समूहको सदस्य हुनेछ। सदस्यता प्रवेश र बहिर्गमन समूहले तोकेको प्रक्रिया, शुल्क र निर्णयअनुसार हुनेछ।' },
    { id: 'vr3', title: '३. कित्ता', detail: 'प्रत्येक सदस्यसँग तोकिएको कित्ता रहनेछ। कित्ता नै समूहको हिस्साको आधार हो। जम्मा कित्ता = सबै सदस्यका कित्ताको योग।' },
    { id: 'vr4', title: '४. मासिक बचत', detail: 'मासिक बचत रकम = सदस्यको कित्ता × प्रति कित्ता मासिक दर। यो दर समूहले तोकेअनुसार एप/सेटिङमा लागू हुनेछ।' },
    { id: 'vr5', title: '५. नयाँ सदस्य प्रवेश', detail: 'नयाँ सदस्यले प्रचलित प्रति कित्ता मूल्य तिरेर कित्ता लिनुपर्नेछ। प्रवेशपछि निजलाई सुरुदेखि बचत गरेसरह मुनाफाको हक लाग्नेछ।' },
    { id: 'vr6', title: '६. भेला / कलेक्सन दिन', detail: 'बचत भेला वा कलेक्सन प्रत्येक नेपाली महिनाको दोस्रो शनिबार (वा समूह बैठकले तोकेको दिन) हुनेछ। समय र स्थान समूहले जानकारी गराउनेछ।' },
    { id: 'vr7', title: '७. अनिवार्य रकम', detail: 'कलेक्सनमा सदस्यले बुझाउनुपर्ने अनिवार्य रकम बचत, ब्याज, जरिवाना र अघिल्लो बाँकी समेत गरी हिसाब गरिनेछ। अग्रिम भए कट्टा हुनेछ।' },
    { id: 'vr8', title: '८. बाँकी', detail: 'अनिवार्य रकम पूर्ण नबुझाए वा अग्रिमले नपुगे बाँकी रहनेछ। बाँकी अर्को महिनाको अनिवार्यमा थपिन सक्छ।' },
    { id: 'vr9', title: '९. अग्रिम', detail: 'अनिवार्यभन्दा बढी तिरेको रकम अग्रिममा रहनेछ र अर्को महिनाको अनिवार्यबाट कट्टा हुनेछ।' },
    { id: 'vr10', title: '१०. जरिवाना', detail: 'अनिवार्य बाँकीमा समूहले तोकेको प्रतिशतअनुसार जरिवाना लाग्नेछ। जरिवाना अर्को कलेक्सनमा तिर्नुपर्नेछ।' },
    { id: 'vr11', title: '११. ऋण / लगानी', detail: 'ऋण समूहको मौज्दात/नगदले भ्याएसम्म आपसी समझदारीमा दिइनेछ। ऋण लिँदा सदस्यको सहि अनिवार्य हुनेछ।' },
    { id: 'vr12', title: '१२. ब्याज', detail: 'ऋणमा ब्याज समूहले तोकेको मासिक प्रतिशतअनुसार अघिल्लो महिनाको बाँकी ऋण (सावा) मा लाग्नेछ। यस महिना लिएको ऋणको ब्याज अर्को महिनादेखि लागू हुनेछ।' },
    { id: 'vr13', title: '१३. सावा फिर्ता', detail: 'ऋणको सावा किस्ता कलेक्सनमा बुझाउन सकिनेछ। सावा उठेपछि उठ्न बाँकी ऋण घट्नेछ।' },
    { id: 'vr14', title: '१४. कलेक्सन बन्द', detail: 'कलेक्सन बन्द भएपछि सो महिनाको कलेक्सन प्रविष्टि सामान्यतया बन्द हुनेछ।' },
    { id: 'vr15', title: '१५. महिना बन्द', detail: 'लगानी प्रक्रिया सकिएपछि महिना बन्द गरिनेछ। बन्दपछि सो महिनाको हिसाब अन्तिम मानिनेछ र प्रति कित्ता मूल्य अपडेट हुनेछ।' },
    { id: 'vr16', title: '१६. सम्पत्ति', detail: 'समूहको सम्पत्ति भनेको सबै कित्ताको मूल्यको योग हो। अन्तिम मौज्दात ÷ जम्मा कित्ता = प्रति कित्ता मूल्य।' },
    { id: 'vr17', title: '१७. सदस्यको हिस्सा', detail: 'सदस्यको सम्पत्ति = प्रति कित्ता मूल्य × निजको कित्ता। यो हिस्सा पासबुक/प्रोफाइलमा देखिनेछ।' },
    { id: 'vr18', title: '१८. आम्दानी', detail: 'बचत, ब्याज, अन्य आम्दानी समूहको आम्दानी हुन्। यसले नगद र मौज्दात बढाउँछ।' },
    { id: 'vr19', title: '१९. खर्च', detail: 'समूहको स्वीकृत खर्च मौज्दात/नगदबाट कट्टी हुनेछ। खर्च खुद आम्दानीमा घट्छ।' },
    { id: 'vr20', title: '२०. पारदर्शिता', detail: 'हिसाब पारदर्शी राखिनेछ। सदस्यले आफ्नो पासबुक, बिल, कलेक्सन सारांश र समूह नियम हेर्न पाउनेछन्। सम्पादन अधिकार Admin मा सीमित हुनेछ।' },
    { id: 'vr21', title: '२१. बिल / रसिद', detail: 'महिना बन्दपछि सदस्यलाई डिजिटल बिल/रसिद उपलब्ध गराइनेछ। बिल नम्बर वर्षअनुसार क्रममा रहनेछ।' },
    { id: 'vr22', title: '२२. कित्ता घटाउने', detail: 'कित्ता घटाउँदा समूहले तोकेको शुल्क कट्टा गरी बाँकी हिस्सा फिर्ता प्रक्रिया बैठक निर्णयअनुसार हुनेछ।' },
    { id: 'vr23', title: '२३. समूह छाड्ने', detail: 'समूह छाड्दा तोकिएको बहिर्गमन शुल्क कट्टा गरी निजको हिस्सा फिर्ता गरिनेछ। बाँकी ऋण भए पहिले चुक्ता गर्नुपर्ने हुन सक्छ।' },
    { id: 'vr24', title: '२४. प्रशासन', detail: 'हिसाब राख्ने र क्लाउड सिंकको मुख्य जिम्मेवारी तोकिएको Admin A मा रहनेछ। Admin B हेर्ने भूमिकामा रहन सक्छ तर हिसाब overwrite नगर्ने।' },
    { id: 'vr25', title: '२५. लगइन र गोपनीयता', detail: 'Username, password, PIN र मोबाइल नम्बर गोप्य राख्नुपर्नेछ। अरूलाई सेयर गर्नु हुँदैन।' },
    { id: 'vr26', title: '२६. एप प्रयोग', detail: 'सदस्यले एपबाट आफ्नो विवरण हेर्न, च्याट/गुनासो गर्न पाउनेछन्। हिसाब प्रविष्टि Admin प्रक्रियाबाट मात्र हुनेछ।' },
    { id: 'vr27', title: '२७. गुनासो र सुझाव', detail: 'सदस्यले तोकिएको तरिकाले गुनासो वा सुझाव राख्न पाउनेछन्। Admin ले जवाफ दिन सक्नेछ।' },
    { id: 'vr28', title: '२८. विवाद समाधान', detail: 'विवाद पहिले समूहभित्र छलफलबाट टुंग्याइनेछ। नटुंगे बैठकको बहुमत/निर्णय मान्य हुनेछ।' },
    { id: 'vr29', title: '२९. बैठक निर्णय', detail: 'महत्त्वपूर्ण निर्णय बैठकमा लिइनेछ र एपमा लेखिनेछ। नियम फेरबदल बैठकबाट पारित भएपछि मात्र सम्पादन गर्न मिल्नेछ।' },
    { id: 'vr30', title: '३०. संशोधन', detail: 'यो बिधान संशोधन गर्न समूह बैठकको निर्णय आवश्यक हुनेछ। संशोधित बुँदा एपमा अपडेट गरी सदस्यलाई जानकारी गराइनेछ।' },
    { id: 'vr31', title: '३१. दर तथा शुल्क', detail: 'मासिक बचत दर, ब्याज %, जरिवाना %, प्रवेश/बहिर्गमन/कित्ता शुल्क समूहले समय–समयमा निर्णय गरी लागू गर्न सक्नेछ।' },
    { id: 'vr32', title: '३२. कोरम', detail: 'बैठक मान्य हुन समूहले तोकेको न्यूनतम सदस्य संख्या (कोरम) उपस्थित हुनुपर्नेछ।' },
    { id: 'vr33', title: '३३. ऋण सीमा', detail: 'एक सदस्यलाई दिइने अधिकतम ऋण मौज्दात, निजको कित्ता/इतिहास र बैठक समझदारीअनुसार सीमित हुन सक्छ।' },
    { id: 'vr34', title: '३४. दोहोरो हिसाब निषेध', detail: 'एउटै रकम दुई पटक नगद वा मौज्दातमा गन्न पाइने छैन। एपको हिसाब सूत्र र महिना बन्द प्रक्रिया अन्तिम आधार हुनेछ।' },
    { id: 'vr35', title: '३५. ब्याकअप', detail: 'Admin ले महिना बन्दपछि हिसाबको ब्याकअप (Export) सुरक्षित राख्नुपर्नेछ।' }
  ];
}

function ensureDefaultRules(data) {
  data.rules = data.rules || [];
  data.settings = data.settings || {};
  data.ruleChangeLog = data.ruleChangeLog || [];
  data.pendingRuleEdits = data.pendingRuleEdits || [];
  if (data.rules.length === 0) {
    const now = new Date().toISOString();
    data.rules = getDefaultVidhanRules().map(function (r) {
      return { id: r.id, title: r.title, detail: r.detail, text: r.title + ' — ' + r.detail, time: now };
    });
    return true;
  }
  data.rules = data.rules.map(function (r, i) {
    if (r.title && r.detail) return r;
    const t = r.text || '';
    return Object.assign({}, r, { title: r.title || ((i + 1) + '. नियम'), detail: r.detail || t });
  });
  return false;
}

function renderVidhanTab() {
  const container = document.getElementById('vidhan-content');
  if (!container) return;
  const data = DB.load();
  if (ensureDefaultRules(data)) DB.save(data);
  else { ensureDefaultRules(data); }
  const rules = data.rules || [];
  const meetings = data.meetings || [];
  const suggestions = data.suggestions || [];

  let html = `
    <div class="section-card">
      <div class="section-title">📜 समूहको नियम तथा कानुन</div>
      ${rules.length === 0 ? '<div class="text-muted">अहिलेसम्म नियम लेखिएको छैन</div>' :
        rules.map((r, i) => {
          const title = r.title || ((i + 1) + '. नियम');
          const detail = r.detail || r.text || '';
          return '<div class="rule-topic" onclick="toggleRuleDetail(\'' + r.id + '\')">' +
            '<div class="rule-topic-head"><span class="rule-topic-title">' + title + '</span><span class="rule-chevron" id="ch-' + r.id + '">›</span></div>' +
            '<div class="rule-detail hidden" id="rd-' + r.id + '">' + detail +
            ruleActionButtons(r, data) +
            '</div></div>';
        }).join('')}
      ${Auth.isAdmin() && Auth.isAccountsWriter && Auth.isAccountsWriter() ? (
          (data.settings && data.settings.rulesFinalized)
            ? '<div class="text-muted" style="font-size:0.8rem;margin-top:8px">बिधान लक · नयाँ बुँदा बैठकबाट मात्र</div>'
            : '<button class="btn btn-primary btn-block mt-2" onclick="addRuleForm()">➕ नियम थप्नुहोस्</button>' +
              '<button class="btn btn-outline btn-block mt-1" onclick="installDefault35Rules()">📋 ३५ बुँदा लोड</button>' +'<button class="btn btn-success btn-block mt-1" onclick="finalizeRulesOnce()">🔒 बिधान अन्तिम (लक)</button>'
        ) : ''}
    </div>

    <div class="section-card">
      <div class="section-title">🏛️ बैठक निर्णयहरू</div>
      ${meetings.length === 0 ? '<div class="text-muted">अहिलेसम्म बैठक निर्णय छैन</div>' :
        meetings.slice().reverse().map(m => {
          const rids = m.ruleIds || [];
          const rlab = rids.length ? '<div class="text-muted" style="font-size:0.75rem">नियम: ' + rids.length + ' वटा छलफल</div>' : '';
          return '<div class="section-card" style="padding:10px;margin-bottom:8px">' +
            '<div class="fw-bold">' + (m.title||'') + '</div>' +
            '<div class="text-muted" style="font-size:0.75rem">' + new Date(m.time).toLocaleString() + '</div>' +
            rlab +
            '<div class="mt-1" style="font-size:0.88rem;white-space:pre-wrap">' + (m.decision||'') + '</div></div>';
        }).join('')}
      ${Auth.isAdmin() ? `<button class="btn btn-success btn-block mt-1" onclick="addMeetingForm()">➕ बैठक निर्णय थप्नुहोस्</button>` : ''}
    </div>
  `;

  if (Auth.isMember()) {
    html += `
      <div class="section-card">
        <div class="section-title">💡 सुझाव / सल्लाह</div>
        <button class="btn btn-warning btn-block mb-1" onclick="addSuggestionForm()">✍️ सुझाव दिनुहोस्</button>
        ${suggestions.filter(s => s.memberId === Auth.currentUser.memberId).map(s =>
          `<div class="section-card" style="padding:8px;margin-top:6px"><div>${s.text}</div>
          ${s.reply ? `<div style="margin-top:4px;padding:6px;background:#e7f1ff;border-radius:8px;font-size:0.85rem"><strong>Admin:</strong> ${s.reply}</div>` : ''}
          </div>`).join('')}
      </div>
    `;
  } else {
    html += `
      <div class="section-card">
        <div class="section-title">💡 सदस्य सुझावहरू</div>
        ${suggestions.length === 0 ? '<div class="text-muted">कुनै सुझाव छैन</div>' :
          suggestions.slice().reverse().map(s => {
            const m = data.members.find(x => x.id === s.memberId);
            return `<div class="section-card" style="padding:10px;margin-bottom:6px">
              <div class="fw-bold">${m ? m.name : s.memberId}</div>
              <div>${s.text}</div>
              ${s.reply ? `<div style="margin-top:4px;padding:6px;background:#e7f1ff;border-radius:8px"><strong>जवाफ:</strong> ${s.reply}</div>` :
                `<div class="form-group mt-1"><input type="text" id="sug-reply-${s.id}" placeholder="जवाफ..."><button class="btn btn-primary btn-sm mt-1" onclick="replySuggestion('${s.id}')">जवाफ</button></div>`}
            </div>`;
          }).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
}


function ruleActionButtons(r, data) {
  if (!(Auth.isAdmin && Auth.isAdmin())) return '';
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return '';
  const finalized = !!(data.settings && data.settings.rulesFinalized);
  const pend = (data.pendingRuleEdits || []).find(function (p) {
    return p.status === 'open' && (p.ruleIds || []).indexOf(r.id) >= 0;
  });
  if (!finalized) {
    return '<div style="margin-top:8px"><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();openRuleEdit(\'' + r.id + '\')">✏️ सम्पादन</button></div>';
  }
  if (pend) {
    return '<div style="margin-top:8px"><button type="button" class="btn btn-warning btn-sm" onclick="event.stopPropagation();openRuleEdit(\'' + r.id + '\',\'' + pend.meetingId + '\')">✏️ बैठकबाट सम्पादन</button></div>';
  }
  return '<div class="text-muted" style="font-size:0.72rem;margin-top:6px">लक · बैठकबाट मात्र परिवर्तन</div>';
}
function openRuleEdit(ruleId, meetingId) {
  const data = DB.load();
  const r = (data.rules || []).find(x => x.id === ruleId);
  if (!r) return;
  const finalized = !!(data.settings && data.settings.rulesFinalized);
  if (finalized && !meetingId) return UI.toast('बैठक पारितपछि मात्र सम्पादन', 'error');
  const html = `
    <p class="text-muted" style="font-size:0.8rem">${meetingId ? ('बैठक: ' + meetingId) : 'सुरुवाती सम्पादन'}</p>
    <div class="form-group"><label>शीर्षक</label><input type="text" id="re-title" value="${(r.title||'').replace(/"/g,'&quot;')}"></div>
    <div class="form-group"><label>विवरण</label><textarea id="re-detail" rows="5">${(r.detail||r.text||'').replace(/</g,'')}</textarea></div>
    <button class="btn btn-primary btn-block" onclick="saveRuleEdit('${ruleId}','${meetingId||''}')">💾 सेभ</button>`;
  UI.showModal('✏️ नियम सम्पादन', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}
function saveRuleEdit(ruleId, meetingId) {
  const title = (document.getElementById('re-title').value || '').trim();
  const detail = (document.getElementById('re-detail').value || '').trim();
  if (!title || !detail) return UI.toast('शीर्षक र विवरण चाहिन्छ', 'error');
  const data = DB.load();
  const r = (data.rules || []).find(x => x.id === ruleId);
  if (!r) return;
  const before = { title: r.title, detail: r.detail };
  r.title = title; r.detail = detail; r.text = title + ' — ' + detail;
  data.ruleChangeLog = data.ruleChangeLog || [];
  data.ruleChangeLog.push({
    ruleId: ruleId, meetingId: meetingId || null,
    before: before, after: { title: title, detail: detail },
    time: new Date().toISOString(), by: (Auth.currentUser && Auth.currentUser.username) || 'admin'
  });
  if (meetingId) {
    data.pendingRuleEdits = (data.pendingRuleEdits || []).map(function (p) {
      if (p.meetingId === meetingId && p.status === 'open') {
        p.ruleIds = (p.ruleIds || []).filter(function (id) { return id !== ruleId; });
        if (!p.ruleIds.length) p.status = 'done';
      }
      return p;
    });
  }
  DB.save(data);
  UI.toast('सेभ भयो', 'success');
  closeModal();
  renderVidhanTab();
}
function installDefault35Rules() {
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return UI.toast('Admin A मात्र', 'error');
  const data = DB.load();
  if (data.settings && data.settings.rulesFinalized) return UI.toast('लक भइसक्यो', 'error');
  if ((data.rules||[]).length && !confirm('अहिलेका नियम हटाएर ३५ बुँदा राख्ने? (लक अघि मात्र)')) return;
  const now = new Date().toISOString();
  data.rules = getDefaultVidhanRules().map(function (r) {
    return { id: r.id, title: r.title, detail: r.detail, text: r.title + ' — ' + r.detail, time: now };
  });
  DB.save(data);
  UI.toast('३५ बुँदा सेभ', 'success');
  renderVidhanTab();
}
function finalizeRulesOnce() {
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return UI.toast('Admin A मात्र', 'error');
  if (!confirm('बिधान अन्तिम गर्ने? यसपछि सीधै मेटाउन/फेर्न मिल्दैन · बैठकबाट मात्र।')) return;
  const data = DB.load();
  data.settings = data.settings || {};
  data.settings.rulesFinalized = true;
  DB.save(data);
  UI.toast('बिधान लक भयो', 'success');
  renderVidhanTab();
}
function toggleRuleDetail(id) {
  const el = document.getElementById('rd-' + id);
  const ch = document.getElementById('ch-' + id);
  if (!el) return;
  const open = el.classList.toggle('hidden') === false;
  if (ch) ch.textContent = open ? '▾' : '›';
}
function loadDefaultRulesIfEmpty() {
  UI.toast('डिफल्ट मेटाएर राख्ने बन्द · खाली भए आफैं ३५ बुँदा आउँछ', 'info');
}

function addRuleForm() {
  const html = `
    <div class="form-group"><label>शीर्षक (छोटो)</label><input type="text" id="rule-title" placeholder="उदा: १८. नयाँ नियम"></div>
    <div class="form-group"><label>विवरण / परिभाषा</label><textarea id="rule-detail" rows="4" placeholder="पूर्ण अर्थ लेख्नुहोस्..."></textarea></div>
    <button class="btn btn-primary btn-block" onclick="saveRule()">💾 सेभ</button>`;
  UI.showModal('➕ नियम', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

function saveRule() {
  const title = (document.getElementById('rule-title').value || '').trim();
  const detail = (document.getElementById('rule-detail').value || '').trim();
  if (!title || !detail) return UI.toast('शीर्षक र विवरण चाहिन्छ', 'error');
  const data = DB.load();
  data.rules = data.rules || [];
  data.rules.push({
    id: 'r_' + Date.now(),
    title: title,
    detail: detail,
    text: title + ' — ' + detail,
    time: new Date().toISOString()
  });
  DB.save(data);
  UI.toast('नियम सेभ भयो', 'success');
  closeModal();
  renderVidhanTab();
}

function deleteRule(id) {
  const data = DB.load();
  if (data.settings && data.settings.rulesFinalized) {
    return UI.toast('लक भएको बिधान मेटाउन मिल्दैन · बैठकबाट संशोधन', 'error');
  }
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return UI.toast('Admin A मात्र', 'error');
  data.rules = (data.rules || []).filter(r => r.id !== id);
  DB.save(data);
  renderVidhanTab();
}

function addMeetingForm() {
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return UI.toast('Admin A मात्र', 'error');
  const data = DB.load();
  const rules = data.rules || [];
  const opts = rules.map(function (r) {
    return '<label style="display:block;font-size:0.82rem;margin:4px 0"><input type="checkbox" class="mt-rule" value="' + r.id + '"> ' + (r.title || r.id) + '</label>';
  }).join('');
  const html = `
    <div class="form-group"><label>बैठक शीर्षक</label><input type="text" id="mt-title" placeholder="उदा: मासिक बैठक"></div>
    <div class="form-group"><label>छलफल विषय — नियम फेरबदल (छान्नुहोस्)</label>
      <div style="max-height:140px;overflow:auto;border:1px solid #ddd;border-radius:8px;padding:8px">${opts || 'नियम छैन'}</div>
    </div>
    <div class="form-group"><label>निर्णय / नोट</label><textarea id="mt-decision" rows="4" placeholder="निर्णय वा स्क्यानबाट आएको पाठ..."></textarea></div>
    <div class="form-group">
      <label>कागज स्क्यान (पाठ मात्र · फोटो सेभ हुँदैन)</label>
      <input type="file" id="mt-scan" accept="image/*" capture="environment" onchange="ocrMeetingNote(this)">
      <div class="text-muted" style="font-size:0.72rem">पहिलो पटक इन्टरनेट चाहिन सक्छ (OCR लोड)</div>
    </div>
    <button class="btn btn-success btn-block" onclick="saveMeeting()">💾 बैठक सेभ</button>`;
  UI.showModal('➕ बैठक', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

function ocrMeetingNote(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  UI.toast('स्क्यान पढ्दै...', 'info');
  const reader = new FileReader();
  reader.onload = function () {
    const dataUrl = reader.result;
    function run(Tesseract) {
      Tesseract.recognize(dataUrl, 'eng+nld', { logger: function () {} })
        .then(function (res) {
          const text = (res && res.data && res.data.text) || '';
          const ta = document.getElementById('mt-decision');
          if (ta) ta.value = ((ta.value || '') + '\n' + text).trim();
          UI.toast(text ? 'पाठ आयो · जाँचेर सेभ गर्नुहोस्' : 'पाठ पढ्न सकिएन · हातले लेख्नुहोस्', text ? 'success' : 'error');
        })
        .catch(function () { UI.toast('स्क्यान असफल · हातले लेख्नुहोस्', 'error'); });
    }
    if (window.Tesseract) run(window.Tesseract);
    else {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = function () { run(window.Tesseract); };
      s.onerror = function () { UI.toast('OCR लोड भएन · नेट जाँच्नुहोस्', 'error'); };
      document.head.appendChild(s);
    }
  };
  reader.readAsDataURL(file);
}

function saveMeeting() {
  const title = document.getElementById('mt-title').value.trim();
  const decision = document.getElementById('mt-decision').value.trim();
  if (!title || !decision) return UI.toast('शीर्षक र निर्णय चाहिन्छ', 'error');
  const ruleIds = Array.prototype.slice.call(document.querySelectorAll('.mt-rule:checked')).map(function (el) { return el.value; });
  const data = DB.load();
  data.meetings = data.meetings || [];
  const mid = 'mt_' + Date.now();
  data.meetings.push({
    id: mid, title: title, decision: decision, ruleIds: ruleIds,
    time: new Date().toISOString()
  });
  if (ruleIds.length) {
    data.pendingRuleEdits = data.pendingRuleEdits || [];
    data.pendingRuleEdits.push({ meetingId: mid, ruleIds: ruleIds.slice(), status: 'open', time: new Date().toISOString() });
  }
  DB.save(data);
  UI.toast(ruleIds.length ? 'सेभ · सम्बन्धित नियम सम्पादन खोल्नुहोस्' : 'सेभ भयो', 'success');
  closeModal();
  renderVidhanTab();
}

function deleteMeeting(id) {
  const data = DB.load();
  data.meetings = (data.meetings || []).filter(m => m.id !== id);
  DB.save(data);
  renderVidhanTab();
}

function addSuggestionForm() {
  const html = `<div class="form-group"><label>सुझाव / सल्लाह</label><textarea id="sug-text" rows="3"></textarea></div>
    <button class="btn btn-warning btn-block" onclick="saveSuggestion()">📤 पठाउनुहोस्</button>`;
  UI.showModal('💡 सुझाव', html, '<button class="btn btn-outline" onclick="closeModal()">रद्द</button>');
}

async function saveSuggestion() {
  const text = document.getElementById('sug-text').value.trim();
  if (!text) return UI.toast('केही लेख्नुहोस्', 'error');
  const data = DB.load();
  const item = { id: 'sg_' + Date.now(), memberId: Auth.currentUser.memberId, text, time: new Date().toISOString(), reply: null };
  data.suggestions = data.suggestions || [];
  data.suggestions.push(item);
  DB.save(data, { localOnly: !Auth.isAccountsWriter() });
  if (Auth.isMember && Auth.isMember()) {
    await DB.submitMemberFeedback({ id: item.id, kind: 'suggestion_vidhan', text: item.text });
  }
  UI.toast('सुझाव पठाइयो', 'success');
  closeModal();
  renderVidhanTab();
}

function replySuggestion(id) {
  const input = document.getElementById('sug-reply-' + id);
  const text = input ? input.value.trim() : '';
  if (!text) return UI.toast('जवाफ लेख्नुहोस्', 'error');
  const data = DB.load();
  const s = (data.suggestions || []).find(x => x.id === id);
  if (s) s.reply = text;
  DB.save(data);
  UI.toast('जवाफ सेभ भयो', 'success');
  renderVidhanTab();
}


// ========== CLOUD SYNC ==========
function onCloudDataRemote(remote) {
  APP_DATA = remote;
  try { checkChatNotifications(remote); } catch (e) {}
  if (typeof Auth !== 'undefined' && Auth.isLoggedIn && Auth.isLoggedIn()) {
    try {
      UI.updateHeader(remote);
      UI.updateHome(remote);
      renderHomeByRole();
      // च्याट सधैं ताजा (ट्याब सक्रिय भए मात्र तुरुन्त रि-रेन्डर)
      if (document.getElementById('tab-chat') && document.getElementById('tab-chat').classList.contains('active')) {
        renderChatTab();
      }
      if (document.getElementById('tab-profile') && document.getElementById('tab-profile').classList.contains('active')) {
        renderProfileTab();
      }
      // खुला रहेको सदस्य प्रोफाइल मोडल / Admin सदस्य विवरण मोडल स्वतः ताजा पार्ने
      const overlay = document.getElementById('modal-overlay');
      const modalOpen = overlay && !overlay.classList.contains('hidden');
      const mTitle = document.getElementById('modal-title') ? document.getElementById('modal-title').textContent : '';
      if (modalOpen) {
        if (Auth.isMember && Auth.isMember() && mTitle === '👤 मेरो प्रोफाइल') {
          openMemberOwnProfileModal({ replace: true });
        } else if (Auth.isAdmin && Auth.isAdmin() && window._openMemberDetailId && mTitle.startsWith('👤 ')) {
          openMemberDetail(window._openMemberDetailId, { replace: true });
        } else if (mTitle === '💬 छलफल चौतारी') {
          openGroupChatFromHome({ replace: true });
        }
      }
      // खुला private च्याट — हल्का refresh (पुनः modal stack नबनाउने)
      if (window._openPrivateMemberId && document.getElementById('priv-messages')) {
        try {
          const mid = window._openPrivateMemberId;
          const data = remote;
          const msgs = ((data.chat && data.chat.private) || {})[mid] || [];
          const box = document.getElementById('priv-messages');
          if (box && typeof escapeHtmlChat === 'function') {
            // optional: full re-open only if count changed
            const prev = Number(box.getAttribute('data-count') || 0);
            if (msgs.length !== prev) {
              box.setAttribute('data-count', String(msgs.length));
              if (typeof openPersonalBox === 'function') openPersonalBox(mid);
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
}

async function startCloudSync() {
  if (typeof DB.bindOnlineSync === 'function') DB.bindOnlineSync();
  const status = await DB.initCloud(onCloudDataRemote);
  if (status === 'ok') {
    APP_DATA = DB.load();
    if (typeof Auth !== 'undefined' && Auth.isLoggedIn && Auth.isLoggedIn()) {
      try {
        UI.updateHeader(APP_DATA);
        UI.updateHome(APP_DATA);
      } catch (e) {}
    }
    console.log('Cloud sync ON');
  }
  return status;
}

function showCloudSetup() {
  if (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin()) {
    if (!window._pinOkCloud) {
      return UI.showPinModal('क्लाउड सिंक खोल्न PIN चाहिन्छ', () => {
        window._pinOkCloud = true;
        showCloudSetup();
        setTimeout(() => { window._pinOkCloud = false; }, 500);
      });
    }
  }

  const cloudOn = DB.isCloudEnabled();
  const pendingCount = (DB.getPendingQueue && DB.getPendingQueue().length) || 0;
  const ver = (DB.getServerVersion && DB.getServerVersion()) || 0;

  const html = `
    <div class="section-title">☁️ Cloudflare D1 + R2 सिंक</div>
    <div class="report-card mb-2">
      <div class="report-row"><span class="label">स्थिति</span><span class="value" style="color:${cloudOn ? '#198754' : '#dc3545'}">${cloudOn ? 'जोडिएको ✅' : 'अफलाइन'}</span></div>
      <div class="report-row"><span class="label">Server Version</span><span class="value">v${ver}</span></div>
      <div class="report-row"><span class="label">पठाउन बाँकी (Outbox)</span><span class="value">${pendingCount}</span></div>
      <div class="report-row"><span class="label">मोड</span><span class="value">${Auth.isAccountsWriter() ? 'Admin A (लेख्ने + पढ्ने)' : 'Read-only (स्वतः सिंक)'}</span></div>
    </div>
    <p class="text-muted" style="font-size:0.8rem;margin-bottom:12px">
      हिसाब Cloudflare D1 डेटाबेस र फोटो/सहि Cloudflare R2 मा सुरक्षित रहन्छन्। अफलाइनमा राखेको हिसाब नेट आउनासाथ दोहोरो entry नगरी सिंक हुन्छ।
    </p>
    <button class="btn btn-primary btn-block" onclick="runManualCloudSync()">🔄 अहिले सिंक गर्नुहोस्</button>
    <button class="btn btn-success btn-block mt-1" onclick="enablePushFromSettings()">🔔 पुश सूचना सेटिङ</button>
  `;
  UI.showModal('☁️ क्लाउड सिंक', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

async function runManualCloudSync() {
  UI.toast('सिंक हुँदैछ…', '');
  if (Auth.isAccountsWriter()) {
    await DB.flushPending();
  }
  const ok = await DB.pullLatest(true);
  if (ok) {
    APP_DATA = DB.load();
    UI.updateHeader(APP_DATA);
    UI.updateHome(APP_DATA);
    UI.toast('क्लाउड सिंक पूरा भयो ✅', 'success');
    showCloudSetup();
  } else {
    UI.toast('नेट जडान जाँच्नुहोस्', 'error');
  }
}

// ========== STANDARD WEB PUSH (VAPID) ==========
window._pushLastGroupId = window._pushLastGroupId || null;
window._pushLastPrivSig = window._pushLastPrivSig || {};

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function showLocalNotification(title, body, tag) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title || 'समूह बचत', {
      body: body || '',
      tag: tag || 'samuha',
      icon: './icon-192.png'
    });
    n.onclick = function () { window.focus(); n.close(); };
  } catch (e) {}
}

async function ensureNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

async function syncWebPushSubscription(silent) {
  try {
    if (!navigator.serviceWorker || !('PushManager' in window)) return false;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    if (!DB.getToken()) return false;

    const reg = await navigator.serviceWorker.ready;
    const keyRes = await DB.apiFetch('/push/vapid-public-key', { method: 'GET' });
    if (!keyRes.ok || !keyRes.body || !keyRes.body.publicKey) return false;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.body.publicKey)
      });
    }
    const saveRes = await DB.apiFetch('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub.toJSON())
    });
    return !!(saveRes.ok && saveRes.body && saveRes.body.ok);
  } catch (e) {
    if (!silent) console.warn('syncWebPushSubscription', e);
    return false;
  }
}

function checkChatNotifications(data) {
  if (!data || !data.chat) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const group = data.chat.group || [];
  if (group.length) {
    const last = group[group.length - 1];
    const rs = (typeof DB.getUserReadState === 'function') ? DB.getUserReadState() : {};
    const readAt = rs.chatReadAt || '';
    const isUnreadByTime = !readAt || (last.time && last.time > readAt);
    if (window._pushLastGroupId && last.id !== window._pushLastGroupId && isUnreadByTime && last.id !== rs.chatReadId) {
      const me = typeof _chatSender === 'function' ? _chatSender() : {};
      if (!(last.fromId === me.id && last.fromRole === me.role)) {
        const preview = (last.text || '').slice(0, 80);
        showLocalNotification(
          last.type === 'auto_group' || last.fromRole === 'system' ? '📢 समूह सूचना' : ('💬 ' + (last.fromName || 'समूह')),
          preview,
          'group-' + last.id
        );
      }
    }
    window._pushLastGroupId = last.id;
  }
}

async function enablePushFromSettings() {
  if (typeof Notification === 'undefined') {
    return UI.toast('यो ब्राउजरले सूचना सपोर्ट गर्दैन', 'error');
  }
  if (Notification.permission === 'denied') {
    return UI.showModal('🔔 सूचना',
      '<p style="font-size:0.9rem">ब्राउजरले रोकेको छ। ठेगाना बार बायाँ → Permissions / साइट सेटिङ → <strong>Notifications = Allow</strong>।</p>',
      '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
  }
  const ok = await ensureNotificationPermission();
  if (!ok) return UI.toast('अनुमति दिनुहोस्', 'error');
  const subOk = await syncWebPushSubscription(false);
  if (subOk) {
    UI.toast('पुश सूचना सक्रिय ✅', 'success');
    const adminBtn = (typeof Auth !== 'undefined' && Auth.isAccountsWriter && Auth.isAccountsWriter())
      ? '<button type="button" class="btn btn-success btn-block mt-1" onclick="sendMeetingReminderPushNow()">📢 सबै सदस्यलाई बैठक रिमाइन्डर Push पठाउनुहोस्</button>'
      : '';
    const html = `
      <p style="font-size:0.88rem;margin-bottom:12px">यो डिभाइसमा Cloudflare Web Push दर्ता भइसकेको छ — एप बन्द भए पनि सूचनाको घण्टी बज्छ।</p>
      <button type="button" class="btn btn-primary btn-block" onclick="sendTestPushNow()">🔔 मेरो फोनमा परीक्षण सूचना</button>
      ${adminBtn}
    `;
    UI.showModal('🔔 पुश सूचना सक्रिय', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
  } else {
    UI.toast('सूचना अनुमति OK (ब्याकग्राउन्ड पुशका लागि HTTPS आवश्यक)', 'success');
  }
}

async function sendTestPushNow() {
  const res = await DB.apiFetch('/push/test', { method: 'POST' });
  if (res.ok && res.body && res.body.sent > 0) {
    UI.toast('परीक्षण सूचना पठाइयो ✅', 'success');
  } else {
    showLocalNotification('🔔 समूह बचत परीक्षण', 'स्थानीय सूचना ठीक चलिरहेको छ!', 'local-test');
    UI.toast('स्थानीय परीक्षण सूचना देखाइयो', 'success');
  }
}

async function sendMeetingReminderPushNow() {
  if (!(Auth.isAccountsWriter && Auth.isAccountsWriter())) return UI.toast('Admin A मात्र', 'error');
  UI.toast('सबै सदस्यलाई सूचना पठाउँदै…', '');
  const res = await DB.apiFetch('/push/remind', {
    method: 'POST',
    body: JSON.stringify({
      title: '🔔 आज बचत बैठक छ',
      body: 'समूहको बचत कलेक्सन बैठक सुरु हुँदैछ — कृपया समयमै उपस्थित हुनुहोला।'
    })
  });
  if (res.ok && res.body && res.body.ok) {
    UI.toast(`पठाइयो ✅ (${res.body.sent || 0} सदस्य डिभाइसमा Push + च्याट सूचना)`, 'success');
  } else {
    UI.toast((res.body && res.body.error) || 'पठाउन सकिएन', 'error');
  }
}

function runAccountingAuditCheck() {
  const data = DB.load();
  const snap = Accounting.getSnapshot(data);
  const active = (data.members || []).filter((m) => m && m.active !== false);
  let sumLoans = 0, sumAdvances = 0, sumMemberAssets = 0, negIssues = [];
  const totalKitta = Accounting.totalKitta(data);
  const perKitta = snap.perKitta;

  active.forEach((m) => {
    const loan = Accounting.getEffectiveMemberLoan(data, m);
    const adv = Accounting.getEffectiveMemberAdvance(data, m);
    sumLoans += loan;
    sumAdvances += adv;
    sumMemberAssets += (Number(m.kitta) || 0) * perKitta;
    if (loan < 0 || adv < 0 || (Number(m.due) || 0) < 0) {
      negIssues.push(m.name);
    }
  });

  const loanDiff = Math.round((snap.loans - sumLoans) * 100) / 100;
  const equationDiff = Math.round((snap.assets - (snap.cash + snap.loans)) * 100) / 100;
  const equityDiff = Math.round(((snap.netShareAssets || 0) - Math.max(0, snap.assets - sumAdvances)) * 100) / 100;
  const allOk = Math.abs(loanDiff) <= 1 && Math.abs(equationDiff) <= 1 && Math.abs(equityDiff) <= 1 && negIssues.length === 0;

  const html = `
    <div class="section-title">${allOk ? '✅ हिसाब १००% मिलेको छ' : '⚠️ फरक जाँच गर्नुहोस्'}</div>
    <div class="report-card mb-2">
      <div class="report-row"><span class="label">सक्रिय सदस्य / कुल कित्ता</span><span class="value">${active.length} जना · ${totalKitta} कित्ता</span></div>
      <div class="report-row"><span class="label">कुल कोस (नगद + ऋण)</span><span class="value">रु. ${Accounting.formatNum(snap.assets)}</span></div>
      <div class="report-row"><span class="label">कोसमा नगद + बाँकी ऋण</span><span class="value">रु. ${Accounting.formatNum(snap.cash + snap.loans)}</span></div>
      <div class="report-row"><span class="label">सम्पत्ति vs (नगद+ऋण) फरक</span><span class="value" style="color:${Math.abs(equationDiff)<=1?'#198754':'#dc3545'}">${equationDiff}</span></div>
      <div class="report-row"><span class="label">सदस्य बाँकी ऋण योग (लाइभ)</span><span class="value">रु. ${Accounting.formatNum(sumLoans)}</span></div>
      <div class="report-row"><span class="label">ऋण मिलान फरक</span><span class="value" style="color:${Math.abs(loanDiff)<=1?'#198754':'#dc3545'}">${loanDiff}</span></div>
      <div class="report-row"><span class="label">सदस्य कुल अग्रिम (दायित्व)</span><span class="value">रु. ${Accounting.formatNum(sumAdvances)}</span></div>
      <div class="report-row highlight"><span class="label">सदस्य खुद शेयर कोस (कोस − अग्रिम)</span><span class="value fw-bold">रु. ${Accounting.formatNum(snap.netShareAssets || 0)}</span></div>
    </div>
    ${negIssues.length ? `<div style="color:#dc3545;font-size:0.82rem">ऋणात्मक मान भेटियो: ${negIssues.join(', ')}</div>` : ''}
    <p class="text-muted" style="font-size:0.78rem;margin-bottom:10px">अग्रिम रकम कोसमा नगद/लगानी भए पनि प्रति कित्ता शेयर मूल्य गणना गर्दा अग्रिम दायित्व अलग गरिएको छ।</p>
    ${Auth.isAccountsWriter && Auth.isAccountsWriter() ? `<button type="button" class="btn btn-warning btn-block" onclick="runAdvanceSnapshotReconcile()">🛠️ पुराना स्न्यापसट र पासबुक मिलान (अग्रिम अलग)</button>` : ''}
  `;
  UI.showModal('🧮 हिसाब मिलान अडिट', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function runAdvanceSnapshotReconcile() {
  UI.showPinModal('पुराना बन्द महिनाका स्न्यापसट र पासबुक शेयर मूल्य (अग्रिम अलग) मिलान गर्न PIN दिनुहोस्', () => {
    const data = DB.load();
    const n = Accounting.reconcileAdvanceSnapshots(data);
    DB.save(data);
    UI.updateHome(data);
    UI.toast(`${n} बन्द महिनाका स्न्यापसट र पासबुक मिल्यो ✅`, 'success');
    runAccountingAuditCheck();
  });
}

async function openSnapshotBackups() {
  UI.toast('स्न्यापसट लोड हुँदैछ…', '');
  const res = await DB.apiFetch('/snapshots', { method: 'GET' });
  if (!res.ok || !res.body || !res.body.ok) {
    return UI.toast((res.body && res.body.error) || 'लोड गर्न सकिएन', 'error');
  }
  const list = res.body.snapshots || [];
  let body = '';
  if (!list.length) {
    body = '<div class="empty-state">अहिलेसम्म बन्द महिना स्न्यापसट छैन (महिना बन्द गर्दा स्वतः बन्छ)</div>';
  } else {
    body = list.map((s) => `
      <div class="section-card" style="padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div>
          <div class="fw-bold">${s.name || s.month_id}</div>
          <div class="text-muted" style="font-size:0.75rem">${(s.closed_at || '').slice(0, 10)} ${s.r2_backup_key ? '· R2 सुरक्षित ✅' : '· D1 मात्र'}</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" onclick="downloadSnapshotBackup('${s.month_id}')">⬇️ डाउनलोड</button>
      </div>
    `).join('');
  }
  UI.showModal('🗂️ बन्द महिना स्न्यापसट', body, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

async function downloadSnapshotBackup(monthId) {
  const res = await DB.apiFetch('/snapshot/' + encodeURIComponent(monthId), { method: 'GET' });
  if (!res.ok || !res.body || !res.body.ok) {
    return UI.toast('डाउनलोड असफल', 'error');
  }
  const blob = new Blob([JSON.stringify(res.body.backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `samuha-snapshot-${monthId}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  UI.toast('स्न्यापसट डाउनलोड भयो ✅', 'success');
}


/** Admin device fingerprint / biometrics (WebAuthn) — optional */
async function registerAdminBiometric() {
  if (!window.PublicKeyCredential) {
    return UI.toast('यो ब्राउजरमा फिंगरप्रिन्ट समर्थित छैन — PIN प्रयोग गर्नुहोस्', 'error');
  }
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: Uint8Array.from(String(Date.now()), c => c.charCodeAt(0)),
        rp: { name: 'Samuha Bachat', id: location.hostname },
        user: {
          id: Uint8Array.from('admin-local', c => c.charCodeAt(0)),
          name: 'admin',
          displayName: 'Admin'
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      }
    });
    if (cred) {
      localStorage.setItem('samuha_webauthn', '1');
      UI.toast('फिंगरप्रिन्ट दर्ता भयो — यो फोनमा PIN सट्टा प्रयोग गर्न सकिन्छ', 'success');
    }
  } catch (e) {
    console.warn(e);
    UI.toast('दर्ता रद्द/असफल — PIN नै प्रयोग गर्नुहोस्', 'error');
  }
}

async function tryAdminBiometricThen(fn) {
  if (localStorage.getItem('samuha_webauthn') !== '1' || !window.PublicKeyCredential) {
    return UI.showPinModal('PIN आवश्यक', fn);
  }
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: Uint8Array.from(String(Date.now()), c => c.charCodeAt(0)),
        timeout: 60000,
        userVerification: 'required',
        rpId: location.hostname
      }
    });
    fn();
  } catch (e) {
    UI.showPinModal('बायोमेट्रिक असफल — PIN हाल्नुहोस्', fn);
  }
}


// ========== BS calendar + Nepal time + bills + meeting reminders ==========
const BS_MONTHS_NP = ['बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पुस','माघ','फाल्गुन','चैत'];
const BS_CAL_DATA = {
  2080: { start: [2023,4,14], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
  2081: { start: [2024,4,13], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
  2082: { start: [2025,4,14], lens: [31,32,31,32,31,30,30,30,29,30,29,31] },
  2083: { start: [2026,4,14], lens: [31,31,32,31,31,31,30,30,29,30,30,30] },
  2084: { start: [2027,4,14], lens: [31,32,31,32,31,30,30,30,29,30,30,30] },
  2085: { start: [2028,4,13], lens: [31,31,32,31,31,31,30,29,30,29,30,30] },
  2086: { start: [2029,4,14], lens: [31,32,31,32,31,30,30,30,29,30,29,31] }
};

function getNepalNow() {
  // Asia/Kathmandu UTC+5:45
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + (5 * 60 + 45) * 60000);
}

function adToBsParts(dt) {
  const y = dt.getFullYear(), m = dt.getMonth() + 1, d = dt.getDate();
  const utc = Date.UTC(y, m - 1, d);
  for (const [yr, info] of Object.entries(BS_CAL_DATA)) {
    const s = info.start;
    const startUtc = Date.UTC(s[0], s[1] - 1, s[2]);
    const yearLen = info.lens.reduce((a, b) => a + b, 0);
    if (utc >= startUtc && utc < startUtc + yearLen * 86400000) {
      let daysCount = Math.round((utc - startUtc) / 86400000);
      let bm = 0;
      for (; bm < 12; bm++) {
        if (daysCount < info.lens[bm]) break;
        daysCount -= info.lens[bm];
      }
      return { year: parseInt(yr, 10), monthIndex: bm, day: daysCount + 1, lens: info.lens, start: s };
    }
  }
  return null;
}

function bsToAdDate(year, monthIndex, day) {
  const info = BS_CAL_DATA[year];
  if (!info) return null;
  let days = day - 1;
  for (let i = 0; i < monthIndex; i++) days += info.lens[i];
  const s = info.start;
  const t = Date.UTC(s[0], s[1] - 1, s[2]) + days * 86400000;
  // UTC noon to avoid TZ edge
  return new Date(t + 12 * 3600000);
}

/** nth weekday in BS month: weekday 0=Sun ... 5=Fri 6=Sat, n=1 first, n=2 second */
function nthWeekdayOfBsMonth(year, monthIndex, weekday, n) {
  const info = BS_CAL_DATA[year];
  if (!info) return null;
  const first = bsToAdDate(year, monthIndex, 1);
  if (!first) return null;
  const firstWd = first.getUTCDay();
  let day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
  if (day > info.lens[monthIndex]) return null;
  return { day: day, ad: bsToAdDate(year, monthIndex, day), year: year, monthIndex: monthIndex };
}

function fiscalYearLabel(yearBS, monthIndex) {
  // साउन (3) देखि नयाँ आर्थिक वर्ष
  if (monthIndex >= 3) {
    return yearBS + '/' + String(yearBS + 1).slice(-2);
  }
  return (yearBS - 1) + '/' + String(yearBS).slice(-2);
}

function nextBillNumber(data, yearBS, monthIndex) {
  if (!data.billSeq) data.billSeq = {};
  if (!data.bills) data.bills = {};
  const fy = fiscalYearLabel(yearBS, monthIndex);
  const n = (data.billSeq[fy] || 0) + 1;
  data.billSeq[fy] = n;
  const num = fy + '/' + String(n).padStart(2, '0');
  return num;
}

function buildMemberReceipt(data, month, member) {
  const c = (month.collections && month.collections[member.id]) || {};
  const loans = (month.loansGiven || []).filter(l => l.memberId === member.id);
  const loanTaken = loans.reduce((s, l) => s + (l.amount || 0), 0);
  const snap = (month.memberSnapshots && month.memberSnapshots[member.id]) || {};
  const loanLeft = snap.outstandingLoan != null ? snap.outstandingLoan : (member.outstandingLoan || 0);
  const yearBS = month.yearBS || (adToBsParts(getNepalNow()) || {}).year || 2083;
  const mIdx = month.monthIndex != null ? month.monthIndex : 0;
  const billNo = nextBillNumber(data, yearBS, mIdx);
  const nepal = getNepalNow();
  const days = ['आइतबार','सोमबार','मंगलबार','बुधबार','बिहिबार','शुक्रबार','शनिबार'];
  const bs = adToBsParts(nepal);
  const dateStr = bs
    ? (BS_MONTHS_NP[bs.monthIndex] + ' ' + bs.day + ', ' + bs.year + ' · ' + days[nepal.getDay()])
    : nepal.toLocaleDateString();

  const bill = {
    id: billNo,
    memberId: member.id,
    memberName: member.name,
    monthId: month.id,
    monthName: month.name,
    time: new Date().toISOString(),
    groupName: (data.group && data.group.name) || 'समूह बचत',
    dateStr: dateStr,
    saving: c.saving || 0,
    interest: c.interest || 0,
    principal: c.principal || 0,
    fine: c.fine || 0,
    previousDue: c.previousDue || 0,
    other: 0,
    totalPaid: c.totalPaid || 0,
    loanTaken: loanTaken,
    loanBalance: loanLeft,
    advance: snap.advance != null ? snap.advance : (member.advance || 0),
    due: snap.due != null ? snap.due : (member.due || 0)
  };
  data.bills[billNo] = bill;
  if (!month.memberBills) month.memberBills = {};
  month.memberBills[member.id] = billNo;
  return bill;
}

function receiptText(bill) {
  const lines = [
    '════════════════════',
    '      डिजिटल रसिद',
    '════════════════════',
    bill.groupName,
    'बिल नं: ' + bill.id,
    bill.dateStr,
    'महिना: ' + (bill.monthName || ''),
    'सदस्य: ' + (bill.memberName || ''),
    '────────────────────',
    'बचत: रु. ' + Accounting.formatNum(bill.saving),
    'ब्याज: रु. ' + Accounting.formatNum(bill.interest),
    'सावा: रु. ' + Accounting.formatNum(bill.principal),
    'जरिवाना: रु. ' + Accounting.formatNum(bill.fine),
    'अघिल्लो बाँकी तिरेको: रु. ' + Accounting.formatNum(bill.previousDue),
    'जम्मा तिरेको: रु. ' + Accounting.formatNum(bill.totalPaid),
    '────────────────────',
    'यस महिना थप ऋण: रु. ' + Accounting.formatNum(bill.loanTaken),
    'तिर्न बाँकी ऋण: रु. ' + Accounting.formatNum(bill.loanBalance),
    'अग्रिम: रु. ' + Accounting.formatNum(bill.advance),
    'बाँकी (अनिवार्य): रु. ' + Accounting.formatNum(bill.due),
    '════════════════════',
    'कृपया पासबुकसँग मिलाएर हेर्नुहोस्।',
    'फरक लागे गुनासो गर्नुहोस्।'
  ];
  return lines.join('\n');
}

function issueMonthCloseReceipts(data, month) {
  if (!data.bills) data.bills = {};
  if (!month.memberBills) month.memberBills = {};
  data.members.filter(m => m.active).forEach(member => {
    const bill = buildMemberReceipt(data, month, member);
    postPrivateMessage(member.id, receiptText(bill), 'receipt', data);
    // store bill id on last message
    const arr = data.chat.private[member.id];
    if (arr && arr.length) {
      arr[arr.length - 1].billId = bill.id;
      arr[arr.length - 1].type = 'receipt';
    }
  });
}

function viewBill(billId) {
  const data = DB.load();
  const bill = data.bills && data.bills[billId];
  if (!bill) return UI.toast('बिल भेटिएन', 'error');
  const html = `
    <div class="print-area" id="print-bill" style="background:#fff;border:2px solid #333;border-radius:12px;padding:16px;max-width:340px;margin:0 auto;font-family:monospace">
      <div style="text-align:center;font-weight:700;font-size:1.05rem">${escapeHtmlChat(bill.groupName)}</div>
      <div style="text-align:center;font-size:0.8rem;margin:4px 0">डिजिटल रसिद</div>
      <div style="text-align:center;font-size:0.85rem;font-weight:700">बिल नं: ${escapeHtmlChat(bill.id)}</div>
      <div style="text-align:center;font-size:0.75rem;color:#555;margin-bottom:8px">${escapeHtmlChat(bill.dateStr || '')}</div>
      <div style="font-size:0.85rem;border-top:1px dashed #999;padding-top:8px">
        <div>महिना: <strong>${escapeHtmlChat(bill.monthName || '')}</strong></div>
        <div>सदस्य: <strong>${escapeHtmlChat(bill.memberName || '')}</strong></div>
      </div>
      <table style="width:100%;font-size:0.82rem;margin-top:8px;border-collapse:collapse">
        <tr><td>बचत</td><td style="text-align:right">${Accounting.formatNum(bill.saving)}</td></tr>
        <tr><td>ब्याज</td><td style="text-align:right">${Accounting.formatNum(bill.interest)}</td></tr>
        <tr><td>सावा</td><td style="text-align:right">${Accounting.formatNum(bill.principal)}</td></tr>
        <tr><td>जरिवाना</td><td style="text-align:right">${Accounting.formatNum(bill.fine)}</td></tr>
        <tr><td>अघिल्लो बाँकी</td><td style="text-align:right">${Accounting.formatNum(bill.previousDue)}</td></tr>
        <tr style="font-weight:700;border-top:1px solid #333"><td>जम्मा तिरेको</td><td style="text-align:right">${Accounting.formatNum(bill.totalPaid)}</td></tr>
        <tr><td>थप ऋण</td><td style="text-align:right">${Accounting.formatNum(bill.loanTaken)}</td></tr>
        <tr><td>बाँकी ऋण</td><td style="text-align:right;color:#c00">${Accounting.formatNum(bill.loanBalance)}</td></tr>
        <tr><td>बाँकी अग्रिम</td><td style="text-align:right;color:#0d6efd">${Accounting.formatNum(bill.advance || 0)}</td></tr>
        <tr><td>तिर्न बाँकी (अनिवार्य)</td><td style="text-align:right;color:#dc3545">${Accounting.formatNum(bill.due || 0)}</td></tr>
      </table>
      <div style="text-align:center;font-size:0.7rem;margin-top:10px;color:#666">— समूह बचत प्रणाली —</div>
    </div>
    <button class="btn btn-primary btn-block mt-2" onclick="printReportImage('print-bill')">🖨️ / सेभ इमेज</button>
  `;
  UI.showModal('🧾 बिल ' + billId, html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

function meetingReminderText(member, data) {
  const month = Accounting.getCurrentMonth(data);
  let mandatory = { total: 0, saving: 0, interest: 0, fine: 0, previousDue: 0 };
  try {
    if (month && member) mandatory = Accounting.calcMandatory(member, data, month);
  } catch (e) {}
  const lines = [
    '🔔 बचत भेला रिमाइन्डर',
    '',
    'प्रिय ' + (member.name || '') + ',',
    '',
    'भोलि (नेपाली महिनाको दोस्रो शनिबार) समूहको बचत भेला बस्ने छ।',
    'कृपया समयमै उपस्थित हुनुहोला।',
    '',
    '— तपाईंको विवरण —',
    'अनिवार्य (नगद) तिर्नुपर्ने: रु. ' + Accounting.formatNum(mandatory.total || mandatory.totalGross || 0),
    'बाँकी ऋण: रु. ' + Accounting.formatNum(member.outstandingLoan || 0),
    'अग्रिम: रु. ' + Accounting.formatNum(member.advance || 0),
    'अनिवार्य बाँकी: रु. ' + Accounting.formatNum(member.due || 0),
    '',
    'धन्यवाद।'
  ];
  return lines.join('\n');
}

function sendSecondFridayReminders(data) {
  if (!data.scheduleLog) data.scheduleLog = {};
  const nepal = getNepalNow();
  const bs = adToBsParts(nepal);
  if (!bs) return false;
  const fri = nthWeekdayOfBsMonth(bs.year, bs.monthIndex, 5, 2); // Friday=5
  if (!fri || !fri.ad) return false;
  // Must be second Friday, hour >= 18 Nepal time
  if (bs.day !== fri.day) return false;
  if (nepal.getHours() < 18) return false;
  const key = 'remind_' + bs.year + '_' + bs.monthIndex;
  if (data.scheduleLog[key]) return false;
  data.members.filter(m => m.active).forEach(m => {
    postPrivateMessage(m.id, meetingReminderText(m, data), 'auto_private', data);
  });
  data.scheduleLog[key] = new Date().toISOString();
  return true;
}

function maybeAutoDriveBackupHint(data) {
  if (!data.scheduleLog) data.scheduleLog = {};
  const nepal = getNepalNow();
  const bs = adToBsParts(nepal);
  if (!bs) return false;
  const sat = nthWeekdayOfBsMonth(bs.year, bs.monthIndex, 6, 2);
  if (!sat || bs.day !== sat.day) return false;
  if (nepal.getHours() < 18) return false;
  const key = 'backup_' + bs.year + '_' + bs.monthIndex;
  if (data.scheduleLog[key]) return false;
  data.scheduleLog[key] = new Date().toISOString();
  // Trigger JSON download backup for admin
  try {
    if (typeof doExportBackup === 'function') doExportBackup();
    UI.toast('📦 दोस्रो शनिबार — ब्याकअप डाउनलोड सुरु (Drive मा सेभ गर्नुहोस्)', 'success');
  } catch (e) {}
  return true;
}

function runScheduleChecks() {
  try {
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn || !Auth.isLoggedIn()) return;
    if (!Auth.isAccountsWriter || !Auth.isAccountsWriter()) return;
    const data = DB.load();
    let changed = false;
    if (sendSecondFridayReminders(data)) changed = true;
    if (maybeAutoDriveBackupHint(data)) changed = true;
    if (changed) DB.save(data);
  } catch (e) {
    console.warn('schedule', e);
  }
}

function startScheduleTimers() {
  if (window._samuhaSched) return;
  window._samuhaSched = setInterval(runScheduleChecks, 60000);
  setTimeout(runScheduleChecks, 5000);
}

function showDriveBackupGuide() {
  const html = `
    <div class="report-card" style="font-size:0.85rem;max-height:65vh;overflow:auto">
      <p><strong>📦 ब्याकअप र Cloudflare सुरक्षा</strong><br>
      हिसाब Cloudflare D1 र R2 मा प्रत्येक परिवर्तनमा सुरक्षित सेभ हुन्छ। महिना बन्द हुँदा R2 मा पनि snapshot बन्छ र JSON ब्याकअप डाउनलोड गर्न सकिन्छ।</p>
      <hr>
      <p><strong>🔔 स्वचालित भेला रिमाइन्डर (दोस्रो शुक्रबार ६ बजे)</strong></p>
      <p><code>cron-worker</code> ले हरेक शुक्रबार नेपाली समय ६:०० बजे D1 जाँचेर दोस्रो शुक्रबार परे सबै सदस्यलाई Web Push सूचना र समूह च्याट सन्देश पठाउँछ।</p>
    </div>`;
  UI.showModal('☁️ ब्याकअप र रिमाइन्डर गाइड', html, '<button class="btn btn-outline" onclick="closeModal()">बन्द</button>');
}

window.confirmClearAccountingOnly = confirmClearAccountingOnly;
window.runClearAccountingOnly = runClearAccountingOnly;

window.fixDuplicateMembersNow = fixDuplicateMembersNow;
