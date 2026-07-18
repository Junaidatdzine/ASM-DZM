import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { doc } from 'firebase/firestore';
import { Sparkles, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { AiGrant, GlobalSettingsDoc, StoreGrant, StoreRole } from '@asm/shared';
import {
  DEFAULT_AI_GRANT,
  STORE_PERMISSION_OPTIONS,
  STORE_ROLE_LABELS,
  can,
  delegationViolations,
  effectiveRole,
  hasAnyManageMembers,
  roleAllows,
} from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveDoc } from '@/lib/hooks';
import { api, callableMessage } from '@/lib/callables';
import { useSession } from '@/auth/AuthProvider';
import { Page } from '@/layout/AppShell';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';

const ROLE_ORDER: StoreRole[] = ['viewer', 'translator', 'editor', 'developer', 'manager'];

interface EditorState {
  grants: Record<string, StoreGrant>;
  ai: Pick<AiGrant, 'features' | 'monthlyCredits'>;
}

type TeamStore = { storeId: string; name: string; apps: Array<{ id: string; name: string }> };

/**
 * Per-store grant editor constrained to the actor's own access: roles above the
 * actor's are not offered, permissions the actor lacks are disabled, AI credits
 * are capped. delegationViolations() gives the same verdict the server enforces.
 */
