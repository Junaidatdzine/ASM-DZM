/**
 * Firestore document shapes shared by web (client SDK) and functions (admin SDK).
 * Timestamps are typed structurally so both SDKs' Timestamp classes satisfy them.
 */
export interface TS {
  toMillis(): number;
}

export type Platform = 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS';

/** Finer-grained than Platform — what the public store listing says the app runs on. */
export type AppleDeviceFamily = 'iphone' | 'ipad' | 'mac' | 'appletv' | 'watch' | 'vision';

export type GlobalRole = 'admin' | 'member';
/**
 * Store roles, in ascending capability:
 *  viewer     — read only
 *  translator — edit drafts + use AI, but CANNOT push to Apple (draft-only contributor)
 *  editor     — translator + push and manage screenshots
 *  developer  — editor + release engineering: versions, review submissions, TestFlight, in-app purchases
 *  manager    — developer + add/remove languages, force sync
 */
export type StoreRole = 'viewer' | 'translator' | 'editor' | 'developer' | 'manager';
export type UserStatus = 'active' | 'disabled';

/** Store-scoped capabilities that an admin may explicitly allow or deny. */
export type StorePermission =
  | 'view'
  | 'editDrafts'
  | 'useAi'
  | 'push'
  | 'addLanguage'
  | 'manageScreenshots'
  | 'removeLanguage'
  | 'createVersion'
  | 'forceSync'
  | 'manageTestFlight'
  | 'manageSubmissions'
  | 'manageIap'
  // Sensitive, no role includes them — granted only by explicit override:
  | 'viewFinance'
  | 'manageMembers'
  | 'manageProvisioning';

export interface AiGrant {
  features: { translate: boolean; generate: boolean };
  monthlyCredits: number;
  usage?: { month: string; used: number }; // month = 'YYYY-MM'
}

export interface StoreGrant {
  role: StoreRole;
  /** Optional per-app narrowing. Absent = all apps at store role. 'none' hides the app. */
  apps?: Record<string, StoreRole | 'none'>;
  /** Explicit capability overrides. Missing keys inherit the selected role preset. */
  permissions?: Partial<Record<StorePermission, boolean>>;
}

export interface UserDoc {
  email: string;
  name: string;
  photoUrl: string | null;
  role: GlobalRole;
  status: UserStatus;
  grants: Record<string, StoreGrant>; // storeId -> grant
  ai: AiGrant;
  createdAt: TS;
  lastLoginAt?: TS;
  /** Where/what the user last signed in from (country via IP, device via user agent). */
  lastLogin?: { at: TS; countryCode?: string; country?: string; city?: string; device?: string };
}

export interface UserPrefsDoc {
  theme?: 'light' | 'dark' | 'system';
  lastStoreId?: string;
  sidebarCollapsed?: boolean;
  /** Presence heartbeat — written every ~2 min while a tab is visible. */
  lastSeenAt?: TS;
}

export interface AllowlistDoc {
  role: GlobalRole;
  grants: Record<string, StoreGrant>;
  ai: AiGrant;
  addedBy: string;
  addedAt: TS;
}

export interface AccessRequestDoc {
  email: string;
  name: string;
  photoUrl?: string | null;
  note?: string;
  createdAt: TS;
}

export type StoreStatus = 'ok' | 'auth_error';

export interface SyncLease {
  leaseUntil: TS | null;
  by: string | null;
}

export interface StoreDoc {
  name: string;
  status: StoreStatus;
  /** Visual identity — palette key + lucide icon name (see storeVisuals.ts). */
  color?: string;
  icon?: string;
  /** Apple vendor number (Payments & Financial Reports) — required for finance analytics. */
  vendorNumber?: string;
  financeSyncedAt?: TS;
  /** Learned subscription-appleId → app-id links (renewal rows lack a Parent Identifier). */
  financeSubMap?: Record<string, string>;
  /** Denormalized from users/*.grants — written only by functions, powers rules + list queries. */
  roles: Record<string, StoreRole>; // uid -> role
  memberUids: string[];
  rate?: { limit: number; remaining: number; at: TS };
  sync?: SyncLease;
  appsSyncedAt?: TS;
  appsCount?: number;
  createdBy: string;
  createdAt: TS;
  /** When true the functions layer uses the fixture-backed mock ASC client. */
  mock?: boolean;
}

export interface StoreSecretDoc {
  issuerId: string;
  keyId: string;
  p8: { v: number; iv: string; ct: string; tag: string }; // AES-256-GCM, AAD = storeId
  addedBy: string;
  addedAt: TS;
}

