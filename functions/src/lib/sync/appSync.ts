import { cleanBuildRef, isEditableState, isKnownLocale, sortLocales, type AppDoc, type LocaleDoc, type Platform, type ReleaseType, type VersionRef } from '@asm/shared';
import { Timestamp, chunkedBatch, refs } from '../firestore';
import { getAscApi } from '../asc/factory';
import type { AscBuild, AscInfoLoc, AscVersion, AscVersionLoc } from '../asc/types';

const DEEP_SYNC_SCHEMA_VERSION = 2;

function pickInfo(entries: Array<{ id: string; state: string }>) {
  const editable = entries.find((e) => isEditableState(e.state)) ?? null;
  const live = entries.find((e) => !isEditableState(e.state)) ?? null;
  return { editable, live };
}

const REVIEW_STATES = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'ACCEPTED',
]);

export function pickVersions(versions: AscVersion[]): Map<Platform, { editable: AscVersion | null; live: AscVersion | null; review: AscVersion | null }> {
  const byPlatform = new Map<Platform, AscVersion[]>();
  for (const v of versions) {
    const arr = byPlatform.get(v.platform) ?? [];
    arr.push(v);
    byPlatform.set(v.platform, arr);
  }
  const out = new Map<Platform, { editable: AscVersion | null; live: AscVersion | null; review: AscVersion | null }>();
  for (const [platform, list] of byPlatform) {
    const sorted = [...list].sort((a, b) => (b.createdDate ?? '').localeCompare(a.createdDate ?? ''));
    const editable = sorted.find((v) => isEditableState(v.state)) ?? null;
    const live =
      sorted.find((v) => v.state === 'READY_FOR_SALE' || v.state === 'READY_FOR_DISTRIBUTION') ?? null;
    const review = sorted.find((v) => REVIEW_STATES.has(v.state)) ?? null;
    out.set(platform, { editable, live, review });
  }
  return out;
}

const toRef = (v: AscVersion | null, build?: AscBuild | null): VersionRef | null => {
  if (!v) return null;
  // Firestore rejects explicit `undefined`, so only set optional keys when present.
  const ref: VersionRef = {
    id: v.id,
    versionString: v.versionString,
    state: v.state,
    copyright: v.copyright ?? '',
    earliestReleaseDate: v.earliestReleaseDate ?? null,
  };
  if (v.releaseType) ref.releaseType = v.releaseType as ReleaseType;
  // build is fetched only for editable/live; omit the key otherwise (undefined arg).
  if (build !== undefined) ref.build = build ? cleanBuildRef(build) : null;
  return ref;
};

/**
 * Deep-sync one app: appInfo branches, version branches (per platform), every
 * localization on both branches → per-locale cache docs. Never touches drafts;
 * locale docs that vanished remotely but still have a draft get missingRemote=true.
 */
