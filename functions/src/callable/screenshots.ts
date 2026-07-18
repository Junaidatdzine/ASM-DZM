import { z } from 'zod';
import { getStorage } from 'firebase-admin/storage';
import {
  MAX_SCREENSHOT_BYTES,
  hasEditableVersion,
  isKnownLocale,
  validateScreenshotDimensions,
  type AppDoc,
  type LocaleDoc,
  type Platform,
  type ScreenshotEntry,
  type ScreenshotSetDoc,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { Timestamp, db, refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, invalid, notFound } from '../lib/errors';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { md5hex, parseImageHeader } from '../lib/asc/assets';
import type { AscApi, AscScreenshot } from '../lib/asc/types';

const platformSchema = z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);
const appStoreLocaleSchema = z.string().refine(isKnownLocale, {
  message: 'This language is not supported for App Store metadata.',
});

const target = z.object({
  storeId: z.string().min(1),
  appId: z.string().min(1),
  platform: platformSchema.default('IOS'),
  locale: appStoreLocaleSchema,
});

const setKey = (platform: string, branch: 'editable' | 'live', displayType: string) =>
  `${platform}_${branch}_${displayType}`;

function mapShot(s: AscScreenshot, position: number): ScreenshotEntry {
  const state =
    s.assetState === 'COMPLETE' ? 'complete'
    : s.assetState === 'FAILED' ? 'failed'
    : 'processing';
  return {
    id: s.id,
    fileName: s.fileName,
    position,
    width: s.width,
    height: s.height,
    templateUrl: s.templateUrl,
    state,
  };
}

async function syncBranchScreenshots(
  api: AscApi,
  storeId: string,
  appId: string,
  platform: Platform,
  locale: string,
  branch: 'editable' | 'live',
  versionLocId: string,
): Promise<number> {
  const sets = await api.listScreenshotSets(versionLocId);
  const batch = db().batch();
  const seenKeys = new Set<string>();
  for (const set of sets) {
    const shots = await api.listScreenshots(set.id);
    const key = setKey(platform, branch, set.displayType);
    seenKeys.add(key);
    batch.set(refs.screenshotSet(storeId, appId, key + '_' + locale), {
      platform,
      branch,
      displayType: set.displayType,
      locale,
      setId: set.id,
      screenshots: shots.map((s, i) => mapShot(s, i)),
      syncedAt: Timestamp.now(),
    } satisfies Omit<ScreenshotSetDoc, 'syncedAt'> & { syncedAt: Timestamp });
  }
  // Remove cached sets for this locale+branch that no longer exist remotely.
  const existing = await refs
    .app(storeId, appId)
    .collection('screenshotSets')
    .where('locale', '==', locale)
    .where('branch', '==', branch)
    .where('platform', '==', platform)
    .get();
  for (const docSnap of existing.docs) {
    const data = docSnap.data() as ScreenshotSetDoc;
    if (!seenKeys.has(setKey(platform, branch, data.displayType))) batch.delete(docSnap.ref);
  }
  await batch.commit();
  return sets.length;
}

