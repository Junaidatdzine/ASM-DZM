import { z } from 'zod';
import {
  FIELD_SPECS,
  decodeFieldKey,
  fieldStatus,
  isAppStoreConnectApiLocale,
  isKnownLocale,
  isEditableState,
  sortLocales,
  validateFieldValue,
  type AppDoc,
  type AuditChange,
  type DraftDoc,
  type LocaleDoc,
  type Platform,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { FieldValue, Timestamp, db, refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, invalid, notFound } from '../lib/errors';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { startOperation } from '../lib/operations';
import { runAppSync } from '../lib/sync/appSync';
import type { AscApi, InfoLocAttrs, VersionLocAttrs } from '../lib/asc/types';

const platformSchema = z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);
const appStoreLocaleSchema = z.string().refine(isKnownLocale, {
  message: 'This language is not supported for App Store metadata.',
});
const appStoreConnectCreateLocaleSchema = z.string().refine(isAppStoreConnectApiLocale, {
  message: 'Apple’s public App Store Connect API cannot create this language yet. Add it in App Store Connect, then sync.',
});

interface LocaleResult {
  locale: string;
  ok: boolean;
  pushedKeys: string[];
  error?: string;
}

/**
 * Apple requires app names to be globally available. Keep the user's name when
 * possible, but provide a deterministic, app-specific fallback after Apple
 * reports a collision. The Apple ID makes the fallback unique across apps.
 */
function collisionSafeAppName(base: string, locale: string, appId: string): string {
  const maxLength = FIELD_SPECS.name.maxLength;
  const suffix = ` ${locale}-${appId}`;
  const room = Math.max(1, maxLength - suffix.length);
  const stem = (base.trim() || 'App').slice(0, room).trimEnd() || 'A';
  return `${stem}${suffix}`.slice(0, maxLength);
}

function isAppNameCollision(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('app name') && (
    message.includes('already being used')
    || message.includes('already in use')
    || message.includes('name is being used')
  );
}

/**
 * Apply drafts to App Store Connect. The protocol per locale:
 *  lease drafts (status=pushing) → fresh state check → PATCH/POST per resource →
 *  patch cache from responses → clear only draft fields still equal to what was pushed.
 * Partial success is first-class: failed locales keep drafts + error message.
 */
