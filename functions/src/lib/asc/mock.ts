import type { Platform } from '@asm/shared';
import { AppError } from '../errors';
import type {
  AscApi,
  AscApp,
  AscAppInfo,
  AscBetaTester,
  AscBuild,
  AscBundleId,
  AscCustomerReview,
  AscInfoLoc,
  AscPhasedRelease,
  AscReviewAttachment,
  AscReviewDetail,
  AscReviewSubmission,
  AscScreenshot,
  AscScreenshotSet,
  AscSubscriptionGroup,
  AscUploadOperation,
  AscVersion,
  AscVersionLoc,
  InfoLocAttrs,
  SalesRow,
  SubscriptionEventRow,
  VersionInfoAttrs,
  VersionLocAttrs,
} from './types';

/** A mock build carries its marketing (pre-release) version so listBuilds can filter like Apple. */
type MockBuild = AscBuild & { preReleaseVersion: string };

/** Deterministic per-date pseudo-random sales so the finance dashboard is testable offline. */
function mockSales(date: string): SalesRow[] {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
  const rand = (min: number, max: number, salt: number) => {
    const x = Math.abs(Math.sin(h + salt) * 10000) % 1;
    return Math.floor(min + x * (max - min));
  };
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const weekend = dow === 0 || dow === 6 ? 1.35 : 1;
  // IAP/subscription rows carry their own (non-app) Apple ID and reference the
  // parent app only via Parent Identifier (= parent SKU) — exactly like Apple's reports.
  return [
    { appleId: 'mock-app-bloom', sku: 'BLOOM1', title: 'Bloom — Plant Care', productType: '1', units: Math.round(rand(60, 160, 1) * weekend), proceedsPerUnit: 0, currency: 'USD', country: 'US' },
    { appleId: '9900000001', sku: 'BLOOM1.PRO', title: 'Bloom Pro (Yearly)', productType: 'IAY', units: Math.round(rand(6, 22, 2) * weekend), proceedsPerUnit: 13.99, currency: 'USD', country: 'US', parentIdentifier: 'BLOOM1' },
    { appleId: '9900000001', sku: 'BLOOM1.PRO', title: 'Bloom Pro (Yearly)', productType: 'IAY', units: rand(2, 9, 3), proceedsPerUnit: 12.6, currency: 'EUR', country: 'DE', parentIdentifier: 'BLOOM1' },
    { appleId: 'mock-app-bloom', sku: 'BLOOM1', title: 'Bloom — Plant Care', productType: '7', units: rand(120, 400, 4), proceedsPerUnit: 0, currency: 'USD', country: 'GB' },
    { appleId: 'mock-app-fittrack', sku: 'FIT1', title: 'FitTrack Pro', productType: '1', units: Math.round(rand(25, 90, 5) * weekend), proceedsPerUnit: 0, currency: 'USD', country: 'US' },
    { appleId: '9900000002', sku: 'FIT1.SUB', title: 'FitTrack Monthly', productType: 'IA9', units: rand(4, 18, 6), proceedsPerUnit: 3.49, currency: 'USD', country: 'US', parentIdentifier: 'FIT1' },
    { appleId: '9900000002', sku: 'FIT1.SUB', title: 'FitTrack Monthly', productType: 'IA9', units: rand(1, 7, 7), proceedsPerUnit: 2.94, currency: 'GBP', country: 'GB', parentIdentifier: 'FIT1' },
  ];
}

/** Deterministic per-date subscription events for the two mock apps that have subs. */
function mockSubscriptionEvents(date: string): SubscriptionEventRow[] {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
  const rand = (min: number, max: number, salt: number) => {
    const x = Math.abs(Math.sin(h + salt) * 10000) % 1;
    return Math.floor(min + x * (max - min));
  };
  return [
    // Bloom (yearly sub) — trials, paid activations, a few cancellations.
    { event: 'Subscribe', appAppleId: 'mock-app-bloom', offerType: 'Free Trial', quantity: rand(8, 30, 11) },
    { event: 'Subscribe', appAppleId: 'mock-app-bloom', offerType: '', quantity: rand(3, 12, 12) },
    { event: 'Cancel', appAppleId: 'mock-app-bloom', offerType: '', quantity: rand(1, 6, 13) },
    // FitTrack (monthly sub).
    { event: 'Subscribe', appAppleId: 'mock-app-fittrack', offerType: 'Free Trial', quantity: rand(5, 18, 14) },
    { event: 'Subscribe', appAppleId: 'mock-app-fittrack', offerType: 'Pay As You Go', quantity: rand(2, 9, 15) },
    { event: 'Cancel', appAppleId: 'mock-app-fittrack', offerType: '', quantity: rand(0, 4, 16) },
  ];
}

/**
 * Fixture-backed, mutable, in-memory App Store Connect. Behaves like the real thing
 * closely enough to drive every UI flow offline: editability enforcement, add/remove
 * locales, screenshot upload lifecycle (AWAITING_UPLOAD → UPLOAD_COMPLETE → COMPLETE).
 * State resets when the functions emulator restarts.
 */

interface MockState {
  apps: AscApp[];
  appInfos: Map<string, AscAppInfo[]>; // appId -> infos
  infoLocs: Map<string, AscInfoLoc[]>; // appInfoId -> locs
  versions: Map<string, AscVersion[]>; // appId -> versions
  versionLocs: Map<string, AscVersionLoc[]>; // versionId -> locs
  sets: Map<string, AscScreenshotSet[]>; // versionLocId -> sets
  screenshots: Map<string, AscScreenshot[]>; // setId -> shots (ordered)
  builds: Map<string, MockBuild[]>; // appId -> builds
  versionBuild: Map<string, string | null>; // versionId -> attached buildId
  reviewDetails: Map<string, AscReviewDetail>; // versionId -> detail
  attachments: Map<string, AscReviewAttachment[]>; // reviewDetailId -> attachments
  phased: Map<string, AscPhasedRelease>; // versionId -> phased release
  submissions: Map<string, AscReviewSubmission[]>; // appId -> submissions
  submissionItems: Map<string, string>; // submissionId -> versionId
  ageRatings: Map<string, Record<string, unknown>>; // declarationId -> attributes
  infoToAgeRating: Map<string, string>; // appInfoId -> declarationId
  customerReviews: Map<string, AscCustomerReview[]>; // appId -> reviews
  betaTesters: Map<string, AscBetaTester[]>; // betaGroupId -> testers
  subGroups: Map<string, AscSubscriptionGroup[]>; // appId -> subscription groups
  subLocalized: Set<string>; // subscriptionIds with at least one localization
  bundleIds: AscBundleId[]; // registered App IDs (provisioning)
  prices: Map<string, { customerPrice: string; proceeds: string }>; // appId -> base price
  seq: number;
}

const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'METADATA_REJECTED', 'DEVELOPER_REJECTED', 'REJECTED', 'INVALID_BINARY']);

