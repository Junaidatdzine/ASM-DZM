import { z } from 'zod';
import type {
  AdsAccountDayStat,
  AdsAccountDoc,
  AdsAdGroupLive,
  AdsCampaignLive,
  AdsCampaignStat,
  AdsDayDoc,
  AdsKeywordLive,
  AdsMetricRow,
  AdsNegativeKeyword,
} from '@asm/shared';
import { isEmulator } from '../config';
import { defineCallable } from '../lib/wrap';
import { Timestamp, db, refs } from '../lib/firestore';
import { requireAdmin } from '../lib/authz';
import { AppError, notFound } from '../lib/errors';
import { decryptSecret, encryptSecret, type Encrypted } from '../lib/crypto';
import { toUsd, usdRates } from '../lib/rates';
import {
  appleAdsAddNegativeKeywords,
  appleAdsAdGroupReport,
  appleAdsAdGroups,
  appleAdsCampaigns,
  appleAdsCreateAdGroup,
  appleAdsCreateCampaign,
  appleAdsCreateKeywords,
  appleAdsDailyReport,
  appleAdsDeleteNegativeKeyword,
  appleAdsKeywordReport,
  appleAdsKeywords,
  appleAdsNegativeKeywords,
  appleAdsSearchTermsReport,
  appleAdsSetCampaignStatus,
  appleAdsUpdateAdGroup,
  appleAdsUpdateCampaign,
  appleAdsUpdateKeyword,
  appleAdsVerify,
  type AppleAdsCredentials,
  type AppleAdsMetrics,
} from '../lib/ads/appleAds';
import { admobAccount, admobDailyEarnings, admobExchangeCode, type AdmobCredentials } from '../lib/ads/admob';