export const locPush = defineCallable(
  'locPush',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      locales: z.array(appStoreLocaleSchema).min(1).max(50),
    }),
    usesAscKey: true,
    timeoutSeconds: 540,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'push', input.storeId, input.appId),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;

    // 1. Lease the drafts we're about to push.
    const leased: string[] = [];
    await db().runTransaction(async (tx) => {
      const draftRefs = input.locales.map((l) => refs.draft(storeId, appId, l));
      const snaps = await Promise.all(draftRefs.map((r) => tx.get(r)));
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const data = snap.data() as DraftDoc;
        if (data.status === 'pushing') {
          throw new AppError('failed-precondition', 'A push is already running for this app. Wait for it to finish.');
        }
        if (Object.keys(data.fields ?? {}).length === 0) continue;
        tx.update(snap.ref, { status: 'pushing' });
        leased.push(snap.id);
      }
    });
    if (leased.length === 0) {
      return { results: [] as LocaleResult[], summary: 'nothing-to-push' };
    }

    const op = await startOperation({
      type: 'loc-push',
      label: `Pushing ${app.name} (${leased.length} ${leased.length === 1 ? 'language' : 'languages'})`,
      startedBy: actor.uid,
      storeId,
      appId,
      platform,
    });

    const unlease = async (locale: string) => {
      await refs.draft(storeId, appId, locale).update({ status: 'open' }).catch(() => {});
    };

    let api: AscApi;
    let stateErrorSeen = false;
    const results: LocaleResult[] = [];
    const auditChanges: AuditChange[] = [];

    try {
      api = await getAscApi(storeId);

      // 2. Fresh state checks (once, not per locale).
      let infoEditable = false;
      if (app.appInfo?.editableId) {
        infoEditable = isEditableState(await api.getAppInfoState(app.appInfo.editableId).catch(() => ''));
      }
      const versionRef = app.versions?.[platform]?.editable ?? null;
      let versionEditable = false;
      if (versionRef) {
        versionEditable = isEditableState(await api.getVersionState(versionRef.id).catch(() => ''));
      }
      const liveRef = app.versions?.[platform]?.live ?? null;

      let done = 0;
      for (const locale of leased) {
        op.progress(done, leased.length);
        done += 1;
        const draftSnap = await refs.draft(storeId, appId, locale).get();
        if (!draftSnap.exists) continue;
        const draft = draftSnap.data() as DraftDoc;
        const localeSnap = await refs.locale(storeId, appId, locale).get();
        const localeDoc = (localeSnap.exists ? localeSnap.data() : null) as LocaleDoc | null;

        const infoAttrs: InfoLocAttrs = {};
        const versionAttrs: VersionLocAttrs = {};
        let livePromo: string | null = null;
        const pushedKeys: string[] = [];
        const pushedValues: Record<string, string> = {};
        let fieldError: string | null = null;

        for (const [key, rawValue] of Object.entries(draft.fields ?? {})) {
          const decoded = decodeFieldKey(key);
          if (!decoded) continue;
          if (decoded.target === 'version' && decoded.platform !== platform) continue;
          const value = String(rawValue);
          const err = validateFieldValue(decoded.field, value);
          if (err) {
            fieldError = err;
            break;
          }
          const status = fieldStatus(app, platform, decoded.field);
          if (decoded.target === 'info') {
            if (!infoEditable) {
              fieldError = FIELD_SPECS[decoded.field].label + ' can’t change right now (no editable app info).';
              break;
            }
            infoAttrs[decoded.field as keyof InfoLocAttrs] = value;
          } else if (status.pushTarget === 'livePromo') {
            livePromo = value;
          } else {
            if (!versionEditable) {
              fieldError = FIELD_SPECS[decoded.field].label + ' can’t change right now (version is not editable).';
              break;
            }
            if (decoded.field === 'whatsNew' && !liveRef) continue; // Apple rejects on first version
            versionAttrs[decoded.field as keyof VersionLocAttrs] = value;
          }
          pushedKeys.push(key);
          pushedValues[key] = value;
        }

        if (fieldError) {
          results.push({ locale, ok: false, pushedKeys: [], error: fieldError });
          await unlease(locale);
          continue;
        }

        try {
          const cachePatch: Record<string, unknown> = {};
          const before = draft.base ?? {};

          if (Object.keys(infoAttrs).length > 0) {
            let id = localeDoc?.info?.ids?.editable ?? null;
            const writeInfo = async (attrs: InfoLocAttrs) => {
              if (!id && app.appInfo?.editableId) {
                return api.createAppInfoLocalization(app.appInfo.editableId, locale, attrs);
              }
              if (id) return api.updateAppInfoLocalization(id, attrs);
              return null;
            };

            let saved;
            try {
              saved = await writeInfo(infoAttrs);
            } catch (err) {
              if (!infoAttrs.name || !isAppNameCollision(err)) throw err;
              const fallbackName = collisionSafeAppName(infoAttrs.name, locale, appId);
              saved = await writeInfo({ ...infoAttrs, name: fallbackName });
              for (const key of pushedKeys) {
                if (decodeFieldKey(key)?.field === 'name') pushedValues[key] = fallbackName;
              }
            }
            if (saved) {
              id = saved.id;
              cachePatch['info.editable'] = {
                name: saved.name,
                subtitle: saved.subtitle,
                privacyPolicyUrl: saved.privacyPolicyUrl ?? '',
                privacyChoicesUrl: saved.privacyChoicesUrl ?? '',
              };
              if (locale === app.primaryLocale && saved.name.trim()) {
                await refs.app(storeId, appId).update({ name: saved.name.trim() });
              }
            }
            cachePatch['info.ids.editable'] = id;
          }

          if (Object.keys(versionAttrs).length > 0 && versionRef) {
            let id = localeDoc?.versions?.[platform]?.ids?.editable ?? null;
            if (!id) {
              const created = await api.createVersionLocalization(versionRef.id, locale, versionAttrs);
              id = created.id;
              cachePatch[`versions.${platform}.editable`] = {
                description: created.description,
                keywords: created.keywords,
                promotionalText: created.promotionalText,
                whatsNew: created.whatsNew,
                supportUrl: created.supportUrl,
                marketingUrl: created.marketingUrl,
              };
            } else {
              const updated = await api.updateVersionLocalization(id, versionAttrs);
              cachePatch[`versions.${platform}.editable`] = {
                description: updated.description,
                keywords: updated.keywords,
                promotionalText: updated.promotionalText,
                whatsNew: updated.whatsNew,
                supportUrl: updated.supportUrl,
                marketingUrl: updated.marketingUrl,
              };
            }
            cachePatch[`versions.${platform}.ids.editable`] = id;
          }

          if (livePromo !== null) {
            const liveId = localeDoc?.versions?.[platform]?.ids?.live ?? null;
            if (!liveId) {
              throw new AppError('failed-precondition', `No live localization exists for ${locale} to update its promotional text.`);
            }
            const updated = await api.updateVersionLocalization(liveId, { promotionalText: livePromo });
            cachePatch[`versions.${platform}.live.promotionalText`] = updated.promotionalText;
          }

          if (Object.keys(cachePatch).length > 0) {
            cachePatch['syncedAt'] = Timestamp.now();
            await refs.locale(storeId, appId, locale).set(
              unflatten(cachePatch),
              { merge: true },
            );
          }

          // 3. Clear only the fields whose draft value is still what we pushed.
          await db().runTransaction(async (tx) => {
            const ref = refs.draft(storeId, appId, locale);
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            const current = snap.data() as DraftDoc;
            const updates: Record<string, unknown> = { status: 'open' };
            let cleared = 0;
            for (const key of pushedKeys) {
              if (current.fields?.[key] === draft.fields[key]) {
                updates[`fields.${key}`] = FieldValue.delete();
                updates[`base.${key}`] = FieldValue.delete();
                updates[`meta.${key}`] = FieldValue.delete();
                cleared += 1;
              }
            }
            const remainingCount = Object.keys(current.fields ?? {}).length - cleared;
            if (remainingCount <= 0) tx.delete(ref);
            else tx.update(ref, updates);
          });

          for (const key of pushedKeys) {
            auditChanges.push({
              field: `${locale}:${key}`,
              from: before[key] ?? null,
              to: pushedValues[key] ?? draft.fields[key] ?? null,
            });
          }
          results.push({ locale, ok: true, pushedKeys });
        } catch (err) {
          if (err instanceof AppError && (err.details as { stateError?: boolean } | undefined)?.stateError) {
            stateErrorSeen = true;
          }
          await markStoreAuthError(storeId, err);
          results.push({
            locale,
            ok: false,
            pushedKeys: [],
            error: err instanceof AppError ? err.message : 'Push failed.',
          });
          await unlease(locale);
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      await op.finish(
        failCount === 0 ? 'success' : 'partial',
        failCount === 0
          ? `Pushed ${app.name} — ${okCount} ${okCount === 1 ? 'language' : 'languages'}`
          : `Pushed ${okCount}, failed ${failCount} — ${app.name}`,
      );

      if (stateErrorSeen) {
        // Cache is stale relative to ASC — reconcile in the background of this invocation.
        await runAppSync(storeId, appId).catch(() => {});
      }

      const { writeAudit } = await import('../lib/audit');
      await writeAudit(
        { uid: actor.uid, email: actor.email },
        {
          action: 'loc.push',
          storeId,
          appId,
          platform,
          changes: auditChanges.slice(0, 60),
          result: failCount === 0 ? 'ok' : okCount === 0 ? 'error' : 'partial',
        },
      );

      return { results, summary: failCount === 0 ? 'ok' : 'partial' };
    } catch (err) {
      for (const locale of leased) await unlease(locale);
      await op.fail(err instanceof Error ? err.message : 'Push failed');
      throw err;
    }
  },
);

