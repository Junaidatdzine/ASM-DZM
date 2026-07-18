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

interface Totals {
  proceedsUsd: number;
  downloads: number;
  units: number;
}
interface StoreRow {
  name: string;
  week: Totals;
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
    // Ordered newest-first, so the first WEEK_DAYS docs are the 7-day window.
    const days = daysSnap.docs.map((d) => d.data() as FinanceDayDoc);
    const weekDays = days.slice(0, WEEK_DAYS);
    if (days[0]!.date > latestDate) latestDate = days[0]!.date;

    storeRows.push({
      name: store.data.name,
      week: aggregate(weekDays),
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
  const totalMonth = sumWindow((r) => r.month);

  const topApps = [...appTotals.values()]
    .sort((a, b) => b.monthProceedsUsd - a.monthProceedsUsd || b.weekProceedsUsd - a.weekProceedsUsd)
    .slice(0, 10);

  // Advertising: Apple Ads spend + AdMob revenue (present only when connected).
  const adsSnap = await refs.adsDays().orderBy('date', 'desc').limit(MONTH_DAYS).get();
  const adsDays = adsSnap.docs.map((d) => d.data() as AdsDayDoc);
  const adsWeek = adsDays.slice(0, WEEK_DAYS);
  const spendUsd = (list: AdsDayDoc[]) => list.reduce((s, d) => s + (d.appleAds?.spendUsd ?? 0), 0);
  const admobUsd = (list: AdsDayDoc[]) => list.reduce((s, d) => s + (d.admob?.earningsUsd ?? 0), 0);
  const ads = {
    haveSpend: adsDays.some((d) => d.appleAds),
    haveAdmob: adsDays.some((d) => d.admob),
    weekSpend: spendUsd(adsWeek),
    monthSpend: spendUsd(adsDays),
    weekAdmob: admobUsd(adsWeek),
    monthAdmob: admobUsd(adsDays),
    weekInstalls: adsWeek.reduce((s, d) => s + (d.appleAds?.installs ?? 0), 0),
  };
  const netWeek = totalWeek.proceedsUsd + ads.weekAdmob - ads.weekSpend;
  const netMonth = totalMonth.proceedsUsd + ads.monthAdmob - ads.monthSpend;

  const brandBar =
    '<div style="height:6px;background:linear-gradient(90deg,#8DC63F,#F7941D,#EE1C25,#EC008C,#662D91,#1C75BC,#00A79D);border-radius:3px 3px 0 0"></div>';
  const tile = (label: string, value: string, sub: string) =>
    `<td style="padding:14px 16px;background:#f7f8fa;border-radius:10px;vertical-align:top">
       <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${label}</div>
       <div style="font-size:22px;font-weight:700;color:#111827;margin-top:2px">${value}</div>
       <div style="font-size:11px;color:#6b7280;margin-top:2px">${sub}</div>
     </td>`;
  const th = (t: string, right = false) =>
    `<th style="text-align:${right ? 'right' : 'left'};padding:6px 10px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb">${t}</th>`;
  const td = (t: string, right = false, bold = false) =>
    `<td style="text-align:${right ? 'right' : 'left'};padding:7px 10px;font-size:13px;color:#111827;${bold ? 'font-weight:600;' : ''}border-bottom:1px solid #f3f4f6">${t}</td>`;

  const storeRowsHtml = storeRows
    .sort((a, b) => b.month.proceedsUsd - a.month.proceedsUsd)
    .map(
      (row) =>
        `<tr>${td(row.name)}${td(money(row.week.proceedsUsd), true, true)}${td(money(row.month.proceedsUsd), true)}${td(count(row.month.downloads), true)}</tr>`,
    )
    .join('');
  const appRowsHtml = topApps
    .map(
      (row, i) =>
        `<tr>${td(`${i + 1}. ${row.name}`)}${td(row.store)}${td(money(row.weekProceedsUsd), true, true)}${td(money(row.monthProceedsUsd), true)}</tr>`,
    )
    .join('');

  const html = `
<div style="max-width:640px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#ffffff">
  ${brandBar}
  <div style="padding:22px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="vertical-align:middle;padding-right:10px">
        <div style="width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#8DC63F 0%,#F7941D 20%,#EE1C25 40%,#EC008C 58%,#662D91 76%,#1C75BC 100%);text-align:center;line-height:34px;font-weight:800;font-size:17px;color:#ffffff">D</div>
      </td>
      <td style="vertical-align:middle">
        <div style="font-size:17px;font-weight:800;color:#111827;letter-spacing:-.01em">Dzinemedia <span style="color:#1C75BC">ASM</span></div>
        <div style="font-size:11px;color:#6b7280">Last 7 &amp; 30 days · through ${latestDate || '—'} · proceeds after Apple's cut, USD</div>
      </td>
    </tr></table>

    <table role="presentation" width="100%" cellspacing="8" style="margin-top:16px"><tr>
      ${tile('Proceeds (7 days)', money(totalWeek.proceedsUsd), `${money(totalMonth.proceedsUsd)} last 30 days`)}
      ${tile('Downloads (7 days)', count(totalWeek.downloads), `${count(totalMonth.downloads)} last 30 days`)}
      ${tile('Units (7 days)', count(totalWeek.units), `${count(totalMonth.units)} last 30 days`)}
    </tr></table>
    ${ads.haveSpend || ads.haveAdmob
      ? `<table role="presentation" width="100%" cellspacing="8" style="margin-top:2px"><tr>
      ${ads.haveSpend ? tile('Ad spend · Apple Ads', money(ads.weekSpend), `${money(ads.monthSpend)} last 30 days · ${count(ads.weekInstalls)} installs/7d`) : ''}
      ${ads.haveAdmob ? tile('Ad revenue · AdMob', money(ads.weekAdmob), `${money(ads.monthAdmob)} last 30 days`) : ''}
      ${tile('Net (7 days)', money(netWeek), `${money(netMonth)} last 30 days · proceeds + AdMob − ad spend`)}
    </tr></table>`
      : ''}

    <div style="font-size:13px;font-weight:600;color:#111827;margin:20px 0 6px">Stores — 7 &amp; 30 days</div>
    <table role="presentation" width="100%" cellspacing="0">
      <tr>${th('Store')}${th('7d proceeds', true)}${th('30d proceeds', true)}${th('30d downloads', true)}</tr>
      ${storeRowsHtml || `<tr>${td('No finance data yet', false)}</tr>`}
    </table>

    <div style="font-size:13px;font-weight:600;color:#111827;margin:20px 0 6px">Top apps — 7 &amp; 30 days</div>
    <table role="presentation" width="100%" cellspacing="0">
      <tr>${th('App')}${th('Store')}${th('7d proceeds', true)}${th('30d proceeds', true)}</tr>
      ${appRowsHtml || `<tr>${td('No per-app data yet', false)}</tr>`}
    </table>
    ${unmatchedMonthUsd > 0.005 ? `<div style="font-size:11px;color:#9ca3af;margin-top:6px">Includes ${money(unmatchedMonthUsd)} of purchases still being matched to their apps (last 30 days) — totals above are complete.</div>` : ''}

    <div style="border-top:1px solid #f3f4f6;margin-top:22px;padding-top:14px;font-size:11px;color:#9ca3af">
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
