import { z } from 'zod';
import {
  STORE_ICONS,
  assignDistinctColors,
  defaultStoreColor,
  isHexColor,
  isStoreColor,
  type StoreDoc,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { FieldValue, Timestamp, db, refs } from '../lib/firestore';
import { requireAdmin } from '../lib/authz';
import { invalid, notFound } from '../lib/errors';
import { encryptSecret } from '../lib/crypto';
import { AscClient } from '../lib/asc/client';
import { getAscApi, markStoreAuthError } from '../lib/asc/factory';
import { mockAscEnabled } from '../config';

const p8Schema = z
  .string()
  .trim()
  .refine((v) => v.includes('BEGIN PRIVATE KEY') && v.includes('END PRIVATE KEY'), {
    message: 'Paste the full .p8 file contents, including the BEGIN/END PRIVATE KEY lines.',
  });

const credsSchema = z.object({
  issuerId: z.string().trim().min(10, 'Issuer ID looks too short.'),
  keyId: z.string().trim().min(6, 'Key ID looks too short.').max(20),
  p8: p8Schema,
});

/** Palette key or a generated unique #rrggbb color. */
const storeColorSchema = z
  .string()
  .max(20)
  .refine((v) => isStoreColor(v) || isHexColor(v), { message: 'Unknown color.' });

async function verifyCredentials(creds: z.infer<typeof credsSchema>): Promise<number> {
  const client = new AscClient({ issuerId: creds.issuerId, keyId: creds.keyId, p8: creds.p8 });
  const { appsCount } = await client.verify();
  return appsCount;
}

export const storesAdd = defineCallable(
  'storesAdd',
  {
    input: z.object({
      name: z.string().trim().min(1).max(60),
      mock: z.boolean().optional(),
      color: storeColorSchema.optional(),
      icon: z.enum(STORE_ICONS as unknown as [string, ...string[]]).optional(),
      vendorNumber: z.string().trim().regex(/^\d{5,12}$/, 'Vendor number is 5–12 digits').optional(),
      creds: credsSchema.optional(),
    }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: (input, out: { storeId: string }) => ({
      action: 'store.add',
      storeId: out.storeId,
      detail: `${input.name}${input.mock ? ' (mock)' : ''}`,
    }),
  },
  async (input, actor) => {
    const mock = !!input.mock;
    if (!mock && !input.creds) throw invalid('API credentials are required.');
    if (mock && !mockAscEnabled()) throw invalid('Mock stores are only available in the emulator.');

    let appsCount = 0;
    if (!mock && input.creds) {
      appsCount = await verifyCredentials(input.creds); // throws a friendly error if the key is bad
    }

    const storeRef = db().collection('stores').doc();
    const batch = db().batch();
    batch.set(storeRef, {
      name: input.name,
      status: 'ok',
      color: input.color ?? defaultStoreColor(storeRef.id),
      icon: input.icon ?? 'store',
      ...(input.vendorNumber ? { vendorNumber: input.vendorNumber } : {}),
      roles: {},
      memberUids: [],
      appsCount,
      createdBy: actor.uid,
      createdAt: Timestamp.now(),
      ...(mock ? { mock: true } : {}),
    });
    if (!mock && input.creds) {
      batch.set(refs.storeSecret(storeRef.id), {
        issuerId: input.creds.issuerId,
        keyId: input.creds.keyId,
        p8: encryptSecret(input.creds.p8, storeRef.id),
        addedBy: actor.uid,
        addedAt: Timestamp.now(),
      });
    }
    await batch.commit();
    return { storeId: storeRef.id, appsCount };
  },
);

export const storesTest = defineCallable(
  'storesTest',
  {
    input: z.object({ storeId: z.string().min(1) }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
  },
  async (input) => {
    try {
      const api = await getAscApi(input.storeId);
      const { appsCount } = await api.verify();
      await refs.store(input.storeId).update({ status: 'ok', appsCount });
      return { ok: true, appsCount };
    } catch (err) {
      await markStoreAuthError(input.storeId, err);
      throw err;
    }
  },
);

export const storesUpdateKey = defineCallable(
  'storesUpdateKey',
  {
    input: z.object({ storeId: z.string().min(1), creds: credsSchema }),
    usesAscKey: true,
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: 'store.update-key', storeId: input.storeId }),
  },
  async (input, actor) => {
    const snap = await refs.store(input.storeId).get();
    if (!snap.exists) throw notFound('Store');
    const appsCount = await verifyCredentials(input.creds);
    await refs.storeSecret(input.storeId).set({
      issuerId: input.creds.issuerId,
      keyId: input.creds.keyId,
      p8: encryptSecret(input.creds.p8, input.storeId),
      addedBy: actor.uid,
      addedAt: Timestamp.now(),
    });
    await refs.store(input.storeId).update({ status: 'ok', appsCount });
    return { ok: true, appsCount };
  },
);

export const storesRename = defineCallable(
  'storesRename',
  {
    input: z.object({
      storeId: z.string().min(1),
      name: z.string().trim().min(1).max(60).optional(),
      color: storeColorSchema.optional(),
      icon: z.enum(STORE_ICONS as unknown as [string, ...string[]]).optional(),
      vendorNumber: z.string().trim().regex(/^\d{5,12}$/, 'Vendor number is 5–12 digits').nullable().optional(),
    }),
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: 'store.update', storeId: input.storeId, detail: input.name ?? 'appearance' }),
  },
  async (input) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color;
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.vendorNumber !== undefined) {
      patch.vendorNumber = input.vendorNumber === null ? FieldValue.delete() : input.vendorNumber;
    }
    if (Object.keys(patch).length > 0) await refs.store(input.storeId).update(patch);
    return { ok: true };
  },
);

export const storesDelete = defineCallable(
  'storesDelete',
  {
    input: z.object({ storeId: z.string().min(1) }),
    timeoutSeconds: 300,
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: 'store.delete', storeId: input.storeId }),
  },
  async (input) => {
    const storeRef = refs.store(input.storeId);
    const snap = await storeRef.get();
    if (!snap.exists) throw notFound('Store');
    const store = snap.data() as StoreDoc;

    // Remove the store from every member's grants.
    const grantHolders = Object.keys(store.roles ?? {});
    if (grantHolders.length > 0) {
      const batch = db().batch();
      for (const uid of grantHolders) {
        batch.update(refs.user(uid), { [`grants.${input.storeId}`]: FieldValue.delete() });
      }
      await batch.commit();
    }

    await refs.storeSecret(input.storeId).delete().catch(() => {});
    await db().recursiveDelete(storeRef);
    return { ok: true };
  },
);

/**
 * One-shot recolor: spread every store evenly around the hue wheel so no two
 * are the same or similar. Deterministic (ordered by createdAt) → idempotent.
 */
export const storesRecolor = defineCallable(
  'storesRecolor',
  {
    timeoutSeconds: 60,
    authorize: (actor) => requireAdmin(actor),
    audit: () => ({ action: 'store.recolor-all' }),
  },
  async (_input: Record<string, never>) => {
    const snap = await db().collection('stores').get();
    const stores = snap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() as StoreDoc }))
      .sort((a, b) => (a.data.createdAt?.toMillis() ?? 0) - (b.data.createdAt?.toMillis() ?? 0) || a.id.localeCompare(b.id));
    const colors = assignDistinctColors(stores.length);
    const batch = db().batch();
    stores.forEach((store, i) => batch.update(refs.store(store.id), { color: colors[i] }));
    await batch.commit();
    return { recolored: stores.length };
  },
);