/** Convert dot-path keys into nested objects for a Firestore set-merge. */
function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      node[part] = (node[part] as Record<string, unknown> | undefined) ?? {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}

export const locAddLanguage = defineCallable(
  'locAddLanguage',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      locales: z.array(appStoreConnectCreateLocaleSchema).min(1).max(50),
      copyFrom: z.string().nullish(),
    }),
    usesAscKey: true,
    timeoutSeconds: 300,
    authorize: (actor, input) => requireAction(actor, 'addLanguage', input.storeId, input.appId),
    audit: (input) => ({
      action: 'loc.add-language',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.locales.join(', '),
    }),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;

    const versionRef = app.versions?.[platform]?.editable;
    if (!versionRef && !app.appInfo?.editableId) {
      throw new AppError('failed-precondition', 'Adding languages needs an editable version. Create one first.');
    }

    const existing = new Set(app.locales ?? []);
    const toAdd = [...new Set(input.locales)];

    // Apple requires `name` when creating an app-info localization. Seed it from
    // the chosen source (falling back to the app name); users can localize it later.
    let seedInfo: InfoLocAttrs = { name: app.name.slice(0, FIELD_SPECS.name.maxLength) };
    let seedVersion: VersionLocAttrs = {};
    if (input.copyFrom) {
      const src = await refs.locale(storeId, appId, input.copyFrom).get();
      if (src.exists) {
        const doc = src.data() as LocaleDoc;
        const sourceName = doc.info?.editable?.name?.trim() || doc.info?.live?.name?.trim() || app.name;
        seedInfo = {
          name: sourceName.slice(0, FIELD_SPECS.name.maxLength),
          subtitle: doc.info?.editable?.subtitle ?? doc.info?.live?.subtitle ?? '',
        };
        const branch = doc.versions?.[platform]?.editable ?? doc.versions?.[platform]?.live ?? null;
        if (branch) {
          seedVersion = {
            description: branch.description ?? '',
            keywords: branch.keywords ?? '',
            promotionalText: branch.promotionalText ?? '',
            whatsNew: app.versions?.[platform]?.live ? (branch.whatsNew ?? '') : undefined,
            supportUrl: branch.supportUrl ?? '',
            marketingUrl: branch.marketingUrl ?? '',
          };
        }
      }
    }

    const api = await getAscApi(storeId);
    const op = await startOperation({
      type: 'add-language',
      label: `Adding ${toAdd.length} ${toAdd.length === 1 ? 'language' : 'languages'} to ${app.name}`,
      startedBy: actor.uid,
      storeId,
      appId,
    });

    const added: string[] = [];
    const skipped: string[] = [];
    const ready: string[] = [];
    const failed: Array<{ locale: string; error: string }> = [];
    try {
      // Read Apple first so this operation is idempotent even when our local cache
      // is stale. Existing resources are reconciled instead of being POSTed again.
      const infoEditable = !!app.appInfo?.editableId && isEditableState(app.appInfo.editableState ?? '');
      const [infoRows, versionRows] = await Promise.all([
        infoEditable && app.appInfo?.editableId
          ? api.listAppInfoLocalizations(app.appInfo.editableId)
          : Promise.resolve([]),
        versionRef ? api.listVersionLocalizations(versionRef.id) : Promise.resolve([]),
      ]);
      const infoByLocale = new Map(infoRows.map((row) => [row.locale, row]));
      const versionByLocale = new Map(versionRows.map((row) => [row.locale, row]));

      let done = 0;
      op.progress(0, toAdd.length, { added: 0, skipped: 0, failed: 0 });
      for (const locale of toAdd) {
        try {
          const cachePatch: Record<string, unknown> = {};
          let infoPending = true;
          let createdAny = false;
          if (infoEditable && app.appInfo?.editableId) {
            let info = infoByLocale.get(locale);
            if (!info) {
              info = await api.createAppInfoLocalization(app.appInfo.editableId, locale, {
                ...seedInfo,
                name: collisionSafeAppName(seedInfo.name ?? app.name, locale, appId),
              });
              infoByLocale.set(locale, info);
              createdAny = true;
            }
            cachePatch['info'] = {
              editable: {
                name: info.name,
                subtitle: info.subtitle,
                privacyPolicyUrl: info.privacyPolicyUrl ?? '',
                privacyChoicesUrl: info.privacyChoicesUrl ?? '',
              },
              live: null,
              ids: { editable: info.id, live: null },
            };
            infoPending = false;
          } else {
            cachePatch['info'] = { editable: null, live: null, ids: { editable: null, live: null } };
          }
          if (versionRef) {
            let version = versionByLocale.get(locale);
            if (!version) {
              version = await api.createVersionLocalization(versionRef.id, locale, seedVersion);
              versionByLocale.set(locale, version);
              createdAny = true;
            }
            cachePatch[`versions`] = {
              [platform]: {
                editable: {
                  description: version.description,
                  keywords: version.keywords,
                  promotionalText: version.promotionalText,
                  whatsNew: version.whatsNew,
                  supportUrl: version.supportUrl,
                  marketingUrl: version.marketingUrl,
                },
                live: null,
                ids: { editable: version.id, live: null },
              },
            };
          }
          await refs.locale(storeId, appId, locale).set(
            {
              ...cachePatch,
              ...(infoPending ? { infoPending: true } : {}),
              syncedAt: Timestamp.now(),
            },
            { merge: true },
          );
          ready.push(locale);
          if (createdAny) added.push(locale);
          else skipped.push(locale);
        } catch (err) {
          await markStoreAuthError(storeId, err);
          failed.push({ locale, error: err instanceof AppError ? err.message : 'Failed' });
        } finally {
          done += 1;
          op.progress(done, toAdd.length, {
            added: added.length,
            skipped: skipped.length,
            failed: failed.length,
          });
        }
      }

      if (ready.length > 0) {
        await refs.app(storeId, appId).update({
          locales: sortLocales([...existing, ...ready], app.primaryLocale),
        });
      }
      await op.finish(
        failed.length === 0 ? 'success' : 'partial',
        `Languages for ${app.name}: ${added.length} added, ${skipped.length} already present${failed.length ? `, ${failed.length} failed` : ''}`,
      );
      return { added, skipped, failed };
    } catch (err) {
      await op.fail(err instanceof Error ? err.message : 'Failed');
      throw err;
    }
  },
);