export type AppStoreVersionState =
  | 'PREPARE_FOR_SUBMISSION'
  | 'METADATA_REJECTED'
  | 'DEVELOPER_REJECTED'
  | 'REJECTED'
  | 'INVALID_BINARY'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'PENDING_DEVELOPER_RELEASE'
  | 'PENDING_APPLE_RELEASE'
  | 'PROCESSING_FOR_APP_STORE'
  | 'READY_FOR_SALE'
  | 'READY_FOR_DISTRIBUTION'
  | 'REPLACED_WITH_NEW_VERSION'
  | 'REMOVED_FROM_SALE'
  | 'DEVELOPER_REMOVED_FROM_SALE'
  | 'PREORDER_READY_FOR_SALE'
  | 'ACCEPTED'
  | (string & {});

/** How an approved version reaches the App Store. Mirrors appStoreVersions.releaseType. */
export type ReleaseType = 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED';

/** A processed (or processing) binary uploaded to App Store Connect. */
export interface BuildRef {
  id: string;
  /** Build number — CFBundleVersion, e.g. '42'. */
  version: string;
  uploadedDate?: string;
  /** PROCESSING | FAILED | INVALID | VALID */
  processingState?: string;
  expired?: boolean;
  /** null when the developer hasn't answered the export-compliance question yet. */
  usesNonExemptEncryption?: boolean | null;
}

export interface VersionRef {
  id: string;
  versionString: string;
  state: AppStoreVersionState;
  /**
   * Version Information (release configuration), cached from appStoreVersions attributes.
   * Present after a deep sync; editable only while the version is in an editable state.
   */
  copyright?: string;
  releaseType?: ReleaseType;
  /** ISO-8601; only meaningful when releaseType is SCHEDULED. */
  earliestReleaseDate?: string | null;
  /** Currently selected build (appStoreVersions.build relationship). Absent = not synced. */
  build?: BuildRef | null;
}

export interface AppDoc {
  name: string;
  bundleId: string;
  sku?: string;
  primaryLocale: string;
  platforms: Platform[];
  /** From the public store listing (released apps only): iPhone/iPad split etc. */
  devices?: AppleDeviceFamily[];
  iconUrl?: string | null;
  removedFromAsc?: boolean;
  /** Optional per-app ACL override (uid -> role or 'none'); mirrors users.grants[sid].apps. */
  acl?: Record<string, StoreRole | 'none'>;
  appInfo: {
    editableId: string | null;
    editableState: string | null;
    liveId: string | null;
  };
  versions: Partial<
    Record<Platform, { live: VersionRef | null; editable: VersionRef | null; review?: VersionRef | null }>
  >;
  /** Union of locales present in any branch — for coverage stats without reading subcollections. */
  locales: string[];
  /** Per-locale AI translation failures — shown in red in the matrix until a later run succeeds. */
  aiFailures?: Record<string, { error: string; fields: string[]; at: TS }>;
  /** Bumped when deep-sync starts caching new branches/fields; clients force one reconciliation. */
  deepSyncSchemaVersion?: number;
  deepSyncedAt?: TS;
  sync?: SyncLease;
  lastEditedAt?: TS;
  lastEditedBy?: string;
  lastActivityAt?: TS;
  pendingDraftFields?: number;
}

export interface InfoLocFields {
  name: string;
  subtitle: string;
  privacyPolicyUrl?: string;
  privacyChoicesUrl?: string;
}

export interface VersionLocFields {
  description: string;
  keywords: string;
  promotionalText: string;
  whatsNew: string;
  supportUrl: string;
  marketingUrl: string;
}

export interface LocaleDoc {
  info: {
    editable: Partial<InfoLocFields> | null;
    live: Partial<InfoLocFields> | null;
    ids: { editable: string | null; live: string | null };
  };
  versions: Partial<
    Record<
      Platform,
      {
        editable: Partial<VersionLocFields> | null;
        live: Partial<VersionLocFields> | null;
        ids: { editable: string | null; live: string | null };
      }
    >
  >;
  /** Locale exists on the version but its appInfo localization couldn't be created (or vice versa). */
  infoPending?: boolean;
  /** Locale vanished from ASC but a local draft still references it. */
  missingRemote?: boolean;
  syncedAt: TS;
}

export type DraftStatus = 'open' | 'pushing';

export interface DraftDoc {
  /** Keys are encoded field keys — see fieldKeys.ts (e.g. 'info__name', 'versions__IOS__description'). */
  fields: Record<string, string>;
  /** Cached remote value at the moment the field was first touched — 3-way conflict base. */
  base: Record<string, string>;
  meta: Record<string, { by: string; at: TS; ai?: boolean }>;
  status: DraftStatus;
  updatedBy: string;
  updatedAt: TS;
}

