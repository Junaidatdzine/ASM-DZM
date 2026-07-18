import type { Platform } from '@asm/shared';

/** Flattened App Store Connect resources (mapped from JSON:API). */
export interface AscApp {
  id: string;
  bundleId: string;
  name: string;
  sku?: string;
  primaryLocale: string;
  /** Union of appStoreVersions platforms — [] when the app has no versions yet. */
  platforms?: Platform[];
  /** Recent versions (id/platform/version/state) piggybacked on the list call. */
  versionsIncluded?: AscVersion[];
}

export interface AscAppInfo {
  id: string;
  state: string; // appStoreState of this appInfo record
}

export interface AscInfoLoc {
  id: string;
  locale: string;
  name: string;
  subtitle: string;
  privacyPolicyUrl: string;
  privacyChoicesUrl: string;
}

export interface AscBuild {
  id: string;
  version: string;
  uploadedDate?: string;
  processingState?: string;
  expired?: boolean;
  usesNonExemptEncryption?: boolean | null;
  /** App icon rendered from the build's iconAssetToken — works for unreleased apps. */
  iconUrl?: string | null;
}

export interface AscVersion {
  id: string;
  platform: Platform;
  versionString: string;
  state: string;
  createdDate?: string;
  copyright?: string;
  releaseType?: string;
  earliestReleaseDate?: string | null;
}

/** Writable appStoreVersions release-configuration attributes. */
export interface VersionInfoAttrs {
  copyright?: string;
  releaseType?: string;
  earliestReleaseDate?: string | null;
}

export interface AscVersionLoc {
  id: string;
  locale: string;
  description: string;
  keywords: string;
  promotionalText: string;
  whatsNew: string;
  supportUrl: string;
  marketingUrl: string;
}

export interface AscScreenshotSet {
  id: string;
  displayType: string;
}

export interface AscUploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: Array<{ name: string; value: string }>;
}

export interface AscScreenshot {
  id: string;
  fileName: string;
  fileSize: number | null;
  /** AWAITING_UPLOAD | UPLOAD_COMPLETE | COMPLETE | FAILED */
  assetState: string;
  templateUrl: string | null;
  width: number | null;
  height: number | null;
  uploadOperations?: AscUploadOperation[];
}

export interface InfoLocAttrs {
  name?: string;
  subtitle?: string;
  privacyPolicyUrl?: string;
  privacyChoicesUrl?: string;
}

export interface VersionLocAttrs {
  description?: string;
  keywords?: string;
  promotionalText?: string;
  whatsNew?: string;
  supportUrl?: string;
  marketingUrl?: string;
}

// ---- Release & review resources ----

export interface AscReviewDetail {
  id: string;
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
  contactEmail: string;
  demoAccountName: string;
  demoAccountPassword: string;
  demoAccountRequired: boolean;
  notes: string;
}

export type ReviewDetailAttrs = Partial<Omit<AscReviewDetail, 'id'>>;

export interface AscReviewAttachment {
  id: string;
  fileName: string;
  fileSize: number | null;
  assetState: string; // AWAITING_UPLOAD | COMPLETE | FAILED …
  uploadOperations?: AscUploadOperation[];
}

export interface AscPhasedRelease {
  id: string;
  state: string; // INACTIVE | ACTIVE | PAUSED | COMPLETE
  currentDayNumber: number | null;
  startDate: string | null;
}

export interface AscReviewSubmission {
  id: string;
  state: string;
  platform: string;
  submittedDate: string | null;
}

/** One item inside a review submission (a version, event, product page…). */
export interface AscReviewSubmissionItem {
  id: string;
  state: string; // READY_FOR_REVIEW | ACCEPTED | APPROVED | REJECTED | REMOVED
  itemType: string; // appStoreVersions | appEvents | …
  /** Human anchor when the item is a version. */
  versionString: string | null;
}

export interface AscAgeRating {
  id: string;
  /** Raw attribute map — level enums, booleans, kidsAgeBand. */
  attributes: Record<string, unknown>;
}

export interface AscCustomerReview {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewerNickname: string;
  createdDate: string;
  territory: string;
  response: { id: string; body: string; lastModified: string; state: string } | null;
}

// ---- Commerce & distribution (read-only summaries) ----

export interface AscAvailabilitySummary {
  availableInNewTerritories: boolean | null;
  availableTerritories: number;
  totalTerritories: number;
}

export interface AscPriceSummary {
  baseTerritory: string | null;
  customerPrice: string | null;
  proceeds: string | null;
}

/** One selectable price tier for an app in a territory. */
export interface AscPricePoint {
  id: string;
  customerPrice: string;
  proceeds: string;
}

export interface AscIap {
  id: string;
  name: string;
  productId: string;
  type: string;
  state: string;
}

export interface AscSubscriptionGroup {
  id: string;
  name: string;
  subscriptions: Array<{ id: string; name: string; productId: string; state: string; period: string }>;
}

export interface AscProductPage {
  id: string;
  name: string;
  visible: boolean;
}