export const locRemoveLanguage = defineCallable(
  'locRemoveLanguage',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      locale: appStoreLocaleSchema,
    }),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor, input) => requireAction(actor, 'removeLanguage', input.storeId, input.appId),
    audit: (input) => ({
      action: 'loc.remove-language',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
    }),
  },
  async (input) => {
    const { storeId, appId, locale } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    if (locale === app.primaryLocale) {
      throw invalid('The primary language can’t be removed.');
    }

    const localeSnap = await refs.locale(storeId, appId, locale).get();
    if (!localeSnap.exists) throw notFound('Language');
    const doc = localeSnap.data() as LocaleDoc;

    const api = await getAscApi(storeId);
    const infoId = doc.info?.ids?.editable;
    const versionId = doc.versions?.[platform]?.ids?.editable;
    if (!infoId && !versionId) {
      throw new AppError('failed-precondition', 'Only draft-version languages can be removed. This one exists only on the live version.');
    }
    if (versionId) await api.deleteVersionLocalization(versionId);
    if (infoId) await api.deleteAppInfoLocalization(infoId);

    const hasLive = !!doc.info?.live || !!doc.versions?.[platform]?.live;
    const batch = db().batch();
    if (hasLive) {
      batch.set(
        refs.locale(storeId, appId, locale),
        {
          info: { editable: null, ids: { editable: null, live: doc.info?.ids?.live ?? null } },
          versions: {
            [platform]: {
              editable: null,
              ids: { editable: null, live: doc.versions?.[platform]?.ids?.live ?? null },
            },
          },
          syncedAt: Timestamp.now(),
        },
        { merge: true },
      );
    } else {
      batch.delete(refs.locale(storeId, appId, locale));
      batch.update(refs.app(storeId, appId), {
        locales: (app.locales ?? []).filter((l) => l !== locale),
      });
    }
    batch.delete(refs.draft(storeId, appId, locale));
    await batch.commit();
    return { ok: true, removedFromLive: !hasLive };
  },
);

