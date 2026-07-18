import { z } from 'zod';
import {
  ALL_FIELDS,
  FIELD_SPECS,
  canUseAi,
  fieldKeyFor,
  fieldStatus,
  isKnownLocale,
  localeName,
  type AppDoc,
  type DraftDoc,
  type LocaleDoc,
  type MetadataField,
  type Platform,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { FieldValue, Timestamp, db, refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, invalid, notFound } from '../lib/errors';
import { consumeAiCredits, generateReviewReply, generateSuggestions, translateBatch } from '../lib/ai';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { startOperation } from '../lib/operations';

const platformSchema = z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);
const appStoreLocaleSchema = z.string().refine(isKnownLocale, {
  message: 'This language is not supported for App Store metadata.',
});
const aiFields = ALL_FIELDS.filter((f) => FIELD_SPECS[f].aiEligible);

/** Effective source text for a field: draft overlay first, then editable, then live. */
function sourceValue(
  app: AppDoc,
  platform: Platform,
  field: MetadataField,
  locale: LocaleDoc | null,
  draft: DraftDoc | null,
): string {
  const key = fieldKeyFor(platform, field);
  const draftValue = draft?.fields?.[key];
  if (draftValue?.trim()) return draftValue;
  if (!locale) return '';
  if (FIELD_SPECS[field].target === 'info') {
    const editable = locale.info?.editable?.[field as keyof NonNullable<NonNullable<typeof locale.info>['editable']>];
    const live = locale.info?.live?.[field as keyof NonNullable<NonNullable<typeof locale.info>['live']>];
    return editable?.trim() ? editable : live ?? '';
  }
  const branch = locale.versions?.[platform];
  const k = field as keyof NonNullable<NonNullable<typeof branch>['live']>;
  const editable = branch?.editable?.[k] as string | undefined;
  const live = branch?.live?.[k] as string | undefined;
  return editable?.trim() ? editable : live ?? '';
}

/**
 * What a push would currently write for this field on this locale — the value the
 * matrix calls "missing" when empty. Unlike sourceValue there is NO live fallback:
 * on a fresh version What's New is empty on the editable branch even though the
 * old release's notes still exist on live, and "fill missing" must fill it.
 */
export function targetCurrentValue(
  app: AppDoc,
  platform: Platform,
  field: MetadataField,
  locale: LocaleDoc | null,
  draft: DraftDoc | null,
): string {
  const key = fieldKeyFor(platform, field);
  const draftValue = draft?.fields?.[key];
  if (draftValue !== undefined) return draftValue;
  if (!locale) return '';
  if (FIELD_SPECS[field].target === 'info') {
    return locale.info?.editable?.[field as keyof NonNullable<NonNullable<typeof locale.info>['editable']>] ?? '';
  }
  const branch = locale.versions?.[platform];
  if (fieldStatus(app, platform, field).pushTarget === 'livePromo') {
    return branch?.live?.promotionalText ?? '';
  }
  return (branch?.editable?.[field as keyof NonNullable<NonNullable<typeof branch>['editable']>] as string | undefined) ?? '';
}

