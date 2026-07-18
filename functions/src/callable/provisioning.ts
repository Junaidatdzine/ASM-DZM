import { z } from 'zod';
import { defineCallable } from '../lib/wrap';
import { requireAction } from '../lib/authz';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';

const target = z.object({ storeId: z.string().min(1) });

/**
 * Apple Developer provisioning (bundle IDs) through the same ASC key.
 * Registering an App ID is the API-side half of creating a new app — the app
 * record itself can only be created in App Store Connect's UI (Apple exposes
 * no endpoint for it), which the web app explains and deep-links.
 */
export const bundleIdsList = defineCallable(
  'bundleIdsList',
  {
    input: target,
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageProvisioning', input.storeId),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      return { bundleIds: await api.listBundleIds() };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const bundleIdCreate = defineCallable(
  'bundleIdCreate',
  {
    input: target.extend({
      identifier: z
        .string()
        .trim()
        .min(3)
        .max(155)
        .regex(/^[A-Za-z0-9.-]+$/, 'Bundle IDs may only use letters, numbers, dots and hyphens.'),
      name: z.string().trim().min(1).max(64),
      platform: z.enum(['IOS', 'MAC_OS', 'UNIVERSAL']),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageProvisioning', input.storeId),
    audit: (input) => ({
      action: 'provisioning.bundle-id-create',
      storeId: input.storeId,
      detail: `${input.identifier} (${input.platform})`,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      const bundleId = await api.createBundleId(input.identifier, input.name, input.platform);
      return { bundleId };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const bundleIdDelete = defineCallable(
  'bundleIdDelete',
  {
    input: target.extend({ bundleIdId: z.string().min(1), identifier: z.string().nullish().transform((v) => v ?? '') }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor, input) => requireAction(actor, 'manageProvisioning', input.storeId),
    audit: (input) => ({
      action: 'provisioning.bundle-id-delete',
      storeId: input.storeId,
      detail: input.identifier || input.bundleIdId,
    }),
  },
  async (input) => {
    const api = await getAscApi(input.storeId);
    try {
      await api.deleteBundleId(input.bundleIdId);
      return { ok: true };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);