export const versionsCreate = defineCallable(
  'versionsCreate',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      versionString: z
        .string()
        .trim()
        .regex(/^\d+(\.\d+){0,3}$/, 'Version must look like 2.4 or 2.4.1'),
    }),
    usesAscKey: true,
    timeoutSeconds: 300,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({
      action: 'version.create',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.versionString,
    }),
  },
  async (input, actor) => {
    const appSnap = await refs.app(input.storeId, input.appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;

    const api = await getAscApi(input.storeId);
    const created = await api.createVersion(input.appId, input.platform as Platform, input.versionString);

    const op = await startOperation({
      type: 'create-version',
      label: `Created v${created.versionString} for ${app.name} — syncing`,
      startedBy: actor.uid,
      storeId: input.storeId,
      appId: input.appId,
    });
    // ASC copies localizations from the previous version — deep sync to pick everything up.
    try {
      await runAppSync(input.storeId, input.appId);
      await op.finish('success', `v${created.versionString} ready for ${app.name}`);
    } catch (err) {
      await op.fail('Version created but sync failed — hit Sync manually.');
    }
    return { versionId: created.id, versionString: created.versionString };
  },
);

export const versionsUpdate = defineCallable(
  'versionsUpdate',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      versionString: z
        .string()
        .trim()
        .regex(/^\d+(\.\d+){0,3}$/, 'Version must look like 2.4 or 2.4.1'),
    }),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({
      action: 'version.update',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.versionString,
    }),
  },
  async (input, actor) => {
    const platform = input.platform as Platform;
    const appRef = refs.app(input.storeId, input.appId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) throw new AppError('failed-precondition', 'There is no editable version to change.');
    if (editable.versionString === input.versionString) {
      return { versionId: editable.id, versionString: editable.versionString };
    }

    const api = await getAscApi(input.storeId);
    const op = await startOperation({
      type: 'update-version',
      label: `Changing ${app.name} to v${input.versionString}`,
      startedBy: actor.uid,
      storeId: input.storeId,
      appId: input.appId,
      platform,
    });
    op.progress(0, 1);
    try {
      const state = await api.getVersionState(editable.id);
      if (!isEditableState(state)) {
        throw new AppError('failed-precondition', 'This version is no longer editable. Sync the app to refresh its status.');
      }
      const updated = await api.updateVersion(editable.id, input.versionString);
      await appRef.update({
        [`versions.${platform}.editable.versionString`]: updated.versionString,
        deepSyncedAt: Timestamp.now(),
      });
      op.progress(1, 1);
      await op.finish('success', `${app.name} is now v${updated.versionString}`);
      return { versionId: updated.id, versionString: updated.versionString };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      await op.fail(err instanceof Error ? err.message : 'Could not change version.');
      throw err;
    }
  },
);
