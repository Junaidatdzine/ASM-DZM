import { can, type Action, type UserDoc } from '@asm/shared';
import { accountDisabled, notPermitted, notSignedIn } from './errors';
import { getUserDoc } from './firestore';

export interface Actor {
  uid: string;
  email: string;
  user: UserDoc;
}

/** Load the caller's user doc and assert the account is active. */
export async function requireActiveUser(uid: string | undefined, email?: string): Promise<Actor> {
  if (!uid) throw notSignedIn();
  const user = await getUserDoc(uid);
  if (!user) throw notPermitted('use this app (no access has been granted)');
  if (user.status !== 'active') throw accountDisabled();
  return { uid, email: email ?? user.email, user };
}

export function requireAdmin(actor: Actor): void {
  if (actor.user.role !== 'admin') throw notPermitted('perform admin actions');
}

/** Assert the actor can perform `action` on (store, app?) using the shared resolver. */
export function requireAction(actor: Actor, action: Action, storeId: string, appId?: string): void {
  if (!can(actor.user, action, storeId, appId)) {
    throw notPermitted(describeAction(action));
  }
}

function describeAction(action: Action): string {
  const map: Partial<Record<Action, string>> = {
    view: 'view this store',
    editDrafts: 'edit metadata in this store',
    push: 'push changes to App Store Connect',
    addLanguage: 'add languages',
    manageScreenshots: 'manage screenshots',
    removeLanguage: 'remove languages',
    createVersion: 'create versions',
    forceSync: 'sync this store',
    viewFinance: 'view finance reports for this store',
    manageMembers: 'manage team members for this store',
    manageStore: 'manage store settings',
    manageUsers: 'manage users',
    viewAudit: 'view the audit log',
  };
  return map[action] ?? 'do this';
}
