import type { AdsDayDoc, FinanceDayDoc, StoreDoc } from '@asm/shared';
import { isEmulator } from '../config';
import { AppError } from './errors';
import { Timestamp, db, refs } from './firestore';

/** Asia/Karachi is UTC+5 with no DST — a fixed offset is exact. */
const PKT_OFFSET_MS = 5 * 3600 * 1000;

export function pktNow(): { date: string; hour: number } {
  const shifted = new Date(Date.now() + PKT_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

/** Rolling windows the report summarises. Data for both is already cached per day. */
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n: number) => n.toLocaleString('en-US');
const avgMoney = (total: number, days: number) => money(total / days);
const avgCount = (total: number, days: number) => count(Math.round(total / days));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' shifted by whole days, staying in UTC (dates are calendar days). */
const shiftDate = (d: string, days: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};
/** 'Jun 24 – 30' within a month, 'May 28 – Jun 3' across one. */
const fmtRange = (from: string, to: string) => {
  const [fy, fm, fd] = from.split('-');
  const [ty, tm, td] = to.split('-');
  const left = `${MONTHS[Number(fm) - 1]} ${Number(fd)}`;
  const right = fm === tm && fy === ty ? `${Number(td)}` : `${MONTHS[Number(tm) - 1]} ${Number(td)}`;
  return `${left} – ${right}`;
};

/** A small week-over-week chip. Empty when there's no prior-window baseline. */
const trendChip = (cur: number, prev: number) => {
  if (prev <= 0) return '';
  const rounded = Math.round(((cur - prev) / prev) * 100);
  const style = (color: string, bg: string) =>
    `display:inline-block;font-size:11px;font-weight:700;color:${color};background:${bg};border-radius:20px;padding:2px 8px;margin-left:8px;vertical-align:middle`;
  if (rounded === 0) return `<span style="${style('#5f6368', '#f1f3f4')}">→ 0%</span>`;
  const up = rounded > 0;
  return `<span style="${style(up ? '#1a7f43' : '#c5221f', up ? '#e6f4ea' : '#fce8e6')}">${up ? '▲' : '▼'} ${Math.abs(rounded)}%</span>`;
};

interface Totals {
  proceedsUsd: number;
  downloads: number;
  units: number;
}
interface StoreRow {
  name: string;
  week: Totals;
  prior: Totals;
  month: Totals;
}
interface AppRow {
  name: string;
  store: string;
  weekProceedsUsd: number;
  monthProceedsUsd: number;
  weekDownloads: number;
  monthDownloads: number;
}

export interface DailyReport {
  subject: string;
  html: string;
  summary: string;
}

/**
 * Aggregate the trailing 7- and 30-day windows across every store that has
 * finance data, and render a self-contained HTML email (inline styles only).
 * The 7-day window also carries the previous 7 days so each headline metric
 * can show a week-over-week trend.
 */
export async function buildDailyReport(): Promise<DailyReport> {
  const storesSnap = await db().collection('stores').get();
  const stores = storesSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() as StoreDoc }));

  const storeRows: StoreRow[] = [];
  const appTotals = new Map<string, AppRow>();
  let unmatchedMonthUsd = 0;
  let latestDate = '';

  const aggregate = (days: FinanceDayDoc[]): Totals => ({
    proceedsUsd: days.reduce((sum, d) => sum + (d.proceedsUsd ?? 0), 0),
    downloads: days.reduce((sum, d) => sum + d.downloads, 0),
    units: days.reduce((sum, d) => sum + d.units, 0),
  });

  for (const store of stores) {
    const daysSnap = await refs
      .store(store.id)
      .collection('financeDays')
      .orderBy('date', 'desc')
      .limit(MONTH_DAYS)
      .get();
    if (daysSnap.empty) continue;
    // Ordered newest-first: [0..6] is this week, [7..13] the week before it.
    const days = daysSnap.docs.map((d) => d.data() as FinanceDayDoc);
    if (days[0]!.date > latestDate) latestDate = days[0]!.date;

    storeRows.push({
      name: store.data.name,
      week: aggregate(days.slice(0, WEEK_DAYS)),
      prior: aggregate(days.slice(WEEK_DAYS, WEEK_DAYS * 2)),
      month: aggregate(days),
    });

    // App names live in the apps collection; perApp docs carry a cached fallback name.
    const appsSnap = await refs.store(store.id).collection('apps').select('name').get();
    const appNames = new Map(appsSnap.docs.map((a) => [a.id, (a.data() as { name?: string }).name ?? a.id]));
    days.forEach((day, idx) => {
      const inWeek = idx < WEEK_DAYS;
      for (const [appId, stat] of Object.entries(day.perApp ?? {})) {
        const proceeds = stat.proceedsUsd ?? 0;
        // Rows that don't resolve to a real app (e.g. subscription products like
        // "yearly") are refined away from Top apps — their proceeds already count
        // in the store and window totals, and the next sync re-attributes them.
        if (!appNames.has(appId)) {
          unmatchedMonthUsd += proceeds;
          continue;
        }
        const key = `${store.id}:${appId}`;
        const row = appTotals.get(key) ?? {
          name: appNames.get(appId) ?? stat.name ?? appId,
          store: store.data.name,
          weekProceedsUsd: 0,
          monthProceedsUsd: 0,
          weekDownloads: 0,
          monthDownloads: 0,
        };
        row.monthProceedsUsd += proceeds;
        row.monthDownloads += stat.downloads;
        if (inWeek) {
          row.weekProceedsUsd += proceeds;
          row.weekDownloads += stat.downloads;
        }
        appTotals.set(key, row);
      }
    });
  }

  const sumWindow = (pick: (r: StoreRow) => Totals): Totals => ({
    proceedsUsd: storeRows.reduce((t, r) => t + pick(r).proceedsUsd, 0),
    downloads: storeRows.reduce((t, r) => t + pick(r).downloads, 0),
    units: storeRows.reduce((t, r) => t + pick(r).units, 0),
  });
  const totalWeek = sumWindow((r) => r.week);
  const totalPrior = sumWindow((r) => r.prior);
  const totalMonth = sumWindow((r) => r.month);

  const topApps = [...appTotals.values()]
    .sort((a, b) => b.monthProceedsUsd - a.monthProceedsUsd || b.weekProceedsUsd - a.weekProceedsUsd)
    .slice(0, 10);

  // Advertising: Apple Ads spend + AdMob revenue (present only when connected).
  const adsSnap = await refs.adsDays().orderBy('date', 'desc').limit(MONTH_DAYS).get();
  const adsDays = adsSnap.docs.map((d) => d.data() as AdsDayDoc);
  const spendUsd = (list: AdsDayDoc[]) => list.reduce((s, d) => s + (d.appleAds?.spendUsd ?? 0), 0);
  const admobUsd = (list: AdsDayDoc[]) => list.reduce((s, d) => s + (d.admob?.earningsUsd ?? 0), 0);
  const ads = {
    haveSpend: adsDays.some((d) => d.appleAds),
    haveAdmob: adsDays.some((d) => d.admob),
    weekSpend: spendUsd(adsDays.slice(0, WEEK_DAYS)),
    priorSpend: spendUsd(adsDays.slice(WEEK_DAYS, WEEK_DAYS * 2)),
    monthSpend: spendUsd(adsDays),
    weekAdmob: admobUsd(adsDays.slice(0, WEEK_DAYS)),
    priorAdmob: admobUsd(adsDays.slice(WEEK_DAYS, WEEK_DAYS * 2)),
    monthAdmob: admobUsd(adsDays),
    weekInstalls: adsDays.slice(0, WEEK_DAYS).reduce((s, d) => s + (d.appleAds?.installs ?? 0), 0),
  };
  const haveAds = ads.haveSpend || ads.haveAdmob;
  const netWeek = totalWeek.proceedsUsd + ads.weekAdmob - ads.weekSpend;
  const netPrior = totalPrior.proceedsUsd + ads.priorAdmob - ads.priorSpend;
  const netMonth = totalMonth.proceedsUsd + ads.monthAdmob - ads.monthSpend;

  const weekRange = latestDate ? fmtRange(shiftDate(latestDate, -(WEEK_DAYS - 1)), latestDate) : '';
  const monthRange = latestDate ? fmtRange(shiftDate(latestDate, -(MONTH_DAYS - 1)), latestDate) : '';
  const storeWord = storeRows.length === 1 ? 'store' : 'stores';
  const headline = storeRows.length
    ? `In the last 7 days${weekRange ? ` (${weekRange})` : ''}, ${storeRows.length} ${storeWord} earned <strong>${money(totalWeek.proceedsUsd)}</strong> in proceeds from <strong>${count(totalWeek.downloads)}</strong> downloads${haveAds ? ` — <strong>${money(netWeek)}</strong> net after ads` : ''}.`
    : 'No finance data has synced yet — this report will fill in once a store finishes its first sales sync.';

  // ---- presentational helpers (inline styles only; email clients ignore <style>) ----
  const brandBar =
    '<div style="height:6px;background:linear-gradient(90deg,#8DC63F,#F7941D,#EE1C25,#EC008C,#662D91,#1C75BC,#00A79D);border-radius:3px 3px 0 0"></div>';
  const metricTile = (label: string, value: string, chip: string, sub: string) =>
    `<td width="33%" style="padding:14px 16px;background:#f8f9fb;border:1px solid #eef0f4;border-radius:12px;vertical-align:top">
       <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${label}</div>
       <div style="margin-top:5px;white-space:nowrap"><span style="font-size:23px;font-weight:800;color:#111827;letter-spacing:-.01em">${value}</span>${chip}</div>
       <div style="font-size:11px;color:#6b7280;margin-top:4px">${sub}</div>
     </td>`;
  const th = (t: string, right = false) =>
    `<th style="text-align:${right ? 'right' : 'left'};padding:6px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;white-space:nowrap">${t}</th>`;
  const td = (t: string, right = false, bold = false) =>
    `<td style="text-align:${right ? 'right' : 'left'};padding:8px 10px;font-size:13px;color:#111827;${bold ? 'font-weight:700;' : ''}border-bottom:1px solid #f3f4f6;white-space:nowrap">${t}</td>`;
  const tdTotal = (t: string, right = false) =>
    `<td style="text-align:${right ? 'right' : 'left'};padding:9px 10px;font-size:13px;font-weight:800;color:#111827;border-top:2px solid #e5e7eb;white-space:nowrap">${t}</td>`;
  const sectionHead = (title: string, hint: string) =>
    `<div style="margin:24px 0 8px"><div style="font-size:14px;font-weight:700;color:#111827">${title}</div><div style="font-size:11px;color:#9ca3af;margin-top:1px">${hint}</div></div>`;

  const storeRowsHtml = [...storeRows]
    .sort((a, b) => b.month.proceedsUsd - a.month.proceedsUsd)
    .map(
      (row) =>
        `<tr>${td(row.name)}${td(money(row.week.proceedsUsd), true)}${td(money(row.month.proceedsUsd), true, true)}${td(count(row.month.downloads), true)}</tr>`,
    )
    .join('');
  const storeTotalHtml = storeRows.length
    ? `<tr>${tdTotal('All stores')}${tdTotal(money(totalWeek.proceedsUsd), true)}${tdTotal(money(totalMonth.proceedsUsd), true)}${tdTotal(count(totalMonth.downloads), true)}</tr>`
    : '';
  const appRowsHtml = topApps
    .map(
      (row, i) =>
        `<tr>${td(`${i + 1}. ${row.name}`)}${td(row.store)}${td(money(row.weekProceedsUsd), true)}${td(money(row.monthProceedsUsd), true, true)}</tr>`,
    )
    .join('');

  const legend = `
    <div style="border-top:1px solid #f3f4f6;margin-top:24px;padding-top:14px;font-size:11px;color:#9ca3af;line-height:1.7">
      <strong style="color:#6b7280">How to read this.</strong>
      <span style="color:#6b7280">Proceeds</span> are your earnings after Apple's commission (USD).
      <span style="color:#6b7280">Downloads</span> count first-time installs; <span style="color:#6b7280">units</span> also include redownloads and updates.
      ${haveAds ? `<span style="color:#6b7280">Net</span> = proceeds + AdMob earnings − Apple Ads spend. ` : ''}
      Trend chips compare the last 7 days with the 7 days before them.
    </div>`;

  const html = `
<div style="max-width:640px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#ffffff">
  ${brandBar}
  <div style="padding:22px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="vertical-align:middle;padding-right:11px">
        <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#8DC63F 0%,#F7941D 20%,#EE1C25 40%,#EC008C 58%,#662D91 76%,#1C75BC 100%);text-align:center;line-height:36px;font-weight:800;font-size:18px;color:#ffffff">D</div>
      </td>
      <td style="vertical-align:middle">
        <div style="font-size:17px;font-weight:800;color:#111827;letter-spacing:-.01em">Dzinemedia <span style="color:#1C75BC">ASM</span></div>
        <div style="font-size:11px;color:#6b7280">Performance report · through ${latestDate || '—'}</div>
      </td>
    </tr></table>

    <div style="margin-top:16px;padding:13px 16px;border-left:3px solid #1C75BC;background:#f6faff;border-radius:0 8px 8px 0;font-size:14px;line-height:1.55;color:#111827">
      ${headline}
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:7px">
      7-day window ${weekRange || '—'} · 30-day window ${monthRange || '—'} · proceeds after Apple's commission, USD
    </div>

    <table role="presentation" width="100%" cellspacing="8" style="margin-top:14px"><tr>
      ${metricTile('Proceeds · 7 days', money(totalWeek.proceedsUsd), trendChip(totalWeek.proceedsUsd, totalPrior.proceedsUsd), `${money(totalMonth.proceedsUsd)} over 30 days · ${avgMoney(totalWeek.proceedsUsd, WEEK_DAYS)}/day avg`)}
      ${metricTile('Downloads · 7 days', count(totalWeek.downloads), trendChip(totalWeek.downloads, totalPrior.downloads), `${count(totalMonth.downloads)} over 30 days · ${avgCount(totalWeek.downloads, WEEK_DAYS)}/day avg`)}
      ${metricTile('Units · 7 days', count(totalWeek.units), trendChip(totalWeek.units, totalPrior.units), `${count(totalMonth.units)} over 30 days · ${avgCount(totalWeek.units, WEEK_DAYS)}/day avg`)}
    </tr></table>
    ${haveAds
      ? `<table role="presentation" width="100%" cellspacing="8" style="margin-top:2px"><tr>
      ${ads.haveSpend ? metricTile('Ad spend · Apple Ads', money(ads.weekSpend), '', `${money(ads.monthSpend)} over 30 days · ${count(ads.weekInstalls)} installs`) : ''}
      ${ads.haveAdmob ? metricTile('Ad revenue · AdMob', money(ads.weekAdmob), '', `${money(ads.monthAdmob)} over 30 days`) : ''}
      ${metricTile('Net · 7 days', money(netWeek), trendChip(netWeek, netPrior), `${money(netMonth)} over 30 days`)}
    </tr></table>`
      : ''}

    ${sectionHead('Stores', `Ranked by 30-day proceeds${monthRange ? ` · ${monthRange}` : ''}`)}
    <table role="presentation" width="100%" cellspacing="0">
      <tr>${th('Store')}${th('Proceeds · 7d', true)}${th('Proceeds · 30d', true)}${th('Downloads · 30d', true)}</tr>
      ${storeRowsHtml || `<tr>${td('No finance data yet', false)}</tr>`}
      ${storeTotalHtml}
    </table>

    ${sectionHead('Top apps', 'Ranked by 30-day proceeds · top 10')}
    <table role="presentation" width="100%" cellspacing="0">
      <tr>${th('App')}${th('Store')}${th('Proceeds · 7d', true)}${th('Proceeds · 30d', true)}</tr>
      ${appRowsHtml || `<tr>${td('No per-app data yet', false)}</tr>`}
    </table>
    ${unmatchedMonthUsd > 0.005 ? `<div style="font-size:11px;color:#9ca3af;margin-top:7px">Includes ${money(unmatchedMonthUsd)} of purchases still being matched to their apps (last 30 days) — the totals above are complete.</div>` : ''}

    ${legend}

    <div style="border-top:1px solid #f3f4f6;margin-top:14px;padding-top:14px;font-size:11px;color:#9ca3af">
      Sent automatically by <strong style="color:#6b7280">Dzinemedia ASM</strong> ·
      <a href="https://asm.dzinemedia.com" style="color:#1C75BC;text-decoration:none">asm.dzinemedia.com</a> ·
      manage recipients in Workspace settings
    </div>
  </div>
</div>`;

  return {
    subject: `Dzinemedia ASM · Report ${latestDate || pktNow().date} — ${money(totalWeek.proceedsUsd)} last 7d · ${money(totalMonth.proceedsUsd)} last 30d`,
    html,
    summary: `${money(totalWeek.proceedsUsd)} proceeds 7d · ${money(totalMonth.proceedsUsd)} 30d · ${count(totalWeek.downloads)} downloads 7d · ${storeRows.length} stores`,
  };
}

