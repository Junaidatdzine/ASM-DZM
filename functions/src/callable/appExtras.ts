import { z } from 'zod';
import { getStorage } from 'firebase-admin/storage';
import {
  AGE_RATING_BOOL_FIELDS,
  AGE_RATING_LEVEL_FIELDS,
  CUSTOMER_REVIEW_RESPONSE_MAX,
  MAX_REVIEW_ATTACHMENT_BYTES,
  OPEN_SUBMISSION_STATES,
  REVIEW_DETAIL_LIMITS,
  can,
  isAgeRatingLevel,
  isKidsAgeBand,
  type AgeRatingLevel,
  type AgeRatingValues,
  type AppDoc,
  type LocaleDoc,
  type Platform,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { refs } from '../lib/firestore';
import { requireAction } from '../lib/authz';
import { AppError, invalid, notFound } from '../lib/errors';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { md5hex } from '../lib/asc/assets';
import { writeAudit } from '../lib/audit';
import type { AscAgeRating, AscApi } from '../lib/asc/types';

const platformSchema = z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']);
const target = z.object({
  storeId: z.string().min(1),
  appId: z.string().min(1),
  platform: platformSchema.default('IOS'),
});

type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof AppError ? err.message : 'Unavailable' };
  }
}

function toAgeRatingValues(decl: AscAgeRating | null): (AgeRatingValues & { id: string }) | null {
  if (!decl) return null;
  const levels: Record<string, AgeRatingLevel> = {};
  for (const { key } of AGE_RATING_LEVEL_FIELDS) {
    const v = decl.attributes[key];
    levels[key] = isAgeRatingLevel(v) ? v : 'NONE';
  }
  const booleans: Record<string, boolean> = {};
  for (const { key } of AGE_RATING_BOOL_FIELDS) {
    booleans[key] = decl.attributes[key] === true;
  }
  const band = decl.attributes['kidsAgeBand'];
  return { id: decl.id, levels, booleans, kidsAgeBand: isKidsAgeBand(band) ? band : null };
}

/**
 * One aggregated read for the Release + Store tabs: review details (+attachments),
 * phased release, open review submission, age rating, and every commerce/distribution
 * summary. Sections fail independently so one flaky endpoint never blanks the page.
 * Single invocation + server-side fan-out (client-side would be 15+ callable calls).
 */