const ADS_SCHEMA_VERSION = 2;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mask = (v: string) => (v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`);

interface AppleSecretDoc {
  clientId: string;
  teamId: string;
  keyId: string;
  orgId: number;
  privateKey: Encrypted;
}
interface AdmobSecretDoc {
  clientId: string;
  clientSecret: Encrypted;
  refreshToken: Encrypted;
  publisherId: string;
  currencyCode: string;
}

interface AppleAccount {
  id: string;
  label: string;
  creds: AppleAdsCredentials;
}
interface AdmobAccountEntry {
  id: string;
  label: string;
  creds: AdmobCredentials;
  publisherId: string;
  currencyCode: string;
}

async function loadAccounts(): Promise<{ apple: AppleAccount[]; admob: AdmobAccountEntry[] }> {
  const snap = await refs.adsAccounts().get();
  const apple: AppleAccount[] = [];
  const admob: AdmobAccountEntry[] = [];
  for (const doc of snap.docs) {
    const account = doc.data() as AdsAccountDoc;
    if (!account.connected) continue;
    const secretSnap = await refs.adsAccountSecret(doc.id).get();
    if (!secretSnap.exists) continue;
    if (account.provider === 'appleAds') {
      const secret = secretSnap.data() as AppleSecretDoc;
      apple.push({
        id: doc.id,
        label: account.label,
        creds: {
          clientId: secret.clientId,
          teamId: secret.teamId,
          keyId: secret.keyId,
          orgId: secret.orgId,
          privateKey: decryptSecret(secret.privateKey, `ads:${doc.id}`),
        },
      });
    } else {
      const secret = secretSnap.data() as AdmobSecretDoc;
      admob.push({
        id: doc.id,
        label: account.label,
        creds: {
          clientId: secret.clientId,
          clientSecret: decryptSecret(secret.clientSecret, `ads:${doc.id}`),
          refreshToken: decryptSecret(secret.refreshToken, `ads:${doc.id}`),
        },
        publisherId: secret.publisherId,
        currencyCode: secret.currencyCode,
      });
    }
  }
  // Emulator with nothing connected: one mock account per provider keeps every flow demoable.
  if (isEmulator() && apple.length === 0) {
    apple.push({
      id: 'mock-apple',
      label: 'Demo — Search Ads',
      creds: { clientId: 'mock', teamId: 'mock', keyId: 'mock', privateKey: 'mock', orgId: 1 },
    });
  }
  if (isEmulator() && admob.length === 0) {
    admob.push({
      id: 'mock-admob',
      label: 'Demo — AdMob',
      creds: { clientId: 'mock', clientSecret: 'mock', refreshToken: 'mock' },
      publisherId: 'pub-0000000000000000',
      currencyCode: 'USD',
    });
  }
  return { apple, admob };
}

function dateString(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Pull spend (all Apple Ads accounts) + earnings (all AdMob accounts) for the last
 * `dayCount` days into adsDays. Accounts fail independently — errors land on the
 * account doc where the UI shows them plainly.
 */
export async function runAdsSync(dayCount: number): Promise<{ days: number; providers: string[] }> {
  const endDate = dateString(1);
  const startDate = dateString(Math.max(1, dayCount));
  const { apple, admob } = await loadAccounts();
  const providers = new Set<string>();

  interface DayBucket {
    spend: Record<string, number>;
    taps: number;
    impressions: number;
    installs: number;
    campaigns: Map<string, AdsCampaignStat>;
    appleAccounts: Map<string, AdsAccountDayStat>;
    earnings: Record<string, number>;
    admobAccounts: Map<string, AdsAccountDayStat>;
  }
  const perDay = new Map<string, DayBucket>();
  const day = (date: string): DayBucket => {
    const existing = perDay.get(date);
    if (existing) return existing;
    const fresh: DayBucket = {
      spend: {},
      taps: 0,
      impressions: 0,
      installs: 0,
      campaigns: new Map(),
      appleAccounts: new Map(),
      earnings: {},
      admobAccounts: new Map(),
    };
    perDay.set(date, fresh);
    return fresh;
  };
  const markError = async (accountId: string, message: string | null) => {
    if (accountId.startsWith('mock-')) return;
    await refs
      .adsAccount(accountId)
      .set({ lastError: message ?? '' }, { mergeFields: ['lastError'] })
      .catch(() => {});
  };

  for (const account of apple) {
    try {
      const rows = await appleAdsDailyReport(account.creds, startDate, endDate);
      providers.add('appleAds');
      for (const row of rows) {
        const bucket = day(row.date);
        bucket.spend[row.spendCurrency] = round2((bucket.spend[row.spendCurrency] ?? 0) + row.spendAmount);
        bucket.taps += row.taps;
        bucket.impressions += row.impressions;
        bucket.installs += row.installs;
        const campaignKey = `${account.id}:${row.campaignId}`;
        const campaign: AdsCampaignStat = bucket.campaigns.get(campaignKey) ?? {
          id: row.campaignId,
          name: row.campaignName,
          accountId: account.id,
          accountLabel: account.label,
          spend: {},
          taps: 0,
          impressions: 0,
          installs: 0,
        };
        campaign.spend[row.spendCurrency] = round2((campaign.spend[row.spendCurrency] ?? 0) + row.spendAmount);
        campaign.taps += row.taps;
        campaign.impressions += row.impressions;
        campaign.installs += row.installs;
        bucket.campaigns.set(campaignKey, campaign);
        const acct = bucket.appleAccounts.get(account.id) ?? { id: account.id, label: account.label, spendUsd: 0, taps: 0, installs: 0 };
        acct.taps = (acct.taps ?? 0) + row.taps;
        acct.installs = (acct.installs ?? 0) + row.installs;
        // spendUsd per account filled after rate conversion using per-currency map:
        (acct as { _spend?: Record<string, number> })._spend = {
          ...((acct as { _spend?: Record<string, number> })._spend ?? {}),
          [row.spendCurrency]:
            round2((((acct as { _spend?: Record<string, number> })._spend ?? {})[row.spendCurrency] ?? 0) + row.spendAmount),
        };
        bucket.appleAccounts.set(account.id, acct);
      }
      await markError(account.id, null);
    } catch (err) {
      await markError(account.id, err instanceof Error ? err.message.slice(0, 200) : 'sync failed');
    }
  }

  for (const account of admob) {
    try {
      const rows = await admobDailyEarnings(account.creds, account.publisherId, account.currencyCode, startDate, endDate);
      providers.add('admob');
      for (const row of rows) {
        const bucket = day(row.date);
        bucket.earnings[row.currency] = round2((bucket.earnings[row.currency] ?? 0) + row.amount);
        const acct = bucket.admobAccounts.get(account.id) ?? { id: account.id, label: account.label, earningsUsd: 0 };
        (acct as { _earn?: Record<string, number> })._earn = {
          ...((acct as { _earn?: Record<string, number> })._earn ?? {}),
          [row.currency]: round2((((acct as { _earn?: Record<string, number> })._earn ?? {})[row.currency] ?? 0) + row.amount),
        };
        bucket.admobAccounts.set(account.id, acct);
      }
      await markError(account.id, null);
    } catch (err) {
      await markError(account.id, err instanceof Error ? err.message.slice(0, 200) : 'sync failed');
    }
  }

  // USD-normalize and persist.
  const currencies = new Set<string>();
  for (const bucket of perDay.values()) {
    for (const c of Object.keys(bucket.spend)) currencies.add(c);
    for (const c of Object.keys(bucket.earnings)) currencies.add(c);
  }
  const rates = await usdRates([...currencies]).catch(() => ({ USD: 1 }));

  const batch = db().batch();
  for (const [date, bucket] of perDay) {
    const campaigns = [...bucket.campaigns.values()].map((c) => ({ ...c, spendUsd: toUsd(c.spend, rates) }));
    const appleAccounts = [...bucket.appleAccounts.values()].map((a) => {
      const spendMap = (a as { _spend?: Record<string, number> })._spend ?? {};
      const { _spend, ...clean } = a as AdsAccountDayStat & { _spend?: Record<string, number> };
      return { ...clean, spendUsd: toUsd(spendMap, rates) };
    });
    const admobAccounts = [...bucket.admobAccounts.values()].map((a) => {
      const earnMap = (a as { _earn?: Record<string, number> })._earn ?? {};
      const { _earn, ...clean } = a as AdsAccountDayStat & { _earn?: Record<string, number> };
      return { ...clean, earningsUsd: toUsd(earnMap, rates) };
    });
    const doc: AdsDayDoc & { fetchedAt: Timestamp } = {
      schemaVersion: ADS_SCHEMA_VERSION,
      date,
      ...(Object.keys(bucket.spend).length > 0 || campaigns.length > 0
        ? {
            appleAds: {
              spend: bucket.spend,
              spendUsd: toUsd(bucket.spend, rates),
              taps: bucket.taps,
              impressions: bucket.impressions,
              installs: bucket.installs,
              campaigns,
              accounts: appleAccounts,
            },
          }
        : {}),
      ...(Object.keys(bucket.earnings).length > 0
        ? {
            admob: {
              earnings: bucket.earnings,
              earningsUsd: toUsd(bucket.earnings, rates),
              accounts: admobAccounts,
            },
          }
        : {}),
      fetchedAt: Timestamp.now(),
    };
    batch.set(refs.adsDay(date), doc);
  }
  batch.set(refs.adsConfig(), { syncedAt: Timestamp.now() }, { merge: true });
  await batch.commit();

  return { days: perDay.size, providers: [...providers] };
}

// ---- Account management ----

export const adsAppleConnect = defineCallable(
  'adsAppleConnect',
  {
    input: z.object({
      label: z.string().trim().min(1).max(60),
      clientId: z.string().trim().min(4).max(200),
      teamId: z.string().trim().min(4).max(200),
      keyId: z.string().trim().min(4).max(200),
      privateKey: z.string().min(40).max(5000),
      orgId: z.number().int().positive(),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: (input, out: { campaignsCount: number }) => ({
      action: 'ads.apple-connect',
      detail: `${input.label} · org ${input.orgId} · ${out.campaignsCount} campaigns`,
    }),
  },
  async (input, actor) => {
    const creds: AppleAdsCredentials = {
      clientId: input.clientId,
      teamId: input.teamId,
      keyId: input.keyId,
      privateKey: input.privateKey,
      orgId: input.orgId,
    };
    const { campaignsCount } = await appleAdsVerify(creds);
    const accountRef = refs.adsAccounts().doc();
    await refs.adsAccountSecret(accountRef.id).set({
      clientId: input.clientId,
      teamId: input.teamId,
      keyId: input.keyId,
      orgId: input.orgId,
      privateKey: encryptSecret(input.privateKey, `ads:${accountRef.id}`),
    } satisfies AppleSecretDoc);
    await accountRef.set({
      provider: 'appleAds',
      label: input.label,
      connected: true,
      orgId: input.orgId,
      clientIdMasked: mask(input.clientId),
      campaignsCount,
      createdBy: actor.uid,
      createdAt: Timestamp.now(),
    } satisfies Omit<AdsAccountDoc, 'createdAt'> & { createdAt: Timestamp });
    return { accountId: accountRef.id, campaignsCount };
  },
);

export const admobConnect = defineCallable(
  'admobConnect',
  {
    input: z.object({
      label: z.string().trim().min(1).max(60),
      clientId: z.string().trim().min(10).max(300),
      clientSecret: z.string().trim().min(6).max(300),
      code: z.string().trim().min(4).max(1000),
      redirectUri: z.string().trim().url().max(300),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: (input, out: { publisherId: string }) => ({
      action: 'ads.admob-connect',
      detail: `${input.label} · ${out.publisherId}`,
    }),
  },
  async (input, actor) => {
    const refreshToken = isEmulator()
      ? 'mock-refresh-token'
      : await admobExchangeCode(input.clientId, input.clientSecret, input.code, input.redirectUri);
    const account = await admobAccount({ clientId: input.clientId, clientSecret: input.clientSecret, refreshToken });
    const accountRef = refs.adsAccounts().doc();
    await refs.adsAccountSecret(accountRef.id).set({
      clientId: input.clientId,
      clientSecret: encryptSecret(input.clientSecret, `ads:${accountRef.id}`),
      refreshToken: encryptSecret(refreshToken, `ads:${accountRef.id}`),
      publisherId: account.publisherId,
      currencyCode: account.currencyCode,
    } satisfies AdmobSecretDoc);
    await accountRef.set({
      provider: 'admob',
      label: input.label,
      connected: true,
      publisherId: account.publisherId,
      currencyCode: account.currencyCode,
      createdBy: actor.uid,
      createdAt: Timestamp.now(),
    } satisfies Omit<AdsAccountDoc, 'createdAt'> & { createdAt: Timestamp });
    return { accountId: accountRef.id, publisherId: account.publisherId, currencyCode: account.currencyCode };
  },
);

export const adsAccountRemove = defineCallable(
  'adsAccountRemove',
  {
    input: z.object({ accountId: z.string().min(1) }),
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: 'ads.account-remove', detail: input.accountId }),
  },
  async (input) => {
    const snap = await refs.adsAccount(input.accountId).get();
    if (!snap.exists) throw notFound('Ads account');
    await refs.adsAccountSecret(input.accountId).delete();
    await refs.adsAccount(input.accountId).delete();
    return { ok: true };
  },
);

// ---- Campaign control (Apple Search Ads) ----

export const adsCampaignsList = defineCallable(
  'adsCampaignsList',
  {
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor) => requireAdmin(actor),
  },
  async () => {
    const { apple } = await loadAccounts();
    const campaigns: AdsCampaignLive[] = [];
    const errors: string[] = [];
    for (const account of apple) {
      try {
        const list = await appleAdsCampaigns(account.creds);
        for (const c of list) {
          campaigns.push({ ...c, accountId: account.id, accountLabel: account.label });
        }
      } catch (err) {
        errors.push(`${account.label}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    return { campaigns, errors };
  },
);