function DelegatedGrantEditor({
  stores,
  state,
  onChange,
}: {
  stores: TeamStore[];
  state: EditorState;
  onChange: (next: EditorState) => void;
}) {
  const { user } = useSession();
  if (!user) return null;

  const toggleStore = (storeId: string, on: boolean) => {
    const grants = { ...state.grants };
    if (on) grants[storeId] = grants[storeId] ?? { role: 'viewer' };
    else delete grants[storeId];
    onChange({ ...state, grants });
  };

  return (
    <div className="space-y-3">
      {stores.map(({ storeId, name, apps }) => {
        const grant = state.grants[storeId];
        const myRole = effectiveRole(user, storeId);
        const myLevel = myRole === 'admin' ? Infinity : ROLE_ORDER.indexOf(myRole as StoreRole);
        const roleOptions = ROLE_ORDER.filter((_, i) => i <= myLevel);
        // An app-limited actor can only hand out apps from their own allowlist.
        const myApps = user.grants?.[storeId]?.apps;
        const assignableApps = myApps
          ? apps.filter((app) => myApps[app.id] !== undefined && myApps[app.id] !== 'none')
          : apps;
        const specific = !!grant?.apps;
        const setApps = (nextApps: Record<string, StoreRole | 'none'> | undefined) =>
          onChange({
            ...state,
            grants: { ...state.grants, [storeId]: { ...grant!, ...(nextApps ? { apps: nextApps } : {}) } },
          });
        const clearApps = () => {
          const { apps: _omit, ...rest } = state.grants[storeId]!;
          onChange({ ...state, grants: { ...state.grants, [storeId]: rest } });
        };
        return (
          <div key={storeId} className="rounded-xl border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {grant ? 'Included in this person’s access' : 'Not included'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {grant && (
                  <Select
                    value={grant.role}
                    onValueChange={(role) =>
                      onChange({
                        ...state,
                        grants: { ...state.grants, [storeId]: { ...grant, role: role as StoreRole } },
                      })
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((role) => (
                        <SelectItem key={role} value={role}>
                          {STORE_ROLE_LABELS[role].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Switch checked={!!grant} onCheckedChange={(on) => toggleStore(storeId, on)} />
              </div>
            </div>
            {grant && (
              <div className="mt-3 border-t pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-muted-foreground">App scope</span>
                  <div className="inline-flex rounded-lg bg-muted p-0.5">
                    <button
                      type="button"
                      onClick={() => clearApps()}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        !specific ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      All apps
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!specific) setApps({});
                      }}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        specific ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Specific apps
                    </button>
                  </div>
                </div>
                {specific && (
                  <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                    {assignableApps.length === 0 ? (
                      <p className="col-span-full py-3 text-center text-[12px] text-muted-foreground">
                        No apps available to assign.
                      </p>
                    ) : (
                      assignableApps.map((app) => {
                        const selected = grant.apps?.[app.id] !== undefined && grant.apps?.[app.id] !== 'none';
                        return (
                          <button
                            key={app.id}
                            type="button"
                            onClick={() => {
                              const next = { ...(grant.apps ?? {}) };
                              if (selected) delete next[app.id];
                              else next[app.id] = grant.role;
                              setApps(next);
                            }}
                            className={`truncate rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                              selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                            }`}
                          >
                            {selected ? '✓ ' : ''}{app.name}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
                {specific && (
                  <FieldHint>Only the selected apps are visible to this person; everything else stays hidden.</FieldHint>
                )}
              </div>
            )}
            {grant && (
              <div className="mt-3 grid gap-1.5 border-t pt-3 sm:grid-cols-2">
                {STORE_PERMISSION_OPTIONS.map(({ key, label }) => {
                  const iHaveIt = can(user, key, storeId);
                  const roleDefault = roleAllows(grant.role, key);
                  const value = grant.permissions?.[key] ?? roleDefault;
                  return (
                    <label
                      key={key}
                      className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[12px] ${
                        iHaveIt ? '' : 'opacity-45'
                      }`}
                      title={iHaveIt ? undefined : 'You don’t have this permission yourself.'}
                    >
                      <span className="truncate">{label}</span>
                      <Switch
                        checked={value && iHaveIt}
                        disabled={!iHaveIt}
                        onCheckedChange={(on) =>
                          onChange({
                            ...state,
                            grants: {
                              ...state.grants,
                              [storeId]: {
                                ...grant,
                                permissions: { ...(grant.permissions ?? {}), [key]: on },
                              },
                            },
                          })
                        }
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* AI access, capped at the actor's own */}
      <div className="rounded-xl border p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
          <Sparkles className="size-3.5" /> AI access
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(['translate', 'generate'] as const).map((feature) => {
            const iHaveIt = !!user.ai?.features?.[feature];
            return (
              <label key={feature} className={`flex items-center justify-between gap-2 text-[12px] ${iHaveIt ? '' : 'opacity-45'}`}>
                <span className="capitalize">AI {feature}</span>
                <Switch
                  checked={state.ai.features[feature] && iHaveIt}
                  disabled={!iHaveIt}
                  onCheckedChange={(on) =>
                    onChange({ ...state, ai: { ...state.ai, features: { ...state.ai.features, [feature]: on } } })
                  }
                />
              </label>
            );
          })}
          <div className="flex items-center gap-2 text-[12px]">
            <span className="whitespace-nowrap">Monthly credits</span>
            <Input
              type="number"
              min={0}
              max={user.ai?.monthlyCredits ?? 0}
              value={state.ai.monthlyCredits}
              onChange={(e) =>
                onChange({
                  ...state,
                  ai: {
                    ...state.ai,
                    monthlyCredits: Math.max(0, Math.min(Number(e.target.value) || 0, user.ai?.monthlyCredits ?? 0)),
                  },
                })
              }
              className="h-7 w-24"
            />
          </div>
        </div>
        <FieldHint>Capped at your own limit ({user.ai?.monthlyCredits ?? 0} credits/month).</FieldHint>
      </div>
    </div>
  );
}

function MemberDialog({
  open,
  onOpenChange,
  stores,
  mode,
  initial,
  targetUid,
  targetEmail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: TeamStore[];
  mode: 'invite' | 'edit';
  initial?: EditorState;
  targetUid?: string;
  targetEmail?: string;
  onDone: () => void;
}) {
  const { user } = useSession();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<EditorState>({
    grants: {},
    ai: { features: { ...DEFAULT_AI_GRANT.features }, monthlyCredits: 0 },
  });
  useEffect(() => {
    if (open) {
      setEmail(targetEmail ?? '');
      setState(initial ?? { grants: {}, ai: { features: { ...DEFAULT_AI_GRANT.features }, monthlyCredits: 0 } });
    }
  }, [open, initial, targetEmail]);

  // Managers may only invite addresses on the workspace's allowed domains; admins anyone.
  const settings = useLiveDoc<GlobalSettingsDoc>(useMemo(() => doc(db, 'settings', 'global'), []));
  const domainList =
    user?.role === 'admin' ? [] : (settings.data?.allowedDomains ?? []).filter(Boolean);
  const emailDomainOk =
    domainList.length === 0 || domainList.includes(email.trim().toLowerCase().split('@')[1] ?? '');

  const violations = useMemo(
    () => (user ? delegationViolations(user, { grants: state.grants, ai: state.ai }) : []),
    [user, state],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (mode === 'invite') {
        return api.usersInvite({ email: email.trim(), role: 'member', grants: state.grants, ai: { ...state.ai } });
      }
      return api.usersUpdate({ uid: targetUid!, grants: state.grants, ai: { ...state.ai } });
    },
    onSuccess: () => {
      toast.success(mode === 'invite' ? 'Invitation added' : 'Access updated', {
        description: mode === 'invite' ? 'They get this access when they first sign in with Google.' : undefined,
      });
      onDone();
      onOpenChange(false);
    },
    onError: (err) => toast.error('Couldn’t save', { description: callableMessage(err) }),
  });

  const emailOk = /.+@.+\..+/.test(email.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title={mode === 'invite' ? 'Invite a team member' : `Edit access — ${targetEmail}`}
          description="You can only grant access you hold yourself — anything else is disabled."
        />
        <div className="space-y-4">
          {mode === 'invite' && (
            <div>
              <Label htmlFor="team-email">Google account email</Label>
              <Input
                id="team-email"
                type="email"
                value={email}
                placeholder="teammate@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
              {domainList.length > 0 && (
                <FieldHint className={emailDomainOk || !email.trim() ? undefined : 'text-destructive'}>
                  You can invite {domainList.map((d) => `@${d}`).join(', ')} addresses only — admins can invite any domain.
                </FieldHint>
              )}
            </div>
          )}
          <DelegatedGrantEditor stores={stores} state={state} onChange={setState} />
          {violations.length > 0 && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{violations[0]}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={violations.length > 0 || (mode === 'invite' && (!emailOk || !emailDomainOk))}
          >
            {mode === 'invite' ? 'Send invite' : 'Save access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TeamPage() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const teamQ = useQuery({ queryKey: ['team'], queryFn: () => api.teamList({}), staleTime: 30_000, enabled: !!user });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['team'] });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    uid: string;
    email: string;
    state: EditorState;
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ uid: string; email: string } | null>(null);

  const revoke = useMutation({
    mutationFn: (email: string) => api.allowlistRemove({ email }),
    onSuccess: () => {
      toast.success('Invite revoked');
      refresh();
    },
    onError: (err) => toast.error('Couldn’t revoke invite', { description: callableMessage(err) }),
  });

  const removeAccess = useMutation({
    // Empty grants: the server removes every store the actor manages and keeps the rest.
    mutationFn: (uid: string) => api.usersUpdate({ uid, grants: {} }),
    onSuccess: () => {
      toast.success('Access removed');
      refresh();
    },
    onError: (err) => toast.error('Couldn’t remove access', { description: callableMessage(err) }),
  });

  if (user && !hasAnyManageMembers(user)) return <Navigate to="/" replace />;

  const stores = teamQ.data?.stores ?? [];
  const members = teamQ.data?.members ?? [];
  const invites = teamQ.data?.invites ?? [];
  const storeName = (sid: string) => stores.find((s) => s.storeId === sid)?.name ?? sid;

  return (
    <Page
      title="Team"
      description="People with access to your stores. You can grant at most the access you hold."
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-3.5" /> Invite member
        </Button>
      }
    >
      {teamQ.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : teamQ.isError ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          {callableMessage(teamQ.error)}
        </div>
      ) : members.length === 0 && invites.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No team members yet"
          description="Invite people to your stores — they can only receive access you already have."
        />
      ) : (
        <div className="space-y-5">
          {members.length > 0 && (
            <ul className="divide-y rounded-xl border bg-card">
              {members.map((member) => (
                <li key={member.uid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar src={member.photoUrl} name={member.name || member.email} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {member.name || member.email}
                      {member.status === 'disabled' && (
                        <Badge variant="destructive" className="ml-2">Disabled</Badge>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{member.email}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {Object.entries(member.grants).map(([sid, grant]) => (
                      <Badge key={sid} variant="neutral">
                        {storeName(sid)} · {STORE_ROLE_LABELS[grant.role].label}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setEditTarget({
                          uid: member.uid,
                          email: member.email,
                          state: {
                            grants: structuredClone(member.grants),
                            ai: { features: { ...member.ai.features }, monthlyCredits: member.ai.monthlyCredits },
                          },
                        })
                      }
                    >
                      Edit access
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => setRemoveTarget({ uid: member.uid, email: member.email })}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {invites.length > 0 && (
            <div>
              <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Pending invites
              </h2>
              <ul className="divide-y rounded-xl border bg-card">
                {invites.map((invite) => (
                  <li key={invite.email} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{invite.email}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(invite.grants).map(([sid, grant]) => (
                        <Badge key={sid} variant="outline">
                          {storeName(sid)} · {STORE_ROLE_LABELS[grant.role].label}
                        </Badge>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(invite.email)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <MemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        stores={stores}
        mode="invite"
        onDone={refresh}
      />
      <MemberDialog
        open={!!editTarget}
        onOpenChange={() => setEditTarget(null)}
        stores={stores}
        mode="edit"
        initial={editTarget?.state}
        targetUid={editTarget?.uid}
        targetEmail={editTarget?.email}
        onDone={refresh}
      />
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={() => setRevokeTarget(null)}
        title={`Revoke invite for ${revokeTarget}?`}
        description="They won’t receive access when signing in."
        confirmLabel="Revoke invite"
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget);
          setRevokeTarget(null);
        }}
      />
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={() => setRemoveTarget(null)}
        title={`Remove access for ${removeTarget?.email}?`}
        description="Removes this person from every store you manage. Access they hold elsewhere is untouched."
        confirmLabel="Remove access"
        destructive
        loading={removeAccess.isPending}
        onConfirm={() => {
          if (removeTarget) removeAccess.mutate(removeTarget.uid);
          setRemoveTarget(null);
        }}
      />
    </Page>
  );
}