export interface AscExperiment {
  id: string;
  name: string;
  state: string;
  trafficProportion: number | null;
}

export interface AscAppEvent {
  id: string;
  name: string;
  state: string;
}

export interface AscPreviewSet {
  id: string;
  previewType: string;
  previewCount: number;
}

export interface AscBetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
  publicLink: string | null;
}

export interface AscBetaTester {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  inviteType: string; // EMAIL | PUBLIC_LINK
}

/** Apple Developer provisioning: a registered App ID. */
export interface AscBundleId {
  id: string;
  identifier: string;
  name: string;
  platform: string; // IOS | MAC_OS | UNIVERSAL
  seedId: string;
}

export interface AscEncryptionDeclaration {
  id: string;
  state: string;
  usesEncryption: boolean | null;
  createdDate: string | null;
}

/** One parsed row of a daily sales summary report. proceeds = per-unit developer proceeds. */
export interface SalesRow {
  appleId: string;
  sku: string;
  title: string;
  productType: string;
  units: number;
  proceedsPerUnit: number;
  currency: string;
  /** App Store country/region ISO code the sale happened in (report column "Country Code"). */
  country: string;
  /** For IAP/subscription rows: the parent APP's SKU (report column "Parent Identifier"). */
  parentIdentifier?: string;
}

/**
 * One parsed row of a daily Subscription Event report (reportType=SUBSCRIPTION_EVENT).
 * This is where real trial starts and subscription activations live — the sales
 * summary report only carries paid units and proceeds, never these lifecycle events.
 */
export interface SubscriptionEventRow {
  /** e.g. "Subscribe", "Renew", "Cancel", "Reactivate". */
  event: string;
  /** The parent app's Apple ID (report column "App Apple ID") — matches our app doc id. */
  appAppleId: string;
  /** e.g. "Free Trial", "Pay As You Go", "Pay Up Front", or "" for none. */
  offerType: string;
  /** Number of subscribers this row represents (report column "Quantity"). */
  quantity: number;
}

/**
 * The surface both the real client and the fixture mock implement.
 * Everything the app does against Apple goes through this interface.
 */
export interface AscApi {
  /** Daily sales summary (gzip TSV on the real API). null = report not available (yet). */
  fetchDailySales(vendorNumber: string, date: string): Promise<SalesRow[] | null>;
  /** Daily subscription events (trials, activations, cancellations). null = no subscriptions / not available. */
  fetchDailySubscriptionEvents(vendorNumber: string, date: string): Promise<SubscriptionEventRow[] | null>;
  /** Cheap credentials probe; returns total app count. */
  verify(): Promise<{ appsCount: number }>;

  listApps(): Promise<AscApp[]>;
  listAppInfos(appId: string): Promise<AscAppInfo[]>;
  listAppInfoLocalizations(appInfoId: string): Promise<AscInfoLoc[]>;
  listVersions(appId: string): Promise<AscVersion[]>;
  listVersionLocalizations(versionId: string): Promise<AscVersionLoc[]>;

  createAppInfoLocalization(appInfoId: string, locale: string, attrs: InfoLocAttrs): Promise<AscInfoLoc>;
  updateAppInfoLocalization(id: string, attrs: InfoLocAttrs): Promise<AscInfoLoc>;
  deleteAppInfoLocalization(id: string): Promise<void>;

  createVersionLocalization(versionId: string, locale: string, attrs: VersionLocAttrs): Promise<AscVersionLoc>;
  updateVersionLocalization(id: string, attrs: VersionLocAttrs): Promise<AscVersionLoc>;
  deleteVersionLocalization(id: string): Promise<void>;

  createVersion(appId: string, platform: Platform, versionString: string): Promise<AscVersion>;
  updateVersion(id: string, versionString: string): Promise<AscVersion>;
  getVersionState(versionId: string): Promise<string>;
  getAppInfoState(appInfoId: string): Promise<string>;

  /** Update release-configuration attributes (copyright, release type/date) on a version. */
  updateVersionInfo(versionId: string, attrs: VersionInfoAttrs): Promise<AscVersion>;
  /** The build currently attached to a version (appStoreVersions.build), or null. */
  getVersionBuild(versionId: string): Promise<AscBuild | null>;
  /** Attach a build to a version, or detach the current one when buildId is null. */
  selectBuild(versionId: string, buildId: string | null): Promise<void>;
  /** Builds eligible for a version — the app's builds whose short version matches. */
  listBuilds(appId: string, versionString: string): Promise<AscBuild[]>;
  /** Most recently uploaded builds for the app, regardless of version. */
  listRecentBuilds(appId: string, limit?: number): Promise<AscBuild[]>;

  // ---- App Review details & attachments ----
  getReviewDetail(versionId: string): Promise<AscReviewDetail | null>;
  createReviewDetail(versionId: string, attrs: ReviewDetailAttrs): Promise<AscReviewDetail>;
  updateReviewDetail(id: string, attrs: ReviewDetailAttrs): Promise<AscReviewDetail>;
  listReviewAttachments(reviewDetailId: string): Promise<AscReviewAttachment[]>;
  reserveReviewAttachment(reviewDetailId: string, fileName: string, fileSize: number): Promise<AscReviewAttachment>;
  commitReviewAttachment(id: string, md5: string): Promise<AscReviewAttachment>;
  deleteReviewAttachment(id: string): Promise<void>;

