import { describe, expect, it } from 'vitest';
import { can, delegationViolations, hasAnyManageMembers, roleAllows, type UserDoc } from '../../shared/src/index';

function member(grants: UserDoc['grants']): Pick<UserDoc, 'role' | 'status' | 'grants'> {
  return { role: 'member', status: 'active', grants };
}

describe('granular store permissions', () => {
  it('keeps role defaults when no override exists', () => {
    const user = member({ store: { role: 'translator' } });
    expect(can(user, 'editDrafts', 'store', 'app')).toBe(true);
    expect(can(user, 'push', 'store', 'app')).toBe(false);
  });

  it('can explicitly grant or deny a capability', () => {
    const user = member({
      store: {
        role: 'viewer',
        permissions: { editDrafts: true, view: false },
      },
    });
    expect(can(user, 'editDrafts', 'store', 'app')).toBe(true);
    expect(can(user, 'view', 'store', 'app')).toBe(false);
  });

  it('never lets a permission override escape a specific-app allowlist', () => {
    const user = member({
      store: {
        role: 'viewer',
        apps: { allowed: 'viewer' },
        permissions: { editDrafts: true },
      },
    });
    expect(can(user, 'editDrafts', 'store', 'allowed')).toBe(true);
    expect(can(user, 'editDrafts', 'store', 'hidden')).toBe(false);
  });

  it('keeps workspace administration admin-only', () => {
    const user = member({ store: { role: 'manager' } });
    expect(can(user, 'manageUsers', 'store')).toBe(false);
    expect(can({ role: 'admin', status: 'active', grants: {} }, 'manageUsers', 'store')).toBe(true);
  });

  it('viewFinance and manageMembers are never role defaults, only explicit grants', () => {
    for (const role of ['viewer', 'translator', 'editor', 'manager'] as const) {
      expect(roleAllows(role, 'viewFinance')).toBe(false);
      expect(roleAllows(role, 'manageMembers')).toBe(false);
    }
    const granted = member({ store: { role: 'viewer', permissions: { viewFinance: true } } });
    expect(can(granted, 'viewFinance', 'store')).toBe(true);
    expect(can(member({ store: { role: 'manager' } }), 'viewFinance', 'store')).toBe(false);
  });
});

describe('delegated team management (attenuation)', () => {
  const manager = (): UserDoc =>
    ({
      role: 'member',
      status: 'active',
      grants: { s1: { role: 'editor', permissions: { manageMembers: true, viewFinance: true } } },
      ai: { features: { translate: true, generate: false }, monthlyCredits: 50 },
    }) as unknown as UserDoc;

  it('allows granting a subset of one’s own access', () => {
    expect(
      delegationViolations(manager(), {
        grants: { s1: { role: 'translator', permissions: { viewFinance: true } } },
        ai: { features: { translate: true, generate: false }, monthlyCredits: 25 },
      }),
    ).toEqual([]);
  });

  it('blocks stores the actor does not manage', () => {
    expect(delegationViolations(manager(), { grants: { s2: { role: 'viewer' } } })[0]).toMatch(/don’t manage members/);
  });

  it('blocks roles above the actor’s own', () => {
    expect(
      delegationViolations(manager(), { grants: { s1: { role: 'manager' } } })[0],
    ).toMatch(/exceeds your own role/);
  });

  it('blocks permissions the actor lacks (incl. chained manageMembers rules)', () => {
    // Editor lacks addLanguage (manager-level) — cannot hand it out.
    expect(
      delegationViolations(manager(), {
        grants: { s1: { role: 'viewer', permissions: { addLanguage: true } } },
      })[0],
    ).toMatch(/can’t grant "addLanguage"/);
    // But CAN pass on manageMembers, which they hold → chainable delegation.
    expect(
      delegationViolations(manager(), {
        grants: { s1: { role: 'viewer', permissions: { manageMembers: true } } },
      }),
    ).toEqual([]);
  });

  it('caps AI features and credits at the actor’s own', () => {
    expect(
      delegationViolations(manager(), {
        grants: { s1: { role: 'viewer' } },
        ai: { features: { translate: false, generate: true }, monthlyCredits: 10 },
      })[0],
    ).toMatch(/AI generate/);
    expect(
      delegationViolations(manager(), {
        grants: { s1: { role: 'viewer' } },
        ai: { features: { translate: true, generate: false }, monthlyCredits: 51 },
      })[0],
    ).toMatch(/capped at your own limit/);
  });

  it('admins bypass attenuation; plain members have no team access', () => {
    const admin = { role: 'admin', status: 'active', grants: {} } as unknown as UserDoc;
    expect(delegationViolations(admin, { grants: { anything: { role: 'manager' } } })).toEqual([]);
    expect(hasAnyManageMembers(admin)).toBe(true);
    expect(hasAnyManageMembers(member({ s1: { role: 'manager' } }) as UserDoc)).toBe(false);
    expect(hasAnyManageMembers(manager())).toBe(true);
  });
});

