import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Banknote, Download, Package, RefreshCw, Store } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Page } from '@/layout/AppShell';
import { api, callableMessage, type AnalyticsOverviewResult } from '@/lib/callables';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { AppGlyph, StoreDot, StoreGlyph } from '@/components/StoreGlyph';
import { PlatformBadges } from '@/components/PlatformBadges';
import { cn } from '@/lib/utils';

const RANGES = [1, 7, 30, 90] as const;

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: value >= 1000 ? 0 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function Growth({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[11px] text-muted-foreground">No previous period</span>;
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', up ? 'text-success' : 'text-destructive')}>
      <Icon className="size-3" /> {Math.abs(value)}% vs previous period
    </span>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  growth,
  note,
  explain,
}: {
  label: string;
  value: string;
  icon: typeof Banknote;
  growth?: number | null;
  note?: string;
  /** Plain-language definition shown on hover — every number explains itself. */
  explain?: string;
}) {
  return (
    <div title={explain} className="border-b bg-card px-4 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-1">{growth !== undefined ? <Growth value={growth} /> : <span className="text-[11px] text-muted-foreground">{note}</span>}</div>
    </div>
  );
}

export function AnalyticsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [storeId, setStoreId] = useState('all');
  const [data, setData] = useState<AnalyticsOverviewResult | null>(null);
  // One automatic first-time sync per visit — new stores shouldn't sit at $0
  // until someone finds the Sync button.
  const autoSynced = useRef(false);
  const analytics = useMutation({
    mutationFn: (sync: boolean | { onlyStoreIds: string[] }) => api.analyticsOverview({
      days,
      sync: sync !== false,
      // First-time backfills sync ONLY the missing stores — never the whole fleet.
      ...(typeof sync === 'object' ? { syncStoreIds: sync.onlyStoreIds } : {}),
      ...(storeId === 'all' ? {} : { storeId }),
    }),
    onSuccess: (result) => {
      setData(result);
      // "Missing" = never attempted (or attempt >24h old). A store with a fresh
      // attempt and still no reports simply has nothing at Apple yet — looping
      // 35 report requests at it every visit helps nobody.
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const missing = result.perStore.filter(
        (store) => store.canSync && !store.hasFinance && (store.financeSyncedAt ?? 0) < dayAgo,
      );
      if (missing.length > 0 && !autoSynced.current) {
        autoSynced.current = true;
        toast.info(
          missing.length === 1
            ? `Fetching finance reports for “${missing[0]!.name}” for the first time…`
            : `Fetching finance reports for ${missing.length} newly added stores…`,
          { description: 'Numbers will fill in automatically in a moment.' },
        );
        analytics.mutate({ onlyStoreIds: missing.map((store) => store.storeId) });
      }
    },
    onError: (error) => toast.error('Analytics failed', { description: callableMessage(error) }),
  });

  useEffect(() => {
    analytics.mutate(false);
    // The selected range is the only automatic refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, storeId]);

  const maxSeries = Math.max(1, ...(data?.series.map((point) => point.proceeds) ?? []));
  const maxStore = Math.max(1, ...(data?.perStore.map((store) => store.proceedsPrimary) ?? []));
  const paidUnits = Math.max(0, (data?.totals.units ?? 0) - (data?.totals.downloads ?? 0));
  const dateSpan = useMemo(() => {
    if (!data?.series.length) return null;
    return `${data.series[0]!.date} → ${data.series[data.series.length - 1]!.date}`;
  }, [data]);

  return (
    <Page
      title="Analytics"
      description="Business performance across every connected App Store account. Admin-only."
      wide
      actions={
        <>
          <Select value={storeId} onValueChange={setStoreId}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stores</SelectItem>
              {(data?.availableStores ?? []).map((store) => (
                <SelectItem key={store.storeId} value={store.storeId}>
                  <span className="inline-flex items-center gap-2">
                    <StoreDot color={store.color} seed={store.storeId} />
                    {store.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {RANGES.map((range) => (
              <button
                key={range}
                onClick={() => setDays(range)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  days === range ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {range === 1 ? 'Latest report' : `${range} days`}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => analytics.mutate(true)} loading={analytics.isPending}>
            <RefreshCw className="size-3.5" /> {storeId === 'all' ? 'Sync all' : 'Sync store'}
          </Button>
        </>
      }
    >
      {!data && analytics.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
        </div>
      ) : data ? (
        <div className="space-y-4">
          <section className="grid overflow-hidden rounded-xl border bg-card shadow-card sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Proceeds · USD"
              value={money(data.totals.proceedsPrimary, 'USD')}
              icon={Banknote}
              growth={data.growth.proceeds}
              explain="Your earnings AFTER Apple's commission, from Apple's daily sales reports, converted to USD with daily reference rates. Growth compares the equivalent previous period."
            />
            <Stat
              label="Downloads"
              value={count(data.totals.downloads)}
              icon={Download}
              growth={data.growth.downloads}
              explain="First-time installs only — updates, re-downloads and purchases are not counted here."
            />
            <Stat
              label="Paid units"
              value={count(paidUnits)}
              icon={Package}
              note="IAP, subscriptions and paid updates"
              explain="Paid transactions: in-app purchases, subscription starts & renewals, and paid app sales. Downloads are excluded."
            />
            <Stat
              label="Coverage"
              value={`${data.appsTotal} apps`}
              icon={Store}
              note={`${data.storesWithFinance}/${data.storesTotal} stores reporting`}
              explain="Stores reporting = stores with at least one Apple sales report synced. New stores appear after their first report day closes."
            />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.8fr)]">
            <section className="rounded-xl border bg-card p-4 shadow-card">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-[13px] font-semibold">{days === 1 ? 'Latest reported proceeds' : 'Daily proceeds'}</h2>
                  <p className="text-[11px] text-muted-foreground">
                    {days === 1
                      ? 'Each store\u2019s newest available report \u2014 Apple publishes a day the following day, and dates can vary per store (see the list on the right).'
                      : (dateSpan ?? 'No report dates in this range')}
                  </p>
                </div>
                <Badge variant="outline" title={`Converted using ${data.exchangeRateDate} reference rates`}>USD</Badge>
              </div>
              {days === 1 ? (
                <p className="rounded-lg bg-muted/40 px-4 py-2.5 text-[12px] text-muted-foreground">
                  {money(data.totals.proceedsPrimary, 'USD')} · {count(data.totals.downloads)} downloads across the newest report of every store
                  {data.series.length > 1 ? ` (report days ${data.series[0]!.date} \u2192 ${data.series[data.series.length - 1]!.date})` : data.series.length === 1 ? ` (${data.series[0]!.date})` : ''}.
                </p>
              ) : data.series.length ? (
                <div className="flex h-44 items-end gap-[3px] border-b pb-px">
                  {data.series.map((point) => (
                    <div key={point.date} className="group relative flex h-full min-w-1 flex-1 items-end">
                      <div
                        className="w-full rounded-t-sm bg-primary/80 transition-colors group-hover:bg-primary"
                        style={{ height: `${Math.max(2, (point.proceeds / maxSeries) * 100)}%` }}
                      />
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[10px] text-background shadow-pop group-hover:block">
                        {point.date} · {money(point.proceeds, data.primaryCurrency)} · {count(point.downloads)} downloads
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-4 text-center text-[12px] text-muted-foreground">
                  No report data in this range yet — Apple publishes each day's report the following day.
                </p>
              )}

              <div className="mt-4 border-t pt-3">
                <div className="mb-1 flex items-baseline justify-between">
                  <h2 className="text-[13px] font-semibold">Top apps</h2>
                  <p className="text-[11px] text-muted-foreground">
                    Highest proceeds {storeId === 'all' ? 'across all stores' : 'in this store'}
                  </p>
                </div>
                <div className="grid divide-y md:grid-cols-2 md:gap-x-6 md:divide-y-0">
                  {data.topApps.map((app) => (
                    <Link key={`${app.storeId}-${app.appId}`} to={`/stores/${app.storeId}/apps/${app.appId}`} className="flex items-center gap-3 rounded-lg px-1.5 py-2 hover:bg-muted/50">
                      <AppGlyph name={app.name} iconUrl={app.iconUrl} seed={app.appId} size="md" className="rounded-[22%]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium">{app.name}</span>
                          <PlatformBadges platforms={app.platforms as never} devices={app.devices as never} className="shrink-0" />
                        </div>
                        <div className="mt-0.5 flex justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>{count(app.downloads)} downloads</span>
                          <span className="font-medium tabular-nums text-foreground">{money(app.proceeds, data.primaryCurrency)}</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                  {data.topApps.length === 0 && (
                    <p className="px-4 py-6 text-center text-[12px] text-muted-foreground md:col-span-2">No per-app sales data in this range.</p>
                  )}
                </div>
              </div>
            </section>

            <section className="flex max-h-[640px] flex-col overflow-hidden rounded-xl border bg-card shadow-card xl:self-start">
              <div className="border-b px-4 py-3">
                <h2 className="text-[13px] font-semibold">Store performance</h2>
                <p className="text-[11px] text-muted-foreground">Ranked by proceeds · click a store for its full finance page</p>
              </div>
              <div className="min-h-0 flex-1 divide-y overflow-y-auto">
                {data.perStore.map((store) => (
                  <Link key={store.storeId} to={`/stores/${store.storeId}/finance`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                    <StoreGlyph color={store.color} icon={store.icon} seed={store.storeId} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{store.name}</span>
                          {!store.hasFinance && (
                            <Badge variant="outline" title={store.canSync ? 'No sales reports from Apple yet — new stores appear after their first report day closes.' : 'Add the vendor number in Stores \u2192 Settings to unlock finance.'}>
                              {store.canSync ? 'no reports yet' : 'no vendor number'}
                            </Badge>
                          )}
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">{store.hasFinance ? money(store.proceedsPrimary, data.primaryCurrency) : '\u2014'}</span>
                      </div>
                      {days === 1 && store.latestReportDate && (
                        <div className="text-[10px] text-muted-foreground">report {store.latestReportDate}</div>
                      )}
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${(store.proceedsPrimary / maxStore) * 100}%` }} />
                        </div>
                        <span className="text-[10px] tabular-nums text-muted-foreground">{count(store.downloads)} ↓</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          </div>

          <section className="rounded-xl border border-dashed bg-card/50 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="text-foreground">How these numbers work:</strong> Proceeds are your earnings after
            Apple\u2019s commission, taken from Apple\u2019s official daily sales reports and converted to USD with daily
            reference rates \u2014 Apple publishes each day\u2019s report the following day, so \u201ctoday\u201d never appears.
            Downloads count first-time installs only; Paid units count IAP, subscription and paid-app transactions.
            \u201cLatest report\u201d shows every store\u2019s newest available day (dates can differ per store); the 7/30/90-day
            views use exact calendar windows. Purchases still being matched to their app are included in totals and
            excluded from Top apps until the next sync attributes them.
          </section>
        </div>
      ) : null}
    </Page>
  );
}