export const screenshotsSyncLocale = defineCallable(
  'screenshotsSyncLocale',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 300,
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const { storeId, appId, locale } = input;
    const platform = input.platform as Platform;
    const localeSnap = await refs.locale(storeId, appId, locale).get();
    if (!localeSnap.exists) throw notFound('Language');
    const doc = localeSnap.data() as LocaleDoc;
    const api = await getAscApi(storeId);
    try {
      let sets = 0;
      const editableId = doc.versions?.[platform]?.ids?.editable;
      const liveId = doc.versions?.[platform]?.ids?.live;
      if (editableId) sets += await syncBranchScreenshots(api, storeId, appId, platform, locale, 'editable', editableId);
      if (liveId) sets += await syncBranchScreenshots(api, storeId, appId, platform, locale, 'live', liveId);
      return { sets };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

export const screenshotsSyncAll = defineCallable(
  'screenshotsSyncAll',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
    }),
    usesAscKey: true,
    timeoutSeconds: 540,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const [appSnap, localesSnap] = await Promise.all([
      refs.app(storeId, appId).get(),
      refs.app(storeId, appId).collection('locales').get(),
    ]);
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const branch = hasEditableVersion(app, platform) ? 'editable' : 'live';
    const api = await getAscApi(storeId);
    let localesSynced = 0;
    let sets = 0;

    try {
      // Small batches keep the view fast without hammering App Store Connect.
      for (let i = 0; i < localesSnap.docs.length; i += 4) {
        const batch = localesSnap.docs.slice(i, i + 4);
        const results = await Promise.all(
          batch.map(async (localeSnap) => {
            const locale = localeSnap.id;
            const localeDoc = localeSnap.data() as LocaleDoc;
            const versionLocId = localeDoc.versions?.[platform]?.ids?.[branch];
            if (!versionLocId) return 0;
            const count = await syncBranchScreenshots(
              api,
              storeId,
              appId,
              platform,
              locale,
              branch,
              versionLocId,
            );
            localesSynced += 1;
            return count;
          }),
        );
        sets += results.reduce((sum, count) => sum + count, 0);
      }
      return { branch, localesSynced, sets };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

export const screenshotsUpload = defineCallable(
  'screenshotsUpload',
  {
    input: target.extend({
      displayType: z.string().min(3),
      storagePath: z.string().min(5),
      fileName: z.string().min(1).max(120),
    }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'manageScreenshots', input.storeId, input.appId),
    audit: (input) => ({
      action: 'screenshot.upload',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
      detail: `${input.displayType} ${input.fileName}`,
    }),
  },
  async (input, actor) => {
    const { storeId, appId, locale, displayType, storagePath } = input;
    const platform = input.platform as Platform;

    if (!storagePath.startsWith(`staging/${actor.uid}/`)) {
      throw invalid('Invalid staging path.');
    }

    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    if (!hasEditableVersion(app, platform)) {
      throw new AppError('failed-precondition', 'Screenshots can only change on an editable version. Create a version first.');
    }
    const localeSnap = await refs.locale(storeId, appId, locale).get();
    const localeDoc = localeSnap.exists ? (localeSnap.data() as LocaleDoc) : null;
    const versionLocId = localeDoc?.versions?.[platform]?.ids?.editable;
    if (!versionLocId) {
      throw new AppError('failed-precondition', 'This language has no draft localization yet — save some metadata first.');
    }

    // Pull the staged file, validate hard, then run Apple's upload dance.
    const file = getStorage().bucket().file(storagePath);
    const [exists] = await file.exists();
    if (!exists) throw invalid('The uploaded file was not found (it may have expired). Try again.');
    const [buf] = await file.download();
    try {
      if (buf.length > MAX_SCREENSHOT_BYTES) throw invalid('Image exceeds 12 MB.');
      const parsed = parseImageHeader(buf);
      const dimError = validateScreenshotDimensions(displayType, parsed.width, parsed.height);
      if (dimError) throw invalid(dimError);

      const api = await getAscApi(storeId);
      const key = setKey(platform, 'editable', displayType) + '_' + locale;
      const setRef = refs.screenshotSet(storeId, appId, key);
      const setSnap = await setRef.get();
      let ascSetId = setSnap.exists ? (setSnap.data() as ScreenshotSetDoc).setId : null;
      let currentShots: ScreenshotEntry[] = setSnap.exists
        ? [...(setSnap.data() as ScreenshotSetDoc).screenshots]
        : [];

      if (!ascSetId) {
        // Reconcile with ASC first (the set may exist remotely without a cache doc).
        const remoteSets = await api.listScreenshotSets(versionLocId);
        const found = remoteSets.find((s) => s.displayType === displayType);
        if (found) {
          ascSetId = found.id;
          const shots = await api.listScreenshots(found.id);
          currentShots = shots.map((s, i) => mapShot(s, i));
        } else {
          const created = await api.createScreenshotSet(versionLocId, displayType);
          ascSetId = created.id;
          currentShots = [];
        }
      }
      if (currentShots.length >= 10) throw invalid('This device size already has 10 screenshots.');

      const reserved = await api.reserveScreenshot(ascSetId, input.fileName, buf.length);
      try {
        await api.uploadScreenshotParts(reserved.uploadOperations ?? [], buf);
        const committed = await api.commitScreenshot(reserved.id, md5hex(buf));

        const entry = mapShot(committed, currentShots.length);
        await setRef.set(
          {
            platform,
            branch: 'editable',
            displayType,
            locale,
            setId: ascSetId,
            screenshots: [...currentShots, entry],
            syncedAt: Timestamp.now(),
          },
          { merge: true },
        );
        return { screenshotId: committed.id, state: entry.state };
      } catch (err) {
        // Don't leave a half-reserved asset behind.
        await api.deleteScreenshot(reserved.id).catch(() => {});
        throw err;
      }
    } finally {
      await file.delete().catch(() => {});
    }
  },
);

export const screenshotsPollState = defineCallable(
  'screenshotsPollState',
  {
    input: target.extend({ displayType: z.string().min(3), screenshotId: z.string().min(1) }),
    usesAscKey: true,
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const { storeId, appId, locale, displayType, screenshotId } = input;
    const platform = input.platform as Platform;
    const api = await getAscApi(storeId);
    const shot = await api.getScreenshot(screenshotId);
    const key = setKey(platform, 'editable', displayType) + '_' + locale;
    const setRef = refs.screenshotSet(storeId, appId, key);
    const snap = await setRef.get();
    if (snap.exists) {
      const data = snap.data() as ScreenshotSetDoc;
      const updated = data.screenshots.map((s) =>
        s.id === screenshotId ? { ...mapShot(shot, s.position), position: s.position } : s,
      );
      await setRef.update({ screenshots: updated, syncedAt: Timestamp.now() });
    }
    return { state: shot.assetState };
  },
);

export const screenshotsDelete = defineCallable(
  'screenshotsDelete',
  {
    input: target.extend({ displayType: z.string().min(3), screenshotId: z.string().min(1) }),
    usesAscKey: true,
    authorize: (actor, input) => requireAction(actor, 'manageScreenshots', input.storeId, input.appId),
    audit: (input) => ({
      action: 'screenshot.delete',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
      detail: input.displayType,
    }),
  },
  async (input) => {
    const { storeId, appId, locale, displayType, screenshotId } = input;
    const platform = input.platform as Platform;
    const api = await getAscApi(storeId);
    await api.deleteScreenshot(screenshotId);
    const key = setKey(platform, 'editable', displayType) + '_' + locale;
    const setRef = refs.screenshotSet(storeId, appId, key);
    const snap = await setRef.get();
    if (snap.exists) {
      const data = snap.data() as ScreenshotSetDoc;
      await setRef.update({
        screenshots: data.screenshots
          .filter((s) => s.id !== screenshotId)
          .map((s, i) => ({ ...s, position: i })),
        syncedAt: Timestamp.now(),
      });
    }
    return { ok: true };
  },
);

export const screenshotsReorder = defineCallable(
  'screenshotsReorder',
  {
    input: target.extend({ displayType: z.string().min(3), orderedIds: z.array(z.string()).min(1).max(10) }),
    usesAscKey: true,
    authorize: (actor, input) => requireAction(actor, 'manageScreenshots', input.storeId, input.appId),
    audit: (input) => ({
      action: 'screenshot.reorder',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
      detail: input.displayType,
    }),
  },
  async (input) => {
    const { storeId, appId, locale, displayType, orderedIds } = input;
    const platform = input.platform as Platform;
    const key = setKey(platform, 'editable', displayType) + '_' + locale;
    const setRef = refs.screenshotSet(storeId, appId, key);
    const snap = await setRef.get();
    if (!snap.exists) throw notFound('Screenshot set');
    const data = snap.data() as ScreenshotSetDoc;
    if (!data.setId) throw notFound('Screenshot set');

    const api = await getAscApi(storeId);
    // Guard the stale-view race: the order must be an exact permutation of what Apple has now.
    const remote = await api.listScreenshots(data.setId);
    const remoteIds = new Set(remote.map((s) => s.id));
    if (remote.length !== orderedIds.length || orderedIds.some((id) => !remoteIds.has(id))) {
      const fresh = remote.map((s, i) => mapShot(s, i));
      await setRef.update({ screenshots: fresh, syncedAt: Timestamp.now() });
      throw new AppError('failed-precondition', 'Screenshots changed since you loaded — refreshed, try again.');
    }
    await api.reorderScreenshots(data.setId, orderedIds);
    const byId = new Map(data.screenshots.map((s) => [s.id, s]));
    await setRef.update({
      screenshots: orderedIds.map((id, i) => ({ ...byId.get(id)!, position: i })),
      syncedAt: Timestamp.now(),
    });
    return { ok: true };
  },
);

export const screenshotSetsDelete = defineCallable(
  'screenshotSetsDelete',
  {
    input: target.extend({ displayType: z.string().min(3) }),
    usesAscKey: true,
    authorize: (actor, input) => requireAction(actor, 'manageScreenshots', input.storeId, input.appId),
    audit: (input) => ({
      action: 'screenshot.set-delete',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
      detail: input.displayType,
    }),
  },
  async (input) => {
    const { storeId, appId, locale, displayType } = input;
    const platform = input.platform as Platform;
    const key = setKey(platform, 'editable', displayType) + '_' + locale;
    const setRef = refs.screenshotSet(storeId, appId, key);
    const snap = await setRef.get();
    if (!snap.exists) throw notFound('Screenshot set');
    const data = snap.data() as ScreenshotSetDoc;
    const api = await getAscApi(storeId);
    if (data.setId) await api.deleteScreenshotSet(data.setId);
    await setRef.delete();
    return { ok: true };
  },
);
