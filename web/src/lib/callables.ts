import { httpsCallable } from 'firebase/functions';
import type {
  AdsAdGroupLive,
  AdsCampaignLive,
  AdsKeywordLive,
  AdsMetricRow,
  AdsNegativeKeyword,
  AgeRatingValues,
  AiGrant,
  BuildRef,
  CustomerReviewEntry,
  GlobalRole,
  KidsAgeBand,
  ReleaseType,
  StoreGrant,
  UserStatus,
} from '@asm/shared';
import { functions } from './firebase';

/**
 * Typed wrappers for every callable. Names must match functions/src/index.ts exports.
 * The SDK's default deadline is 70s — long-running callables (syncs, pushes, reports)
 * must pass a timeout matching their server budget or the client aborts early with
 * deadline-exceeded while the server keeps working.
 */
function call<I, O>(name: string, timeoutMs?: number) {
  const fn = httpsCallable<I, O>(functions, name, timeoutMs ? { timeout: timeoutMs } : undefined);
  return async (input: I): Promise<O> => (await fn(input)).data;
}

export type BootstrapResult = { status: 'active' | 'disabled' | 'unprovisioned'; reason?: 'domain' };
type Ok = { ok: boolean };

export interface AnalyticsOverviewResult {
  days: number;
  selectedStoreId: string | null;
  availableStores: Array<{ storeId: string; name: string; color?: string; icon?: string }>;
  primaryCurrency: string;
  exchangeRateDate: string;
  totals: { proceeds: Record<string, number>; proceedsPrimary: number; downloads: number; units: number };
  growth: { proceeds: number | null; downloads: number | null; hasPrev: boolean };
  series: Array<{ date: string; proceeds: number; downloads: number }>;
  perStore: Array<{
    storeId: string;
    name: string;
    color?: string;
    icon?: string;
    proceeds: Record<string, number>;
    proceedsPrimary: number;
    downloads: number;
    units: number;
    hasFinance: boolean;
    canSync: boolean;
    financeSyncedAt: number | null;
    latestReportDate: string | null;
  }>;
  topApps: Array<{
    storeId: string;
    appId: string;
    name: string;
    iconUrl: string | null;
    platforms?: string[];
    devices?: string[] | null;
    proceeds: number;
    downloads: number;
  }>;
  storesTotal: number;
  storesWithFinance: number;
  appsTotal: number;
}

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ReviewDetailData {
  id: string;
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
  contactEmail: string;
  demoAccountName: string;
  demoAccountPassword: string;
  demoAccountRequired: boolean;
  notes: string;
  hasDemoPassword: boolean;
  attachments: Array<{ id: string; fileName: string; fileSize: number | null; assetState: string }>;
}

export interface AppExtrasResult {
  versionString: string | null;
  versionEditable: boolean;
  reviewDetail: Section<ReviewDetailData | null>;
  phasedRelease: Section<{ id: string; state: string; currentDayNumber: number | null; startDate: string | null } | null>;
  submission: Section<{
    id: string;
    state: string;
    platform: string;
    submittedDate: string | null;
    items: Array<{ id: string; state: string; itemType: string; versionString: string | null }>;
  } | null>;
  ageRating: Section<(AgeRatingValues & { id: string }) | null>;
  availability: Section<{ availableInNewTerritories: boolean | null; availableTerritories: number; totalTerritories: number }>;
  price: Section<{ baseTerritory: string | null; customerPrice: string | null; proceeds: string | null }>;
  iaps: Section<Array<{ id: string; name: string; productId: string; type: string; state: string }>>;
  subscriptionGroups: Section<Array<{ id: string; name: string; subscriptions: Array<{ id: string; name: string; productId: string; state: string; period: string }> }>>;
  eula: Section<string | null>;
  productPages: Section<Array<{ id: string; name: string; visible: boolean }>>;
  experiments: Section<Array<{ id: string; name: string; state: string; trafficProportion: number | null }>>;
  events: Section<Array<{ id: string; name: string; state: string }>>;
  previewSets: Section<Array<{ id: string; previewType: string; previewCount: number }>>;
  betaGroups: Section<Array<{ id: string; name: string; isInternal: boolean; publicLink: string | null }>>;
  recentBuilds: Section<BuildRef[]>;
  encryption: Section<Array<{ id: string; state: string; usesEncryption: boolean | null; createdDate: string | null }>>;
}