const states = new Map<string, MockState>();

function id(st: MockState, prefix: string): string {
  st.seq += 1;
  return `mock-${prefix}-${st.seq}`;
}

function thumb(seed: string): string {
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/{w}/{h}`;
}

function vLoc(st: MockState, locale: string, over: Partial<AscVersionLoc> = {}): AscVersionLoc {
  return {
    id: id(st, 'vloc'),
    locale,
    description: `Bloom helps you keep every plant thriving. Smart watering reminders, light tracking and a plant library — in ${locale}.`,
    keywords: 'plants,garden,watering,reminder,care',
    promotionalText: 'New: seasonal care tips are here!',
    whatsNew: 'Bug fixes and a fresh coat of paint.',
    supportUrl: 'https://example.com/support',
    marketingUrl: 'https://example.com',
    ...over,
  };
}

function iLoc(st: MockState, locale: string, name: string, subtitle: string): AscInfoLoc {
  return { id: id(st, 'iloc'), locale, name, subtitle, privacyPolicyUrl: 'https://example.com/privacy', privacyChoicesUrl: '' };
}

function shot(st: MockState, fileName: string, seed: string, w = 1290, h = 2796): AscScreenshot {
  return {
    id: id(st, 'shot'),
    fileName,
    fileSize: 480_000,
    assetState: 'COMPLETE',
    templateUrl: thumb(seed),
    width: w,
    height: h,
  };
}

function bld(st: MockState, version: string, preReleaseVersion: string, processingState = 'VALID'): MockBuild {
  return {
    id: id(st, 'build'),
    version,
    preReleaseVersion,
    uploadedDate: '2026-07-12T10:30:00Z',
    processingState,
    expired: false,
    usesNonExemptEncryption: false,
  };
}

function stripBuild(b: MockBuild): AscBuild {
  const { preReleaseVersion: _pre, ...rest } = b;
  return { ...rest };
}

function buildFixtures(): MockState {
  const st: MockState = {
    apps: [],
    appInfos: new Map(),
    infoLocs: new Map(),
    versions: new Map(),
    versionLocs: new Map(),
    sets: new Map(),
    screenshots: new Map(),
    builds: new Map(),
    versionBuild: new Map(),
    reviewDetails: new Map(),
    attachments: new Map(),
    phased: new Map(),
    submissions: new Map(),
    submissionItems: new Map(),
    ageRatings: new Map(),
    infoToAgeRating: new Map(),
    customerReviews: new Map(),
    betaTesters: new Map(),
    subGroups: new Map(),
    subLocalized: new Set(),
    bundleIds: [],
    prices: new Map(),
    seq: 0,
  };

  // ---- App 1: Bloom (live + editable draft version) ----
  const bloom: AscApp = { id: 'mock-app-bloom', bundleId: 'com.example.bloom', name: 'Bloom — Plant Care', sku: 'BLOOM1', primaryLocale: 'en-US' };
  st.apps.push(bloom);

  const bloomInfoLive: AscAppInfo = { id: id(st, 'info'), state: 'READY_FOR_SALE' };
  const bloomInfoEditable: AscAppInfo = { id: id(st, 'info'), state: 'PREPARE_FOR_SUBMISSION' };
  st.appInfos.set(bloom.id, [bloomInfoLive, bloomInfoEditable]);
  st.infoLocs.set(bloomInfoLive.id, [
    iLoc(st, 'en-US', 'Bloom — Plant Care', 'Watering, light & care'),
    iLoc(st, 'de-DE', 'Bloom — Pflanzenpflege', 'Gießen, Licht & Pflege'),
    iLoc(st, 'fr-FR', 'Bloom — Soin des plantes', 'Arrosage et lumière'),
    iLoc(st, 'ja', 'Bloom — 植物ケア', '水やりと日光の管理'),
    iLoc(st, 'es-ES', 'Bloom — Cuidado de plantas', 'Riego, luz y cuidados'),
  ]);
  st.infoLocs.set(bloomInfoEditable.id, [
    iLoc(st, 'en-US', 'Bloom — Plant Care', 'Watering, light & care'),
    iLoc(st, 'de-DE', 'Bloom — Pflanzenpflege', 'Gießen, Licht & Pflege'),
    iLoc(st, 'fr-FR', 'Bloom — Soin des plantes', 'Arrosage et lumière'),
    iLoc(st, 'ja', 'Bloom — 植物ケア', '水やりと日光の管理'),
    iLoc(st, 'es-ES', 'Bloom — Cuidado de plantas', 'Riego, luz y cuidados'),
  ]);

  const bloomLive: AscVersion = { id: id(st, 'ver'), platform: 'IOS', versionString: '2.3', state: 'READY_FOR_SALE', copyright: '2025 Example Botanicals', releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null };
  const bloomDraft: AscVersion = { id: id(st, 'ver'), platform: 'IOS', versionString: '2.4', state: 'PREPARE_FOR_SUBMISSION', copyright: '2026 Example Botanicals', releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null };
  // A Mac release too, so multi-platform UI (badges, editor tabs) is exercised in the emulator.
  const bloomMacLive: AscVersion = { id: id(st, 'ver'), platform: 'MAC_OS', versionString: '2.3', state: 'READY_FOR_SALE', copyright: '2025 Example Botanicals', releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null };
  st.versions.set(bloom.id, [bloomLive, bloomDraft, bloomMacLive]);

  // Builds: the live 2.3 has one attached; 2.4 offers two ready builds + one still processing.
  const bloomBuild40 = bld(st, '40', '2.3');
  const bloomBuild42 = bld(st, '42', '2.4');
  const bloomBuild41 = bld(st, '41', '2.4');
  const bloomBuild43 = bld(st, '43', '2.4', 'PROCESSING');
  st.builds.set(bloom.id, [bloomBuild43, bloomBuild42, bloomBuild41, bloomBuild40]);
  st.versionBuild.set(bloomLive.id, bloomBuild40.id);
  st.versionBuild.set(bloomDraft.id, null);

  st.versionLocs.set(bloomLive.id, [
    vLoc(st, 'en-US'),
    vLoc(st, 'de-DE', { description: 'Bloom hilft dir, jede Pflanze zum Gedeihen zu bringen. Intelligente Gieß-Erinnerungen und Lichtanalyse.', keywords: 'pflanzen,garten,gießen' }),
    vLoc(st, 'fr-FR', { description: 'Bloom aide vos plantes à prospérer. Rappels d’arrosage intelligents et suivi de la lumière.' }),
    vLoc(st, 'ja', { description: '植物を元気に育てるアプリ。水やりリマインダーと日照トラッキング。' }),
    vLoc(st, 'es-ES', { description: 'Bloom ayuda a que tus plantas prosperen. Recordatorios de riego inteligentes.' }),
  ]);
  const draftLocs = [
    vLoc(st, 'en-US', { whatsNew: 'Seasonal care tips, plant sharing, and performance improvements.' }),
    vLoc(st, 'de-DE', { whatsNew: 'Saisonale Pflegetipps und Verbesserungen.', description: 'Bloom hilft dir, jede Pflanze zum Gedeihen zu bringen. Intelligente Gieß-Erinnerungen und Lichtanalyse.' }),
    vLoc(st, 'fr-FR', { whatsNew: 'Conseils saisonniers et améliorations.' }),
    vLoc(st, 'ja', { whatsNew: '季節のケアヒントを追加しました。' }),
    vLoc(st, 'es-ES', { whatsNew: 'Consejos de temporada y mejoras.' }),
    vLoc(st, 'pt-BR', { description: 'O Bloom ajuda suas plantas a prosperar.', whatsNew: 'Dicas sazonais.' }), // no matching info loc → infoPending case
  ];
  st.versionLocs.set(bloomDraft.id, draftLocs);

  // Screenshots on the editable version (en-US + de-DE) and the live version (en-US)
  const enDraft = draftLocs[0]!;
  const deDraft = draftLocs[1]!;
  const s1: AscScreenshotSet = { id: id(st, 'set'), displayType: 'APP_IPHONE_69' };
  const s2: AscScreenshotSet = { id: id(st, 'set'), displayType: 'APP_IPHONE_67' };
  const s3: AscScreenshotSet = { id: id(st, 'set'), displayType: 'APP_IPAD_PRO_3GEN_129' };
  st.sets.set(enDraft.id, [s1, s2, s3]);
  st.screenshots.set(s1.id, [
    shot(st, 'home.png', 'bloom-home', 1320, 2868),
    shot(st, 'reminders.png', 'bloom-rem', 1320, 2868),
    shot(st, 'library.png', 'bloom-lib', 1320, 2868),
  ]);
  st.screenshots.set(s2.id, [shot(st, 'home-67.png', 'bloom-h67'), shot(st, 'stats-67.png', 'bloom-s67')]);
  st.screenshots.set(s3.id, [shot(st, 'ipad-1.png', 'bloom-ip1', 2064, 2752), shot(st, 'ipad-2.png', 'bloom-ip2', 2064, 2752)]);

  const deSet: AscScreenshotSet = { id: id(st, 'set'), displayType: 'APP_IPHONE_69' };
  st.sets.set(deDraft.id, [deSet]);
  st.screenshots.set(deSet.id, [shot(st, 'start-de.png', 'bloom-de1', 1320, 2868)]);

  const liveEn = st.versionLocs.get(bloomLive.id)![0]!;
  const liveSet: AscScreenshotSet = { id: id(st, 'set'), displayType: 'APP_IPHONE_69' };
  st.sets.set(liveEn.id, [liveSet]);
  st.screenshots.set(liveSet.id, [shot(st, 'live-home.png', 'bloom-lh', 1320, 2868), shot(st, 'live-lib.png', 'bloom-ll', 1320, 2868)]);

  // ---- App 2: FitTrack (live only — tests locks & create-version) ----
  const fit: AscApp = { id: 'mock-app-fittrack', bundleId: 'com.example.fittrack', name: 'FitTrack Pro', sku: 'FIT1', primaryLocale: 'en-US' };
  st.apps.push(fit);
  const fitInfo: AscAppInfo = { id: id(st, 'info'), state: 'READY_FOR_SALE' };
  st.appInfos.set(fit.id, [fitInfo]);
  st.infoLocs.set(fitInfo.id, [
    iLoc(st, 'en-US', 'FitTrack Pro', 'Workouts that stick'),
    iLoc(st, 'de-DE', 'FitTrack Pro', 'Training, das bleibt'),
    iLoc(st, 'zh-Hans', 'FitTrack Pro', '坚持锻炼'),
  ]);
  const fitLive: AscVersion = { id: id(st, 'ver'), platform: 'IOS', versionString: '1.8', state: 'READY_FOR_SALE', copyright: '2025 FitTrack Labs', releaseType: 'MANUAL', earliestReleaseDate: null };
  // 1.9 was rejected by App Review — exercises every "rejected" surface (badges,
  // submission items, dashboard bucket, resubmit flow) offline.
  const fitRejected: AscVersion = { id: id(st, 'ver'), platform: 'IOS', versionString: '1.9', state: 'REJECTED', copyright: '2026 FitTrack Labs', releaseType: 'MANUAL', earliestReleaseDate: null };
  st.versions.set(fit.id, [fitLive, fitRejected]);
  st.builds.set(fit.id, [bld(st, '112', '1.9'), bld(st, '108', '1.8')]);
  st.versionBuild.set(fitLive.id, st.builds.get(fit.id)![1]!.id);
  st.versionBuild.set(fitRejected.id, st.builds.get(fit.id)![0]!.id);
  const fitSubmission: AscReviewSubmission = { id: id(st, 'sub'), state: 'UNRESOLVED_ISSUES', platform: 'IOS', submittedDate: '2026-07-16T17:56:00Z' };
  st.submissions.set(fit.id, [fitSubmission]);
  st.submissionItems.set(fitSubmission.id, fitRejected.id);
  st.versionLocs.set(fitRejected.id, [
    vLoc(st, 'en-US', { whatsNew: 'Faster workout logging and new stretching plans.' }),
  ]);
  st.versionLocs.set(fitLive.id, [
    vLoc(st, 'en-US', { description: 'Strength, cardio and mobility plans that adapt to you.', keywords: 'fitness,workout,gym,training', promotionalText: 'Summer challenge is live — join now!' }),
    vLoc(st, 'de-DE', { description: 'Kraft-, Cardio- und Mobility-Pläne, die sich dir anpassen.', keywords: 'fitness,training,gym' }),
    vLoc(st, 'zh-Hans', { description: '力量、有氧和灵活性训练计划，随你而变。', keywords: '健身,锻炼,训练' }),
  ]);

  // FitTrack ships with an active phased release so the rollout controls are demoable.
  st.phased.set(fitLive.id, { id: id(st, 'phased'), state: 'ACTIVE', currentDayNumber: 3, startDate: '2026-07-15' });

  // Subscription groups live in mutable state so create/submit flows work offline.
  st.subGroups.set(bloom.id, [
    {
      id: 'mock-sg-1',
      name: 'Bloom Pro',
      subscriptions: [
        { id: 'mock-sub-1', name: 'Bloom Pro Monthly', productId: 'com.example.bloom.pro.monthly', state: 'APPROVED', period: 'ONE_MONTH' },
        { id: 'mock-sub-2', name: 'Bloom Pro Yearly', productId: 'com.example.bloom.pro.yearly', state: 'APPROVED', period: 'ONE_YEAR' },
      ],
    },
  ]);
  st.subGroups.set(fit.id, [
    {
      id: 'mock-sg-2',
      name: 'FitTrack Membership',
      subscriptions: [
        { id: 'mock-sub-3', name: 'FitTrack Monthly', productId: 'com.example.fittrack.monthly', state: 'APPROVED', period: 'ONE_MONTH' },
      ],
    },
  ]);

  // Registered App IDs (provisioning) — the fixtures' bundles plus one unused.
  st.bundleIds = [
    { id: id(st, 'bid'), identifier: 'com.example.bloom', name: 'Bloom', platform: 'UNIVERSAL', seedId: 'MOCKSEED01' },
    { id: id(st, 'bid'), identifier: 'com.example.fittrack', name: 'FitTrack', platform: 'IOS', seedId: 'MOCKSEED01' },
    { id: id(st, 'bid'), identifier: 'com.example.next.app', name: 'Next App (unused)', platform: 'IOS', seedId: 'MOCKSEED01' },
  ];

  // A few beta testers in each app's internal TestFlight group.
  for (const app of [bloom, fit]) {
    st.betaTesters.set(`mock-bg-int-${app.id}`, [
      { id: id(st, 'bt'), email: 'sana@example.com', firstName: 'Sana', lastName: 'Iqbal', inviteType: 'EMAIL' },
      { id: id(st, 'bt'), email: 'omar@example.com', firstName: 'Omar', lastName: 'Farooq', inviteType: 'EMAIL' },
    ]);
    st.betaTesters.set(`mock-bg-ext-${app.id}`, [
      { id: id(st, 'bt'), email: 'beta.fan@example.com', firstName: '', lastName: '', inviteType: 'PUBLIC_LINK' },
    ]);
  }

  // Default age-rating declarations for every appInfo (all NONE, no gambling / web access).
  const defaultAgeRating = (): Record<string, unknown> => ({
    violenceCartoonOrFantasy: 'NONE',
    violenceRealistic: 'NONE',
    violenceRealisticProlongedGraphicOrSadistic: 'NONE',
    profanityOrCrudeHumor: 'NONE',
    matureOrSuggestiveThemes: 'NONE',
    horrorOrFearThemes: 'NONE',
    medicalOrTreatmentInformation: 'NONE',
    alcoholTobaccoOrDrugUseOrReferences: 'NONE',
    sexualContentOrNudity: 'NONE',
    sexualContentGraphicAndNudity: 'NONE',
    gamblingSimulated: 'NONE',
    contests: 'NONE',
    gambling: false,
    unrestrictedWebAccess: false,
    kidsAgeBand: null,
  });
  for (const infos of st.appInfos.values()) {
    for (const info of infos) {
      const declId = id(st, 'ar');
      st.infoToAgeRating.set(info.id, declId);
      st.ageRatings.set(declId, defaultAgeRating());
    }
  }

  // Customer reviews — bloom gets a spread of ratings, one already answered.
  st.customerReviews.set(bloom.id, [
    {
      id: id(st, 'rev'),
      rating: 5,
      title: 'My plants have never been happier',
      body: 'The watering reminders are spot on and the plant library is huge. Worth every penny for Pro.',
      reviewerNickname: 'GreenThumbGemma',
      createdDate: '2026-07-14T08:12:00Z',
      territory: 'USA',
      response: null,
    },
    {
      id: id(st, 'rev'),
      rating: 4,
      title: 'Great app, needs widgets',
      body: 'Love the reminders. A home-screen widget showing today’s watering queue would make it perfect.',
      reviewerNickname: 'ficus_fan',
      createdDate: '2026-07-11T17:40:00Z',
      territory: 'GBR',
      response: {
        id: id(st, 'resp'),
        body: 'Thanks! Widgets are on the roadmap for the next release — stay tuned.',
        lastModified: '2026-07-12T09:00:00Z',
        state: 'PUBLISHED',
      },
    },
    {
      id: id(st, 'rev'),
      rating: 2,
      title: 'Sync ate my plant list',
      body: 'After the last update my plant list disappeared on my iPad. Restoring from backup brought it back, but please fix.',
      reviewerNickname: 'MonsteraMike',
      createdDate: '2026-07-09T21:03:00Z',
      territory: 'DEU',
      response: null,
    },
  ]);
  st.customerReviews.set(fit.id, [
    {
      id: id(st, 'rev'),
      rating: 5,
      title: 'Best training plans',
      body: 'The adaptive plans keep me consistent. Summer challenge is a blast.',
      reviewerNickname: 'IronRunner',
      createdDate: '2026-07-13T06:30:00Z',
      territory: 'USA',
      response: null,
    },
  ]);

  return st;
}

function stateFor(storeId: string): MockState {
  let st = states.get(storeId);
  if (!st) {
    st = buildFixtures();
    states.set(storeId, st);
  }
  return st;
}

function findVersionOfLoc(st: MockState, locId: string): AscVersion | null {
  for (const [verId, locs] of st.versionLocs) {
    if (locs.some((l) => l.id === locId)) {
      for (const vers of st.versions.values()) {
        const v = vers.find((x) => x.id === verId);
        if (v) return v;
      }
    }
  }
  return null;
}

function stateError(): AppError {
  return new AppError('failed-precondition', 'This version is no longer editable — its state changed in App Store Connect. Re-sync to see the current state.', { stateError: true });
}

export function getMockAsc(storeId: string): AscApi {
  const st = stateFor(storeId);

  const api: AscApi = {
    async fetchDailySales(_vendorNumber, date) {
      // Reports "exist" only for the past year, like Apple's.
      const d = new Date(date + 'T00:00:00Z').getTime();
      if (Number.isNaN(d) || d > Date.now() - 12 * 3600 * 1000) return null;
      return mockSales(date);
    },
    async fetchDailySubscriptionEvents(_vendorNumber, date) {
      const d = new Date(date + 'T00:00:00Z').getTime();
      if (Number.isNaN(d) || d > Date.now() - 12 * 3600 * 1000) return null;
      return mockSubscriptionEvents(date);
    },
    async verify() {
      return { appsCount: st.apps.length };
    },
    async listApps() {
      // Same platform union + included versions the real client derives.
      return st.apps.map((a) => ({
        ...a,
        platforms: [...new Set((st.versions.get(a.id) ?? []).map((v) => v.platform))],
        versionsIncluded: (st.versions.get(a.id) ?? []).map((v) => ({ ...v })),
      }));
    },
    async listAppInfos(appId) {
      return [...(st.appInfos.get(appId) ?? [])];
    },
    async listAppInfoLocalizations(appInfoId) {
      return [...(st.infoLocs.get(appInfoId) ?? [])];
    },
    async listVersions(appId) {
      return [...(st.versions.get(appId) ?? [])];
    },
    async listVersionLocalizations(versionId) {
      return [...(st.versionLocs.get(versionId) ?? [])];
    },

    async createAppInfoLocalization(appInfoId, locale, attrs) {
      const info = [...st.appInfos.values()].flat().find((i) => i.id === appInfoId);
      if (!info || !EDITABLE.has(info.state)) throw stateError();
      const locs = st.infoLocs.get(appInfoId) ?? [];
      if (locs.some((l) => l.locale === locale)) {
        throw new AppError('invalid-argument', `The ${locale} localization already exists.`);
      }
      const loc: AscInfoLoc = {
        id: id(st, 'iloc'),
        locale,
        name: attrs.name ?? '',
        subtitle: attrs.subtitle ?? '',
        privacyPolicyUrl: attrs.privacyPolicyUrl ?? '',
        privacyChoicesUrl: attrs.privacyChoicesUrl ?? '',
      };
      locs.push(loc);
      st.infoLocs.set(appInfoId, locs);
      return { ...loc };
    },
    async updateAppInfoLocalization(locId, attrs) {
      for (const [infoId, locs] of st.infoLocs) {
        const loc = locs.find((l) => l.id === locId);
        if (loc) {
          const info = [...st.appInfos.values()].flat().find((i) => i.id === infoId);
          if (!info || !EDITABLE.has(info.state)) throw stateError();
          Object.assign(loc, attrs);
          return { ...loc };
        }
      }
      throw new AppError('not-found', 'Localization not found.');
    },
    async deleteAppInfoLocalization(locId) {
      for (const [infoId, locs] of st.infoLocs) {
        if (locs.some((l) => l.id === locId)) {
          st.infoLocs.set(infoId, locs.filter((l) => l.id !== locId));
          return;
        }
      }
    },

    async createVersionLocalization(versionId, locale, attrs) {
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      if (!version || !EDITABLE.has(version.state)) throw stateError();
      const locs = st.versionLocs.get(versionId) ?? [];
      if (locs.some((l) => l.locale === locale)) {
        throw new AppError('invalid-argument', `The ${locale} localization already exists.`);
      }
      const loc: AscVersionLoc = {
        id: id(st, 'vloc'),
        locale,
        description: attrs.description ?? '',
        keywords: attrs.keywords ?? '',
        promotionalText: attrs.promotionalText ?? '',
        whatsNew: attrs.whatsNew ?? '',
        supportUrl: attrs.supportUrl ?? '',
        marketingUrl: attrs.marketingUrl ?? '',
      };
      locs.push(loc);
      st.versionLocs.set(versionId, locs);
      return { ...loc };
    },
    async updateVersionLocalization(locId, attrs) {
      for (const [, locs] of st.versionLocs) {
        const loc = locs.find((l) => l.id === locId);
        if (loc) {
          const version = findVersionOfLoc(st, locId);
          const isPromoOnly = Object.keys(attrs).every((k) => k === 'promotionalText');
          if (!version) throw new AppError('not-found', 'Version not found.');
          if (!EDITABLE.has(version.state) && !(isPromoOnly && version.state === 'READY_FOR_SALE')) {
            throw stateError();
          }
          Object.assign(loc, attrs);
          return { ...loc };
        }
      }
      throw new AppError('not-found', 'Localization not found.');
    },
    async deleteVersionLocalization(locId) {
      for (const [verId, locs] of st.versionLocs) {
        if (locs.some((l) => l.id === locId)) {
          st.versionLocs.set(verId, locs.filter((l) => l.id !== locId));
          return;
        }
      }
    },

    async createVersion(appId, platform, versionString) {
      const versions = st.versions.get(appId) ?? [];
      if (versions.some((v) => v.versionString === versionString && v.platform === platform)) {
        throw new AppError('invalid-argument', `Version ${versionString} already exists.`);
      }
      if (versions.some((v) => EDITABLE.has(v.state) && v.platform === platform)) {
        throw new AppError('invalid-argument', 'An editable version already exists.');
      }
      const created: AscVersion = { id: id(st, 'ver'), platform, versionString, state: 'PREPARE_FOR_SUBMISSION', copyright: '', releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null };
      versions.push(created);
      st.versions.set(appId, versions);
      st.versionBuild.set(created.id, null);
      // ASC copies localizations from the latest live version.
      const live = versions.find((v) => v.state === 'READY_FOR_SALE');
      const copied = (live ? st.versionLocs.get(live.id) ?? [] : []).map((l) => ({
        ...l,
        id: id(st, 'vloc'),
        whatsNew: '',
      }));
      st.versionLocs.set(created.id, copied);
      // Flip the appInfo to an editable one if none exists.
      const infos = st.appInfos.get(appId) ?? [];
      if (!infos.some((i) => EDITABLE.has(i.state))) {
        const liveInfo = infos[0];
        const editableInfo: AscAppInfo = { id: id(st, 'info'), state: 'PREPARE_FOR_SUBMISSION' };
        infos.push(editableInfo);
        st.appInfos.set(appId, infos);
        const src = liveInfo ? st.infoLocs.get(liveInfo.id) ?? [] : [];
        st.infoLocs.set(editableInfo.id, src.map((l) => ({ ...l, id: id(st, 'iloc') })));
      }
      return { ...created };
    },
    async updateVersion(versionId, versionString) {
      for (const versions of st.versions.values()) {
        const version = versions.find((v) => v.id === versionId);
        if (!version) continue;
        if (!EDITABLE.has(version.state)) {
          throw new AppError('failed-precondition', 'Only an editable version can be changed.');
        }
        version.versionString = versionString;
        return { ...version };
      }
      throw new AppError('not-found', 'Version not found.');
    },
    async getVersionState(versionId) {
      const v = [...st.versions.values()].flat().find((x) => x.id === versionId);
      if (!v) throw new AppError('not-found', 'Version not found.');
      return v.state;
    },
    async getAppInfoState(appInfoId) {
      const i = [...st.appInfos.values()].flat().find((x) => x.id === appInfoId);
      if (!i) throw new AppError('not-found', 'App info not found.');
      return i.state;
    },

    async updateVersionInfo(versionId, attrs) {
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      if (!version) throw new AppError('not-found', 'Version not found.');
      if (!EDITABLE.has(version.state)) throw stateError();
      if (attrs.copyright !== undefined) version.copyright = attrs.copyright;
      if (attrs.releaseType !== undefined) version.releaseType = attrs.releaseType;
      if (attrs.earliestReleaseDate !== undefined) version.earliestReleaseDate = attrs.earliestReleaseDate;
      return { ...version };
    },
    async getVersionBuild(versionId) {
      const buildId = st.versionBuild.get(versionId) ?? null;
      if (!buildId) return null;
      const build = [...st.builds.values()].flat().find((b) => b.id === buildId);
      return build ? stripBuild(build) : null;
    },
    async selectBuild(versionId, buildId) {
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      if (!version) throw new AppError('not-found', 'Version not found.');
      if (!EDITABLE.has(version.state)) throw stateError();
      if (buildId) {
        const build = [...st.builds.values()].flat().find((b) => b.id === buildId);
        if (!build) throw new AppError('not-found', 'Build not found.');
        if (build.processingState !== 'VALID' || build.expired) {
          throw new AppError('invalid-argument', 'That build isn’t ready to attach yet.');
        }
        if (build.preReleaseVersion !== version.versionString) {
          throw new AppError('invalid-argument', `Build ${build.version} doesn’t match version ${version.versionString}.`);
        }
      }
      st.versionBuild.set(versionId, buildId);
    },
    async listBuilds(appId, versionString) {
      return (st.builds.get(appId) ?? [])
        .filter((b) => b.preReleaseVersion === versionString)
        .map(stripBuild);
    },
    async listRecentBuilds(appId, limit = 10) {
      return (st.builds.get(appId) ?? []).slice(0, limit).map(stripBuild);
    },

    // ---- App Review details & attachments ----

    async getReviewDetail(versionId) {
      const d = st.reviewDetails.get(versionId);
      return d ? { ...d } : null;
    },
    async createReviewDetail(versionId, attrs) {
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      if (!version) throw new AppError('not-found', 'Version not found.');
      if (!EDITABLE.has(version.state)) throw stateError();
      if (st.reviewDetails.has(versionId)) {
        throw new AppError('invalid-argument', 'Review details already exist for this version.');
      }
      const detail: AscReviewDetail = {
        id: id(st, 'rd'),
        contactFirstName: attrs.contactFirstName ?? '',
        contactLastName: attrs.contactLastName ?? '',
        contactPhone: attrs.contactPhone ?? '',
        contactEmail: attrs.contactEmail ?? '',
        demoAccountName: attrs.demoAccountName ?? '',
        demoAccountPassword: attrs.demoAccountPassword ?? '',
        demoAccountRequired: attrs.demoAccountRequired ?? false,
        notes: attrs.notes ?? '',
      };
      st.reviewDetails.set(versionId, detail);
      st.attachments.set(detail.id, []);
      return { ...detail };
    },
    async updateReviewDetail(detailId, attrs) {
      for (const [versionId, detail] of st.reviewDetails) {
        if (detail.id !== detailId) continue;
        const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
        if (!version || !EDITABLE.has(version.state)) throw stateError();
        Object.assign(detail, attrs);
        return { ...detail };
      }
      throw new AppError('not-found', 'Review details not found.');
    },
    async listReviewAttachments(reviewDetailId) {
      return (st.attachments.get(reviewDetailId) ?? []).map((a) => ({ ...a }));
    },
    async reserveReviewAttachment(reviewDetailId, fileName, fileSize) {
      const list = st.attachments.get(reviewDetailId);
      if (!list) throw new AppError('not-found', 'Review details not found.');
      const created: AscReviewAttachment = {
        id: id(st, 'att'),
        fileName,
        fileSize,
        assetState: 'AWAITING_UPLOAD',
        uploadOperations: [
          { method: 'PUT', url: 'https://mock-upload.invalid/att1', offset: 0, length: fileSize, requestHeaders: [] },
        ],
      };
      list.push(created);
      return { ...created };
    },
    async commitReviewAttachment(attachmentId, _md5) {
      for (const list of st.attachments.values()) {
        const att = list.find((a) => a.id === attachmentId);
        if (att) {
          att.assetState = 'COMPLETE';
          return { ...att };
        }
      }
      throw new AppError('not-found', 'Attachment not found.');
    },
    async deleteReviewAttachment(attachmentId) {
      for (const [detailId, list] of st.attachments) {
        if (list.some((a) => a.id === attachmentId)) {
          st.attachments.set(detailId, list.filter((a) => a.id !== attachmentId));
          return;
        }
      }
    },

    // ---- Phased release & review submission ----

    async getPhasedRelease(versionId) {
      const p = st.phased.get(versionId);
      return p ? { ...p } : null;
    },
    async createPhasedRelease(versionId) {
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      if (!version) throw new AppError('not-found', 'Version not found.');
      if (st.phased.has(versionId)) {
        throw new AppError('invalid-argument', 'A phased release already exists for this version.');
      }
      const created: AscPhasedRelease = { id: id(st, 'phased'), state: 'INACTIVE', currentDayNumber: null, startDate: null };
      st.phased.set(versionId, created);
      return { ...created };
    },
    async updatePhasedRelease(phasedId, state) {
      for (const p of st.phased.values()) {
        if (p.id !== phasedId) continue;
        p.state = state;
        if (state === 'ACTIVE' && p.currentDayNumber === null) p.currentDayNumber = 1;
        if (state === 'COMPLETE') p.currentDayNumber = 7;
        return { ...p };
      }
      throw new AppError('not-found', 'Phased release not found.');
    },
    async deletePhasedRelease(phasedId) {
      for (const [versionId, p] of st.phased) {
        if (p.id === phasedId) {
          st.phased.delete(versionId);
          return;
        }
      }
    },
    async listReviewSubmissions(appId, platform) {
      return (st.submissions.get(appId) ?? []).filter((sub) => sub.platform === platform).map((sub) => ({ ...sub }));
    },
    async createReviewSubmission(appId, platform) {
      const list = st.submissions.get(appId) ?? [];
      const OPEN = new Set(['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES']);
      if (list.some((sub) => OPEN.has(sub.state))) {
        throw new AppError('invalid-argument', 'An active review submission already exists.');
      }
      const created: AscReviewSubmission = { id: id(st, 'sub'), state: 'READY_FOR_REVIEW', platform, submittedDate: null };
      list.push(created);
      st.submissions.set(appId, list);
      return { ...created };
    },
    async addReviewSubmissionItem(submissionId, versionId) {
      st.submissionItems.set(submissionId, versionId);
    },
    async submitReviewSubmission(submissionId) {
      for (const list of st.submissions.values()) {
        const sub = list.find((x) => x.id === submissionId);
        if (!sub) continue;
        sub.state = 'WAITING_FOR_REVIEW';
        sub.submittedDate = new Date().toISOString();
        const versionId = st.submissionItems.get(submissionId);
        const version = versionId ? [...st.versions.values()].flat().find((v) => v.id === versionId) : null;
        if (version) version.state = 'WAITING_FOR_REVIEW';
        return { ...sub };
      }
      throw new AppError('not-found', 'Submission not found.');
    },
    async cancelReviewSubmission(submissionId) {
      for (const [appId, list] of st.submissions) {
        const sub = list.find((x) => x.id === submissionId);
        if (!sub) continue;
        st.submissions.set(appId, list.filter((x) => x.id !== submissionId));
        const versionId = st.submissionItems.get(submissionId);
        const version = versionId ? [...st.versions.values()].flat().find((v) => v.id === versionId) : null;
        if (version && version.state === 'WAITING_FOR_REVIEW') version.state = 'PREPARE_FOR_SUBMISSION';
        st.submissionItems.delete(submissionId);
        return { ...sub, state: 'COMPLETE' };
      }
      throw new AppError('not-found', 'Submission not found.');
    },
    async listReviewSubmissionItems(submissionId) {
      const versionId = st.submissionItems.get(submissionId);
      if (!versionId) return [];
      const submission = [...st.submissions.values()].flat().find((x) => x.id === submissionId);
      const version = [...st.versions.values()].flat().find((v) => v.id === versionId);
      const itemState =
        submission?.state === 'UNRESOLVED_ISSUES' ? 'REJECTED'
        : submission?.state === 'COMPLETE' ? 'ACCEPTED'
        : 'READY_FOR_REVIEW';
      return [{ id: `${submissionId}-item`, state: itemState, itemType: 'appStoreVersions', versionString: version?.versionString ?? null }];
    },

    // ---- Age rating ----

    async getAgeRatingDeclaration(appInfoId) {
      const declId = st.infoToAgeRating.get(appInfoId);
      if (!declId) return null;
      return { id: declId, attributes: { ...(st.ageRatings.get(declId) ?? {}) } };
    },
    async updateAgeRatingDeclaration(declId, attributes) {
      const current = st.ageRatings.get(declId);
      if (!current) throw new AppError('not-found', 'Age rating declaration not found.');
      Object.assign(current, attributes);
      return { id: declId, attributes: { ...current } };
    },

    // ---- Customer reviews ----

    async listCustomerReviews(appId, limit = 50) {
      return (st.customerReviews.get(appId) ?? []).slice(0, limit).map((r) => ({ ...r, response: r.response ? { ...r.response } : null }));
    },
    async respondToReview(reviewId, body) {
      for (const reviews of st.customerReviews.values()) {
        const review = reviews.find((r) => r.id === reviewId);
        if (review) {
          review.response = {
            id: review.response?.id ?? id(st, 'resp'),
            body,
            lastModified: new Date().toISOString(),
            state: 'PENDING_PUBLISH',
          };
          return;
        }
      }
      throw new AppError('not-found', 'Review not found.');
    },
    async deleteReviewResponse(responseId) {
      for (const reviews of st.customerReviews.values()) {
        for (const review of reviews) {
          if (review.response?.id === responseId) {
            review.response = null;
            return;
          }
        }
      }
    },

    // ---- Commerce & distribution summaries (static fixtures) ----

    async getAvailabilitySummary(appId) {
      return appId === 'mock-app-bloom'
        ? { availableInNewTerritories: true, availableTerritories: 175, totalTerritories: 175 }
        : { availableInNewTerritories: false, availableTerritories: 98, totalTerritories: 175 };
    },
    async getPriceSummary(appId) {
      const set = st.prices.get(appId);
      if (set) return { baseTerritory: 'USA', ...set };
      return appId === 'mock-app-bloom'
        ? { baseTerritory: 'USA', customerPrice: '0.00', proceeds: '0.00' }
        : { baseTerritory: 'USA', customerPrice: '4.99', proceeds: '3.49' };
    },
    async listPricePoints() {
      const tiers = ['0.00', '0.99', '1.99', '2.99', '4.99', '6.99', '9.99', '14.99', '19.99', '29.99'];
      return tiers.map((price, i) => ({
        id: `mock-pp-${i}`,
        customerPrice: price,
        proceeds: (Number(price) * 0.7).toFixed(2),
      }));
    },
    async setPriceSchedule(appId, pricePointId) {
      const i = Number(pricePointId.replace('mock-pp-', ''));
      const tiers = ['0.00', '0.99', '1.99', '2.99', '4.99', '6.99', '9.99', '14.99', '19.99', '29.99'];
      const price = tiers[i];
      if (price === undefined) throw new AppError('not-found', 'Price point not found.');
      st.prices.set(appId, { customerPrice: price, proceeds: (Number(price) * 0.7).toFixed(2) });
    },
    async listInAppPurchases(appId) {
      if (appId !== 'mock-app-bloom') return [];
      return [
        { id: 'mock-iap-1', name: 'Seed Pack (Large)', productId: 'com.example.bloom.seeds.large', type: 'CONSUMABLE', state: 'APPROVED' },
        { id: 'mock-iap-2', name: 'Rare Plant Guide', productId: 'com.example.bloom.guide', type: 'NON_CONSUMABLE', state: 'APPROVED' },
      ];
    },
    async listSubscriptionGroups(appId) {
      return (st.subGroups.get(appId) ?? []).map((g) => ({ ...g, subscriptions: g.subscriptions.map((sub) => ({ ...sub })) }));
    },
    async listBundleIds() {
      return st.bundleIds.map((b) => ({ ...b }));
    },
    async createBundleId(identifier, name, platform) {
      if (st.bundleIds.some((b) => b.identifier.toLowerCase() === identifier.toLowerCase())) {
        throw new AppError('invalid-argument', 'That bundle ID is already registered.');
      }
      const created: AscBundleId = { id: id(st, 'bid'), identifier, name, platform, seedId: 'MOCKSEED01' };
      st.bundleIds.push(created);
      return { ...created };
    },
    async deleteBundleId(bundleIdId) {
      const target = st.bundleIds.find((b) => b.id === bundleIdId);
      if (!target) throw new AppError('not-found', 'Bundle ID not found.');
      if (st.apps.some((a) => a.bundleId === target.identifier)) {
        throw new AppError('invalid-argument', 'That bundle ID is in use by an app and can\u2019t be deleted.');
      }
      st.bundleIds = st.bundleIds.filter((b) => b.id !== bundleIdId);
    },
    async createSubscriptionGroup(appId, referenceName) {
      const groups = st.subGroups.get(appId) ?? [];
      if (groups.some((g) => g.name.toLowerCase() === referenceName.toLowerCase())) {
        throw new AppError('invalid-argument', 'A subscription group with that reference name already exists.');
      }
      const created = { id: id(st, 'sg'), name: referenceName, subscriptions: [] };
      groups.push(created);
      st.subGroups.set(appId, groups);
      return { id: created.id, name: created.name };
    },
    async createSubscription(groupId, attrs) {
      for (const groups of st.subGroups.values()) {
        const group = groups.find((g) => g.id === groupId);
        if (!group) continue;
        const allSubs = [...st.subGroups.values()].flat().flatMap((g) => g.subscriptions);
        if (allSubs.some((sub) => sub.productId === attrs.productId)) {
          throw new AppError('invalid-argument', 'That product ID is already in use.');
        }
        const created = { id: id(st, 'ns'), name: attrs.name, productId: attrs.productId, state: 'MISSING_METADATA', period: attrs.period };
        group.subscriptions.push(created);
        return { ...created };
      }
      throw new AppError('not-found', 'Subscription group not found.');
    },
    async createSubscriptionLocalization(subscriptionId) {
      st.subLocalized.add(subscriptionId);
    },
    async submitSubscription(subscriptionId) {
      for (const groups of st.subGroups.values()) {
        for (const group of groups) {
          const sub = group.subscriptions.find((x) => x.id === subscriptionId);
          if (!sub) continue;
          if (sub.state === 'WAITING_FOR_REVIEW' || sub.state === 'IN_REVIEW') {
            throw new AppError('invalid-argument', 'This subscription is already in review.');
          }
          sub.state = 'WAITING_FOR_REVIEW';
          return;
        }
      }
      throw new AppError('not-found', 'Subscription not found.');
    },
    async getEulaText() {
      return null; // both fixture apps use Apple's standard EULA
    },
    async listCustomProductPages(appId) {
      if (appId !== 'mock-app-bloom') return [];
      return [{ id: 'mock-cpp-1', name: 'Holiday Campaign', visible: true }];
    },
    async listExperiments(appId) {
      if (appId !== 'mock-app-bloom') return [];
      return [{ id: 'mock-exp-1', name: 'Icon A/B — leaf vs pot', state: 'IN_REVIEW', trafficProportion: 50 }];
    },
    async listAppEvents(appId) {
      if (appId !== 'mock-app-bloom') return [];
      return [{ id: 'mock-evt-1', name: 'Spring Repotting Challenge', state: 'PUBLISHED' }];
    },
    async listPreviewSets(versionLocId) {
      // Only bloom's primary draft localization ships with a preview in fixtures.
      const bloomDraftLocs = [...st.versionLocs.values()].flat().filter((l) => l.locale === 'en-US');
      const isKnownLoc = bloomDraftLocs.some((l) => l.id === versionLocId);
      if (!isKnownLoc) return [];
      return [{ id: 'mock-pvs-1', previewType: 'IPHONE_67', previewCount: 1 }];
    },
    async listBetaGroups(appId) {
      return [
        { id: `mock-bg-int-${appId}`, name: 'Internal Team', isInternal: true, publicLink: null },
        { id: `mock-bg-ext-${appId}`, name: 'Public Beta', isInternal: false, publicLink: 'https://testflight.apple.com/join/mockcode' },
      ];
    },
    async listBetaTesters(groupId) {
      return (st.betaTesters.get(groupId) ?? []).map((t) => ({ ...t }));
    },
    async createBetaTester(groupId, email, firstName, lastName) {
      const testers = st.betaTesters.get(groupId) ?? [];
      if (testers.some((t) => t.email.toLowerCase() === email.toLowerCase())) {
        throw new AppError('invalid-argument', 'That email is already a tester in this group.');
      }
      const created: AscBetaTester = { id: id(st, 'bt'), email, firstName: firstName ?? '', lastName: lastName ?? '', inviteType: 'EMAIL' };
      testers.push(created);
      st.betaTesters.set(groupId, testers);
      return { ...created };
    },
    async removeBetaTesterFromGroup(groupId, testerId) {
      const testers = st.betaTesters.get(groupId) ?? [];
      st.betaTesters.set(groupId, testers.filter((t) => t.id !== testerId));
    },
    async listEncryptionDeclarations() {
      return [{ id: 'mock-enc-1', state: 'COMPLETED', usesEncryption: false, createdDate: '2026-06-02T10:00:00Z' }];
    },

    async listScreenshotSets(versionLocId) {
      return [...(st.sets.get(versionLocId) ?? [])];
    },
    async listScreenshots(setId) {
      return (st.screenshots.get(setId) ?? []).map((x) => ({ ...x }));
    },
    async createScreenshotSet(versionLocId, displayType) {
      const sets = st.sets.get(versionLocId) ?? [];
      if (sets.some((x) => x.displayType === displayType)) {
        throw new AppError('invalid-argument', 'That device size already exists.');
      }
      const set: AscScreenshotSet = { id: id(st, 'set'), displayType };
      sets.push(set);
      st.sets.set(versionLocId, sets);
      st.screenshots.set(set.id, []);
      return { ...set };
    },
    async deleteScreenshotSet(setId) {
      for (const [locId, sets] of st.sets) {
        if (sets.some((x) => x.id === setId)) {
          st.sets.set(locId, sets.filter((x) => x.id !== setId));
          st.screenshots.delete(setId);
          return;
        }
      }
    },
    async reserveScreenshot(setId, fileName, fileSize) {
      const shots = st.screenshots.get(setId);
      if (!shots) throw new AppError('not-found', 'Screenshot set not found.');
      if (shots.length >= 10) throw new AppError('invalid-argument', 'A set holds at most 10 screenshots.');
      const created: AscScreenshot = {
        id: id(st, 'shot'),
        fileName,
        fileSize,
        assetState: 'AWAITING_UPLOAD',
        templateUrl: null,
        width: null,
        height: null,
        uploadOperations: [
          {
            method: 'PUT',
            url: 'https://mock-upload.invalid/part1',
            offset: 0,
            length: fileSize,
            requestHeaders: [],
          },
        ],
      };
      shots.push(created);
      return { ...created };
    },
    async uploadScreenshotParts() {
      // parts vanish into the void, successfully
    },
    async commitScreenshot(shotId, _md5) {
      for (const shots of st.screenshots.values()) {
        const shotRec = shots.find((x) => x.id === shotId);
        if (shotRec) {
          shotRec.assetState = 'UPLOAD_COMPLETE';
          // Simulate Apple's processing pipeline.
          setTimeout(() => {
            shotRec.assetState = 'COMPLETE';
            shotRec.templateUrl = thumb(shotRec.fileName + shotRec.id);
            shotRec.width = 1320;
            shotRec.height = 2868;
          }, 4000);
          return { ...shotRec };
        }
      }
      throw new AppError('not-found', 'Screenshot not found.');
    },
    async getScreenshot(shotId) {
      for (const shots of st.screenshots.values()) {
        const shotRec = shots.find((x) => x.id === shotId);
        if (shotRec) return { ...shotRec };
      }
      throw new AppError('not-found', 'Screenshot not found.');
    },
    async deleteScreenshot(shotId) {
      for (const [setId, shots] of st.screenshots) {
        if (shots.some((x) => x.id === shotId)) {
          st.screenshots.set(setId, shots.filter((x) => x.id !== shotId));
          return;
        }
      }
    },
    async reorderScreenshots(setId, orderedIds) {
      const shots = st.screenshots.get(setId) ?? [];
      const current = new Set(shots.map((x) => x.id));
      if (orderedIds.length !== shots.length || orderedIds.some((oid) => !current.has(oid))) {
        throw new AppError('failed-precondition', 'Screenshots changed since you loaded — refresh and try again.');
      }
      st.screenshots.set(
        setId,
        orderedIds.map((oid) => shots.find((x) => x.id === oid)!),
      );
    },
  };
  return api;
}