/** Send via Resend. In the emulator we log instead of sending. */
export async function sendReportEmail(
  apiKey: string,
  to: string[],
  report: DailyReport,
): Promise<void> {
  if (isEmulator()) {
    console.log('[emulator] would send report to', to.join(', '), '—', report.subject);
    return;
  }
  if (!apiKey) throw new AppError('failed-precondition', 'Email isn’t configured (missing Resend key).');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // asm.dzinemedia.com is domain-verified in Resend — branded sender, any recipient.
      from: 'Dzinemedia ASM <reports@asm.dzinemedia.com>',
      to,
      subject: report.subject,
      html: report.html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Resend's onboarding sender only delivers to the Resend account owner until
    // a domain is verified — surface that as guidance instead of a raw 4xx.
    if (res.status === 403 || body.includes('verify a domain') || body.includes('testing emails')) {
      throw new AppError(
        'failed-precondition',
        'Resend can currently only email your own Resend account address. Verify dzinemedia.com under Resend → Domains, then reports can go to any recipient.',
      );
    }
    throw new AppError('internal', `Email send failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/** Stamp the once-per-day guard. */
export async function markReportSent(date: string): Promise<void> {
  await db().collection('settings').doc('reportState').set(
    { lastSentDate: date, lastSentAt: Timestamp.now() },
    { merge: true },
  );
}
