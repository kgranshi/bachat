/**
 * Scheduled Cloudflare Worker — 2nd Friday 6:00 PM Nepal Time (UTC+5:45) Reminder
 * Shares the exact same D1 database (`DB`) as Cloudflare Pages.
 * Sends standard Web Push notifications even when all users have closed the app,
 * and posts a group announcement in `chat_messages`.
 */

import { sendWebPush, randomHex } from '../functions/lib/crypto.js';

const BS_MONTHS_NP = ['बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज', 'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फाल्गुन', 'चैत'];
const BS_CAL_DATA = {
  2080: { start: [2023, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2081: { start: [2024, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2082: { start: [2025, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] },
  2083: { start: [2026, 4, 14], lens: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30] },
  2084: { start: [2027, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30] },
  2085: { start: [2028, 4, 13], lens: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  2086: { start: [2029, 4, 14], lens: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31] }
};

function getNepalNow() {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 45) * 60000);
}

function adToBsParts(dt) {
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
  const utc = Date.UTC(y, m - 1, d);
  for (const [yr, info] of Object.entries(BS_CAL_DATA)) {
    const s = info.start;
    const startUtc = Date.UTC(s[0], s[1] - 1, s[2]);
    const yearLen = info.lens.reduce((a, b) => a + b, 0);
    if (utc >= startUtc && utc < startUtc + yearLen * 86400000) {
      let days = Math.round((utc - startUtc) / 86400000);
      let bm = 0;
      for (; bm < 12; bm++) {
        if (days < info.lens[bm]) break;
        days -= info.lens[bm];
      }
      return { year: parseInt(yr, 10), monthIndex: bm, day: days + 1 };
    }
  }
  return null;
}

function nthWeekdayOfBsMonth(year, monthIndex, weekday, n) {
  const info = BS_CAL_DATA[year];
  if (!info) return null;
  let days = 0;
  for (let i = 0; i < monthIndex; i++) days += info.lens[i];
  const s = info.start;
  const first = new Date(Date.UTC(s[0], s[1] - 1, s[2]) + days * 86400000);
  const firstWd = first.getUTCDay();
  const day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
  if (day > info.lens[monthIndex]) return null;
  return day;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const nepal = getNepalNow();
    const bs = adToBsParts(nepal);
    if (!bs) return;

    const secondFridayDay = nthWeekdayOfBsMonth(bs.year, bs.monthIndex, 5, 2);
    if (!secondFridayDay || bs.day !== secondFridayDay) return;
    if (nepal.getUTCHours() < 18) return;

    const jobKey = `remind_${bs.year}_${bs.monthIndex}`;
    const already = await env.DB.prepare('SELECT job_key FROM schedule_log WHERE job_key = ?').bind(jobKey).first();
    if (already) return;

    const nowIso = new Date().toISOString();
    const msgText =
      `🔔 बचत भेला रिमाइन्डर (${BS_MONTHS_NP[bs.monthIndex]} ${bs.year})\n\n` +
      `भोलि नेपाली महिनाको दोस्रो शनिबार समूहको बचत भेला बस्ने छ।\n` +
      `कृपया समयमै उपस्थित भई अनिवार्य रकम बुझाउनुहोला।`;

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO chat_messages (id, channel, from_id, from_name, from_role, text, type, bill_id, created_at)
         VALUES (?, 'group', 'system', 'समूह सूचना', 'system', ?, 'auto_group', NULL, ?)`
      )
      .bind('rem_' + bs.year + '_' + bs.monthIndex + '_' + randomHex(3), msgText, nowIso)
      .run();

    const vapidRow = await env.DB.prepare("SELECT value FROM system_secrets WHERE key = 'vapid_keys'").first();
    if (vapidRow && vapidRow.value) {
      const vapid = JSON.parse(vapidRow.value);
      const subs = await env.DB.prepare('SELECT sub_key, endpoint, p256dh, auth FROM push_subscriptions').all();
      for (const s of subs.results || []) {
        try {
          const res = await sendWebPush(s, {
            title: '🔔 भोलि बचत भेला छ',
            body: `${BS_MONTHS_NP[bs.monthIndex]} महिनाको दोस्रो शनिबार भेला — समयमै उपस्थित हुनुहोला।`,
            tag: jobKey
          }, vapid);
          if (res.gone) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE sub_key = ?').bind(s.sub_key).run();
          }
        } catch (e) {}
      }
    }

    await env.DB
      .prepare('INSERT OR IGNORE INTO schedule_log (job_key, ran_at) VALUES (?, ?)')
      .bind(jobKey, nowIso)
      .run();
  }
};