export type ScreenshotState = 'uploading' | 'processing' | 'complete' | 'failed';

export interface ScreenshotEntry {
  id: string;
  fileName: string;
  position: number;
  width: number | null;
  height: number | null;
  /** Apple CDN template URL — substitute {w}x{h}bb.{f} to render thumbnails. */
  templateUrl: string | null;
  state: ScreenshotState;
  error?: string;
}

export type Branch = 'editable' | 'live';

export interface ScreenshotSetDoc {
  platform: Platform;
  branch: Branch;
  displayType: string;
  locale: string;
  setId: string | null; // null until created on ASC
  screenshots: ScreenshotEntry[];
  syncedAt: TS;
}

export type OperationType =
  | 'store-sync'
  | 'app-sync'
  | 'loc-push'
  | 'add-language'
  | 'remove-language'
  | 'create-version'
  | 'update-version'
  | 'screenshot-upload'
  | 'screenshot-sync'
  | 'ai-translate'
  | 'ai-generate';

export type OperationStatus = 'running' | 'success' | 'error' | 'partial';

export interface OperationDoc {
  type: OperationType;
  status: OperationStatus;
  label: string; // human line for the Activity UI, e.g. 'Syncing MyApp'
  storeId?: string;
  appId?: string;
  locale?: string;
  progress?: {
    done: number;
    total: number;
    added?: number;
    skipped?: number;
    failed?: number;
  };
  startedBy: string;
  startedAt: TS;
  finishedAt?: TS;
  error?: string;
  expireAt: TS; // Firestore TTL
}

export interface AuditChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface AuditLogDoc {
  at: TS;
  actor: { uid: string; email: string };
  action: string; // e.g. 'loc.push', 'store.add', 'user.disable', 'ai.translate'
  storeId?: string;
  appId?: string;
  locale?: string;
  platform?: Platform;
  changes?: AuditChange[];
  result: 'ok' | 'error' | 'partial';
  error?: string;
  detail?: string;
  expireAt: TS; // Firestore TTL (~180d)
}

export interface GlobalSettingsDoc {
  aiModel: string; // e.g. 'gemini-2.5-flash-lite'
  /** Sessions expire after this much inactivity. null = use the 7-day default. */
  idleTimeoutMinutes: number | null;
  /**
   * If non-empty, only Google accounts on these email domains may gain access
   * (allowlisted/admin emails always pass). e.g. ['acme.com'].
   */
  allowedDomains?: string[];
  /** Recipients of the automated daily finance report. Empty = reports off. */
  reportEmails?: string[];
  /** Hour of day (0–23, Asia/Karachi) the daily report goes out. */
  reportHour?: number;
}

/** State doc for the daily report scheduler (settings/reportState). */
export interface ReportStateDoc {
  /** Asia/Karachi calendar date of the last delivered report — the once-per-day guard. */
  lastSentDate?: string;
  lastSentAt?: TS;
  lastError?: string;
}

/** Per-app stats inside one finance day. Proceeds = developer proceeds (after Apple's cut). */
export interface FinanceAppStat {
  units: number;
  downloads: number;
  proceeds: Record<string, number>; // currency -> amount
  proceedsUsd?: number;
  name?: string;
}

/**
 * One day of sales-report data, cached per store (admin-only readable).
 * Only proceeds are stored — customer prices are never persisted.
 */
export interface FinanceDayDoc {
  schemaVersion?: number;
  date: string; // YYYY-MM-DD
  units: number;
  downloads: number;
  proceeds: Record<string, number>;
  proceedsUsd?: number;
  perApp: Record<string, FinanceAppStat>; // ASC app id -> stats
  /** Developer proceeds by App Store country/region (ISO code), in USD. */
  perCountry?: Record<string, number>;
  fetchedAt: TS;
}

/**
 * One day of subscription lifecycle events, cached per store (admin-only readable),
 * from Apple's Subscription Event report. Counts of people, never money.
 * subscriptionDays/{YYYY-MM-DD}.
 */
export interface SubsDayDoc {
  schemaVersion?: number;
  date: string; // YYYY-MM-DD
  /** Free-trial subscriptions started. */
  trialStarts: number;
  /** New paid subscriptions started (no free trial). */
  newPaid: number;
  /** Auto-renew turned off (a future churn signal, not an immediate loss). */
  cancellations: number;
  fetchedAt: TS;
}