export const adsCampaignSetStatus = defineCallable(
  'adsCampaignSetStatus',
  {
    input: z.object({
      accountId: z.string().min(1),
      campaignId: z.string().min(1),
      status: z.enum(['ENABLED', 'PAUSED']),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({
      action: input.status === 'PAUSED' ? 'ads.campaign-pause' : 'ads.campaign-run',
      detail: `${input.campaignId} (${input.accountId})`,
    }),
  },
  async (input) => {
    const { apple } = await loadAccounts();
    const account = apple.find((a) => a.id === input.accountId);
    if (!account) throw notFound('Apple Search Ads account');
    await appleAdsSetCampaignStatus(account.creds, input.campaignId, input.status);
    return { ok: true, status: input.status };
  },
);

// ---- Campaign / ad group / keyword management (Apple Search Ads) ----

async function appleCreds(accountId: string): Promise<AppleAdsCredentials> {
  const { apple } = await loadAccounts();
  const account = apple.find((a) => a.id === accountId);
  if (!account) throw notFound('Apple Search Ads account');
  return account.creds;
}
/** Merge range-total report metrics onto live entities by id. */
function withMetrics<T extends { id: string }>(items: T[], metrics: AppleAdsMetrics[]) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  return items.map((it) => {
    const m = byId.get(it.id);
    return {
      ...it,
      spendAmount: m?.spendAmount ?? 0,
      spendCurrency: m?.spendCurrency ?? 'USD',
      taps: m?.taps ?? 0,
      impressions: m?.impressions ?? 0,
      installs: m?.installs ?? 0,
    };
  });
}
const reportWindow = (days: number): [string, string] => [dateString(Math.max(1, days)), dateString(1)];
const money = z.object({ amount: z.number().nonnegative(), currency: z.string().min(1) });
const account = { accountId: z.string().min(1), campaignId: z.string().min(1) };

export const adsAdGroupsList = defineCallable(
  'adsAdGroupsList',
  { input: z.object({ ...account, days: z.number().int().min(1).max(90).default(30) }), usesAscKey: true, timeoutSeconds: 120, authorize: (a) => requireAdmin(a) },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const [groups, metrics] = await Promise.all([
      appleAdsAdGroups(creds, input.campaignId),
      appleAdsAdGroupReport(creds, input.campaignId, ...reportWindow(input.days ?? 30)).catch(() => []),
    ]);
    const adGroups: AdsAdGroupLive[] = withMetrics(groups.map((g) => ({ ...g, accountId: input.accountId })), metrics);
    return { adGroups };
  },
);

