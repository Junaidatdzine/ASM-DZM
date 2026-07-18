import type { StoreGrant, StorePermission, StoreRole, UserDoc } from './types';

/**
 * Single permission resolver used by BOTH the UI (to show/hide/disable controls) and
 * functions authz (to enforce). Firestore rules enforce the coarse store-level subset.
 */
export type Action =
  | StorePermission
  | 'manageStore' // store credentials & members & deletion — admin only
  | 'manageUsers' // admin only
  | 'viewAudit'; // admin only

const ROLE_LEVEL: Record<StoreRole, number> = { viewer: 1, translator: 2, editor: 3, developer: 4, manager: 5 };

/** Above every role: reachable ONLY through an explicit permission override (default no). */
const NEVER_BY_ROLE = ROLE_LEVEL.manager + 1;

const MIN_LEVEL: Record<Action, number> = {
  view: ROLE_LEVEL.viewer,
  editDrafts: ROLE_LEVEL.translator, // translators edit drafts + use AI…
  useAi: ROLE_LEVEL.translator,
  push: ROLE_LEVEL.editor, // …but only editors+ can push to Apple
  addLanguage: ROLE_LEVEL.manager,
  manageScreenshots: ROLE_LEVEL.editor,
  removeLanguage: ROLE_LEVEL.manager,
  createVersion: ROLE_LEVEL.developer, // release engineering starts at developer
  forceSync: ROLE_LEVEL.manager,
  manageTestFlight: ROLE_LEVEL.developer,
  manageSubmissions: ROLE_LEVEL.developer,
  manageIap: ROLE_LEVEL.developer,
  viewFinance: NEVER_BY_ROLE, // financial data: explicit grant only
  manageMembers: NEVER_BY_ROLE, // team delegation: explicit grant only
  manageProvisioning: NEVER_BY_ROLE, // bundle IDs / Developer portal: explicit grant only
  manageStore: Infinity, // admin only
  manageUsers: Infinity,
  viewAudit: Infinity,
};

export const STORE_PERMISSION_OPTIONS: ReadonlyArray<{
  key: StorePermission;
  label: string;
  hint: string;
}> = [
  { key: 'view', label: 'View apps and metadata', hint: 'Open assigned apps and read App Store data.' },
  { key: 'editDrafts', label: 'Edit metadata drafts', hint: 'Create and edit local metadata drafts.' },
  { key: 'useAi', label: 'Use AI tools', hint: 'Translate and generate within the separate AI quota.' },
  { key: 'push', label: 'Push to Apple', hint: 'Send selected draft metadata to App Store Connect.' },
  { key: 'manageScreenshots', label: 'Manage screenshots', hint: 'Upload, reorder, preview, and delete screenshots.' },
  { key: 'addLanguage', label: 'Add languages', hint: 'Create supported App Store localizations.' },
  { key: 'removeLanguage', label: 'Remove languages', hint: 'Delete localizations from editable versions.' },
  { key: 'createVersion', label: 'Create versions', hint: 'Create or change editable App Store versions.' },
  { key: 'manageTestFlight', label: 'Manage TestFlight', hint: 'Add and remove beta testers in TestFlight groups.' },
  { key: 'manageSubmissions', label: 'Send for review', hint: 'Submit versions to App Review, cancel or resubmit rejected submissions.' },
  { key: 'manageIap', label: 'Manage subscriptions', hint: 'Create subscription groups and subscriptions, submit them for review.' },
  { key: 'forceSync', label: 'Sync store app list', hint: 'Refresh the assigned store’s app catalog from Apple.' },
  { key: 'viewFinance', label: 'View finance reports', hint: 'Sales proceeds and downloads for this store. No role includes this — explicit grant only.' },
  { key: 'manageMembers', label: 'Manage team members', hint: 'Invite and manage users for this store, granting at most their own permissions. Explicit grant only.' },
  { key: 'manageProvisioning', label: 'Register bundle IDs', hint: 'Create and delete App IDs (bundle identifiers) for new apps in the Apple Developer account. Explicit grant only.' },
] as const;

export function roleAllows(role: StoreRole, action: StorePermission): boolean {
  return ROLE_LEVEL[role] >= MIN_LEVEL[action];
}

export const STORE_ROLE_LABELS: Record<StoreRole, { label: string; hint: string }> = {
  viewer: { label: 'Viewer', hint: 'Read-only' },
  translator: { label: 'Translator', hint: 'Edit drafts & use AI — cannot push to Apple' },
  editor: { label: 'Editor', hint: 'Edit, push & manage screenshots' },
  developer: { label: 'Developer', hint: 'Editor + versions, review submissions, TestFlight & subscriptions' },
  manager: { label: 'Manager', hint: 'Everything, incl. add/remove languages & force sync' },
};

export type PermissionSubject = Pick<UserDoc, 'role' | 'status' | 'grants'>;

/** Effective role for a user on (store, app?) — null means no access at all. */
export function effectiveRole(
  user: PermissionSubject,
  storeId: string,
  appId?: string,
): StoreRole | 'admin' | null {
  if (user.status !== 'active') return null;
  if (user.role === 'admin') return 'admin';
  const grant = user.grants?.[storeId];
  if (!grant) return null;
  if (appId && grant.apps) {
    const override = grant.apps[appId];
    if (override === 'none') return null;
    if (override) return override;
    // An explicit app map acts as an allowlist: unlisted apps are hidden.
    return null;
  }
  return grant.role;
}

