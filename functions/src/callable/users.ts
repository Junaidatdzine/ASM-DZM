import { z } from 'zod';
import { getAuth } from 'firebase-admin/auth';
import {
  DEFAULT_AI_GRANT,
  delegationViolations,
  hasAnyManageMembers,
  isAdminUser,
  managedStoreIds,
  type AiGrant,
  type AllowlistDoc,
  type GlobalSettingsDoc,
  type StoreGrant,
  type UserDoc,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { FieldValue, Timestamp, db, refs } from '../lib/firestore';
import { requireAdmin, type Actor } from '../lib/authz';
import { invalid, notFound, notPermitted } from '../lib/errors';
import { AppError } from '../lib/errors';

const storeGrantSchema: z.ZodType<StoreGrant> = z.object({
  role: z.enum(['viewer', 'translator', 'editor', 'developer', 'manager']),
  apps: z.record(z.union([z.enum(['viewer', 'translator', 'editor', 'developer', 'manager']), z.literal('none')])).optional(),
  permissions: z.object({
    view: z.boolean().optional(),
    editDrafts: z.boolean().optional(),
    useAi: z.boolean().optional(),
    push: z.boolean().optional(),
    addLanguage: z.boolean().optional(),
    manageScreenshots: z.boolean().optional(),
    removeLanguage: z.boolean().optional(),
    createVersion: z.boolean().optional(),
    forceSync: z.boolean().optional(),
    viewFinance: z.boolean().optional(),
    manageMembers: z.boolean().optional(),
  }).optional(),
});

/** Admin, or a member holding manageMembers on at least one store. */
function requireUserManager(actor: Actor): void {
  if (actor.user.role === 'admin') return;
  if (!hasAnyManageMembers(actor.user)) throw notPermitted('manage users');
}

/** Delegated callers: every requested grant/AI value must be within the actor's own. */
function assertDelegationAllowed(
  actor: Actor,
  grants: Record<string, StoreGrant>,
  ai?: Pick<AiGrant, 'features' | 'monthlyCredits'>,
  opts?: { allowEmpty?: boolean },
): void {
  if (isAdminUser(actor.user)) return;
  const problems = delegationViolations(actor.user, { grants, ai }, opts);
  if (problems.length > 0) {
    throw new AppError('permission-denied', problems[0]!);
  }
}

/** Stores the delegated actor manages; used to scope reads and merges. */
function actorManagedStores(actor: Actor): Set<string> {
  const managed = managedStoreIds(actor.user);
  return new Set(managed ?? []);
}

const grantsSchema = z.record(storeGrantSchema);

const aiSchema: z.ZodType<AiGrant> = z.object({
  features: z.object({ translate: z.boolean(), generate: z.boolean() }),
  monthlyCredits: z.number().int().min(0).max(1_000_000),
  usage: z.object({ month: z.string(), used: z.number() }).optional(),
});

/** Apply grant changes to the denormalized store membership (roles map + memberUids). */
async function syncStoreMembership(
  uid: string,
  before: Record<string, StoreGrant>,
  after: Record<string, StoreGrant>,
): Promise<void> {
  const touched = new Set([...Object.keys(before), ...Object.keys(after)]);
  if (touched.size === 0) return;
  const snaps = await db().getAll(...[...touched].map((sid) => refs.store(sid)));
  const existing = new Set(snaps.filter((s) => s.exists).map((s) => s.id));

  const batch = db().batch();
  for (const sid of touched) {
    if (!existing.has(sid)) continue;
    const grant = after[sid];
    if (grant) {
      batch.update(refs.store(sid), {
        [`roles.${uid}`]: grant.role,
        memberUids: FieldValue.arrayUnion(uid),
      });
    } else {
      batch.update(refs.store(sid), {
        [`roles.${uid}`]: FieldValue.delete(),
        memberUids: FieldValue.arrayRemove(uid),
      });
    }
  }
  await batch.commit();

  // Mirror per-app overrides onto app docs so client draft rules can enforce the
  // same scope as callable authorization. An explicit app map is an allowlist.
  for (const sid of touched) {
    if (!existing.has(sid)) continue;
    const apps = await refs.store(sid).collection('apps').get();
    const appBatch = db().batch();
    const grant = after[sid];
    for (const app of apps.docs) {
      const override = grant?.apps ? (grant.apps[app.id] ?? 'none') : FieldValue.delete();
      appBatch.update(app.ref, { [`acl.${uid}`]: override });
    }
    if (!apps.empty) await appBatch.commit();
  }
}

/** Fails when this change would leave the workspace without an active admin. */
async function assertNotLastAdmin(targetUid: string): Promise<void> {
  const admins = await db()
    .collection('users')
    .where('role', '==', 'admin')
    .where('status', '==', 'active')
    .get();
  const others = admins.docs.filter((d) => d.id !== targetUid);
  if (others.length === 0) {
    throw new AppError('failed-precondition', 'You are the last active admin — add another admin first.');
  }
}

export const usersInvite = defineCallable(
  'usersInvite',
  {
    input: z.object({
      email: z.string().email().transform((e) => e.toLowerCase()),
      role: z.enum(['admin', 'member']),
      grants: grantsSchema.default({}),
      ai: aiSchema.default(DEFAULT_AI_GRANT),
    }),
    authorize: (actor) => requireUserManager(actor),
    audit: (input) => ({ action: 'user.invite', detail: `${input.email} as ${input.role}` }),
  },
  async (input, actor) => {
    if (!isAdminUser(actor.user)) {
      // Delegated invite: member-only, and never more access than the inviter holds.
      if (input.role !== 'member') throw notPermitted('invite admins');
      assertDelegationAllowed(actor, input.grants ?? {}, input.ai);
      // Admins may invite any address; managers are held to the workspace's
      // allowed domains whenever that list is configured.
      const settingsSnap = await refs.settings().get();
      const allowedDomains = ((settingsSnap.data() as GlobalSettingsDoc | undefined)?.allowedDomains ?? []).filter(Boolean);
      if (allowedDomains.length > 0) {
        const domain = input.email.split('@')[1] ?? '';
        if (!allowedDomains.includes(domain)) {
          throw new AppError(
            'permission-denied',
            `You can only invite ${allowedDomains.map((d) => `@${d}`).join(', ')} addresses — ask an admin to invite other domains.`,
          );
        }
      }
    }
    const dupe = await db().collection('users').where('email', '==', input.email).limit(1).get();
    if (!dupe.empty) throw invalid('This person already has access — edit them instead.');
    await refs.allowlist(input.email).set({
      role: input.role,
      grants: input.grants ?? {},
      ai: input.ai ?? DEFAULT_AI_GRANT,
      addedBy: actor.uid,
      addedAt: Timestamp.now(),
    } satisfies Omit<AllowlistDoc, 'addedAt'> & { addedAt: Timestamp });
    return { ok: true };
  },
);

/** A delegated actor may only touch invites that sit entirely inside their managed stores. */
function assertInviteWithinScope(actor: Actor, doc: AllowlistDoc): void {
  if (isAdminUser(actor.user)) return;
  if (doc.role === 'admin') throw notPermitted('modify admin invites');
  const managed = actorManagedStores(actor);
  for (const sid of Object.keys(doc.grants ?? {})) {
    if (!managed.has(sid)) throw notPermitted('modify invites outside your stores');
  }
}

export const allowlistUpdate = defineCallable(
  'allowlistUpdate',
  {
    input: z.object({
      email: z.string().email().transform((e) => e.toLowerCase()),
      role: z.enum(['admin', 'member']).optional(),
      grants: grantsSchema.optional(),
      ai: aiSchema.optional(),
    }),
    authorize: (actor) => requireUserManager(actor),
    audit: (input) => ({ action: 'user.invite-update', detail: input.email }),
  },
  async (input, actor) => {
    const ref = refs.allowlist(input.email);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('Invite');
    if (!isAdminUser(actor.user)) {
      assertInviteWithinScope(actor, snap.data() as AllowlistDoc);
      if (input.role === 'admin') throw notPermitted('promote invites to admin');
      if (input.grants) assertDelegationAllowed(actor, input.grants, input.ai);
      else if (input.ai) assertDelegationAllowed(actor, {}, input.ai);
    }
    const patch: Record<string, unknown> = {};
    if (input.role) patch.role = input.role;
    if (input.grants) patch.grants = input.grants;
    if (input.ai) patch.ai = input.ai;
    await ref.update(patch);
    return { ok: true };
  },
);

export const allowlistRemove = defineCallable(
  'allowlistRemove',
  {
    input: z.object({ email: z.string().email().transform((e) => e.toLowerCase()) }),
    authorize: (actor) => requireUserManager(actor),
    audit: (input) => ({ action: 'user.invite-revoke', detail: input.email }),
  },
  async (input, actor) => {
    const ref = refs.allowlist(input.email);
    if (!isAdminUser(actor.user)) {
      const snap = await ref.get();
      if (!snap.exists) throw notFound('Invite');
      assertInviteWithinScope(actor, snap.data() as AllowlistDoc);
    }
    await ref.delete();
    return { ok: true };
  },
);

export const usersUpdate = defineCallable(
  'usersUpdate',
  {
    input: z.object({
      uid: z.string().min(1),
      role: z.enum(['admin', 'member']).optional(),
      grants: grantsSchema.optional(),
      ai: aiSchema.optional(),
    }),
    authorize: (actor) => requireUserManager(actor),
    audit: (input) => ({ action: 'user.update', detail: input.uid }),
  },
  async (input, actor) => {
    const ref = refs.user(input.uid);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('User');
    const current = snap.data() as UserDoc;
    const delegated = !isAdminUser(actor.user);

    let nextGrants = input.grants;
    if (delegated) {
      // Delegated edits: members only, no role changes, and only the actor's
      // managed stores may change — everything else is preserved verbatim.
      if (current.role === 'admin') throw notPermitted('modify admins');
      if (input.uid === actor.uid) throw invalid('You can’t change your own access.');
      if (input.role !== undefined) throw notPermitted('change global roles');
      if (input.grants) {
        for (const sid of Object.keys(input.grants)) {
          if (!actorManagedStores(actor).has(sid)) throw notPermitted(`assign store ${sid}`);
        }
        // Empty payload = remove this person from every store the actor manages.
        assertDelegationAllowed(actor, input.grants, input.ai, { allowEmpty: true });
        // Merge: managed stores are replaced by the payload (absence = removal);
        // grants on stores the actor does NOT manage are kept untouched.
        const merged: Record<string, StoreGrant> = {};
        for (const [sid, grant] of Object.entries(current.grants ?? {})) {
          if (!actorManagedStores(actor).has(sid)) merged[sid] = grant;
        }
        for (const [sid, grant] of Object.entries(input.grants)) merged[sid] = grant;
        nextGrants = merged;
      } else if (input.ai) {
        assertDelegationAllowed(actor, {}, input.ai);
      }
    }

    if (input.role === 'member' && current.role === 'admin') {
      if (input.uid === actor.uid) throw invalid('You can’t remove your own admin role.');
      await assertNotLastAdmin(input.uid);
    }

    const patch: Record<string, unknown> = {};
    if (input.role) patch.role = input.role;
    if (nextGrants) patch.grants = nextGrants;
    if (input.ai) {
      // Replace the grant map and preserve server-owned usage when present. A delete
      // sentinel nested inside a map is invalid in Firestore update payloads.
      patch.ai = current.ai?.usage
        ? { features: input.ai.features, monthlyCredits: input.ai.monthlyCredits, usage: current.ai.usage }
        : { features: input.ai.features, monthlyCredits: input.ai.monthlyCredits };
    }
    await ref.update(patch);

    if (nextGrants) {
      await syncStoreMembership(input.uid, current.grants ?? {}, nextGrants);
    }
    return { ok: true };
  },
);

/**
 * Sanitized member/invite listing for delegated managers: only people whose access
 * touches the actor's managed stores, and only the slice of their grants for those
 * stores. Full workspace administration stays on the admin-only Users page.
 */
export const teamList = defineCallable(
  'teamList',
  {
    authorize: (actor) => requireUserManager(actor),
  },
  async (_input: Record<string, never>, actor) => {
    const managed = isAdminUser(actor.user)
      ? null // admins see everything (parity with /admin/users)
      : actorManagedStores(actor);

    const inScope = (grants: Record<string, StoreGrant>): boolean =>
      managed === null || Object.keys(grants ?? {}).some((sid) => managed.has(sid));
    const sliceGrants = (grants: Record<string, StoreGrant>): Record<string, StoreGrant> => {
      if (managed === null) return grants ?? {};
      const out: Record<string, StoreGrant> = {};
      for (const [sid, grant] of Object.entries(grants ?? {})) {
        if (managed.has(sid)) out[sid] = grant;
      }
      return out;
    };

    const [usersSnap, invitesSnap, storesSnap] = await Promise.all([
      db().collection('users').get(),
      db().collection('allowlist').get(),
      db().collection('stores').get(),
    ]);

    const members = usersSnap.docs
      .map((doc) => ({ uid: doc.id, data: doc.data() as UserDoc }))
      .filter(({ uid, data }) => uid !== actor.uid && data.role !== 'admin' && inScope(data.grants ?? {}))
      .map(({ uid, data }) => ({
        uid,
        name: data.name,
        email: data.email,
        photoUrl: data.photoUrl ?? null,
        status: data.status,
        grants: sliceGrants(data.grants ?? {}),
        ai: { features: data.ai?.features ?? { translate: false, generate: false }, monthlyCredits: data.ai?.monthlyCredits ?? 0 },
      }));

    const invites = invitesSnap.docs
      .map((doc) => ({ email: doc.id, data: doc.data() as AllowlistDoc }))
      .filter(({ data }) => data.role !== 'admin' && inScope(data.grants ?? {}))
      .map(({ email, data }) => ({ email, grants: sliceGrants(data.grants ?? {}) }));

    const managedStoreDocs = storesSnap.docs.filter((doc) => managed === null || managed.has(doc.id));
    const stores = await Promise.all(
      managedStoreDocs.map(async (doc) => {
        // App names power the "Specific apps" picker; select() keeps reads light.
        const apps = await refs.store(doc.id).collection('apps').select('name').get();
        return {
          storeId: doc.id,
          name: (doc.data() as { name?: string }).name ?? doc.id,
          apps: apps.docs.map((app) => ({ id: app.id, name: (app.data() as { name?: string }).name ?? app.id })),
        };
      }),
    );

    return { members, invites, stores };
  },
);

export const usersSetStatus = defineCallable(
  'usersSetStatus',
  {
    input: z.object({ uid: z.string().min(1), status: z.enum(['active', 'disabled']) }),
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({ action: input.status === 'disabled' ? 'user.disable' : 'user.enable', detail: input.uid }),
  },
  async (input, actor) => {
    if (input.uid === actor.uid) throw invalid('You can’t change your own status.');
    const ref = refs.user(input.uid);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('User');
    const user = snap.data() as UserDoc;
    if (user.role === 'admin' && input.status === 'disabled') await assertNotLastAdmin(input.uid);

    await ref.update({ status: input.status });

    // Auth-level enforcement: block token refresh immediately and kill existing sessions.
    try {
      await getAuth().updateUser(input.uid, { disabled: input.status === 'disabled' });
      if (input.status === 'disabled') await getAuth().revokeRefreshTokens(input.uid);
    } catch (err) {
      console.error('auth status update failed', err);
    }

    // Membership denorm: disabled users drop out of store member lists; enable restores.
    await syncStoreMembership(
      input.uid,
      input.status === 'disabled' ? (user.grants ?? {}) : {},
      input.status === 'disabled' ? {} : (user.grants ?? {}),
    );
    return { ok: true };
  },
);

export const accessRequestResolve = defineCallable(
  'accessRequestResolve',
  {
    input: z.object({
      uid: z.string().min(1),
      approve: z.boolean(),
      role: z.enum(['admin', 'member']).optional(),
      grants: grantsSchema.optional(),
      ai: aiSchema.optional(),
    }),
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({
      action: input.approve ? 'user.request-approve' : 'user.request-deny',
      detail: input.uid,
    }),
  },
  async (input) => {
    const reqRef = refs.accessRequest(input.uid);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) throw notFound('Access request');
    const request = reqSnap.data() as { email: string; name: string; photoUrl?: string | null };

    if (!input.approve) {
      await reqRef.delete();
      return { ok: true };
    }

    const grants = input.grants ?? {};
    const batch = db().batch();
    batch.set(refs.user(input.uid), {
      email: request.email,
      name: request.name,
      photoUrl: request.photoUrl ?? null,
      role: input.role ?? 'member',
      status: 'active',
      grants,
      ai: input.ai ?? DEFAULT_AI_GRANT,
      createdAt: Timestamp.now(),
    });
    batch.delete(reqRef);
    await batch.commit();
    await syncStoreMembership(input.uid, {}, grants);
    return { ok: true };
  },
);