export interface OverviewRow {
  storeId: string;
  storeName: string;
  storeColor: string | null;
  storeIcon: string | null;
  appId: string;
  appName: string;
  iconUrl: string | null;
  platform: string;
  platforms: string[];
  devices: string[] | null;
  versionString: string;
  state: string;
  bucket: 'rejected' | 'waiting' | 'inReview' | 'approved' | 'draft' | 'live' | 'none';
}

export const api = {
  ping: call<Record<string, never>, { ok: boolean }>('ping'),
  authBootstrap: call<{ device?: string }, BootstrapResult>('authBootstrap'),
  appsOverview: call<Record<string, never>, { rows: OverviewRow[] }>('appsOverview'),

  teamList: call<
    Record<string, never>,
    {
      members: Array<{
        uid: string;
        name: string;
        email: string;
        photoUrl: string | null;
        status: UserStatus;
        grants: Record<string, StoreGrant>;
        ai: { features: { translate: boolean; generate: boolean }; monthlyCredits: number };
      }>;
      invites: Array<{ email: string; grants: Record<string, StoreGrant> }>;
      stores: Array<{ storeId: string; name: string; apps: Array<{ id: string; name: string }> }>;
    }
  >('teamList'),
  usersInvite: call<{ email: string; role: GlobalRole; grants?: Record<string, StoreGrant>; ai?: AiGrant }, Ok>('usersInvite'),
  usersUpdate: call<{ uid: string; role?: GlobalRole; grants?: Record<string, StoreGrant>; ai?: AiGrant }, Ok>('usersUpdate'),
  usersSetStatus: call<{ uid: string; status: UserStatus }, Ok>('usersSetStatus'),
  allowlistUpdate: call<{ email: string; role?: GlobalRole; grants?: Record<string, StoreGrant>; ai?: AiGrant }, Ok>('allowlistUpdate'),
  allowlistRemove: call<{ email: string }, Ok>('allowlistRemove'),
  accessRequestResolve: call<{ uid: string; approve: boolean; role?: GlobalRole; grants?: Record<string, StoreGrant>; ai?: AiGrant }, Ok>('accessRequestResolve'),

  storesAdd: call<
    {
      name: string;
      mock?: boolean;
      color?: string;
      icon?: string;
      vendorNumber?: string;
      creds?: { issuerId: string; keyId: string; p8: string };
    },
    { storeId: string; appsCount: number }
  >('storesAdd'),
  storesTest: call<{ storeId: string }, { ok: boolean; appsCount: number }>('storesTest'),
  storesUpdateKey: call<{ storeId: string; creds: { issuerId: string; keyId: string; p8: string } }, Ok>('storesUpdateKey'),
  storesRename: call<
    { storeId: string; name?: string; color?: string; icon?: string; vendorNumber?: string | null },
    Ok
  >('storesRename'),
  storesRecolor: call<Record<string, never>, { recolored: number }>('storesRecolor'),
  bundleIdsList: call<
    { storeId: string },
    { bundleIds: Array<{ id: string; identifier: string; name: string; platform: string; seedId: string }> }
  >('bundleIdsList'),
  bundleIdCreate: call<
    { storeId: string; identifier: string; name: string; platform: 'IOS' | 'MAC_OS' | 'UNIVERSAL' },
    { bundleId: { id: string; identifier: string } }
  >('bundleIdCreate'),
  bundleIdDelete: call<{ storeId: string; bundleIdId: string; identifier?: string }, Ok>('bundleIdDelete'),
  financeSync: call<{ storeId: string; days?: number }, { fetched: number }>('financeSync', 310_000),
  analyticsOverview: call<{ days?: number; sync?: boolean; syncStoreIds?: string[]; storeId?: string | null }, AnalyticsOverviewResult>('analyticsOverview', 550_000),
  storesDelete: call<{ storeId: string }, Ok>('storesDelete'),

  storesSync: call<{ storeId: string }, { skipped: boolean; apps?: number; reason?: string }>('storesSync', 550_000),
  storesHardSync: call<{ storeId: string }, { skipped: boolean; apps?: number; deepSynced?: number; failed?: number; financeDays?: number; reason?: string }>('storesHardSync', 550_000),
  appsSyncOne: call<{ storeId: string; appId: string }, { skipped: boolean; locales?: number; reason?: string }>('appsSyncOne', 310_000),

  locPush: call<
    { storeId: string; appId: string; platform?: string; locales: string[] },
    { results: Array<{ locale: string; ok: boolean; pushedKeys: string[]; error?: string }>; summary: string }
  >('locPush', 550_000),
  locAddLanguage: call<
    { storeId: string; appId: string; platform?: string; locales: string[]; copyFrom?: string | null },
    { added: string[]; skipped: string[]; failed: Array<{ locale: string; error: string }> }
  >('locAddLanguage', 310_000),
  locRemoveLanguage: call<
    { storeId: string; appId: string; platform?: string; locale: string },
    { ok: boolean; removedFromLive: boolean }
  >('locRemoveLanguage'),
  versionsCreate: call<
    { storeId: string; appId: string; platform?: string; versionString: string },
    { versionId: string; versionString: string }
  >('versionsCreate', 310_000),
  versionsUpdate: call<
    { storeId: string; appId: string; platform?: string; versionString: string },
    { versionId: string; versionString: string }
  >('versionsUpdate'),
  buildsList: call<
    { storeId: string; appId: string; platform?: string },
    { versionString: string; selectedBuildId: string | null; builds: BuildRef[] }
  >('buildsList'),
  versionInfoUpdate: call<
    {
      storeId: string;
      appId: string;
      platform?: string;
      copyright?: string;
      releaseType?: ReleaseType;
      earliestReleaseDate?: string | null;
      buildId?: string | null;
    },
    { ok: boolean }
  >('versionInfoUpdate'),

  screenshotsSyncLocale: call<
    { storeId: string; appId: string; platform?: string; locale: string },
    { sets: number }
  >('screenshotsSyncLocale', 310_000),
  screenshotsSyncAll: call<
    { storeId: string; appId: string; platform?: string },
    { branch: 'editable' | 'live'; localesSynced: number; sets: number }
  >('screenshotsSyncAll', 310_000),
  screenshotsUpload: call<
    { storeId: string; appId: string; platform?: string; locale: string; displayType: string; storagePath: string; fileName: string },
    { screenshotId: string; state: string }
  >('screenshotsUpload', 310_000),
  screenshotsPollState: call<
    { storeId: string; appId: string; platform?: string; locale: string; displayType: string; screenshotId: string },
    { state: string }
  >('screenshotsPollState'),
  screenshotsDelete: call<
    { storeId: string; appId: string; platform?: string; locale: string; displayType: string; screenshotId: string },
    Ok
  >('screenshotsDelete'),
  screenshotsReorder: call<
    { storeId: string; appId: string; platform?: string; locale: string; displayType: string; orderedIds: string[] },
    Ok
  >('screenshotsReorder'),
  screenshotSetsDelete: call<
    { storeId: string; appId: string; platform?: string; locale: string; displayType: string },
    Ok
  >('screenshotSetsDelete'),

  appExtrasGet: call<{ storeId: string; appId: string; platform?: string }, AppExtrasResult>('appExtrasGet', 130_000),
  reviewDetailSave: call<
    {
      storeId: string;
      appId: string;
      platform?: string;
      contactFirstName?: string;
      contactLastName?: string;
      contactPhone?: string;
      contactEmail?: string;
      demoAccountName?: string;
      demoAccountPassword?: string;
      demoAccountRequired?: boolean;
      notes?: string;
    },
    Ok
  >('reviewDetailSave'),
  reviewAttachmentUpload: call<
    { storeId: string; appId: string; platform?: string; storagePath: string; fileName: string },
    { attachmentId: string; state: string }
  >('reviewAttachmentUpload', 310_000),
  reviewAttachmentDelete: call<
    { storeId: string; appId: string; platform?: string; attachmentId: string },
    Ok
  >('reviewAttachmentDelete'),
  phasedReleaseSet: call<
    { storeId: string; appId: string; platform?: string; action: 'enable' | 'pause' | 'resume' | 'complete' | 'disable' },
    { state: string | null }
  >('phasedReleaseSet'),
  reviewSubmit: call<{ storeId: string; appId: string; platform?: string }, { state: string }>('reviewSubmit'),
  reviewSubmissionCancel: call<{ storeId: string; appId: string; platform?: string }, Ok>('reviewSubmissionCancel'),
  testflightTestersList: call<
    { storeId: string; appId: string; platform?: string; groupId: string },
    { testers: Array<{ id: string; email: string; firstName: string; lastName: string; inviteType: string }> }
  >('testflightTestersList'),
  testflightTesterAdd: call<
    { storeId: string; appId: string; platform?: string; groupId: string; email: string; firstName?: string; lastName?: string },
    { tester: { id: string; email: string } }
  >('testflightTesterAdd'),
  testflightTesterRemove: call<
    { storeId: string; appId: string; platform?: string; groupId: string; testerId: string; email?: string },
    Ok
  >('testflightTesterRemove'),
  subscriptionGroupCreate: call<
    { storeId: string; appId: string; platform?: string; referenceName: string },
    { group: { id: string; name: string } }
  >('subscriptionGroupCreate'),
  subscriptionCreate: call<
    { storeId: string; appId: string; platform?: string; groupId: string; name: string; productId: string; period: string; displayName: string; description?: string },
    { subscription: { id: string; name: string; productId: string; state: string; period: string } }
  >('subscriptionCreate'),
  subscriptionSubmit: call<
    { storeId: string; appId: string; platform?: string; subscriptionId: string; name?: string },
    Ok
  >('subscriptionSubmit'),
  pricePointsList: call<
    { storeId: string; appId: string; platform?: string },
    { pricePoints: Array<{ id: string; customerPrice: string; proceeds: string }> }
  >('pricePointsList'),
  priceScheduleSet: call<
    { storeId: string; appId: string; platform?: string; pricePointId: string; customerPrice?: string },
    Ok
  >('priceScheduleSet'),
  ageRatingSave: call<
    { storeId: string; appId: string; platform?: string; levels: Record<string, string>; booleans: Record<string, boolean>; kidsAgeBand: KidsAgeBand | null },
    Ok
  >('ageRatingSave'),
  customerReviewsList: call<
    { storeId: string; appId: string; platform?: string; limit?: number },
    { reviews: CustomerReviewEntry[] }
  >('customerReviewsList'),
  customerReviewRespond: call<
    { storeId: string; appId: string; platform?: string; reviewId: string; body: string },
    Ok
  >('customerReviewRespond'),
  customerReviewResponseDelete: call<
    { storeId: string; appId: string; platform?: string; responseId: string },
    Ok
  >('customerReviewResponseDelete'),

  aiTranslate: call<
    {
      storeId: string;
      appId: string;
      platform?: string;
      sourceLocale: string;
      targetLocales: string[];
      fields: string[];
      overwrite?: boolean;
    },
    { results: Array<{ locale: string; ok: boolean; fieldsWritten: number; error?: string }> }
  >('aiTranslate', 550_000),
  aiGenerate: call<
    { storeId: string; appId: string; platform?: string; locale: string; kind: 'name' | 'keywords' | 'subtitle' | 'improve-description' | 'promotional-text' | 'whatsnew'; context?: string | null },
    { options: string[]; field: string; fieldKey: string }
  >('aiGenerate'),
  aiReviewReply: call<
    { storeId: string; appId: string; platform?: string; reviewId: string; attempt?: number },
    { reply: string }
  >('aiReviewReply'),

  settingsUpdate: call<
    {
      aiModel?: string;
      idleTimeoutMinutes?: number | null;
      allowedDomains?: string[];
      reportEmails?: string[];
      reportHour?: number;
    },
    Ok
  >('settingsUpdate'),
  reportSendNow: call<Record<string, never>, { summary: string }>('reportSendNow', 550_000),

  adsAppleConnect: call<
    { label: string; clientId: string; teamId: string; keyId: string; privateKey: string; orgId: number },
    { accountId: string; campaignsCount: number }
  >('adsAppleConnect'),
  admobConnect: call<
    { label: string; clientId?: string; clientSecret?: string; code: string; redirectUri: string },
    { accountId: string; publisherId: string; currencyCode: string }
  >('admobConnect'),
  admobOauthStatus: call<Record<string, never>, { configured: boolean; clientId?: string }>('admobOauthStatus'),
  adsAccountRemove: call<{ accountId: string }, Ok>('adsAccountRemove'),
  adsCampaignsList: call<Record<string, never>, { campaigns: AdsCampaignLive[]; errors: string[] }>('adsCampaignsList', 130_000),
  adsCampaignSetStatus: call<
    { accountId: string; campaignId: string; status: 'ENABLED' | 'PAUSED' },
    { ok: boolean; status: string }
  >('adsCampaignSetStatus'),
  adsSync: call<{ days?: number }, { days: number; providers: string[] }>('adsSync', 310_000),

  // Apple Search Ads management
  adsAdGroupsList: call<{ accountId: string; campaignId: string; days?: number }, { adGroups: AdsAdGroupLive[] }>('adsAdGroupsList', 130_000),
  adsAdGroupCreate: call<
    { accountId: string; campaignId: string; name: string; defaultBid: Money },
    { adGroup: AdsAdGroupLive }
  >('adsAdGroupCreate'),
  adsAdGroupUpdate: call<
    { accountId: string; campaignId: string; adGroupId: string; name?: string; status?: 'ENABLED' | 'PAUSED'; defaultBid?: Money },
    Ok
  >('adsAdGroupUpdate'),
  adsKeywordsList: call<{ accountId: string; campaignId: string; adGroupId: string; days?: number }, { keywords: AdsKeywordLive[] }>('adsKeywordsList', 130_000),
  adsKeywordsCreate: call<
    { accountId: string; campaignId: string; adGroupId: string; keywords: Array<{ text: string; matchType: 'EXACT' | 'BROAD'; bid: Money }> },
    { created: number }
  >('adsKeywordsCreate'),
  adsKeywordUpdate: call<
    { accountId: string; campaignId: string; adGroupId: string; keywordId: string; status?: 'ACTIVE' | 'PAUSED'; bid?: Money },
    Ok
  >('adsKeywordUpdate'),
  adsNegativeKeywordsList: call<{ accountId: string; campaignId: string; adGroupId: string }, { negatives: AdsNegativeKeyword[] }>('adsNegativeKeywordsList'),
  adsNegativeKeywordsAdd: call<
    { accountId: string; campaignId: string; adGroupId: string; keywords: Array<{ text: string; matchType: 'EXACT' | 'BROAD' }> },
    Ok
  >('adsNegativeKeywordsAdd'),
  adsNegativeKeywordDelete: call<{ accountId: string; campaignId: string; adGroupId: string; keywordId: string }, Ok>('adsNegativeKeywordDelete'),
  adsSearchTermsList: call<{ accountId: string; campaignId: string; adGroupId: string; days?: number }, { terms: AdsMetricRow[] }>('adsSearchTermsList', 130_000),
  adsCampaignCreate: call<
    { accountId: string; name: string; adamId: number; currency: string; budget: number; dailyBudget: number; countries: string[] },
    { campaign: AdsCampaignLive }
  >('adsCampaignCreate', 130_000),
  adsCampaignUpdate: call<
    { accountId: string; campaignId: string; name?: string; status?: 'ENABLED' | 'PAUSED'; currency: string; dailyBudget?: number; countries?: string[] },
    Ok
  >('adsCampaignUpdate'),
};

type Money = { amount: number; currency: string };

/** Extract a human-readable message from a callable error. */
export function callableMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    // firebase HttpsError messages are already user-facing (our wrap.ts guarantees it)
    return err.message.replace(/^Firebase: /, '').replace(/ \(functions\/[a-z-]+\)\.?$/, '');
  }
  return 'Something went wrong.';
}