export const adsAdGroupCreate = defineCallable(
  'adsAdGroupCreate',
  {
    input: z.object({ ...account, name: z.string().min(1).max(200), defaultBid: money }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.adgroup-create', detail: `${input.name} (${input.campaignId})` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const group = await appleAdsCreateAdGroup(creds, input.campaignId, { name: input.name, defaultBid: input.defaultBid });
    return { adGroup: { ...group, accountId: input.accountId } };
  },
);

export const adsAdGroupUpdate = defineCallable(
  'adsAdGroupUpdate',
  {
    input: z.object({ ...account, adGroupId: z.string().min(1), name: z.string().min(1).optional(), status: z.enum(['ENABLED', 'PAUSED']).optional(), defaultBid: money.optional() }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.adgroup-update', detail: `${input.adGroupId}${input.status ? ` → ${input.status}` : ''}` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    await appleAdsUpdateAdGroup(creds, input.campaignId, input.adGroupId, { name: input.name, status: input.status, defaultBid: input.defaultBid });
    return { ok: true };
  },
);

export const adsKeywordsList = defineCallable(
  'adsKeywordsList',
  { input: z.object({ ...account, adGroupId: z.string().min(1), days: z.number().int().min(1).max(90).default(30) }), usesAscKey: true, timeoutSeconds: 120, authorize: (a) => requireAdmin(a) },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const [keywords, metrics] = await Promise.all([
      appleAdsKeywords(creds, input.campaignId, input.adGroupId),
      appleAdsKeywordReport(creds, input.campaignId, input.adGroupId, ...reportWindow(input.days ?? 30)).catch(() => []),
    ]);
    const rows: AdsKeywordLive[] = withMetrics(keywords, metrics);
    return { keywords: rows };
  },
);

export const adsKeywordsCreate = defineCallable(
  'adsKeywordsCreate',
  {
    input: z.object({
      ...account,
      adGroupId: z.string().min(1),
      keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(['EXACT', 'BROAD']), bid: money })).min(1).max(500),
    }),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.keywords-create', detail: `${input.keywords.length} keyword(s) → ${input.adGroupId}` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const created = await appleAdsCreateKeywords(creds, input.campaignId, input.adGroupId, input.keywords);
    return { created: created.length };
  },
);