export const aiTranslate = defineCallable(
  'aiTranslate',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      sourceLocale: appStoreLocaleSchema,
      targetLocales: z.array(appStoreLocaleSchema).min(1).max(50),
      fields: z.array(z.enum(aiFields as [MetadataField, ...MetadataField[]])).min(1),
      overwrite: z.boolean().default(false),
    }),
    timeoutSeconds: 540,
    memory: '512MiB',
    authorize: (actor, input) => {
      requireAction(actor, 'editDrafts', input.storeId, input.appId);
      requireAction(actor, 'useAi', input.storeId, input.appId);
      const gate = canUseAi(actor.user, 'translate');
      if (!gate.ok) {
        throw new AppError(
          gate.reason === 'feature' ? 'permission-denied' : 'resource-exhausted',
          gate.reason === 'feature'
            ? 'AI translation isn’t enabled for your account — ask an admin.'
            : 'Your monthly AI credits are used up — ask an admin to raise the limit.',
        );
      }
    },
    audit: (input, out: { results: Array<{ locale: string; ok: boolean }> }) => ({
      action: 'ai.translate',
      storeId: input.storeId,
      appId: input.appId,
      detail: `${input.sourceLocale} → ${out.results.filter((r) => r.ok).length}/${input.targetLocales.length} locales, fields: ${input.fields.join(',')}`,
    }),
  },
  async (input, actor) => {
    const { storeId, appId, sourceLocale } = input;
    const platform = input.platform as Platform;
    const targets = input.targetLocales.filter((l) => l !== sourceLocale);
    if (targets.length === 0) throw invalid('Pick at least one target language.');

    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;

    const [srcLocaleSnap, srcDraftSnap] = await Promise.all([
      refs.locale(storeId, appId, sourceLocale).get(),
      refs.draft(storeId, appId, sourceLocale).get(),
    ]);
    const srcLocale = srcLocaleSnap.exists ? (srcLocaleSnap.data() as LocaleDoc) : null;
    const srcDraft = srcDraftSnap.exists ? (srcDraftSnap.data() as DraftDoc) : null;

    // Collect non-empty, AI-eligible source fields. The source may be a draft even
    // when its current Apple branch is locked; target editability is enforced at push.
    const fields: Record<string, string> = {};
    const limits: Record<string, number> = {};
    const labels: Record<string, string> = {};
    for (const field of input.fields) {
      const value = sourceValue(app, platform, field, srcLocale, srcDraft);
      if (value.trim() === '') continue;
      const key = fieldKeyFor(platform, field);
      fields[key] = value;
      limits[key] = FIELD_SPECS[field].maxLength;
      labels[key] = FIELD_SPECS[field].label;
    }
    if (Object.keys(fields).length === 0) {
      throw invalid(`Nothing to translate: the selected fields are empty in ${localeName(sourceLocale)}.`);
    }

    const op = await startOperation({
      type: 'ai-translate',
      label: `Translating ${app.name} → ${targets.length} ${targets.length === 1 ? 'language' : 'languages'}`,
      startedBy: actor.uid,
      storeId,
      appId,
    });

    const results: Array<{ locale: string; ok: boolean; fieldsWritten: number; error?: string }> = [];
    try {
      // Load every target's current state, then decide per (locale, field) what to send —
      // only missing fields unless overwrite is on. Skips wasted tokens.
      op.progress(0, targets.length);
      const targetState = new Map<string, { locale: LocaleDoc | null; draft: DraftDoc | null }>();
      await Promise.all(
        targets.map(async (target) => {
          const [tLocaleSnap, tDraftSnap] = await Promise.all([
            refs.locale(storeId, appId, target).get(),
            refs.draft(storeId, appId, target).get(),
          ]);
          targetState.set(target, {
            locale: tLocaleSnap.exists ? (tLocaleSnap.data() as LocaleDoc) : null,
            draft: tDraftSnap.exists ? (tDraftSnap.data() as DraftDoc) : null,
          });
        }),
      );

      const perLocale: Array<{ locale: string; fieldKeys: string[] }> = [];
      for (const target of targets) {
        const state = targetState.get(target)!;
        const keys: string[] = [];
        for (const key of Object.keys(fields)) {
          if (!input.overwrite) {
            const field = ALL_FIELDS.find((f) => fieldKeyFor(platform, f) === key)!;
            // "Missing" must mean what the matrix shows: the push-target value is
            // empty. The old live-branch fallback made fill-missing skip languages
            // whose previous release still had content (fresh What's New bug).
            const existing = targetCurrentValue(app, platform, field, state.locale, state.draft);
            if (existing.trim() !== '') continue;
          }
          keys.push(key);
        }
        perLocale.push({ locale: target, fieldKeys: keys });
      }

      // Fill-missing charges only languages that actually need work. Retranslate-all
      // naturally charges every selected language because each has requested fields.
      const chargeableLocales = perLocale.filter((item) => item.fieldKeys.length > 0).length;
      if (chargeableLocales > 0) await consumeAiCredits(actor.uid, chargeableLocales);

      const issues = new Map<string, string>();
      const translations =
        perLocale.some((p) => p.fieldKeys.length > 0)
          ? await translateBatch({ sourceLocale, appName: app.name, fields, limits, labels, perLocale }, issues)
          : {};

      op.progress(Math.floor(targets.length / 2), targets.length);

      // Land results into drafts (base = current remote) for human review.
      let done = 0;
      for (const target of targets) {
        done += 1;
        op.progress(done, targets.length);
        const state = targetState.get(target)!;
        const got = translations[target] ?? {};
        const wantedKeys = perLocale.find((p) => p.locale === target)?.fieldKeys ?? [];
        if (wantedKeys.length === 0) {
          results.push({ locale: target, ok: true, fieldsWritten: 0 });
          continue;
        }
        try {
          const patch: Record<string, unknown> = { status: 'open', updatedBy: actor.uid, updatedAt: Timestamp.now() };
          let written = 0;
          for (const key of wantedKeys) {
            const value = got[key];
            if (typeof value !== 'string' || value.trim() === '') continue;
            const field = ALL_FIELDS.find((f) => fieldKeyFor(platform, f) === key)!;
            // Compare/base against the push-target value (no live fallback): a fresh
            // version's empty field must accept a draft even when the translation
            // matches the previous release's live text.
            const remote = targetCurrentValue(app, platform, field, state.locale, null);
            if (value === remote) continue;
            patch[`fields.${key}`] = value;
            if (state.draft?.base?.[key] === undefined) patch[`base.${key}`] = remote;
            patch[`meta.${key}`] = { by: actor.uid, at: Timestamp.now(), ai: true };
            written += 1;
          }
          if (written > 0) await refs.draft(storeId, appId, target).set(unflattenDraft(patch), { merge: true });
          const ok = written > 0 || Object.keys(got).length > 0;
          results.push({
            locale: target,
            ok,
            fieldsWritten: written,
            error: ok ? undefined : (issues.get(target) ?? 'The AI returned nothing for this language'),
          });
        } catch (err) {
          results.push({ locale: target, ok: false, fieldsWritten: 0, error: err instanceof AppError ? err.message : 'Failed to save' });
        }
      }

      // Persist failures in red on the matrix (and clear rows that now succeeded)
      // so nobody has to catch a 4-second toast to know what needs a retry.
      const failurePatch: Record<string, unknown> = {};
      for (const r of results) {
        if (!r.ok) {
          const wanted = perLocale.find((p) => p.locale === r.locale)?.fieldKeys ?? [];
          failurePatch[`aiFailures.${r.locale}`] = {
            error: r.error ?? 'AI failed for this language',
            fields: wanted
              .map((key) => ALL_FIELDS.find((f) => fieldKeyFor(platform, f) === key))
              .filter((f): f is MetadataField => !!f),
            at: Timestamp.now(),
          };
        } else if (app.aiFailures?.[r.locale]) {
          failurePatch[`aiFailures.${r.locale}`] = FieldValue.delete();
        }
      }
      if (Object.keys(failurePatch).length > 0) {
        await refs.app(storeId, appId).update(failurePatch).catch(() => {});
      }

      const failed = results.filter((r) => !r.ok).length;
      await op.finish(
        failed === 0 ? 'success' : 'partial',
        `Translated ${app.name} — ${results.filter((r) => r.ok).length}/${targets.length} languages drafted`,
      );
      return { results };
    } catch (err) {
      await op.fail(err instanceof Error ? err.message : 'Translation failed');
      throw err;
    }
  },
);

