import { z } from 'zod';
import {
  COPYRIGHT_MAX,
  cleanBuildRef,
  isEditableState,
  normalizeEarliestReleaseDate,
  releaseConfigError,
  validateCopyright,
  type AppDoc,
  type AuditChange,
  type BuildRef,
  type Platform,
  type ReleaseType,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { Timestamp, refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, invalid, notFound } from '../lib/errors';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { startOperation } from '../lib/operations';
import { writeAudit } from '../lib/audit';
import type { AscBuild, VersionInfoAttrs } from '../lib/asc/types';

const platformSchema = z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);
const releaseTypeSchema = z.enum(['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED']);

/** Drop undefined keys so the result is safe to persist in Firestore. */
function cleanBuild(b: AscBuild | null): BuildRef | null {
  return b ? cleanBuildRef(b) : null;
}

/**
 * Builds eligible for the editable version's build slot, plus the currently attached one.
 * Read-only; gated by createVersion since only those who can change a version need it.
 */
export const buildsList = defineCallable(
  'buildsList',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
  },
  async (input) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) {
      throw new AppError('failed-precondition', 'There is no editable version to select a build for. Create one first.');
    }

    const api = await getAscApi(storeId);
    try {
      const [builds, current] = await Promise.all([
        api.listBuilds(appId, editable.versionString),
        api.getVersionBuild(editable.id),
      ]);
      return {
        versionString: editable.versionString,
        selectedBuildId: current?.id ?? null,
        builds: builds.map((b) => cleanBuild(b)!),
      };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

/**
 * Update the editable version's release configuration (copyright, release type/date) and/or
 * its selected build. Applies exactly the subset the caller sends. Server re-checks fresh
 * editability before mutating, then patches the cached version ref and writes an audit entry.
 */
export const versionInfoUpdate = defineCallable(
  'versionInfoUpdate',
  {
    input: z
      .object({
        storeId: z.string().min(1),
        appId: z.string().min(1),
        platform: platformSchema.default('IOS'),
        copyright: z.string().max(2000).optional(),
        releaseType: releaseTypeSchema.optional(),
        earliestReleaseDate: z.string().max(64).nullable().optional(),
        // Present key changes the build: a string attaches, null detaches. Absent = leave as-is.
        buildId: z.string().min(1).nullable().optional(),
      })
      .refine(
        (v) =>
          v.copyright !== undefined ||
          v.releaseType !== undefined ||
          v.earliestReleaseDate !== undefined ||
          v.buildId !== undefined,
        { message: 'Nothing to update.' },
      ),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appRef = refs.app(storeId, appId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) {
      throw new AppError('failed-precondition', 'There is no editable version to configure. Create one first.');
    }

    // Validate + assemble the release-configuration patch before touching Apple.
    const infoAttrs: VersionInfoAttrs = {};
    if (input.copyright !== undefined) {
      const copyright = input.copyright.trim();
      const err = validateCopyright(copyright);
      if (err) throw invalid(err);
      infoAttrs.copyright = copyright;
    }
    if (input.releaseType !== undefined) {
      infoAttrs.releaseType = input.releaseType;
      if (input.releaseType === 'SCHEDULED') {
        const normalized = normalizeEarliestReleaseDate(input.earliestReleaseDate ?? null);
        const cfgErr = releaseConfigError('SCHEDULED', normalized);
        if (cfgErr) throw invalid(cfgErr);
        infoAttrs.earliestReleaseDate = normalized;
      } else {
        // Apple requires the scheduled date to be cleared for MANUAL / AFTER_APPROVAL.
        infoAttrs.earliestReleaseDate = null;
      }
    } else if (input.earliestReleaseDate !== undefined) {
      const type = (editable.releaseType ?? 'SCHEDULED') as ReleaseType;
      const normalized = normalizeEarliestReleaseDate(input.earliestReleaseDate);
      const cfgErr = releaseConfigError(type, normalized);
      if (cfgErr) throw invalid(cfgErr);
      infoAttrs.earliestReleaseDate = normalized;
    }
    const wantsBuild = input.buildId !== undefined;

    const api = await getAscApi(storeId);
    const op = await startOperation({
      type: 'update-version',
      label: `Saving version information for ${app.name}`,
      startedBy: actor.uid,
      storeId,
      appId,
      platform,
    });
    op.progress(0, 1);
    try {
      const state = await api.getVersionState(editable.id);
      if (!isEditableState(state)) {
        throw new AppError('failed-precondition', 'This version is no longer editable. Sync the app to refresh its status.');
      }

      const cachePatch: Record<string, unknown> = {};
      const changes: AuditChange[] = [];
      const base = `versions.${platform}.editable`;

      if (Object.keys(infoAttrs).length > 0) {
        const updated = await api.updateVersionInfo(editable.id, infoAttrs);
        if (infoAttrs.copyright !== undefined) {
          changes.push({ field: 'copyright', from: editable.copyright ?? null, to: updated.copyright ?? '' });
          cachePatch[`${base}.copyright`] = updated.copyright ?? '';
        }
        if (infoAttrs.releaseType !== undefined || infoAttrs.earliestReleaseDate !== undefined) {
          changes.push({
            field: 'releaseType',
            from: `${editable.releaseType ?? '—'}${editable.earliestReleaseDate ? ` @ ${editable.earliestReleaseDate}` : ''}`,
            to: `${updated.releaseType ?? '—'}${updated.earliestReleaseDate ? ` @ ${updated.earliestReleaseDate}` : ''}`,
          });
          cachePatch[`${base}.releaseType`] = updated.releaseType ?? null;
          cachePatch[`${base}.earliestReleaseDate`] = updated.earliestReleaseDate ?? null;
        }
      }

      if (wantsBuild) {
        await api.selectBuild(editable.id, input.buildId ?? null);
        const build = cleanBuild(await api.getVersionBuild(editable.id));
        changes.push({ field: 'build', from: editable.build?.version ?? null, to: build?.version ?? null });
        cachePatch[`${base}.build`] = build;
      }

      if (Object.keys(cachePatch).length > 0) {
        cachePatch['deepSyncedAt'] = Timestamp.now();
        await appRef.update(cachePatch);
      }

      op.progress(1, 1);
      await op.finish('success', `Version information saved for ${app.name}`);
      await writeAudit(
        { uid: actor.uid, email: actor.email },
        { action: 'version.info-update', storeId, appId, platform, changes, result: 'ok' },
      );
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      await op.fail(err instanceof Error ? err.message : 'Could not save version information.');
      throw err;
    }
  },
);