export const adsKeywordUpdate = defineCallable(
  'adsKeywordUpdate',
  {
    input: z.object({ ...account, adGroupId: z.string().min(1), keywordId: z.string().min(1), status: z.enum(['ACTIVE', 'PAUSED']).optional(), bid: money.optional() }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.keyword-update', detail: `${input.keywordId}${input.status ? ` → ${input.status}` : ''}${input.bid ? ` bid ${input.bid.amount}` : ''}` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    await appleAdsUpdateKeyword(creds, input.campaignId, input.adGroupId, input.keywordId, { status: input.status, bid: input.bid });
    return { ok: true };
  },
);

export const adsNegativeKeywordsList = defineCallable(
  'adsNegativeKeywordsList',
  { input: z.object({ ...account, adGroupId: z.string().min(1) }), usesAscKey: true, timeoutSeconds: 60, authorize: (a) => requireAdmin(a) },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const negatives: AdsNegativeKeyword[] = await appleAdsNegativeKeywords(creds, input.campaignId, input.adGroupId);
    return { negatives };
  },
);

export const adsNegativeKeywordsAdd = defineCallable(
  'adsNegativeKeywordsAdd',
  {
    input: z.object({ ...account, adGroupId: z.string().min(1), keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(['EXACT', 'BROAD']) })).min(1).max(500) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.negatives-add', detail: `${input.keywords.length} → ${input.adGroupId}` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    await appleAdsAddNegativeKeywords(creds, input.campaignId, input.adGroupId, input.keywords);
    return { ok: true };
  },
);