// ---- Advertising: Apple Search Ads spend + AdMob revenue ----

export type AdsProvider = 'appleAds' | 'admob';

/**
 * One connected advertising account (adsAccounts/{id}, admin-readable, no secrets).
 * People name them like they talk about them: "Rvira — Search Ads", "Main AdMob".
 */
export interface AdsAccountDoc {
  provider: AdsProvider;
  label: string;
  connected: boolean;
  // Apple Search Ads
  orgId?: number;
  clientIdMasked?: string;
  campaignsCount?: number;
  // AdMob
  publisherId?: string;
  currencyCode?: string;
  lastError?: string;
  createdBy: string;
  createdAt: TS;
}

export interface AdsCampaignStat {
  id: string;
  name: string;
  accountId?: string;
  accountLabel?: string;
  spend: Record<string, number>; // currency -> amount
  spendUsd?: number;
  taps: number;
  impressions: number;
  installs: number;
}

/** Live campaign state from Apple (status is controllable from the dashboard). */
export interface AdsCampaignLive {
  id: string;
  name: string;
  accountId: string;
  accountLabel: string;
  status: 'ENABLED' | 'PAUSED' | (string & {});
  servingStatus?: string;
  dailyBudget?: { amount: number; currency: string } | null;
  countries?: string[];
}

/** Per-account slice inside one ads day. */
export interface AdsAccountDayStat {
  id: string;
  label: string;
  spendUsd?: number;
  earningsUsd?: number;
  taps?: number;
  installs?: number;
}

/** One day of advertising data across every connected account (adsDays/{YYYY-MM-DD}, admin-only). */
export interface AdsDayDoc {
  schemaVersion?: number;
  date: string;
  appleAds?: {
    spend: Record<string, number>;
    spendUsd?: number;
    taps: number;
    impressions: number;
    installs: number;
    campaigns: AdsCampaignStat[];
    accounts?: AdsAccountDayStat[];
  };
  admob?: {
    earnings: Record<string, number>;
    earningsUsd?: number;
    accounts?: AdsAccountDayStat[];
  };
  fetchedAt: TS;
}

/** Workspace-level ads sync status (adsConfig/status, admin-readable). */
export interface AdsConfigDoc {
  syncedAt?: TS;
}

// ---- Apple Search Ads management (live, not persisted) ----

type Money = { amount: number; currency: string };

/** One ad group in a campaign, with range-total metrics merged in. */
export interface AdsAdGroupLive {
  id: string;
  campaignId: string;
  accountId: string;
  name: string;
  status: string; // ENABLED | PAUSED
  servingStatus?: string;
  defaultBid: Money | null;
  spendAmount: number;
  spendCurrency: string;
  taps: number;
  impressions: number;
  installs: number;
}

/** One targeting keyword in an ad group, with range-total metrics merged in. */
export interface AdsKeywordLive {
  id: string;
  adGroupId: string;
  text: string;
  matchType: string; // EXACT | BROAD
  status: string; // ACTIVE | PAUSED
  bid: Money | null;
  spendAmount: number;
  spendCurrency: string;
  taps: number;
  impressions: number;
  installs: number;
}

export interface AdsNegativeKeyword {
  id: string;
  text: string;
  matchType: string;
}

/** A generic reporting row (e.g. a customer search term) with range totals. */
export interface AdsMetricRow {
  id: string;
  label: string;
  spendAmount: number;
  spendCurrency: string;
  taps: number;
  impressions: number;
  installs: number;
}

/** First-time download product types in Apple sales reports (updates/IAP excluded). */
export function isDownloadProductType(productType: string): boolean {
  return /^(1|1F|1T|1E|1EP|1EU|F1)/.test(productType) && !/^7/.test(productType);
}

/** Default AI grant applied when an admin hasn't configured one. */
export const DEFAULT_AI_GRANT: AiGrant = {
  features: { translate: false, generate: false },
  monthlyCredits: 0,
};

export const DEFAULT_SETTINGS: GlobalSettingsDoc = {
  // flash-lite is the cheapest capable model — great for translation, keeps AI credits cheap.
  aiModel: 'gemini-2.5-flash-lite',
  // One week without signing in ends the session for every user.
  idleTimeoutMinutes: 10080,
  allowedDomains: [],
  reportEmails: [],
  reportHour: 11, // 11:00 Asia/Karachi
};

/** Selectable Gemini models, cheapest first. */
export const AI_MODELS: Array<{ id: string; label: string; note: string }> = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', note: 'Cheapest — great for translation' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Higher quality, a bit pricier' },
];
