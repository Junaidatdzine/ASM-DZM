import { onSchedule } from 'firebase-functions/v2/scheduler';
import { DEFAULT_SETTINGS, type GlobalSettingsDoc, type ReportStateDoc, type StoreDoc } from '@asm/shared';
import { ASC_MASTER_KEY, RESEND_API_KEY } from '../config';
import { defineCallable } from '../lib/wrap';
import { db, refs } from '../lib/firestore';
import { requireAdmin } from '../lib/authz';
import { AppError } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { buildDailyReport, markReportSent, pktNow, sendReportEmail } from '../lib/report';
import { runFinanceSync } from './finance';
import { runAdsSync } from './ads';

async function loadSettings(): Promise<GlobalSettingsDoc> {
  const snap = await refs.settings().get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? (snap.data() as GlobalSettingsDoc) : {}) };
}

/** Refresh the last couple of report days for every store that can sync. Best-effort per store. */
async function refreshFinance(actorUid: string): Promise<void> {
  const stores = await db().collection('stores').get();
  for (const doc of stores.docs) {
    const store = doc.data() as StoreDoc;
    if (!store.mock && !store.vendorNumber) continue;
    await runFinanceSync(doc.id, store, 3, actorUid).catch((err) => {
      console.warn('report finance sync failed', doc.id, err instanceof Error ? err.message : err);
    });
  }
}

async function deliverReport(recipients: string[], actorUid: string): Promise<{ summary: string }> {
  await refreshFinance(actorUid);
  await runAdsSync(3).catch((err) => {
    console.warn('report ads sync failed', err instanceof Error ? err.message : err);
  });
  const report = await buildDailyReport();
  await sendReportEmail(RESEND_API_KEY.value(), recipients, report);
  await markReportSent(pktNow().date);
  return { summary: report.summary };
}

/** Manual "send report now" — admin-only; also counts as today's send. */
export const reportSendNow = defineCallable(
  'reportSendNow',
  {
    usesAscKey: true,
    // The wrapper's usesAscKey only binds the ASC key — the Resend key must be
    // bound explicitly or .value() is empty in production (emulator hides this).
    secrets: [RESEND_API_KEY],
    timeoutSeconds: 540,
    memory: '512MiB',
    authorize: (actor) => requireAdmin(actor),
    audit: (_input, out: { summary: string }) => ({ action: 'report.send-now', detail: out.summary }),
  },
  async (_input, actor) => {
    const settings = await loadSettings();
    const recipients = (settings.reportEmails ?? []).filter(Boolean);
    if (recipients.length === 0) {
      throw new AppError('failed-precondition', 'Add at least one report email in Workspace settings first.');
    }
    return deliverReport(recipients, actor.uid);
  },
);

/**
 * Hourly scheduler that delivers the daily report at the configured hour
 * (Asia/Karachi, default 11:00). The reportState doc guarantees one email per day
 * no matter how often this fires or whether a manual send already happened.
 */
export const reportDaily = onSchedule(
  {
    schedule: '5 * * * *', // hourly at :05, gated below to the configured PKT hour
    timeZone: 'UTC',
    secrets: [RESEND_API_KEY, ASC_MASTER_KEY],
    timeoutSeconds: 540,
    memory: '512MiB',
    retryCount: 1,
  },
  async () => {
    const settings = await loadSettings();
    const recipients = (settings.reportEmails ?? []).filter(Boolean);
    if (recipients.length === 0) return;

    const { date, hour } = pktNow();
    const targetHour = settings.reportHour ?? DEFAULT_SETTINGS.reportHour ?? 11;
    if (hour !== targetHour) return;

    const stateSnap = await db().collection('settings').doc('reportState').get();
    const state = (stateSnap.exists ? stateSnap.data() : {}) as ReportStateDoc;
    if (state.lastSentDate === date) return; // already delivered today (auto or manual)

    try {
      const { summary } = await deliverReport(recipients, 'scheduler');
      await writeAudit(
        { uid: 'scheduler', email: 'scheduler@system' },
        { action: 'report.daily-send', detail: summary, result: 'ok' },
      );
    } catch (err) {
      await db().collection('settings').doc('reportState').set(
        { lastError: err instanceof Error ? err.message.slice(0, 300) : 'send failed' },
        { merge: true },
      );
      throw err;
    }
  },
);