describe('developer role', () => {
  it('sits between editor and manager: release engineering yes, language/team ops no', () => {
    const dev = member({ s1: { role: 'developer' } });
    expect(can(dev, 'push', 's1')).toBe(true);
    expect(can(dev, 'createVersion', 's1')).toBe(true);
    expect(can(dev, 'manageTestFlight', 's1')).toBe(true);
    expect(can(dev, 'manageSubmissions', 's1')).toBe(true);
    expect(can(dev, 'manageIap', 's1')).toBe(true);
    expect(can(dev, 'addLanguage', 's1')).toBe(false);
    expect(can(dev, 'forceSync', 's1')).toBe(false);
    expect(can(dev, 'viewFinance', 's1')).toBe(false);
    expect(can(dev, 'manageMembers', 's1')).toBe(false);
  });

  it('editors do NOT get the new release capabilities by role; managers do', () => {
    const editor = member({ s1: { role: 'editor' } });
    expect(can(editor, 'manageTestFlight', 's1')).toBe(false);
    expect(can(editor, 'manageSubmissions', 's1')).toBe(false);
    expect(can(editor, 'createVersion', 's1')).toBe(false);
    const mgr = member({ s1: { role: 'manager' } });
    expect(can(mgr, 'manageTestFlight', 's1')).toBe(true);
    expect(can(mgr, 'manageSubmissions', 's1')).toBe(true);
    expect(can(mgr, 'manageIap', 's1')).toBe(true);
  });

  it('new capabilities are grantable à la carte to any role', () => {
    const viewer = member({ s1: { role: 'viewer', permissions: { manageTestFlight: true } } });
    expect(can(viewer, 'manageTestFlight', 's1')).toBe(true);
    expect(can(viewer, 'manageSubmissions', 's1')).toBe(false);
    expect(roleAllows('developer', 'manageSubmissions')).toBe(true);
    expect(roleAllows('editor', 'manageSubmissions')).toBe(false);
  });

  it('attenuation: a developer-managing user cannot grant a manager role or perms they lack', () => {
    const devManager = {
      role: 'member',
      status: 'active',
      grants: { s1: { role: 'developer', permissions: { manageMembers: true } } },
      ai: { features: { translate: false, generate: false }, monthlyCredits: 0 },
    } as unknown as UserDoc;
    expect(
      delegationViolations(devManager, { grants: { s1: { role: 'manager' } } })[0],
    ).toMatch(/exceeds your own role/);
    expect(
      delegationViolations(devManager, {
        grants: { s1: { role: 'viewer', permissions: { forceSync: true } } },
      })[0],
    ).toMatch(/can’t grant "forceSync"/);
    expect(
      delegationViolations(devManager, {
        grants: { s1: { role: 'developer', permissions: { manageTestFlight: true } } },
      }),
    ).toEqual([]);
  });
});

describe('manageProvisioning', () => {
  it('is explicit-grant only — no role includes it, admins have it', () => {
    expect(can(member({ s1: { role: 'manager' } }), 'manageProvisioning', 's1')).toBe(false);
    expect(can(member({ s1: { role: 'developer' } }), 'manageProvisioning', 's1')).toBe(false);
    expect(can(member({ s1: { role: 'viewer', permissions: { manageProvisioning: true } } }), 'manageProvisioning', 's1')).toBe(true);
    const admin = { role: 'admin', status: 'active', grants: {} } as unknown as UserDoc;
    expect(can(admin, 'manageProvisioning', 'anywhere')).toBe(true);
  });
});
