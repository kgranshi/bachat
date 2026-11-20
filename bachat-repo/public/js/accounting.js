/**
 * Accounting Engine
 * All formulas as per final design
 */

const Accounting = {
  // Nepali months (साउन = 0 ... असार = 11)
  NEPALI_MONTHS: [
    'साउन', 'भदौ', 'असोज', 'कात्तिक',
    'मंसिर', 'पुस', 'माघ', 'फागुन',
    'चैत', 'बैशाख', 'जेठ', 'असार'
  ],

  formatNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '0';
    return String(Math.round(Number(n)));
  },

  // Create initial 20 members
  createDefaultMembers() {
    const members = [];
    for (let i = 1; i <= 20; i++) {
      members.push({
        id: 'm' + i,
        name: 'सदस्य ' + i,
        mobile: '',
        pin: '',
        kitta: 0,
        photo: null,
        active: true,
        joinedMonthId: null,
        // Running balances (updated each month close)
        outstandingLoan: 0,   // उठ्न बाँकी ऋण
        advance: 0,           // अग्रिम
        due: 0,               // बाँकी (अनिवार्य नतिरेको)
        // History for passbook
        assetHistory: [],     // { monthId, prev, added, total }
        loanHistory: []       // { monthId, prev, taken, repaid, balance }
      });
    }
    return members;
  },

  // Get total kittas of active members
  totalKitta(data) {
    return data.members
      .filter(m => m.active)
      .reduce((s, m) => s + (m.kitta || 0), 0);
  },

  totalMembers(data) {
    return data.members.filter(m => m.active).length;
  },

  // Current month object
  getCurrentMonth(data) {
    if (!data.currentMonthId) return null;
    return data.months.find(m => m.id === data.currentMonthId) || null;
  },

  // Previous closed month (chronological: year + monthIndex + closedAt)
  getPreviousMonth(data) {
    const closed = (data.months || []).filter(m => m.status === 'closed');
    if (closed.length === 0) return null;
    closed.sort((a, b) => {
      if ((a.yearBS || 0) !== (b.yearBS || 0)) return (a.yearBS || 0) - (b.yearBS || 0);
      if ((a.monthIndex || 0) !== (b.monthIndex || 0)) return (a.monthIndex || 0) - (b.monthIndex || 0);
      return String(a.closedAt || '').localeCompare(String(b.closedAt || ''));
    });
    return closed[closed.length - 1];
  },

  // All closed months in order
  getClosedMonthsSorted(data) {
    const closed = (data.months || []).filter(m => m.status === 'closed');
    closed.sort((a, b) => {
      if ((a.yearBS || 0) !== (b.yearBS || 0)) return (a.yearBS || 0) - (b.yearBS || 0);
      if ((a.monthIndex || 0) !== (b.monthIndex || 0)) return (a.monthIndex || 0) - (b.monthIndex || 0);
      return String(a.closedAt || '').localeCompare(String(b.closedAt || ''));
    });
    return closed;
  },

  /**
   * Single source of truth for all screens (home, profile, passbook, reports)
   * assets = group total property
   * loans  = outstanding investment
   * cash   = assets - loans
   * kitta  = total shares
   * perKitta = assets / kitta
   */
  // Real-time effective member loan: during open collection, principal paid reduces displayed loan immediately
  getEffectiveMemberLoan(data, member, month) {
    if (!member) return 0;
    const base = Number(member.outstandingLoan) || 0;
    const m = month !== undefined ? month : this.getCurrentMonth(data);
    if (m && m.status === 'open' && m.collections && m.collections[member.id]) {
      const paidPrincipal = Number(m.collections[member.id].principal) || 0;
      return Math.max(0, base - paidPrincipal);
    }
    return base;
  },

  // Real-time effective member advance during open collection
  getEffectiveMemberAdvance(data, member, month) {
    if (!member) return 0;
    const base = Number(member.advance) || 0;
    const m = month !== undefined ? month : this.getCurrentMonth(data);
    if (m && m.status === 'open' && m.collections && m.collections[member.id]) {
      const c = m.collections[member.id];
      return Math.max(0, base - (Number(c.fromAdvance) || 0)) + (Number(c.advance) || 0);
    }
    return base;
  },

  totalAdvance(data, month) {
    if (month && month.status === 'closed') {
      if (typeof month.totalAdvances === 'number' && !isNaN(month.totalAdvances)) {
        return month.totalAdvances;
      }
      if (month.memberSnapshots && Object.keys(month.memberSnapshots).length) {
        return Object.values(month.memberSnapshots)
          .reduce((s, snap) => s + (Number(snap && snap.advance) || 0), 0);
      }
    }
    return (data.members || [])
      .filter(m => m.active)
      .reduce((s, m) => s + this.getEffectiveMemberAdvance(data, m, month), 0);
  },

  /**
   * HOME = latest group position only
   * assets = current/last month finalAssets (total fund = cash + loans)
   * loans  = live sum of effective member outstanding loans (today's reality)
   * cash   = assets - loans
   * netShareAssets = assets - totalAdvance (member equity excluding advance deposits)
   */
  getSnapshot(data) {
    if (data.migrationDone) this.syncOpenMonthFromMigration(data);

    const month = this.getCurrentMonth(data);
    const prev = this.getPreviousMonth(data);
    const kitta = this.totalKitta(data);
    const members = this.totalMembers(data);

    const migLoans = Object.values((data.migration && data.migration.loans) || {})
      .reduce((s, v) => s + (Number(v) || 0), 0);
    const migCash = Number((data.migration && data.migration.cash) || 0);

    let assets = 0;

    if (month) {
      this.recalcMonth(month, data);
      assets = Number(month.finalAssets) || 0;
    } else if (prev) {
      assets = Number(prev.finalAssets) || 0;
    } else if (data.migrationDone) {
      assets = migCash + migLoans;
    }

    const loans = (data.members || []).filter(m => m.active)
      .reduce((s, m) => s + this.getEffectiveMemberLoan(data, m, month), 0);
    const cash = assets - loans;
    const totalAdvance = this.totalAdvance(data, month || prev);
    const netShareAssets = Math.max(0, assets - totalAdvance);
    const perKitta = kitta > 0 ? Math.round(netShareAssets / kitta) : 0;

    return { assets, loans, cash, totalAdvance, netShareAssets, kitta, members, perKitta, month, prev, migCash, migLoans };
  },

  // Per kitta value — deducts member advances from fund assets so advances don't inflate share value
  perKittaValue(data, month) {
    const snap = this.getSnapshot(data);
    if (month && month.finalAssets != null && (month.totalKitta || snap.kitta) > 0) {
      const k = month.totalKitta || snap.kitta;
      const adv = this.totalAdvance(data, month);
      const netShare = Math.max(0, (Number(month.finalAssets) || 0) - adv);
      return Math.round(netShare / k);
    }
    return snap.perKitta;
  },

  // Member's share of group assets
  memberAssets(data, member) {
    const snap = this.getSnapshot(data);
    return snap.perKitta * (member.kitta || 0);
  },

  // Interest on PREVIOUS month-end loan balance
  // First month after migration: interest on migration loan (past loan)
  calcInterest(member, prevMonth, rate, data) {
    let prevLoan = 0;
    if (prevMonth) {
      prevLoan = (prevMonth.memberSnapshots && prevMonth.memberSnapshots[member.id])
        ? (prevMonth.memberSnapshots[member.id].outstandingLoan || 0)
        : (member.outstandingLoan || 0);
    } else if (data && data.migrationDone && data.migration.loans) {
      // First app month: migration loans are "previous" outstanding
      prevLoan = Number(data.migration.loans[member.id]) || 0;
    }
    return Math.round(prevLoan * ((rate || 0) / 100));
  },

  // What a member must pay this month (अनिवार्य)
  // बाँकी (due) → अनिवार्य बढ्छ; अग्रिम → अनिवार्य (नगद) घट्छ
  calcMandatory(member, data, month) {
    const saving = (member.kitta || 0) * (data.settings.monthlySaving || 0);
    const interest = this.calcInterest(member, this.getPreviousMonth(data), data.settings.interestRate, data);
    const previousDue = member.due || 0;
    const fine = Math.round(previousDue * ((data.settings.fineRate || 0) / 100));
    const gross = saving + interest + fine + previousDue; // पूर्ण अनिवार्य
    const advance = member.advance || 0;
    const advanceCover = Math.min(advance, gross); // अग्रिमले कट्टा
    const toPay = Math.max(0, gross - advanceCover); // नगद तिर्नुपर्ने
    return {
      saving,
      interest,
      fine,
      previousDue,
      gross,
      advance,
      advanceCover,
      total: toPay,       // नगद अनिवार्य (अग्रिम कट्टा पछि)
      totalGross: gross   // कट्टा अघिको जम्मा
    };
  },

  // Allocate payment
  // Order: saving → interest → fine → previousDue → principal(saawa) → advance
  // advanceCover: amount already covered by existing advance (reduces what cash must fill)
  allocatePayment(member, amount, mandatory, hasLoan, advanceCover = 0) {
    // First apply advance cover against mandatory in same order
    let coverLeft = advanceCover || 0;
    const afterAdv = {
      saving: mandatory.saving || 0,
      interest: mandatory.interest || 0,
      fine: mandatory.fine || 0,
      previousDue: mandatory.previousDue || 0
    };
    ['saving', 'interest', 'fine', 'previousDue'].forEach(k => {
      const use = Math.min(coverLeft, afterAdv[k]);
      afterAdv[k] -= use;
      coverLeft -= use;
    });

    let remaining = amount;
    const result = {
      saving: 0,
      interest: 0,
      fine: 0,
      previousDue: 0,
      principal: 0,
      advance: 0,
      totalPaid: amount,
      fromAdvance: advanceCover || 0
    };

    // Cash fills what advance didn't cover
    result.saving = Math.min(remaining, afterAdv.saving);
    remaining -= result.saving;

    result.interest = Math.min(remaining, afterAdv.interest);
    remaining -= result.interest;

    result.fine = Math.min(remaining, afterAdv.fine);
    remaining -= result.fine;

    result.previousDue = Math.min(remaining, afterAdv.previousDue);
    remaining -= result.previousDue;

    if (hasLoan && remaining > 0) {
      const maxPrincipal = member.outstandingLoan || 0;
      result.principal = Math.min(remaining, maxPrincipal);
      remaining -= result.principal;
    }

    // Excess cash → new advance
    result.advance = remaining;

    return result;
  },

  // Create a new month — सुरु मौज्दात = पछिल्लो बन्द महिनाको अन्तिम मौज्दात मात्र
  createMonth(data, monthIndex, yearBS) {
    const prev = this.getPreviousMonth(data);
    let startAssets = 0;
    let startOutstanding = 0;

    if (prev) {
      // Always use LAST closed month (not migration, not first month)
      this.recalcMonth(prev, data);
      startAssets = Number(prev.finalAssets) || 0;
      startOutstanding = Number(prev.outstandingLoans) || 0;
    } else if (data.migrationDone) {
      // First month only
      startOutstanding = Object.values(data.migration.loans || {}).reduce((s, v) => s + (Number(v) || 0), 0);
      startAssets = (Number(data.migration.cash) || 0) + startOutstanding;
    }

    const id = 'mth_' + yearBS + '_' + monthIndex + '_' + Date.now();
    return {
      id,
      monthIndex,
      yearBS,
      name: this.NEPALI_MONTHS[monthIndex] + ' ' + yearBS,
      status: 'open',
      startAssets,
      savingsCollected: 0,
      interestCollected: 0,
      otherIncome: 0,
      expenses: 0,
      netIncome: 0,
      finalAssets: startAssets,
      principalCollected: 0,
      newLoansGiven: 0,
      outstandingLoans: startOutstanding,
      cashInHand: startAssets - startOutstanding,
      totalMembers: this.totalMembers(data),
      totalKitta: this.totalKitta(data),
      collections: {},
      loansGiven: [],
      memberSnapshots: {},
      otherIncomeDetails: [],
      expenseDetails: [],
      fromPrevMonthId: prev ? prev.id : null,
      closedAt: null,
      collectionClosedAt: null
    };
  },

  /**
   * Recalc ONE month only (does not change other months).
   * RULE: Only CASH received affects मौज्दात.
   * Advance usage does NOT add income.
   * Closed month: outstandingLoans stays FROZEN (as at close).
   * Open month: outstandingLoans = live member loans.
   */
  recalcMonth(month, data) {
    let savings = 0, interest = 0, other = 0, expenses = 0;
    let principal = 0, newLoans = 0, advanceFromCash = 0;

    Object.values(month.collections || {}).forEach(c => {
      const paid = Number(c.totalPaid) || 0;
      if (paid <= 0) return; // advance-only: no income
      savings += c.saving || 0;
      interest += c.interest || 0;
      principal += c.principal || 0;
      if ((c.advance || 0) > 0) advanceFromCash += c.advance;
    });

    other = (month.otherIncomeDetails || []).reduce((s, d) => s + (d.amount || 0), 0);
    expenses = (month.expenseDetails || []).reduce((s, d) => s + (d.amount || 0), 0);
    newLoans = (month.loansGiven || []).reduce((s, l) => s + (l.amount || 0), 0);

    month.savingsCollected = savings;
    month.interestCollected = interest;
    month.otherIncome = other;
    month.expenses = expenses;
    month.principalCollected = principal;
    month.newLoansGiven = newLoans;
    month.advanceFromCash = advanceFromCash;

    month.netIncome = savings + interest + other + advanceFromCash - expenses;
    month.finalAssets = (Number(month.startAssets) || 0) + month.netIncome;

    if (month.status === 'closed') {
      if (month.memberSnapshots && Object.keys(month.memberSnapshots).length) {
        month.outstandingLoans = Object.values(month.memberSnapshots)
          .reduce((s, snap) => s + (Number(snap.outstandingLoan) || 0), 0);
      }
      month.totalAdvances = this.totalAdvance(data, month);
    } else {
      const liveOutstanding = (data.members || [])
        .filter(m => m.active)
        .reduce((s, m) => s + this.getEffectiveMemberLoan(data, m, month), 0);
      const prevOut = this.getStartOutstanding(data, month);
      const calcOutstanding = Math.max(0, prevOut - principal + newLoans);
      month.outstandingLoans = liveOutstanding > 0 ? liveOutstanding : calcOutstanding;
      month.totalAdvances = this.totalAdvance(data, month);
    }

    month.netShareAssets = Math.max(0, (Number(month.finalAssets) || 0) - (Number(month.totalAdvances) || 0));
    month.cashInHand = (Number(month.finalAssets) || 0) - (Number(month.outstandingLoans) || 0);
    month.totalMembers = this.totalMembers(data);
    month.totalKitta = this.totalKitta(data);

    return month;
  },

  getStartOutstanding(data, month) {
    // Chronological previous month (closed or not) — same chain rule as assets
    const all = (data.months || []).slice().sort((a, b) => {
      if ((a.yearBS || 0) !== (b.yearBS || 0)) return (a.yearBS || 0) - (b.yearBS || 0);
      if ((a.monthIndex || 0) !== (b.monthIndex || 0)) return (a.monthIndex || 0) - (b.monthIndex || 0);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    const idx = all.findIndex(m => m.id === month.id);
    if (idx > 0) {
      return Number(all[idx - 1].outstandingLoans) || 0;
    }
    if (data.migrationDone) {
      return Object.values(data.migration.loans || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    }
    return 0;
  },

  getPreviousOutstanding(data, month) {
    return this.getStartOutstanding(data, month);
  },

  // Apply migration to members
  applyMigration(data) {
    if (!data.migration) return;
    if (!data.migration.loans) data.migration.loans = {};
    if (!data.migration.advances) data.migration.advances = {};
    if (!data.migration.kittas) data.migration.kittas = {};
    data.members.forEach(m => {
      if (data.migration.kittas[m.id] !== undefined) {
        m.kitta = parseInt(data.migration.kittas[m.id], 10) || 0;
      }
      m.outstandingLoan = parseFloat(data.migration.loans[m.id]) || 0;
      m.advance = parseFloat(data.migration.advances[m.id]) || 0;
      m.due = 0;
    });
    data.migrationDone = true;
    this.syncOpenMonthFromMigration(data);

    // Seed passbook so profile/passbook show opening balances immediately
    data.members.forEach(m => {
      if (!m.active) return;
      const assets = this.memberAssets(data, m);
      m.assetHistory = [{
        monthId: 'migration',
        monthName: 'सुरु (माइग्रेशन)',
        prev: 0,
        added: assets,
        total: assets
      }];
      if ((m.outstandingLoan || 0) > 0) {
        m.loanHistory = [{
          monthId: 'migration',
          monthName: 'सुरु (माइग्रेशन)',
          prev: 0,
          taken: m.outstandingLoan,
          repaid: 0,
          balance: m.outstandingLoan
        }];
      } else {
        m.loanHistory = m.loanHistory || [];
      }
    });
  },

  syncOpenMonthFromMigration(data) {
    if (!data.migrationDone || !data.migration) return;
    // ONLY first open month — never overwrite later months with migration figures
    const closedCount = (data.months || []).filter(m => m.status === 'closed').length;
    if (closedCount > 0) return;

    const migLoans = Object.values(data.migration.loans || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const migCash = Number(data.migration.cash || 0);
    const assets = migCash + migLoans;
    if (assets <= 0 && this.totalKitta(data) <= 0) return;

    if (data.currentMonthId) {
      const month = data.months.find(m => m.id === data.currentMonthId);
      if (month) {
        const hasActivity = Object.keys(month.collections || {}).length > 0 || (month.loansGiven || []).length > 0;
        if (!hasActivity) {
          month.startAssets = assets;
          month.finalAssets = assets;
          month.outstandingLoans = migLoans;
          month.cashInHand = migCash;
          month.totalKitta = this.totalKitta(data);
          month.totalMembers = this.totalMembers(data);
        }
      }
    }
  },

  // Close collection: those who didn't pay → due
  closeCollection(data, month) {
    data.members.filter(m => m.active).forEach(m => {
      const coll = month.collections[m.id];
      const mandatory = this.calcMandatory(m, data, month);

      if (!coll) {
        // No cash — apply advance once against FULL gross mandatory, remainder → due
        let stillDue = mandatory.totalGross || mandatory.total || 0;
        let used = 0;
        if (m.advance > 0 && stillDue > 0) {
          used = Math.min(m.advance, stillDue);
          m.advance -= used;
          stillDue -= used;
        }
        if (used > 0) {
          month.collections[m.id] = {
            saving: 0, interest: 0, fine: 0, previousDue: 0, principal: 0,
            advance: 0, totalPaid: 0,
            fromAdvance: used,
            coveredByAdvance: true,
            time: new Date().toISOString()
          };
        }
        m.due = stillDue > 0 ? stillDue : 0;
      } else {
        // Cash was paid — apply allocation results
        // Advance that was reserved at entry time
        const reservedAdv = coll.fromAdvance || 0;
        if (reservedAdv > 0) {
          m.advance = Math.max(0, (m.advance || 0) - reservedAdv);
        }
        // Excess cash becomes new advance
        if ((coll.advance || 0) > 0) {
          m.advance = (m.advance || 0) + coll.advance;
        }
        if ((coll.principal || 0) > 0) {
          m.outstandingLoan = Math.max(0, (m.outstandingLoan || 0) - coll.principal);
        }

        // Covered = cash components + advance reserved
        const paidMandatory = (coll.saving || 0) + (coll.interest || 0) + (coll.fine || 0) + (coll.previousDue || 0);
        const covered = paidMandatory + reservedAdv;
        let shortfall = (mandatory.totalGross || mandatory.total) - covered;
        if (shortfall > 0 && m.advance > 0) {
          const used = Math.min(m.advance, shortfall);
          m.advance -= used;
          shortfall -= used;
          coll.fromAdvance = reservedAdv + used;
          coll.coveredByAdvance = true;
        }
        m.due = shortfall > 0 ? shortfall : 0;
      }
    });
    month.status = 'collection_closed';
    month.collectionClosedAt = new Date().toISOString();
    this.recalcMonth(month, data);
  },

  // Close month fully — finalize & freeze this month's figures
  closeMonth(data, month) {
    if (month.status === 'open') {
      this.closeCollection(data, month);
    }
    // Freeze outstanding at close = live member loans (today's truth for this moment)
    const liveOut = data.members.filter(m => m.active)
      .reduce((s, m) => s + (Number(m.outstandingLoan) || 0), 0);
    month.outstandingLoans = liveOut;
    this.recalcMonth(month, data);
    // After recalcMonth (open path may overwrite) force freeze values
    month.outstandingLoans = liveOut;
    month.cashInHand = (Number(month.finalAssets) || 0) - liveOut;

    month.status = 'collection_closed';
    month.totalAdvances = (data.members || []).filter(m => m.active)
      .reduce((s, m) => s + (Number(m.advance) || 0), 0);
    month.netShareAssets = Math.max(0, (Number(month.finalAssets) || 0) - month.totalAdvances);

    month.memberSnapshots = month.memberSnapshots || {};
    data.members.filter(m => m.active).forEach(m => {
      m.assetHistory = Array.isArray(m.assetHistory) ? m.assetHistory : [];
      m.loanHistory = Array.isArray(m.loanHistory) ? m.loanHistory : [];
      month.memberSnapshots[m.id] = {
        kitta: m.kitta,
        outstandingLoan: m.outstandingLoan || 0,
        advance: m.advance || 0,
        due: m.due || 0,
        assets: this.perKittaValue(data, month) * (m.kitta || 0)
      };

      // Passbook history
      const prevAsset = m.assetHistory.length
        ? m.assetHistory[m.assetHistory.length - 1].total
        : 0;
      const currentAsset = month.memberSnapshots[m.id].assets;
      m.assetHistory.push({
        monthId: month.id,
        monthName: month.name,
        prev: prevAsset,
        added: currentAsset - prevAsset,
        total: currentAsset
      });

      const prevLoan = m.loanHistory.length
        ? m.loanHistory[m.loanHistory.length - 1].balance
        : ((data.migration && data.migration.loans && data.migration.loans[m.id]) || 0);
      const taken = (month.loansGiven || [])
        .filter(l => l.memberId === m.id)
        .reduce((s, l) => s + l.amount, 0);
      const repaid = (month.collections[m.id] && month.collections[m.id].principal) || 0;
      m.loanHistory.push({
        monthId: month.id,
        monthName: month.name,
        prev: prevLoan,
        taken,
        repaid,
        balance: m.outstandingLoan || 0
      });
    });

    month.status = 'closed';
    month.closedAt = new Date().toISOString();
    data.currentMonthId = null;

    const liveOut2 = data.members.filter(m => m.active)
      .reduce((s, m) => s + (Number(m.outstandingLoan) || 0), 0);
    month.outstandingLoans = liveOut2;
    this.recalcMonth(month, data);
    month.outstandingLoans = liveOut2;
    month.cashInHand = (Number(month.finalAssets) || 0) - liveOut2;

    if (data.months.filter(m => m.status === 'closed').length === 1) {
      if (data.migration) data.migration.hideAfterFirst = true;
    }

    this.rebuildMonthChain(data);
  },

  /**
   * Fix startAssets chain ONLY (does not invent loan numbers):
   * Month 1 start = migration
   * Month N start = Month N-1 finalAssets
   * Each month finalAssets = start + that month's net income only
   */
  rebuildMonthChain(data) {
    const months = (data.months || []).slice().sort((a, b) => {
      if ((a.yearBS || 0) !== (b.yearBS || 0)) return (a.yearBS || 0) - (b.yearBS || 0);
      if ((a.monthIndex || 0) !== (b.monthIndex || 0)) return (a.monthIndex || 0) - (b.monthIndex || 0);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    if (months.length === 0) return;

    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      if (i === 0) {
        if (data.migrationDone && data.migration) {
          const migLoans = Object.values(data.migration.loans || {}).reduce((s, v) => s + (Number(v) || 0), 0);
          const migCash = Number(data.migration.cash || 0);
          if (migCash + migLoans > 0) {
            m.startAssets = migCash + migLoans;
          }
        }
        m.fromPrevMonthId = null;
      } else {
        const prev = months[i - 1];
        this.recalcMonth(prev, data);
        m.startAssets = Number(prev.finalAssets) || 0;
        m.fromPrevMonthId = prev.id;
      }
      this.recalcMonth(m, data);
    }
  },

  /**
   * Reconcile closed-month snapshots & member assetHistory so Advance liabilities
   * are cleanly separated from member equity across historical snapshots too.
   */
  reconcileAdvanceSnapshots(data) {
    this.rebuildMonthChain(data);
    const closed = this.getClosedMonthsSorted(data);

    // Seed base assetHistory from migration if present
    if (data.migrationDone && data.migration) {
      const migLoans = Object.values(data.migration.loans || {}).reduce((s, v) => s + (Number(v) || 0), 0);
      const migCash = Number(data.migration.cash || 0);
      const migAdv = Object.values(data.migration.advances || {}).reduce((s, v) => s + (Number(v) || 0), 0);
      const migNet = Math.max(0, (migCash + migLoans) - migAdv);
      const migKitta = (data.members || []).filter(m => m.active)
        .reduce((s, m) => s + (Number((data.migration.kittas && data.migration.kittas[m.id] !== undefined) ? data.migration.kittas[m.id] : m.kitta) || 0), 0);
      const migPerKitta = migKitta > 0 ? Math.round(migNet / migKitta) : 0;

      (data.members || []).forEach((m) => {
        if (!Array.isArray(m.assetHistory)) return;
        const idx = m.assetHistory.findIndex((h) => h && h.monthId === 'migration');
        if (idx >= 0) {
          const mk = Number((data.migration.kittas && data.migration.kittas[m.id] !== undefined) ? data.migration.kittas[m.id] : m.kitta) || 0;
          const aVal = migPerKitta * mk;
          m.assetHistory[idx].prev = 0;
          m.assetHistory[idx].added = aVal;
          m.assetHistory[idx].total = aVal;
        }
      });
    }

    closed.forEach((m) => {
      if (m.memberSnapshots && Object.keys(m.memberSnapshots).length) {
        m.totalAdvances = Object.values(m.memberSnapshots)
          .reduce((s, snap) => s + (Number(snap && snap.advance) || 0), 0);
      } else {
        m.totalAdvances = Number(m.totalAdvances) || 0;
      }
      m.netShareAssets = Math.max(0, (Number(m.finalAssets) || 0) - m.totalAdvances);
      const k = m.totalKitta || this.totalKitta(data);
      const perK = k > 0 ? Math.round(m.netShareAssets / k) : 0;

      (data.members || []).forEach((mem) => {
        const snap = m.memberSnapshots && m.memberSnapshots[mem.id];
        if (snap) {
          snap.assets = perK * (Number(snap.kitta) || 0);
        }
        if (Array.isArray(mem.assetHistory)) {
          const row = mem.assetHistory.find((h) => h && h.monthId === m.id);
          if (row && snap) {
            const idx = mem.assetHistory.indexOf(row);
            const prevTotal = idx > 0 ? (Number(mem.assetHistory[idx - 1].total) || 0) : 0;
            row.prev = prevTotal;
            row.total = snap.assets;
            row.added = row.total - prevTotal;
          }
        }
      });
    });

    return closed.length;
  }
};