export async function runAppSync(storeId: string, appId: string): Promise<{ locales: number }> {
  const api = await getAscApi(storeId);

  const [infos, versions] = await Promise.all([api.listAppInfos(appId), api.listVersions(appId)]);
  const info = pickInfo(infos);
  const versionPick = pickVersions(versions);

  const [infoEditableLocs, infoLiveLocs] = await Promise.all([
    info.editable ? api.listAppInfoLocalizations(info.editable.id) : Promise.resolve([] as AscInfoLoc[]),
    info.live ? api.listAppInfoLocalizations(info.live.id) : Promise.resolve([] as AscInfoLoc[]),
  ]);

  const platformLocs = new Map<
    Platform,
    { editable: Map<string, AscVersionLoc>; live: Map<string, AscVersionLoc> }
  >();
  for (const [platform, pick] of versionPick) {
    const [editableLocs, liveLocs] = await Promise.all([
      pick.editable ? api.listVersionLocalizations(pick.editable.id) : Promise.resolve([] as AscVersionLoc[]),
      pick.live ? api.listVersionLocalizations(pick.live.id) : Promise.resolve([] as AscVersionLoc[]),
    ]);
    platformLocs.set(platform, {
      editable: new Map(editableLocs.map((l) => [l.locale, l])),
      live: new Map(liveLocs.map((l) => [l.locale, l])),
    });
  }

  const infoEditableByLocale = new Map(infoEditableLocs.map((l) => [l.locale, l]));
  const infoLiveByLocale = new Map(infoLiveLocs.map((l) => [l.locale, l]));

  const localeSet = new Set<string>([
    ...infoEditableByLocale.keys(),
    ...infoLiveByLocale.keys(),
  ].filter(isKnownLocale));
  for (const { editable, live } of platformLocs.values()) {
    for (const k of editable.keys()) if (isKnownLocale(k)) localeSet.add(k);
    for (const k of live.keys()) if (isKnownLocale(k)) localeSet.add(k);
  }

  const appRef = refs.app(storeId, appId);
  const [existingLocales, drafts, appSnap] = await Promise.all([
    appRef.collection('locales').get(),
    appRef.collection('drafts').get(),
    appRef.get(),
  ]);
  const draftedLocales = new Set(drafts.docs.map((d) => d.id));
  const primaryLocale = (appSnap.data() as AppDoc | undefined)?.primaryLocale;
  const primaryName = primaryLocale
    ? (infoEditableByLocale.get(primaryLocale)?.name ?? infoLiveByLocale.get(primaryLocale)?.name ?? '').trim()
    : '';

  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
  const stripInfo = (l: AscInfoLoc | undefined) =>
    l ? {
        name: l.name ?? '',
        subtitle: l.subtitle ?? '',
        privacyPolicyUrl: l.privacyPolicyUrl ?? '',
        privacyChoicesUrl: l.privacyChoicesUrl ?? '',
      } : null;
  const stripVersion = (l: AscVersionLoc | undefined) =>
    l
      ? {
          description: l.description ?? '',
          keywords: l.keywords ?? '',
          promotionalText: l.promotionalText ?? '',
          whatsNew: l.whatsNew ?? '',
          supportUrl: l.supportUrl ?? '',
          marketingUrl: l.marketingUrl ?? '',
        }
      : null;

  for (const locale of localeSet) {
    const versionsField: LocaleDoc['versions'] = {};
    let hasEditableVersionLoc = false;
    for (const [platform, locs] of platformLocs) {
      const editable = locs.editable.get(locale);
      const live = locs.live.get(locale);
      if (editable) hasEditableVersionLoc = true;
      versionsField[platform] = {
        editable: stripVersion(editable),
        live: stripVersion(live),
        ids: { editable: editable?.id ?? null, live: live?.id ?? null },
      };
    }
    const infoEditableLoc = infoEditableByLocale.get(locale);
    const doc: Omit<LocaleDoc, 'syncedAt'> & { syncedAt: Timestamp } = {
      info: {
        editable: stripInfo(infoEditableLoc),
        live: stripInfo(infoLiveByLocale.get(locale)),
        ids: { editable: infoEditableLoc?.id ?? null, live: infoLiveByLocale.get(locale)?.id ?? null },
      },
      versions: versionsField,
      ...(hasEditableVersionLoc && !infoEditableLoc ? { infoPending: true } : {}),
      syncedAt: Timestamp.now(),
    };
    ops.push((b) => b.set(refs.locale(storeId, appId, locale), doc));
  }

  // Locales that vanished remotely: drop the cache doc unless a draft still references it.
  for (const d of existingLocales.docs) {
    if (!localeSet.has(d.id)) {
      if (draftedLocales.has(d.id)) {
        ops.push((b) => b.update(d.ref, { missingRemote: true, syncedAt: Timestamp.now() }));
      } else {
        ops.push((b) => b.delete(d.ref));
      }
    }
  }

  const versionsDocField: AppDoc['versions'] = {};
  // Unreleased apps have no public listing to pull an icon from — but any app
  // with an uploaded build carries its icon in the build's iconAssetToken.
  let buildIcon: string | null = null;
  for (const [platform, pick] of versionPick) {
    // Fetch the attached build for the branches users configure (editable + live).
    // A failed build fetch must not break the whole app sync — fall back to null.
    const [editableBuild, liveBuild] = await Promise.all([
      pick.editable ? api.getVersionBuild(pick.editable.id).catch(() => null) : Promise.resolve(null),
      pick.live ? api.getVersionBuild(pick.live.id).catch(() => null) : Promise.resolve(null),
    ]);
    buildIcon ??= liveBuild?.iconUrl ?? editableBuild?.iconUrl ?? null;
    versionsDocField[platform] = {
      editable: toRef(pick.editable, editableBuild),
      live: toRef(pick.live, liveBuild),
      review: toRef(pick.review),
    };
  }

  // Only fill a missing icon — a marketing icon from the public listing wins.
  const hasIcon = buildIcon ? !!((await appRef.get()).data() as AppDoc | undefined)?.iconUrl : true;

  ops.push((b) =>
    b.update(appRef, {
      ...(!hasIcon && buildIcon ? { iconUrl: buildIcon } : {}),
      appInfo: {
        editableId: info.editable?.id ?? null,
        editableState: info.editable?.state ?? null,
        liveId: info.live?.id ?? null,
      },
      versions: versionsDocField,
      platforms: [...versionPick.keys()],
      locales: sortLocales([...localeSet], primaryLocale),
      ...(primaryName ? { name: primaryName } : {}),
      deepSyncSchemaVersion: DEEP_SYNC_SCHEMA_VERSION,
      deepSyncedAt: Timestamp.now(),
    }),
  );

  await chunkedBatch(ops);
  return { locales: localeSet.size };
}
