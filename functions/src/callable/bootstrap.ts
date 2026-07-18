import {
  DEFAULT_AI_GRANT,
  type AllowlistDoc,
  type GlobalSettingsDoc,
  type StoreGrant,
  type UserDoc,
} from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { FieldValue, Timestamp, db, refs } from '../lib/firestore';
import { writeAudit } from '../lib/audit';
import { lookupGeo } from '../lib/geo';
import { invalid } from '../lib/errors';
import { ADMIN_EMAILS } from '../config';

async function domainAllowed(email: string): Promise<boolean> {
  const snap = await refs.settings().get();
  const domains = (snap.exists ? (snap.data() as GlobalSettingsDoc).allowedDomains : []) ?? [];
  if (domains.length === 0) return true; // no restriction configured
  const domain = email.split('@')[1] ?? '';
  return domains.map((d) => d.toLowerCase().trim()).includes(domain);
}

type BootstrapResult =
  | { status: 'active' }
  | { status: 'disabled' }
  | { status: 'unprovisioned'; reason?: 'domain' };

/**
 * First contact after Google sign-in. Provisioning rules, in order:
 *  1. users/{uid} exists → refresh profile, report active/disabled.
 *  2. allowlist/{email} exists → provision the user from it (and denormalize store roles).
 *  3. email is in ADMIN_EMAILS → provision as admin.
 *  4. otherwise → unprovisioned (client offers the request-access flow).
 */
export const authBootstrap = defineCallable<unknown, BootstrapResult>(
  'authBootstrap',
  { allowUnprovisioned: true },
  async (_input, actor, req) => {
    const token = req.auth!.token;
    // Where/what this session comes from — shown to admins on Users & Access.
    const device =
      typeof (_input as { device?: unknown } | null)?.device === 'string'
        ? ((_input as { device: string }).device.slice(0, 120))
        : undefined;
    const buildLastLogin = async (previous?: UserDoc['lastLogin']) => {
      // Geo lookups are throttled: reuse the last result within 6 hours.
      const fresh = previous?.at && Date.now() - previous.at.toMillis() < 6 * 3600 * 1000;
      const geo = fresh
        ? { countryCode: previous?.countryCode, country: previous?.country, city: previous?.city }
        : await lookupGeo(req.rawRequest?.ip);
      return {
        at: Timestamp.now(),
        ...(device ? { device } : previous?.device ? { device: previous.device } : {}),
        ...(geo.countryCode ? { countryCode: geo.countryCode } : {}),
        ...(geo.country ? { country: geo.country } : {}),
        ...(geo.city ? { city: geo.city } : {}),
      };
    };
    const provider = (token.firebase?.sign_in_provider ?? '') as string;
    if (provider !== 'google.com') {
      throw invalid('Only Google sign-in is allowed.');
    }
    const email = (token.email ?? '').toLowerCase();
    if (!email) throw invalid('Google account has no email.');

    const uid = actor.uid;
    const profile = {
      email,
      name: (token.name as string | undefined) ?? email.split('@')[0]!,
      photoUrl: (token.picture as string | undefined) ?? null,
    };

    const userRef = refs.user(uid);
    const existing = await userRef.get();

    if (existing.exists) {
      const data = existing.data() as UserDoc;
      await userRef.update({ ...profile, lastLoginAt: Timestamp.now(), lastLogin: await buildLastLogin(data.lastLogin) });
      return { status: data.status === 'active' ? 'active' : 'disabled' };
    }

    // Try allowlist provisioning (explicit invites always bypass the domain filter).
    const allowRef = refs.allowlist(email);
    const allowSnap = await allowRef.get();
    if (allowSnap.exists) {
      const allow = allowSnap.data() as AllowlistDoc;
      await provisionUser(uid, profile, allow.role, allow.grants ?? {}, allow.ai ?? DEFAULT_AI_GRANT, await buildLastLogin());
      await allowRef.delete();
      await writeAudit({ uid, email }, { action: 'user.bootstrap', detail: `provisioned from allowlist as ${allow.role}` });
      return { status: 'active' };
    }

    // Bootstrap admins from configuration (also bypasses the domain filter).
    const adminEmails = ADMIN_EMAILS.value()
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.includes(email)) {
      await provisionUser(uid, profile, 'admin', {}, {
        features: { translate: true, generate: true },
        monthlyCredits: 1000,
      }, await buildLastLogin());
      await writeAudit({ uid, email }, { action: 'user.bootstrap', detail: 'provisioned as configured admin' });
      return { status: 'active' };
    }

    // Non-invited sign-ins: block if an email-domain allowlist is configured and doesn't match.
    if (!(await domainAllowed(email))) {
      return { status: 'unprovisioned', reason: 'domain' };
    }

    return { status: 'unprovisioned' };
  },
);

async function provisionUser(
  uid: string,
  profile: { email: string; name: string; photoUrl: string | null },
  role: 'admin' | 'member',
  grants: Record<string, StoreGrant>,
  ai: UserDoc['ai'],
  lastLogin?: UserDoc['lastLogin'],
): Promise<void> {
  // Grants may reference stores deleted since the allowlist entry was written — only
  // denormalize onto stores that still exist, and drop stale grants from the user doc.
  const storeIds = Object.keys(grants);
  const existing = new Set<string>();
  if (storeIds.length > 0) {
    const snaps = await db().getAll(...storeIds.map((sid) => refs.store(sid)));
    for (const snap of snaps) if (snap.exists) existing.add(snap.id);
  }
  const liveGrants = Object.fromEntries(Object.entries(grants).filter(([sid]) => existing.has(sid)));

  const batch = db().batch();
  batch.set(refs.user(uid), {
    ...profile,
    role,
    status: 'active',
    grants: liveGrants,
    ai,
    createdAt: Timestamp.now(),
    lastLoginAt: Timestamp.now(),
    ...(lastLogin ? { lastLogin } : {}),
  });

  // Denormalize membership onto store docs (rules + provable list queries).
  for (const [storeId, grant] of Object.entries(liveGrants)) {
    batch.update(refs.store(storeId), {
      [`roles.${uid}`]: grant.role,
      memberUids: FieldValue.arrayUnion(uid),
    });
  }
  // Clear any stale access request.
  batch.delete(refs.accessRequest(uid));
  await batch.commit();
}