export const adsNegativeKeywordDelete = defineCallable(
  'adsNegativeKeywordDelete',
  {
    input: z.object({ ...account, adGroupId: z.string().min(1), keywordId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.negative-delete', detail: input.keywordId }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    await appleAdsDeleteNegativeKeyword(creds, input.campaignId, input.adGroupId, input.keywordId);
    return { ok: true };
  },
);

export const adsSearchTermsList = defineCallable(
  'adsSearchTermsList',
  { input: z.object({ ...account, adGroupId: z.string().min(1), days: z.number().int().min(1).max(90).default(30) }), usesAscKey: true, timeoutSeconds: 120, authorize: (a) => requireAdmin(a) },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const terms: AdsMetricRow[] = await appleAdsSearchTermsReport(creds, input.campaignId, input.adGroupId, ...reportWindow(input.days ?? 30)).catch(() => []);
    return { terms: terms.sort((a, b) => b.installs - a.installs || b.spendAmount - a.spendAmount) };
  },
);

export const adsCampaignCreate = defineCallable(
  'adsCampaignCreate',
  {
    input: z.object({
      accountId: z.string().min(1),
      name: z.string().min(1).max(200),
      adamId: z.number().int().positive(),
      currency: z.string().min(1),
      budget: z.number().positive(),
      dailyBudget: z.number().positive(),
      countries: z.array(z.string().min(2).max(2)).min(1).max(175),
    }),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.campaign-create', detail: `${input.name} · ${input.countries.join(',')} · ${input.currency} ${input.dailyBudget}/day` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    const campaign = await appleAdsCreateCampaign(creds, {
      name: input.name,
      adamId: input.adamId,
      budgetAmount: { amount: input.budget, currency: input.currency },
      dailyBudgetAmount: { amount: input.dailyBudget, currency: input.currency },
      countries: input.countries,
    });
    return { campaign: { ...campaign, accountId: input.accountId, accountLabel: '' } as AdsCampaignLive };
  },
);

export const adsCampaignUpdate = defineCallable(
  'adsCampaignUpdate',
  {
    input: z.object({
      accountId: z.string().min(1),
      campaignId: z.string().min(1),
      name: z.string().min(1).optional(),
      status: z.enum(['ENABLED', 'PAUSED']).optional(),
      currency: z.string().min(1),
      dailyBudget: z.number().positive().optional(),
      countries: z.array(z.string().min(2).max(2)).min(1).optional(),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (a) => requireAdmin(a),
    audit: (input) => ({ action: 'ads.campaign-update', detail: `${input.campaignId}${input.dailyBudget ? ` budget ${input.dailyBudget}` : ''}${input.status ? ` → ${input.status}` : ''}` }),
  },
  async (input) => {
    const creds = await appleCreds(input.accountId);
    await appleAdsUpdateCampaign(creds, input.campaignId, {
      name: input.name,
      status: input.status,
      dailyBudgetAmount: input.dailyBudget !== undefined ? { amount: input.dailyBudget, currency: input.currency } : undefined,
      countries: input.countries,
    });
    return { ok: true };
  },
);

// ---- Sync ----

export const adsSync = defineCallable(
  'adsSync',
  {
    input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    authorize: (actor) => requireAdmin(actor),
    audit: (input, out: { days: number; providers: string[] }) => ({
      action: 'ads.sync',
      detail: `${out.days} days · ${out.providers.join('+') || 'nothing connected'}`,
    }),
  },
  async (input) => {
    if (!isEmulator()) {
      const accounts = await refs.adsAccounts().where('connected', '==', true).limit(1).get();
      if (accounts.empty) {
        throw new AppError('failed-precondition', 'Connect an Apple Search Ads or AdMob account first.');
      }
    }
    return runAdsSync(input.days ?? 30);
  },
);