export const appExtrasGet = defineCallable(
  'appExtrasGet',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 120,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable ?? null;
    const live = app.versions?.[platform]?.live ?? null;
    const releaseVersion = editable ?? live;

    const api = await getAscApi(storeId);
    const canManageRelease = can(actor.user, 'createVersion', storeId, appId);

    // Preview sets hang off the primary locale's version localization.
    const primarySnap = await refs.locale(storeId, appId, app.primaryLocale).get();
    const primaryLoc = primarySnap.exists ? (primarySnap.data() as LocaleDoc) : null;
    const previewLocId =
      primaryLoc?.versions?.[platform]?.ids?.editable ?? primaryLoc?.versions?.[platform]?.ids?.live ?? null;

    try {
      const [
        reviewDetail,
        phasedRelease,
        submissions,
        ageRating,
        availability,
        price,
        iaps,
        subscriptionGroups,
        eula,
        productPages,
        experiments,
        events,
        previewSets,
        betaGroups,
        recentBuilds,
        encryption,
      ] = await Promise.all([
        section(async () => {
          if (!releaseVersion) return null;
          const detail = await api.getReviewDetail(releaseVersion.id);
          if (!detail) return null;
          const attachments = await api.listReviewAttachments(detail.id).catch(() => []);
          return {
            ...detail,
            // The demo password is sensitive: only managers (who can edit it) receive it.
            demoAccountPassword: canManageRelease ? detail.demoAccountPassword : '',
            hasDemoPassword: detail.demoAccountPassword.length > 0,
            attachments: attachments.map((a) => ({
              id: a.id,
              fileName: a.fileName,
              fileSize: a.fileSize,
              assetState: a.assetState,
            })),
          };
        }),
        section(async () => (releaseVersion ? api.getPhasedRelease(releaseVersion.id) : null)),
        section(async () => {
          const all = await api.listReviewSubmissions(appId, platform);
          // Prefer the open submission; else the most recent one (so a rejection
          // that closed remains visible with its items).
          const latest = [...all].sort((a, b) => (b.submittedDate ?? '').localeCompare(a.submittedDate ?? ''));
          const current = all.find((sub) => OPEN_SUBMISSION_STATES.has(sub.state)) ?? latest[0] ?? null;
          if (!current) return null;
          const items = await api.listReviewSubmissionItems(current.id).catch(() => []);
          return { ...current, items };
        }),
        section(async () => {
          const infoId = app.appInfo?.editableId ?? app.appInfo?.liveId;
          if (!infoId) return null;
          return toAgeRatingValues(await api.getAgeRatingDeclaration(infoId));
        }),
        section(() => api.getAvailabilitySummary(appId)),
        section(() => api.getPriceSummary(appId)),
        section(() => api.listInAppPurchases(appId)),
        section(() => api.listSubscriptionGroups(appId)),
        section(() => api.getEulaText(appId)),
        section(() => api.listCustomProductPages(appId)),
        section(() => api.listExperiments(appId)),
        section(() => api.listAppEvents(appId)),
        section(async () => (previewLocId ? api.listPreviewSets(previewLocId) : [])),
        section(() => api.listBetaGroups(appId)),
        section(() => api.listRecentBuilds(appId, 10)),
        section(() => api.listEncryptionDeclarations(appId)),
      ]);

      return {
        versionString: releaseVersion?.versionString ?? null,
        versionEditable: !!editable,
        reviewDetail,
        phasedRelease,
        submission: submissions,
        ageRating,
        availability,
        price,
        iaps,
        subscriptionGroups,
        eula,
        productPages,
        experiments,
        events,
        previewSets,
        betaGroups,
        recentBuilds,
        encryption,
      };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

// ---- App Review details ----

const reviewDetailInput = target.extend({
  contactFirstName: z.string().trim().max(REVIEW_DETAIL_LIMITS.contactFirstName).default(''),
  contactLastName: z.string().trim().max(REVIEW_DETAIL_LIMITS.contactLastName).default(''),
  contactPhone: z.string().trim().max(REVIEW_DETAIL_LIMITS.contactPhone).default(''),
  contactEmail: z.string().trim().max(REVIEW_DETAIL_LIMITS.contactEmail).default(''),
  demoAccountName: z.string().trim().max(REVIEW_DETAIL_LIMITS.demoAccountName).default(''),
  demoAccountPassword: z.string().max(REVIEW_DETAIL_LIMITS.demoAccountPassword).default(''),
  demoAccountRequired: z.boolean().default(false),
  notes: z.string().max(REVIEW_DETAIL_LIMITS.notes).default(''),
});

export const reviewDetailSave = defineCallable(
  'reviewDetailSave',
  {
    input: reviewDetailInput,
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) {
      throw new AppError('failed-precondition', 'App Review details need an editable version. Create one first.');
    }

    const api = await getAscApi(storeId);
    try {
      const attrs = {
        contactFirstName: input.contactFirstName,
        contactLastName: input.contactLastName,
        contactPhone: input.contactPhone,
        contactEmail: input.contactEmail,
        demoAccountName: input.demoAccountName,
        demoAccountPassword: input.demoAccountPassword,
        demoAccountRequired: input.demoAccountRequired,
        notes: input.notes,
      };
      const existing = await api.getReviewDetail(editable.id);
      if (existing) await api.updateReviewDetail(existing.id, attrs);
      else await api.createReviewDetail(editable.id, attrs);

      // Contact info and credentials are sensitive — audit the action, never the values.
      await writeAudit(
        { uid: actor.uid, email: actor.email },
        { action: 'review.detail-save', storeId, appId, platform, result: 'ok', detail: existing ? 'updated' : 'created' },
      );
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

export const reviewAttachmentUpload = defineCallable(
  'reviewAttachmentUpload',
  {
    input: target.extend({
      storagePath: z.string().min(5),
      fileName: z.string().min(1).max(120),
    }),
    usesAscKey: true,
    timeoutSeconds: 300,
    memory: '512MiB',
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({
      action: 'review.attachment-upload',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.fileName,
    }),
  },
  async (input, actor) => {
    const { storeId, appId, storagePath } = input;
    const platform = input.platform as Platform;
    if (!storagePath.startsWith(`staging/${actor.uid}/`)) throw invalid('Invalid staging path.');

    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) {
      throw new AppError('failed-precondition', 'Attachments need an editable version. Create one first.');
    }

    const file = getStorage().bucket().file(storagePath);
    const [exists] = await file.exists();
    if (!exists) throw invalid('The uploaded file was not found (it may have expired). Try again.');
    const [buf] = await file.download();
    try {
      if (buf.length > MAX_REVIEW_ATTACHMENT_BYTES) throw invalid('Attachments are limited to 30 MB.');
      const api = await getAscApi(storeId);
      let detail = await api.getReviewDetail(editable.id);
      if (!detail) detail = await api.createReviewDetail(editable.id, {});
      const reserved = await api.reserveReviewAttachment(detail.id, input.fileName, buf.length);
      await api.uploadScreenshotParts(reserved.uploadOperations ?? [], buf);
      const committed = await api.commitReviewAttachment(reserved.id, md5hex(buf));
      return { attachmentId: committed.id, state: committed.assetState };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    } finally {
      await file.delete().catch(() => {});
    }
  },
);

export const reviewAttachmentDelete = defineCallable(
  'reviewAttachmentDelete',
  {
    input: target.extend({ attachmentId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({
      action: 'review.attachment-delete',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.attachmentId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    await api.deleteReviewAttachment(input.attachmentId);
    return { ok: true };
  },
);

// ---- Phased release ----

export const phasedReleaseSet = defineCallable(
  'phasedReleaseSet',
  {
    input: target.extend({
      action: z.enum(['enable', 'pause', 'resume', 'complete', 'disable']),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({
      action: 'release.phased-' + input.action,
      storeId: input.storeId,
      appId: input.appId,
    }),
  },
  async (input) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable ?? null;
    const live = app.versions?.[platform]?.live ?? null;
    // enable/disable configure the upcoming version; pause/resume/complete steer a live rollout.
    const version = input.action === 'enable' || input.action === 'disable' ? (editable ?? live) : (live ?? editable);
    if (!version) throw new AppError('failed-precondition', 'No version available for phased release.');

    const api = await getAscApi(storeId);
    try {
      const current = await api.getPhasedRelease(version.id);
      if (input.action === 'enable') {
        if (current) return { state: current.state };
        const created = await api.createPhasedRelease(version.id);
        return { state: created.state };
      }
      if (!current) throw new AppError('failed-precondition', 'No phased release exists for this version.');
      if (input.action === 'disable') {
        await api.deletePhasedRelease(current.id);
        return { state: null };
      }
      const nextState = input.action === 'pause' ? 'PAUSED' : input.action === 'resume' ? 'ACTIVE' : 'COMPLETE';
      const updated = await api.updatePhasedRelease(current.id, nextState);
      return { state: updated.state };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

// ---- Review submission ----

export const reviewSubmit = defineCallable(
  'reviewSubmit',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 120,
    authorize: (actor, input) => requireAction(actor, 'manageSubmissions', input.storeId, input.appId),
  },
  async (input, actor) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const editable = app.versions?.[platform]?.editable;
    if (!editable) {
      throw new AppError('failed-precondition', 'There is no editable version to submit. Create one first.');
    }
    if (!editable.build) {
      throw new AppError('failed-precondition', 'Attach a build in the Version tab before submitting for review.');
    }

    const api = await getAscApi(storeId);
    try {
      const open = (await api.listReviewSubmissions(appId, platform)).find((sub) =>
        OPEN_SUBMISSION_STATES.has(sub.state),
      );
      // UNRESOLVED_ISSUES = rejected: resubmitting the same submission is exactly
      // Apple's "Resubmit to App Review" flow after edits.
      if (open && open.state !== 'READY_FOR_REVIEW' && open.state !== 'UNRESOLVED_ISSUES') {
        throw new AppError('failed-precondition', 'A review submission is already in progress for this app.');
      }
      const submission = open ?? (await api.createReviewSubmission(appId, platform));
      await api.addReviewSubmissionItem(submission.id, editable.id).catch((err) => {
        // The version may already be in the submission (retry after a partial failure).
        if (!(err instanceof AppError && err.code === 'invalid-argument')) throw err;
      });
      const submitted = await api.submitReviewSubmission(submission.id);

      await refs.app(storeId, appId).update({
        [`versions.${platform}.editable.state`]: 'WAITING_FOR_REVIEW',
      }).catch(() => {});
      await writeAudit(
        { uid: actor.uid, email: actor.email },
        {
          action: 'review.submit',
          storeId,
          appId,
          platform,
          result: 'ok',
          detail: `v${editable.versionString} (build ${editable.build.version})`,
        },
      );
      return { state: submitted.state };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

export const reviewSubmissionCancel = defineCallable(
  'reviewSubmissionCancel',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageSubmissions', input.storeId, input.appId),
    audit: (input) => ({ action: 'review.submission-cancel', storeId: input.storeId, appId: input.appId }),
  },
  async (input) => {
    const { storeId, appId } = input;
    const platform = input.platform as Platform;
    const api = await getAscApi(storeId);
    try {
      const open = (await api.listReviewSubmissions(appId, platform)).find((sub) =>
        OPEN_SUBMISSION_STATES.has(sub.state),
      );
      if (!open) throw new AppError('failed-precondition', 'There is no active review submission to cancel.');
      await api.cancelReviewSubmission(open.id);
      // Reflect the withdrawn state in the cached version ref.
      const appSnap = await refs.app(storeId, appId).get();
      const app = appSnap.data() as AppDoc | undefined;
      if (app?.versions?.[platform]?.editable?.state === 'WAITING_FOR_REVIEW') {
        await refs.app(storeId, appId).update({
          [`versions.${platform}.editable.state`]: 'PREPARE_FOR_SUBMISSION',
        }).catch(() => {});
      }
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

// ---- Age rating ----

const levelSchema = z.enum(['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE']);

export const ageRatingSave = defineCallable(
  'ageRatingSave',
  {
    input: target.extend({
      levels: z.record(z.string(), levelSchema),
      booleans: z.record(z.string(), z.boolean()),
      kidsAgeBand: z.enum(['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN']).nullable(),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'createVersion', input.storeId, input.appId),
    audit: (input) => ({ action: 'compliance.age-rating-save', storeId: input.storeId, appId: input.appId }),
  },
  async (input) => {
    const { storeId, appId } = input;
    const appSnap = await refs.app(storeId, appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const infoId = app.appInfo?.editableId;
    if (!infoId) {
      throw new AppError('failed-precondition', 'Age ratings can only change while a version is being prepared.');
    }

    // Only accept known questionnaire keys — never pass arbitrary attributes to Apple.
    const attributes: Record<string, unknown> = {};
    for (const { key } of AGE_RATING_LEVEL_FIELDS) {
      const v = input.levels[key];
      if (v) attributes[key] = v;
    }
    for (const { key } of AGE_RATING_BOOL_FIELDS) {
      const v = input.booleans[key];
      if (v !== undefined) attributes[key] = v;
    }
    attributes['kidsAgeBand'] = input.kidsAgeBand;

    const api = await getAscApi(storeId);
    try {
      const decl = await api.getAgeRatingDeclaration(infoId);
      if (!decl) throw notFound('Age rating declaration');
      await api.updateAgeRatingDeclaration(decl.id, attributes);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(storeId, err);
      throw err;
    }
  },
);

// ---- Customer reviews ----

export const customerReviewsList = defineCallable(
  'customerReviewsList',
  {
    input: target.extend({ limit: z.number().int().min(1).max(200).default(50) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      const reviews = await api.listCustomerReviews(input.appId, input.limit);
      return { reviews };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const customerReviewRespond = defineCallable(
  'customerReviewRespond',
  {
    input: target.extend({
      reviewId: z.string().min(1),
      body: z.string().trim().min(1).max(CUSTOMER_REVIEW_RESPONSE_MAX),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'push', input.storeId, input.appId),
    audit: (input) => ({
      action: 'review.respond',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.reviewId,
      changes: [{ field: 'response', from: null, to: input.body }],
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      await api.respondToReview(input.reviewId, input.body);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const customerReviewResponseDelete = defineCallable(
  'customerReviewResponseDelete',
  {
    input: target.extend({ responseId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'push', input.storeId, input.appId),
    audit: (input) => ({
      action: 'review.response-delete',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.responseId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    await api.deleteReviewResponse(input.responseId);
    return { ok: true };
  },
);

// ---- TestFlight testers ----

export const testflightTestersList = defineCallable(
  'testflightTestersList',
  {
    input: target.extend({ groupId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      return { testers: await api.listBetaTesters(input.groupId) };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const testflightTesterAdd = defineCallable(
  'testflightTesterAdd',
  {
    input: target.extend({
      groupId: z.string().min(1),
      email: z.string().trim().email().max(255),
      firstName: z.string().trim().max(100).nullish().transform((v) => v ?? ''),
      lastName: z.string().trim().max(100).nullish().transform((v) => v ?? ''),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageTestFlight', input.storeId, input.appId),
    audit: (input) => ({
      action: 'testflight.tester-add',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.email,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      const tester = await api.createBetaTester(
        input.groupId,
        input.email,
        input.firstName || undefined,
        input.lastName || undefined,
      );
      return { tester };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const testflightTesterRemove = defineCallable(
  'testflightTesterRemove',
  {
    input: target.extend({ groupId: z.string().min(1), testerId: z.string().min(1), email: z.string().nullish().transform((v) => v ?? '') }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageTestFlight', input.storeId, input.appId),
    audit: (input) => ({
      action: 'testflight.tester-remove',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.email || input.testerId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      await api.removeBetaTesterFromGroup(input.groupId, input.testerId);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

// ---- Subscription creation ----

const SUBSCRIPTION_PERIODS = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'] as const;

export const subscriptionGroupCreate = defineCallable(
  'subscriptionGroupCreate',
  {
    input: target.extend({ referenceName: z.string().trim().min(1).max(64) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageIap', input.storeId, input.appId),
    audit: (input) => ({
      action: 'iap.group-create',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.referenceName,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      const group = await api.createSubscriptionGroup(input.appId, input.referenceName);
      return { group };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const subscriptionCreate = defineCallable(
  'subscriptionCreate',
  {
    input: target.extend({
      groupId: z.string().min(1),
      name: z.string().trim().min(1).max(64),
      productId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'Product IDs may only use letters, numbers, dots, dashes and underscores.'),
      period: z.enum(SUBSCRIPTION_PERIODS),
      /** Shopper-facing display name/description for the app's primary language. */
      displayName: z.string().trim().min(1).max(30),
      description: z.string().trim().max(45).nullish().transform((v) => v ?? ''),
    }),
    usesAscKey: true,
    timeoutSeconds: 90,
    authorize: (actor, input) => requireAction(actor, 'manageIap', input.storeId, input.appId),
    audit: (input) => ({
      action: 'iap.subscription-create',
      storeId: input.storeId,
      appId: input.appId,
      detail: `${input.name} (${input.productId})`,
    }),
  },
  async (input) => {
    const appSnap = await refs.app(input.storeId, input.appId).get();
    if (!appSnap.exists) throw notFound('App');
    const app = appSnap.data() as AppDoc;
    const api = await getAscApi(input.storeId);
    try {
      const sub = await api.createSubscription(input.groupId, {
        name: input.name,
        productId: input.productId,
        period: input.period,
        groupLevel: 1,
      });
      // The shopper-facing localization is required before Apple accepts a review.
      await api
        .createSubscriptionLocalization(sub.id, app.primaryLocale, input.displayName, input.description ?? '')
        .catch(() => {});
      return { subscription: sub };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const subscriptionSubmit = defineCallable(
  'subscriptionSubmit',
  {
    input: target.extend({ subscriptionId: z.string().min(1), name: z.string().nullish().transform((v) => v ?? '') }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageIap', input.storeId, input.appId),
    audit: (input) => ({
      action: 'iap.subscription-submit',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.name || input.subscriptionId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      await api.submitSubscription(input.subscriptionId);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

// ---- Pricing ----

export const pricePointsList = defineCallable(
  'pricePointsList',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'view', input.storeId, input.appId),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      return { pricePoints: await api.listPricePoints(input.appId) };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const priceScheduleSet = defineCallable(
  'priceScheduleSet',
  {
    input: target.extend({
      pricePointId: z.string().min(1),
      customerPrice: z.string().nullish().transform((v) => v ?? ''),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageIap', input.storeId, input.appId),
    audit: (input) => ({
      action: 'commerce.price-set',
      storeId: input.storeId,
      appId: input.appId,
      detail: input.customerPrice ? `$${input.customerPrice}` : input.pricePointId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      await api.setPriceSchedule(input.appId, input.pricePointId);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);
