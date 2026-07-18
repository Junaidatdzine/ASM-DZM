import { useMemo } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { Activity, Rocket, Sparkles, Users } from 'lucide-react';
import type { AuditLogDoc, UserDoc } from '@asm/shared';
import { aiCreditsRemaining } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { Page } from '@/layout/AppShell';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn, timeAgo } from '@/lib/utils';

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function AdminUsagePage() {
  const users = useLiveQuery<UserDoc>(useMemo(() => query(collection(db, 'users')), []), 'usage-users');
  const audit = useLiveQuery<AuditLogDoc>(
    useMemo(() => query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(500)), []),
    'usage-audit',
  );

  const month = new Date().toISOString().slice(0, 7);

  // Aggregate activity per user email from the recent audit window.
  const perUser = useMemo(() => {
    const map = new Map<string, { actions: number; pushes: number; ai: number; last?: AuditLogDoc['at'] }>();
    for (const row of audit.rows) {
      const email = row.data.actor.email;
      const rec = map.get(email) ?? { actions: 0, pushes: 0, ai: 0 };
      rec.actions += 1;
      if (row.data.action.startsWith('loc.push')) rec.pushes += 1;
      if (row.data.action.startsWith('ai.')) rec.ai += 1;
      if (!rec.last) rec.last = row.data.at;
      map.set(email, rec);
    }
    return map;
  }, [audit.rows]);

  const totalAiThisMonth = users.rows.reduce(
    (n, u) => n + (u.data.ai?.usage?.month === month ? u.data.ai.usage.used : 0),
    0,
  );
  const totalPushes = audit.rows.filter((r) => r.data.action.startsWith('loc.push')).length;
  const activeCount = users.rows.filter((u) => u.data.status === 'active').length;

  return (
    <Page title="Usage & stats" description="Who's using what — AI credits, pushes and activity." wide>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="Active members" value={activeCount} sub={`${users.rows.length} total`} />
        <StatCard icon={Sparkles} label="AI credits used" value={totalAiThisMonth} sub="this month" />
        <StatCard icon={Rocket} label="Pushes" value={totalPushes} sub="recent window" />
        <StatCard icon={Activity} label="Actions logged" value={audit.rows.length} sub="recent window" />
      </div>

      <section className="overflow-x-auto rounded-xl border bg-card shadow-card">
        <div className="border-b bg-muted/40 px-4 py-2.5 text-[13px] font-semibold">Per member</div>
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Member</th>
              <th className="px-4 py-2 font-medium">AI this month</th>
              <th className="px-4 py-2 font-medium">AI credits left</th>
              <th className="px-4 py-2 font-medium">AI runs</th>
              <th className="px-4 py-2 font-medium">Pushes</th>
              <th className="px-4 py-2 font-medium">Actions</th>
              <th className="px-4 py-2 font-medium">Last active</th>
            </tr>
          </thead>
          <tbody>
            {users.loading && (
              <tr>
                <td colSpan={7} className="px-4 py-3">
                  <Skeleton className="h-8 w-full" />
                </td>
              </tr>
            )}
            {users.rows.map((u) => {
              const used = u.data.ai?.usage?.month === month ? u.data.ai.usage.used : 0;
              const cap = u.data.ai?.monthlyCredits ?? 0;
              const stats = perUser.get(u.data.email);
              const aiEnabled = u.data.ai?.features.translate || u.data.ai?.features.generate;
              const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
              return (
                <tr key={u.id} className={cn('border-b last:border-0', u.data.status === 'disabled' && 'opacity-50')}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar src={u.data.photoUrl} name={u.data.name} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium">
                          {u.data.name}
                          {u.data.role === 'admin' && <Badge variant="accent">admin</Badge>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{u.data.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {aiEnabled ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', pct >= 90 ? 'bg-destructive' : 'bg-primary')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                          {used}/{cap}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">off</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {aiEnabled ? aiCreditsRemaining(u.data) : '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{stats?.ai ?? 0}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{stats?.pushes ?? 0}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{stats?.actions ?? 0}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{stats?.last ? timeAgo(stats.last) : timeAgo(u.data.lastLoginAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="mt-2 text-[11px] text-muted-foreground">
        AI counts reflect the most recent {audit.rows.length} audited actions; monthly credit usage is exact.
      </p>
    </Page>
  );
}