  // ---- Phased release & review submission ----
  getPhasedRelease(versionId: string): Promise<AscPhasedRelease | null>;
  createPhasedRelease(versionId: string): Promise<AscPhasedRelease>;
  updatePhasedRelease(id: string, state: string): Promise<AscPhasedRelease>;
  deletePhasedRelease(id: string): Promise<void>;
  listReviewSubmissions(appId: string, platform: Platform): Promise<AscReviewSubmission[]>;
  createReviewSubmission(appId: string, platform: Platform): Promise<AscReviewSubmission>;
  addReviewSubmissionItem(submissionId: string, versionId: string): Promise<void>;
  submitReviewSubmission(id: string): Promise<AscReviewSubmission>;
  cancelReviewSubmission(id: string): Promise<AscReviewSubmission>;
  listReviewSubmissionItems(submissionId: string): Promise<AscReviewSubmissionItem[]>;

  // ---- Age rating ----
  getAgeRatingDeclaration(appInfoId: string): Promise<AscAgeRating | null>;
  updateAgeRatingDeclaration(id: string, attributes: Record<string, unknown>): Promise<AscAgeRating>;

  // ---- Customer reviews ----
  listCustomerReviews(appId: string, limit?: number): Promise<AscCustomerReview[]>;
  respondToReview(reviewId: string, body: string): Promise<void>;
  deleteReviewResponse(responseId: string): Promise<void>;

  // ---- Commerce & distribution summaries (read-only) ----
  getAvailabilitySummary(appId: string): Promise<AscAvailabilitySummary>;
  getPriceSummary(appId: string): Promise<AscPriceSummary>;
  listInAppPurchases(appId: string): Promise<AscIap[]>;
  listSubscriptionGroups(appId: string): Promise<AscSubscriptionGroup[]>;
  getEulaText(appId: string): Promise<string | null>;
  listCustomProductPages(appId: string): Promise<AscProductPage[]>;
  listExperiments(appId: string): Promise<AscExperiment[]>;
  listAppEvents(appId: string): Promise<AscAppEvent[]>;
  listPreviewSets(versionLocId: string): Promise<AscPreviewSet[]>;
  listBetaGroups(appId: string): Promise<AscBetaGroup[]>;
  listEncryptionDeclarations(appId: string): Promise<AscEncryptionDeclaration[]>;

  // ---- TestFlight management ----
  listBetaTesters(groupId: string): Promise<AscBetaTester[]>;
  createBetaTester(groupId: string, email: string, firstName?: string, lastName?: string): Promise<AscBetaTester>;
  /** Removes the tester from ONE group (they stay in other groups / the account). */
  removeBetaTesterFromGroup(groupId: string, testerId: string): Promise<void>;

  // ---- Pricing ----
  /** Price tiers Apple offers for this app in the given territory (default USA). */
  listPricePoints(appId: string, territory?: string): Promise<AscPricePoint[]>;
  /** Replace the app's price schedule: one manual base price, effective immediately. */
  setPriceSchedule(appId: string, pricePointId: string, baseTerritory?: string): Promise<void>;

  // ---- Apple Developer provisioning ----
  listBundleIds(): Promise<AscBundleId[]>;
  createBundleId(identifier: string, name: string, platform: string): Promise<AscBundleId>;
  deleteBundleId(id: string): Promise<void>;

  // ---- Subscription creation ----
  createSubscriptionGroup(appId: string, referenceName: string): Promise<{ id: string; name: string }>;
  createSubscription(
    groupId: string,
    attrs: { name: string; productId: string; period: string; groupLevel: number },
  ): Promise<{ id: string; name: string; productId: string; state: string; period: string }>;
  /** Localized display name/description shoppers see — required before review. */
  createSubscriptionLocalization(subscriptionId: string, locale: string, name: string, description: string): Promise<void>;
  submitSubscription(subscriptionId: string): Promise<void>;

  listScreenshotSets(versionLocId: string): Promise<AscScreenshotSet[]>;
  listScreenshots(setId: string): Promise<AscScreenshot[]>;
  createScreenshotSet(versionLocId: string, displayType: string): Promise<AscScreenshotSet>;
  deleteScreenshotSet(id: string): Promise<void>;
  reserveScreenshot(setId: string, fileName: string, fileSize: number): Promise<AscScreenshot>;
  uploadScreenshotParts(ops: AscUploadOperation[], data: Buffer): Promise<void>;
  commitScreenshot(id: string, md5: string): Promise<AscScreenshot>;
  getScreenshot(id: string): Promise<AscScreenshot>;
  deleteScreenshot(id: string): Promise<void>;
  reorderScreenshots(setId: string, orderedIds: string[]): Promise<void>;
}