export function can(
  user: PermissionSubject,
  action: Action,
  storeId: string,
  appId?: string,
): boolean {
  const role = effectiveRole(user, storeId, appId);
  if (role === null) return false;
  if (role === 'admin') return true;
  const override = user.grants?.[storeId]?.permissions?.[action as StorePermission];
  if (override !== undefined && action in MIN_LEVEL && MIN_LEVEL[action] !== Infinity) return override;
  return ROLE_LEVEL[role] >= MIN_LEVEL[action];
}

export function isAdminUser(user: PermissionSubject): boolean {
  return user.status === 'active' && user.role === 'admin';
}

export function canUseAi(
  user: Pick<UserDoc, 'role' | 'status' | 'ai'>,
  feature: 'translate' | 'generate',
): { ok: true } | { ok: false; reason: 'feature' | 'credits' } {
  if (user.status !== 'active') return { ok: false, reason: 'feature' };
  const ai = user.ai;
  if (!ai?.features?.[feature]) return { ok: false, reason: 'feature' };
  const month = new Date().toISOString().slice(0, 7);
  const used = ai.usage?.month === month ? ai.usage.used : 0;
  if (used >= ai.monthlyCredits) return { ok: false, reason: 'credits' };
  return { ok: true };
}

export function aiCreditsRemaining(user: Pick<UserDoc, 'ai'>): number {
  const ai = user.ai;
  if (!ai) return 0;
  const month = new Date().toISOString().slice(0, 7);
  const used = ai.usage?.month === month ? ai.usage.used : 0;
  return Math.max(0, ai.monthlyCredits - used);
}

// ---- Delegated team management (attenuation) ----

/** Stores where this user may manage members. Admins manage everywhere (returns null = all). */
export function managedStoreIds(user: PermissionSubject): string[] | null {
  if (isAdminUser(user)) return null;
  if (user.status !== 'active') return [];
  return Object.keys(user.grants ?? {}).filter((sid) => can(user, 'manageMembers', sid));
}

export function hasAnyManageMembers(user: PermissionSubject): boolean {
  const managed = managedStoreIds(user);
  return managed === null || managed.length > 0;
}

const ROLE_OF = (role: StoreRole): number => ROLE_LEVEL[role];

/**
 * Attenuation check for delegated user management: a non-admin may only hand out
 * a subset of what they hold. Returns human-readable violations (empty = allowed).
 * Pure and shared so the UI can disable exactly what the server would reject.
 */
export function delegationViolations(
  actor: Pick<UserDoc, 'role' | 'status' | 'grants' | 'ai'>,
  target: {
    grants: Record<string, StoreGrant>;
    ai?: Pick<AiGrantLike, 'features' | 'monthlyCredits'>;
  },
  opts?: { allowEmpty?: boolean },
): string[] {
  if (isAdminUser(actor)) return [];
  const problems: string[] = [];
  const stores = Object.entries(target.grants);
  // Empty grants are meaningless on an invite, but valid on an update (= remove access).
  if (stores.length === 0 && !opts?.allowEmpty) problems.push('Assign at least one store you manage.');

  for (const [sid, grant] of stores) {
    if (!can(actor, 'manageMembers', sid)) {
      problems.push(`You don’t manage members for store ${sid}.`);
      continue;
    }
    const actorRole = effectiveRole(actor, sid);
    const actorLevel = actorRole === 'admin' ? Infinity : actorRole ? ROLE_OF(actorRole) : 0;
    if (ROLE_OF(grant.role) > actorLevel) {
      problems.push(`Role "${grant.role}" exceeds your own role in store ${sid}.`);
    }
    for (const [perm, value] of Object.entries(grant.permissions ?? {})) {
      if (value === true && !can(actor, perm as StorePermission, sid)) {
        problems.push(`You can’t grant "${perm}" in store ${sid} — you don’t have it yourself.`);
      }
    }
    // App scope: an app-limited actor may only assign apps they can access themselves.
    const actorApps = actor.grants?.[sid]?.apps;
    if (actorApps) {
      const allowedApps = new Set(
        Object.entries(actorApps).filter(([, r]) => r !== 'none').map(([appId]) => appId),
      );
      if (!grant.apps) {
        problems.push(`In store ${sid} you are limited to specific apps — the grant must list apps too.`);
      } else {
        for (const [appId, r] of Object.entries(grant.apps)) {
          if (r !== 'none' && !allowedApps.has(appId)) {
            problems.push(`App ${appId} in store ${sid} isn’t in your own app list.`);
          }
        }
      }
    }
    // Per-app role overrides must not exceed the actor's own effective role on that app.
    for (const [appId, appRole] of Object.entries(grant.apps ?? {})) {
      if (appRole === 'none') continue;
      const actorAppRole = effectiveRole(actor, sid, appId);
      const actorAppLevel = actorAppRole === 'admin' ? Infinity : actorAppRole ? ROLE_OF(actorAppRole) : 0;
      if (ROLE_OF(appRole) > actorAppLevel) {
        problems.push(`App ${appId} in store ${sid}: role "${appRole}" exceeds your own access.`);
      }
    }
  }

  if (target.ai) {
    const mine = actor.ai;
    if (target.ai.features.translate && !mine?.features?.translate) problems.push('You can’t grant AI translate — you don’t have it.');
    if (target.ai.features.generate && !mine?.features?.generate) problems.push('You can’t grant AI generate — you don’t have it.');
    if (target.ai.monthlyCredits > (mine?.monthlyCredits ?? 0)) {
      problems.push(`AI credits are capped at your own limit (${mine?.monthlyCredits ?? 0}).`);
    }
  }
  return problems;
}

interface AiGrantLike {
  features: { translate: boolean; generate: boolean };
  monthlyCredits: number;
}
