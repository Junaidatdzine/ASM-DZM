import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { collection, doc, limit, orderBy, query } from 'firebase/firestore';
import {
  Apple,
  BadgeDollarSign,
  LineChart,
  Megaphone,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import type { AdsAccountDoc, AdsConfigDoc, AdsDayDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveDoc, useLiveQuery } from '@/lib/hooks';
import { isStale, useAutoSync } from '@/lib/staleness';
import { Page } from '@/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Textarea';
import { cn, timeAgo } from '@/lib/utils';
import { AdsStatusBadge, CampaignManagerDialog, CreateCampaignDialog, ServingHoldNotice, type CampaignRef } from './CampaignManager';
import { resolveAdsStatus } from '@asm/shared';

const RANGES = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

const fmt = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cnt = (n: number) => n.toLocaleString('en-US');

function Tile({ icon: Icon, label, value, sub, tone }: { icon: typeof Wallet; label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn('mt-1 truncate text-2xl font-semibold tabular-nums', tone === 'good' && 'text-success', tone === 'bad' && 'text-destructive')}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Admin manager for advertising: every Apple Search Ads + AdMob account, campaign control, and the true net. */
export function AdsPage() {
  const queryClient = useQueryClient();
  const config = useLiveDoc<AdsConfigDoc>(useMemo(() => doc(db, 'adsConfig', 'status'), []));
  const accountsQ = useLiveQuery<AdsAccountDoc>(
    useMemo(() => query(collection(db, 'adsAccounts'), orderBy('createdAt', 'asc')), []),
    'ads-accounts',
  );
  const daysQ = useLiveQuery<AdsDayDoc>(
    useMemo(() => query(collection(db, 'adsDays'), orderBy('date', 'desc'), limit(90)), []),
    'ads-days',
  );

  const [range, setRange] = useState<RangeKey>('30');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [appleOpen, setAppleOpen] = useState(false);
  const [admobOpen, setAdmobOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null);
  const [manageTarget, setManageTarget] = useState<CampaignRef | null>(null);
  const [createCampaignOpen, setCreateCampaignOpen] = useState(false);

  const accounts = accountsQ.rows.map((r) => ({ id: r.id, ...r.data }));
  const appleAccounts = accounts.filter((a) => a.provider === 'appleAds');
  const admobAccounts = accounts.filter((a) => a.provider === 'admob');
  const anyConnected = accounts.some((a) => a.connected);

  const sync = useMutation({
    mutationFn: () => api.adsSync({ days: 90 }),
    onSuccess: (res) => {
      toast.success('Ads data synced', { description: `${res.days} days from ${res.providers.join(' + ') || 'demo data'}` });
      queryClient.invalidateQueries({ queryKey: ['adsCampaigns'] });
      queryClient.invalidateQueries({ queryKey: ['analyticsNet'] });
    },
    onError: (err) => toast.error('Ads sync failed', { description: callableMessage(err) }),
  });

  useAutoSync(
    'ads-sync',
    config.exists === true && anyConnected && isStale(config.data?.syncedAt, 6 * 3600 * 1000),
    async () => {
      await sync.mutateAsync().catch(() => {});
    },
  );

  const remove = useMutation({
    mutationFn: (accountId: string) => api.adsAccountRemove({ accountId }),
    onSuccess: () => toast.success('Account removed'),
    onError: (err) => toast.error('Couldn’t remove account', { description: callableMessage(err) }),
  });

  // Live campaigns (status + budget) — merged with range metrics below.
  const campaignsQ = useQuery({
    queryKey: ['adsCampaigns'],
    queryFn: () => api.adsCampaignsList({}),
    enabled: appleAccounts.some((a) => a.connected) || accounts.length === 0,
    staleTime: 120_000,
  });
  const setStatus = useMutation({
    mutationFn: (v: { accountId: string; campaignId: string; status: 'ENABLED' | 'PAUSED' }) =>
      api.adsCampaignSetStatus(v),
    onSuccess: (res) => {
      toast.success(res.status === 'PAUSED' ? 'Campaign paused' : 'Campaign running', {
        description: res.status === 'PAUSED' ? 'Apple stops serving it within minutes.' : 'Apple resumes serving it within minutes.',
      });
      queryClient.invalidateQueries({ queryKey: ['adsCampaigns'] });
    },
    onError: (err) => toast.error('Couldn’t change campaign', { description: callableMessage(err) }),
  });

  const proceedsQ = useQuery({
    queryKey: ['analyticsNet', range],
    queryFn: () => api.analyticsOverview({ days: Number(range), sync: false }),
    staleTime: 120_000,
  });

  const daysAsc = useMemo(
    () => [...daysQ.rows].map((r) => r.data).sort((a, b) => a.date.localeCompare(b.date)),
    [daysQ.rows],
  );
  const rangeDays = useMemo(() => daysAsc.slice(-Number(range)), [daysAsc, range]);

  const filtered = useMemo(() => {
    const all = accountFilter === 'all';
    let spend = 0;
    let admob = 0;
    let taps = 0;
    let installs = 0;
    const perCampaign = new Map<string, { accountId: string; accountLabel: string; name: string; spend: number; taps: number; installs: number }>();
    const bars: Array<{ date: string; spend: number; admob: number }> = [];
    for (const dayDoc of rangeDays) {
      let daySpend = 0;
      let dayAdmob = 0;
      if (all) {
        daySpend = dayDoc.appleAds?.spendUsd ?? 0;
        dayAdmob = dayDoc.admob?.earningsUsd ?? 0;
        taps += dayDoc.appleAds?.taps ?? 0;
        installs += dayDoc.appleAds?.installs ?? 0;
      } else {
        const appleAcct = dayDoc.appleAds?.accounts?.find((a) => a.id === accountFilter);
        const admobAcct = dayDoc.admob?.accounts?.find((a) => a.id === accountFilter);
        daySpend = appleAcct?.spendUsd ?? 0;
        dayAdmob = admobAcct?.earningsUsd ?? 0;
        taps += appleAcct?.taps ?? 0;
        installs += appleAcct?.installs ?? 0;
      }
      spend += daySpend;
      admob += dayAdmob;
      bars.push({ date: dayDoc.date, spend: daySpend, admob: dayAdmob });
      for (const c of dayDoc.appleAds?.campaigns ?? []) {
        if (!all && c.accountId !== accountFilter) continue;
        const key = `${c.accountId ?? ''}:${c.id}`;
        const row = perCampaign.get(key) ?? {
          accountId: c.accountId ?? '',
          accountLabel: c.accountLabel ?? '',
          name: c.name,
          spend: 0,
          taps: 0,
          installs: 0,
        };
        row.spend += c.spendUsd ?? 0;
        row.taps += c.taps;
        row.installs += c.installs;
        perCampaign.set(key, row);
      }
    }
    return { spend, admob, taps, installs, perCampaign, bars };
  }, [rangeDays, accountFilter]);

  const liveCampaigns = campaignsQ.data?.campaigns ?? [];
  const campaignRows = useMemo(() => {
    const rows = liveCampaigns
      .filter((c) => accountFilter === 'all' || c.accountId === accountFilter)
      .map((c) => {
        const metrics = filtered.perCampaign.get(`${c.accountId}:${c.id}`);
        return { ...c, spend: metrics?.spend ?? 0, taps: metrics?.taps ?? 0, installs: metrics?.installs ?? 0 };
      });
    // Campaigns that spent in-range but vanished from the live list stay visible.
    for (const [key, m] of filtered.perCampaign) {
      const [accountId, id] = key.split(':');
      if (!rows.some((r) => r.accountId === accountId && r.id === id)) {
        rows.push({
          id: id!,
          name: m.name,
          accountId: m.accountId,
          accountLabel: m.accountLabel,
          status: 'UNKNOWN',
          displayStatus: undefined,
          servingStateReasons: [],
          adamId: undefined,
          dailyBudget: null,
          countries: [],
          spend: m.spend,
          taps: m.taps,
          installs: m.installs,
        });
      }
    }
    return rows.sort((a, b) => b.spend - a.spend);
  }, [liveCampaigns, filtered, accountFilter]);

  const proceeds = proceedsQ.data?.totals.proceedsPrimary ?? 0;
  const net = proceeds + filtered.admob - filtered.spend;
  const maxBar = Math.max(1, ...filtered.bars.map((b) => Math.max(b.spend, b.admob)));

  return (
    <Page
      wide
      title="Ads & Spend"
      description="Every Apple Search Ads and AdMob account in one place — spend, ad revenue, campaign control, and your true net."
      actions={
        <>
          <span className="text-[11px] text-muted-foreground">synced {timeAgo(config.data?.syncedAt)}</span>
          <Button variant="outline" size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>
            <RefreshCw className="size-3.5" /> Sync
          </Button>
        </>
      }
    >
      {/* Accounts */}
      <div className="mb-5 rounded-xl border bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h3 className="text-[13px] font-semibold">Connected accounts</h3>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setAppleOpen(true)}>
              <Apple className="size-3.5" /> Add Search Ads account
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdmobOpen(true)}>
              <BadgeDollarSign className="size-3.5" /> Add AdMob account
            </Button>
          </div>
        </div>
        {accounts.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            Nothing connected yet. Add your Apple Search Ads and AdMob accounts — you can connect as many as you need.
          </p>
        ) : (
          <ul className="divide-y">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                {account.provider === 'appleAds' ? <Apple className="size-4 shrink-0" /> : <BadgeDollarSign className="size-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{account.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {account.provider === 'appleAds'
                      ? `Apple Search Ads · org ${account.orgId} · ${account.campaignsCount ?? '—'} campaigns`
                      : `AdMob · ${account.publisherId} · ${account.currencyCode ?? 'USD'}`}
                  </div>
                </div>
                {account.lastError ? (
                  <Badge variant="destructive" title={account.lastError}>Needs attention</Badge>
                ) : (
                  <Badge variant="success">Connected</Badge>
                )}
                <Button
                  variant="ghost"
                  size="iconSm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setRemoveTarget({ id: account.id, label: account.label })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Range + account filter */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'rounded-md px-3 py-1 text-[12px] font-medium transition-colors',
                range === r.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setAccountFilter('all')}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
                accountFilter === 'all' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              All accounts
            </button>
            {accounts.map((account) => (
              <button
                key={account.id}
                onClick={() => setAccountFilter(account.id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
                  accountFilter === account.id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {account.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {daysQ.loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Tile icon={Wallet} label="Ad spend" value={fmt(filtered.spend)} sub={`${cnt(filtered.taps)} taps`} tone="bad" />
            <Tile icon={Megaphone} label="Ads installs" value={cnt(filtered.installs)} sub={filtered.installs > 0 ? `${fmt(filtered.spend / Math.max(1, filtered.installs))} per install` : undefined} />
            <Tile icon={BadgeDollarSign} label="AdMob revenue" value={fmt(filtered.admob)} tone="good" />
            <Tile icon={LineChart} label="Proceeds" value={fmt(proceeds)} sub="App Store, after Apple’s cut" />
            <Tile icon={Wallet} label="Net" value={fmt(net)} sub="proceeds + AdMob − spend" tone={net >= 0 ? 'good' : 'bad'} />
          </div>

          <div className="mt-5 rounded-xl border bg-card p-4 shadow-card">
            <div className="mb-2 flex items-center justify-between text-[13px] font-semibold">
              <span>Daily — spend vs ad revenue (USD)</span>
              <span className="flex items-center gap-3 text-[11px] font-normal text-muted-foreground">
                <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-destructive/70" /> spend</span>
                <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-success/80" /> AdMob</span>
              </span>
            </div>
            {filtered.bars.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted-foreground">No ads data yet — connect an account and hit Sync.</p>
            ) : (
              <div className="flex h-40 items-end gap-[2px]">
                {filtered.bars.map((bar, i) => {
                  // Clamp the tooltip at the chart edges so it never clips.
                  const pos = filtered.bars.length < 2 ? 0.5 : i / (filtered.bars.length - 1);
                  const align = pos < 0.18 ? 'left-0' : pos > 0.82 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                  return (
                    <div
                      key={bar.date}
                      tabIndex={0}
                      className="group relative flex h-full min-w-0 flex-1 items-end gap-[1px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      {/* Whole column is the hit target; hovered bars lift to full opacity. */}
                      <div className="min-h-[2px] flex-1 rounded-t-sm bg-destructive/70 transition-colors group-hover:bg-destructive group-focus-within:bg-destructive" style={{ height: `${(bar.spend / maxBar) * 100}%` }} />
                      <div className="min-h-[2px] flex-1 rounded-t-sm bg-success/80 transition-colors group-hover:bg-success group-focus-within:bg-success" style={{ height: `${(bar.admob / maxBar) * 100}%` }} />
                      <div
                        role="tooltip"
                        className={cn(
                          'pointer-events-none absolute top-0 z-10 hidden w-max min-w-[132px] rounded-lg border bg-popover px-2.5 py-2 shadow-pop group-hover:block group-focus-within:block',
                          align,
                        )}
                      >
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {new Date(`${bar.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                        </div>
                        <div className="space-y-1 text-[12px]">
                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 text-muted-foreground"><span className="inline-block h-[2px] w-2.5 rounded-full bg-destructive" /> Ad spend</span>
                            <span className="font-semibold tabular-nums">{fmt(bar.spend)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 text-muted-foreground"><span className="inline-block h-[2px] w-2.5 rounded-full bg-success" /> AdMob</span>
                            <span className="font-semibold tabular-nums">{fmt(bar.admob)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Billing/serving problems are account-wide — surface them before the table. */}
          {(() => {
            const held = liveCampaigns.find((c) => resolveAdsStatus(c).kind === 'onHold');
            return held ? <div className="mt-5"><ServingHoldNotice entity={held} scope="campaigns in this account" /></div> : null;
          })()}

          {/* Campaigns — live status + range metrics + run/pause control */}
          <div className="mt-5 overflow-x-auto rounded-xl border bg-card shadow-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="flex items-center gap-2 text-[13px] font-semibold">
                Campaigns
                {campaignsQ.isFetching && <span className="text-[11px] font-normal text-muted-foreground">refreshing…</span>}
              </h3>
              {appleAccounts.some((a) => a.connected) && (
                <Button size="sm" onClick={() => setCreateCampaignOpen(true)}>
                  <Plus className="size-3.5" /> New campaign
                </Button>
              )}
            </div>
            {campaignsQ.isLoading ? (
              <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : campaignRows.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                No campaigns found{appleAccounts.length === 0 ? ' — add a Search Ads account first' : ''}.
              </p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Campaign</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Daily budget</th>
                    <th className="px-4 py-2.5 text-right font-medium">Spend ({range}d)</th>
                    <th className="px-4 py-2.5 text-right font-medium">Taps</th>
                    <th className="px-4 py-2.5 text-right font-medium">Installs</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cost/install</th>
                    <th className="px-4 py-2.5 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignRows.map((c) => (
                    <tr key={`${c.accountId}:${c.id}`} className="border-b last:border-0">
                      <td className="max-w-[280px] px-4 py-2">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{c.accountLabel}</div>
                      </td>
                      <td className="px-4 py-2">
                        <AdsStatusBadge entity={c} />
                        {resolveAdsStatus(c).reasons[0] && (
                          <div className="mt-0.5 max-w-[180px] text-[10px] leading-tight text-destructive">{resolveAdsStatus(c).reasons[0]}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {c.dailyBudget ? `${fmt(c.dailyBudget.amount)}${c.dailyBudget.currency !== 'USD' ? ` ${c.dailyBudget.currency}` : ''}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(c.spend)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{cnt(c.taps)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{cnt(c.installs)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.installs > 0 ? fmt(c.spend / c.installs) : '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {c.status === 'ENABLED' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              loading={setStatus.isPending && setStatus.variables?.campaignId === c.id}
                              onClick={() => setStatus.mutate({ accountId: c.accountId, campaignId: c.id, status: 'PAUSED' })}
                            >
                              <Pause className="size-3.5" /> Stop
                            </Button>
                          ) : c.status === 'PAUSED' ? (
                            <Button
                              size="sm"
                              loading={setStatus.isPending && setStatus.variables?.campaignId === c.id}
                              onClick={() => setStatus.mutate({ accountId: c.accountId, campaignId: c.id, status: 'ENABLED' })}
                            >
                              <Play className="size-3.5" /> Run
                            </Button>
                          ) : null}
                          {c.status !== 'UNKNOWN' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setManageTarget({ accountId: c.accountId, id: c.id, name: c.name, status: c.status, displayStatus: c.displayStatus, servingStateReasons: c.servingStateReasons, adamId: c.adamId, dailyBudget: c.dailyBudget ?? null, countries: c.countries ?? [], accountLabel: c.accountLabel })}
                            >
                              <Settings2 className="size-3.5" /> Manage
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(campaignsQ.data?.errors.length ?? 0) > 0 && (
              <p className="border-t px-4 py-2 text-[12px] text-destructive">{campaignsQ.data!.errors[0]}</p>
            )}
          </div>
        </>
      )}

      <AppleAdsDialog open={appleOpen} onOpenChange={setAppleOpen} />
      <AdmobDialog open={admobOpen} onOpenChange={setAdmobOpen} />
      <CampaignManagerDialog
        open={!!manageTarget}
        onOpenChange={(o) => { if (!o) setManageTarget(null); }}
        campaign={manageTarget}
        days={Number(range)}
      />
      <CreateCampaignDialog
        open={createCampaignOpen}
        onOpenChange={setCreateCampaignOpen}
        accounts={appleAccounts.filter((a) => a.connected).map((a) => ({ id: a.id, label: a.label }))}
        campaigns={liveCampaigns}
      />
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={() => setRemoveTarget(null)}
        title={`Remove “${removeTarget?.label}”?`}
        description="Its stored credentials are deleted. Already-synced daily data stays until the next sync overwrites it."
        confirmLabel="Remove account"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.id);
          setRemoveTarget(null);
        }}
      />
    </Page>
  );
}

function AppleAdsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ label: '', clientId: '', teamId: '', keyId: '', orgId: '', privateKey: '' });
  const connect = useMutation({
    mutationFn: () =>
      api.adsAppleConnect({
        label: form.label.trim() || `Search Ads org ${form.orgId}`,
        clientId: form.clientId.trim(),
        teamId: form.teamId.trim(),
        keyId: form.keyId.trim(),
        privateKey: form.privateKey.trim(),
        orgId: Number(form.orgId),
      }),
    onSuccess: (res) => {
      toast.success('Apple Search Ads connected', { description: `${res.campaignsCount} campaigns found.` });
      onOpenChange(false);
      setForm({ label: '', clientId: '', teamId: '', keyId: '', orgId: '', privateKey: '' });
    },
    onError: (err) => toast.error('Couldn’t connect', { description: callableMessage(err) }),
  });
  const ready =
    form.clientId.trim() && form.teamId.trim() && form.keyId.trim() && Number(form.orgId) > 0 && form.privateKey.includes('BEGIN');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!connect.isPending) onOpenChange(o); }}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title="Add an Apple Search Ads account"
          description="In Apple Search Ads: Settings → API → create an API user (Read & Write to control campaigns), generate a key, and paste its details."
        />
        <div className="mb-3">
          <Label htmlFor="asa-label">Name this account</Label>
          <Input id="asa-label" value={form.label} placeholder="e.g. Rvira — Search Ads" onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="asa-client">Client ID</Label>
            <Input id="asa-client" value={form.clientId} placeholder="SEARCHADS.xxxxxxxx" onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="asa-team">Team ID</Label>
            <Input id="asa-team" value={form.teamId} placeholder="SEARCHADS.xxxxxxxx" onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="asa-key">Key ID</Label>
            <Input id="asa-key" value={form.keyId} placeholder="xxxxxxxx-xxxx…" onChange={(e) => setForm((f) => ({ ...f, keyId: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="asa-org">Org ID</Label>
            <Input id="asa-org" type="number" value={form.orgId} placeholder="1234567" onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))} />
            <FieldHint>Shown in the Search Ads account switcher (top right).</FieldHint>
          </div>
        </div>
        <div className="mt-3">
          <Label htmlFor="asa-pem">Private key (.pem)</Label>
          <Textarea
            id="asa-pem"
            rows={5}
            value={form.privateKey}
            placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
            onChange={(e) => setForm((f) => ({ ...f, privateKey: e.target.value }))}
            className="font-mono text-[11px]"
          />
          <FieldHint>Stored encrypted (AES-256-GCM) — same protection as your App Store Connect keys.</FieldHint>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={connect.isPending}>Cancel</Button>
          <Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!ready}>
            Verify & add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdmobDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const redirectUri = `${window.location.origin}/oauth/admob`;

  // After the first connection the OAuth client is saved server-side —
  // connecting more AdMob accounts is just "sign in with Google".
  const oauthQ = useQuery({
    queryKey: ['admobOauthStatus'],
    queryFn: () => api.admobOauthStatus({}),
    enabled: open,
    staleTime: 300_000,
  });
  const saved = oauthQ.data?.configured === true;

  const start = () => {
    const useClientId = saved ? oauthQ.data!.clientId! : clientId.trim();
    const state = crypto.randomUUID();
    sessionStorage.setItem(
      'admob-oauth',
      JSON.stringify({
        label: label.trim() || 'AdMob',
        // Omit credentials when the workspace client is saved — the server uses it.
        ...(saved ? {} : { clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
        state,
        redirectUri,
      }),
    );
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', useClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/admob.readonly');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    window.location.href = url.toString();
  };

  const ready = saved || (clientId.trim().includes('.apps.googleusercontent.com') && clientSecret.trim().length >= 6);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader
          title="Add an AdMob account"
          description={
            saved
              ? 'Sign in with the Google account that owns the AdMob account — its data syncs automatically.'
              : 'One-time setup in Google Cloud console — every AdMob account after this is just a Google sign-in.'
          }
        />
        <div className="mb-3">
          <Label htmlFor="am-label">Name this account</Label>
          <Input id="am-label" value={label} placeholder="e.g. Main AdMob" onChange={(e) => setLabel(e.target.value)} />
        </div>
        {!saved && !oauthQ.isLoading && (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
              <li>In <span className="font-medium text-foreground">console.cloud.google.com</span>, enable the <span className="font-medium text-foreground">AdMob API</span>.</li>
              <li>Create an <span className="font-medium text-foreground">OAuth client ID → Web application</span> with this redirect URI:</li>
            </ol>
            <code className="mt-1 block select-all rounded-lg border bg-muted/40 px-3 py-2 text-[12px]">{redirectUri}</code>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="am-id">OAuth Client ID</Label>
                <Input id="am-id" value={clientId} placeholder="xxxx.apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="am-secret">Client secret</Label>
                <Input id="am-secret" type="password" value={clientSecret} placeholder="GOCSPX-…" onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
              </div>
            </div>
            <FieldHint>Read-only reporting access. Saved once, encrypted server-side — you won’t enter this again.</FieldHint>
          </>
        )}
        {saved && (
          <p className="text-[13px] text-muted-foreground">
            Google will ask which account to use — pick the one that owns this AdMob account and approve read-only reporting access.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={start} disabled={!ready || oauthQ.isLoading}>
            Continue with Google
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