function unflattenDraft(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    if (parts.length === 1) {
      out[path] = value;
      continue;
    }
    const [head, ...rest] = parts as [string, ...string[]];
    const key = rest.join('.');
    const bucket = (out[head] as Record<string, unknown> | undefined) ?? {};
    bucket[key] = value;
    out[head] = bucket;
  }
  return out;
}

export const aiGenerate = defineCallable(
  'aiGenerate',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      locale: appStoreLocaleSchema,
      kind: z.enum(['name', 'keywords', 'subtitle', 'improve-description', 'promotional-text', 'whatsnew']),
      // Firebase callable payloads can materialize an omitted JS property as null.
      // Accept both forms at the transport boundary and normalize below.
      context: z.string().max(1000).nullish(),
    }),
    timeoutSeconds: 120,
    authorize: (actor, input) => {
      requireAction(actor, 'editDrafts', input.storeId, input.appId);
      requireAction(actor, 'useAi', input.storeId, input.appId);
      const gate = canUseAi(actor.user, 'generate');
      if (!gate.ok) {
        throw new AppError(
          gate.reason === 'feature' ? 'permission-denied' : 'resource-exhausted',
          gate.reason === 'feature'
            ? 'AI generation isn’t enabled for your account — ask an admin.'
            : 'Your monthly AI credits are used up — ask an admin to raise the limit.',
        );
      }
    },
    audit: (input) => ({
      action: 'ai.generate',
      storeId: input.storeId,
      appId: input.appId,
      locale: input.locale,
      detail: input.kind,
    }),
  },
  async (input, actor) => {
    const appSnap = await refs.app(input.storeId, input.appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const platform = input.platform as Platform;

    const fieldByKind: Record<typeof input.kind, MetadataField> = {
      name: 'name',
      keywords: 'keywords',
      subtitle: 'subtitle',
      'improve-description': 'description',
      'promotional-text': 'promotionalText',
      whatsnew: 'whatsNew',
    };
    const field = fieldByKind[input.kind];

    const [localeSnap, draftSnap] = await Promise.all([
      refs.locale(input.storeId, input.appId, input.locale).get(),
      refs.draft(input.storeId, input.appId, input.locale).get(),
    ]);
    const localeDoc = localeSnap.exists ? (localeSnap.data() as LocaleDoc) : null;
    const current = sourceValue(
      app,
      platform,
      field,
      localeDoc,
      draftSnap.exists ? (draftSnap.data() as DraftDoc) : null,
    );

    await consumeAiCredits(actor.uid, 1);
    const options = await generateSuggestions({
      kind: input.kind,
      appName: app.name,
      locale: input.locale,
      currentValue: current,
      context: input.context ?? undefined,
      limit: FIELD_SPECS[field].maxLength,
      termsUrl: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
      privacyPolicyUrl:
        localeDoc?.info?.editable?.privacyPolicyUrl?.trim()
        || localeDoc?.info?.live?.privacyPolicyUrl?.trim()
        || undefined,
    });
    return { options, field, fieldKey: fieldKeyFor(platform, field) };
  },
);

