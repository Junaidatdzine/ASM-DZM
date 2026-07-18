import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { collection, orderBy, query } from 'firebase/firestore';
import { Check, MoreHorizontal, ShieldOff, ShieldCheck, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AccessRequestDoc, AllowlistDoc, UserDoc, UserPrefsDoc } from '@asm/shared';
import { DEFAULT_AI_GRANT, aiCreditsRemaining } from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';
import { Page } from '@/layout/AppShell';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn, timeAgo } from '@/lib/utils';
import { AccessDialog, InviteDialog, type AccessTarget } from './UserDialogs';

/** 'PK' → 🇵🇰 via regional-indicator letters. */
function flagEmoji(countryCode: string): string {
  return countryCode
    .toUpperCase()
    .replace(/[A-Z]/g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
}

export function UsersPage() {
  const { uid: myUid } = useSession();
  const users = useLiveQuery<UserDoc>(useMemo(() => query(collection(db, 'users')), []), 'users');
  // Presence: live heartbeats + a minute tick so statuses decay without reloads.
  const prefs = useLiveQuery<UserPrefsDoc>(useMemo(() => query(collection(db, 'userPrefs')), []), 'user-presence');
  const lastSeen = useMemo(() => new Map(prefs.rows.map((r) => [r.id, r.data.lastSeenAt])), [prefs.rows]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const presenceOf = (uid: string): { label: string; dot: string } => {
    const at = lastSeen.get(uid)?.toMillis() ?? 0;
    const age = Date.now() - at;
    if (age < 3 * 60_000) return { label: 'Online', dot: 'bg-success' };
    if (age < 15 * 60_000) return { label: 'Away', dot: 'bg-warning' };
    return { label: 'Offline', dot: 'bg-muted-foreground/40' };
  };
  const invites = useLiveQuery<AllowlistDoc>(useMemo(() => query(collection(db, 'allowlist')), []), 'allowlist');
  const requests = useLiveQuery<AccessRequestDoc>(
    useMemo(() => query(collection(db, 'accessRequests'), orderBy('createdAt', 'desc')), []),
    'accessRequests',
  );

  const [inviteOpen, setInviteOpen] = useState(false);
  const [accessTarget, setAccessTarget] = useState<AccessTarget | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ uid: string; name: string; to: 'active' | 'disabled' } | null>(null);

  const setStatus = useMutation({
    mutationFn: (input: { uid: string; status: 'active' | 'disabled' }) => api.usersSetStatus(input),
    onSuccess: (_d, v) => {
      toast.success(v.status === 'disabled' ? 'User disabled' : 'User re-enabled');
      setStatusTarget(null);
    },
    onError: (err) => toast.error('Failed', { description: callableMessage(err) }),
  });

  const resolveRequest = useMutation({
    mutationFn: (input: { uid: string; approve: boolean }) =>
      api.accessRequestResolve({ ...input, role: 'member', ai: DEFAULT_AI_GRANT }),
    onSuccess: (_d, v) => toast.success(v.approve ? 'Access granted' : 'Request denied'),
    onError: (err) => toast.error('Failed', { description: callableMessage(err) }),
  });

  const revokeInvite = useMutation({
    mutationFn: (email: string) => api.allowlistRemove({ email }),
    onSuccess: () => toast.success('Invite revoked'),
    onError: (err) => toast.error('Failed', { description: callableMessage(err) }),
  });

  return (
    <Page
      title="Users & Access"
      description="Invite teammates, assign store roles and AI quotas."
      actions={
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-4" /> Invite
        </Button>
      }
    >
      {requests.rows.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-semibold text-muted-foreground">
            Pending requests ({requests.rows.length})
          </h2>
          <div className="space-y-2">
            {requests.rows.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 shadow-card"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={r.data.photoUrl} name={r.data.name} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{r.data.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.data.email}
                      {r.data.note ? ` — “${r.data.note}”` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveRequest.mutate({ uid: r.id, approve: false })}
                    disabled={resolveRequest.isPending}
                  >
                    <X className="size-3.5" /> Deny
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => resolveRequest.mutate({ uid: r.id, approve: true })}
                    disabled={resolveRequest.isPending}
                  >
                    <Check className="size-3.5" /> Approve as member
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-x-auto rounded-xl border bg-card shadow-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead>
            <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Member</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Stores</th>
              <th className="px-4 py-2.5 font-medium">AI credits</th>
              <th className="px-4 py-2.5 font-medium">Last active</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {users.loading && (
              <tr>
                <td colSpan={6} className="px-4 py-3">
                  <Skeleton className="h-8 w-full" />
                </td>
              </tr>
            )}
            {users.rows.map((u) => {
              const disabled = u.data.status === 'disabled';
              return (
                <tr key={u.id} className={`border-b last:border-0 ${disabled ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar src={u.data.photoUrl} name={u.data.name} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          {u.data.name}
                          {u.id === myUid && <Badge variant="outline">you</Badge>}
                          {disabled && <Badge variant="destructive">disabled</Badge>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{u.data.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={u.data.role === 'admin' ? 'accent' : 'neutral'}>{u.data.role}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {u.data.role === 'admin' ? 'All stores' : `${Object.keys(u.data.grants ?? {}).length} granted`}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {u.data.ai?.features.translate || u.data.ai?.features.generate
                      ? `${aiCreditsRemaining(u.data)}/${u.data.ai.monthlyCredits}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {(() => {
                      const presence = presenceOf(u.id);
                      return (
                        <div className="flex items-center gap-1.5">
                          <span className={cn('inline-block size-2 rounded-full', presence.dot)} />
                          <span className={cn('text-[12px] font-medium', presence.label === 'Online' && 'text-success')}>{presence.label}</span>
                          <span className="text-[11px]">· {timeAgo(u.data.lastLoginAt)}</span>
                        </div>
                      );
                    })()}
                    {u.data.lastLogin && (u.data.lastLogin.countryCode || u.data.lastLogin.device) && (
                      <div className="mt-0.5 text-[11px]">
                        {u.data.lastLogin.countryCode ? `${flagEmoji(u.data.lastLogin.countryCode)} ` : ''}
                        {[u.data.lastLogin.city, u.data.lastLogin.country].filter(Boolean).join(', ')}
                        {u.data.lastLogin.device ? `${u.data.lastLogin.countryCode ? ' · ' : ''}${u.data.lastLogin.device}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            setAccessTarget({
                              kind: 'user',
                              id: u.id,
                              name: u.data.name,
                              role: u.data.role,
                              grants: u.data.grants ?? {},
                              ai: u.data.ai ?? DEFAULT_AI_GRANT,
                              isSelf: u.id === myUid,
                            })
                          }
                        >
                          Edit access & AI
                        </DropdownMenuItem>
                        {u.id !== myUid &&
                          (disabled ? (
                            <DropdownMenuItem
                              onSelect={() => setStatus.mutate({ uid: u.id, status: 'active' })}
                            >
                              <ShieldCheck className="size-3.5" /> Re-enable
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              destructive
                              onSelect={() => setStatusTarget({ uid: u.id, name: u.data.name, to: 'disabled' })}
                            >
                              <ShieldOff className="size-3.5" /> Disable
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {invites.rows.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-[13px] font-semibold text-muted-foreground">
            Pending invites ({invites.rows.length})
          </h2>
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            {invites.rows.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between border-b px-4 py-2.5 text-[13px] last:border-0">
                <div>
                  <span className="font-medium">{inv.id}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {inv.data.role} · invited {timeAgo(inv.data.addedAt)}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setAccessTarget({
                        kind: 'invite',
                        id: inv.id,
                        name: inv.id,
                        role: inv.data.role,
                        grants: inv.data.grants ?? {},
                        ai: inv.data.ai ?? DEFAULT_AI_GRANT,
                        isSelf: false,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revokeInvite.mutate(inv.id)}>
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <AccessDialog target={accessTarget} onOpenChange={() => setAccessTarget(null)} />
      <ConfirmDialog
        open={!!statusTarget}
        onOpenChange={() => setStatusTarget(null)}
        title={`Disable ${statusTarget?.name}?`}
        description="They are signed out immediately and lose all access. Store data they can currently see keeps streaming for at most an hour. You can re-enable them anytime."
        confirmLabel="Disable user"
        destructive
        loading={setStatus.isPending}
        onConfirm={() => {
          if (statusTarget) setStatus.mutate({ uid: statusTarget.uid, status: statusTarget.to });
        }}
      />
    </Page>
  );
}