/**
 * Draft a public reply to a customer review, grounded ONLY in the app's own
 * metadata (name, primary-locale description/subtitle, support URL). The review
 * is re-fetched from Apple server-side so generation never trusts client text.
 * Costs 1 AI credit; the user edits/approves before anything is sent to Apple.
 */
export const aiReviewReply = defineCallable(
  'aiReviewReply',
  {
    input: z.object({
      storeId: z.string().min(1),
      appId: z.string().min(1),
      platform: platformSchema.default('IOS'),
      reviewId: z.string().min(1),
      // Regenerate counter — lets "try again" produce a different phrasing.
      attempt: z.number().int().min(0).max(20).default(0),
    }),
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor, input) => {
      // Drafting is only offered where responding is possible…
      requireAction(actor, 'push', input.storeId, input.appId);
      requireAction(actor, 'useAi', input.storeId, input.appId);
      // …and consumes the same generation feature/credits as other AI tools.
      const gate = canUseAi(actor.user, 'generate');
      if (!gate.ok) {
        throw new AppError(
          gate.reason === 'feature' ? 'permission-denied' : 'resource-exhausted',
          gate.reason === 'feature'
            ? 'AI generation isn’t enabled for your account — ask an admin.'
            : 'Your monthly AI credits are used up — ask an admin to raise the limit.',
        );
      }
    },
    audit: (input) => ({
      action: 'ai.review-reply',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.reviewId,
    }),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;

    // Grounding context from the primary locale's cached metadata.
    const primarySnap = await refs.locale(storeId, appId, app.primaryLocale).get();
    const primary = primarySnap.exists ? (primarySnap.data() as LocaleDoc) : null;
    const platform = input.platform as Platform;
    const branch = primary?.versions?.[platform];
    const description = branch?.editable?.description ?? branch?.live?.description ?? '';
    const subtitle = primary?.info?.editable?.subtitle ?? primary?.info?.live?.subtitle ?? '';
    const supportUrl = (branch?.editable?.supportUrl ?? branch?.live?.supportUrl ?? '').trim() || undefined;

    const api = await getAscApi(storeId);
    try {
      const reviews = await api.listCustomerReviews(appId, 200);
      const review = reviews.find((r) => r.id === input.reviewId);
      if (!review) {
        throw new AppError('not-found', 'That review is no longer available from Apple — refresh the list.');
      }

      await consumeAiCredits(actor.uid, 1);
      const reply = await generateReviewReply({
        appName: app.name,
        appDescription: [subtitle, description.slice(0, 1200)].filter(Boolean).join('\n'),
        supportUrl,
        rating: review.rating,
        title: review.title,
        body: review.body,
        reviewerNickname: review.reviewerNickname,
        attempt: input.attempt || undefined,
      });
      return { reply };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);
