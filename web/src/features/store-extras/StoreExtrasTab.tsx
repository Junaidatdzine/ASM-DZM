import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FileText,
  FlaskConical,
  Globe2,
  LayoutTemplate,
  Lock,
  Package,
  PlayCircle,
  Plus,
  RefreshCw,
  Repeat,
  Rocket,
  TestTubes,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Platform } from '@asm/shared';
import { can, describeBuildState } from '@asm/shared';
import { api, callableMessage, type AppExtrasResult, type Section } from '@/lib/callables';
import { useSession } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

function Card({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: typeof Globe2;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <h3 className="text-[13px] font-semibold">{title}</h3>
        </div>
        {badge}
      </header>
      {children}
    </section>
  );
}

function SectionBody<T>({
  section,
  render,
}: {
  section: Section<T>;
  render: (data: T) => React.ReactNode;
}) {
  if (!section.ok) return <p className="text-[12px] text-muted-foreground">Unavailable: {section.error}</p>;
  return <>{render(section.data)}</>;
}

const stateBadge = (state: string) => {
  const good = new Set(['APPROVED', 'PUBLISHED', 'COMPLETED', 'READY_FOR_SALE', 'ACCEPTED', 'VALID']);
  const warn = new Set(['IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING', 'PROCESSING', 'IN_PROGRESS']);
  return (
    <Badge variant={good.has(state) ? 'success' : warn.has(state) ? 'warning' : 'neutral'}>
      {state.replace(/_/g, ' ').toLowerCase()}
    </Badge>
  );
};

/**
 * Read-only App Store configuration pulled live from Apple: availability, pricing,
 * IAP, subscriptions, events, product pages, experiments, TestFlight, media, legal.
 * Editing these stays in App Store Connect for now — this keeps the whole picture visible.
 */
export function StoreExtrasTab({
  storeId,
  appId,
  platform,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
}) {
  const queryClient = useQueryClient();
  const key = ['appExtras', storeId, appId, platform];
  const extras = useQuery({
    queryKey: key,
    queryFn: () => api.appExtrasGet({ storeId, appId, platform }),
    staleTime: 60_000,
  });

  if (extras.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    );
  }
  if (extras.isError) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
        {callableMessage(extras.error)}
      </div>
    );
  }
  const data: AppExtrasResult = extras.data!;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">
          Live from App Store Connect{data.versionString ? ` · v${data.versionString}` : ''}. Subscriptions and
          TestFlight testers are managed right here; the rest links to ASC.
        </p>
        <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: key })} loading={extras.isFetching}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          icon={Globe2}
          title="Availability"
          badge={
            <a
              href={`https://appstoreconnect.apple.com/apps/${appId}/distribution/availability`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Edit territories ↗
            </a>
          }
        >
          <SectionBody
            section={data.availability}
            render={(a) => (
              <div className="space-y-1 text-[13px]">
                <div>
                  <span className="font-medium tabular-nums">{a.availableTerritories}</span>
                  <span className="text-muted-foreground"> of {a.totalTerritories || '—'} territories</span>
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {a.availableInNewTerritories === null
                    ? ''
                    : a.availableInNewTerritories
                      ? 'Automatically available in new territories.'
                      : 'Not released automatically in new territories.'}
                </div>
              </div>
            )}
          />
        </Card>

        <PricingCard
          storeId={storeId}
          appId={appId}
          platform={platform}
          section={data.price}
          onDone={() => queryClient.invalidateQueries({ queryKey: key })}
        />

        <Card
          icon={Package}
          title="In-app purchases"
          badge={data.iaps.ok ? <Badge variant="neutral">{data.iaps.data.length}</Badge> : undefined}
        >
          <SectionBody
            section={data.iaps}
            render={(iaps) =>
              iaps.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No in-app purchases.</p>
              ) : (
                <ul className="space-y-1.5">
                  {iaps.slice(0, 6).map((iap) => (
                    <li key={iap.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">{iap.name}</span>
                      {stateBadge(iap.state)}
                    </li>
                  ))}
                  {iaps.length > 6 && (
                    <li className="text-[11px] text-muted-foreground">+{iaps.length - 6} more</li>
                  )}
                </ul>
              )
            }
          />
        </Card>

        <SubscriptionsCard storeId={storeId} appId={appId} platform={platform} section={data.subscriptionGroups} onDone={() => queryClient.invalidateQueries({ queryKey: key })} />

        <TestFlightCard storeId={storeId} appId={appId} platform={platform} data={data} />

        <Card
          icon={CalendarRange}
          title="In-app events"
          badge={data.events.ok ? <Badge variant="neutral">{data.events.data.length}</Badge> : undefined}
        >
          <SectionBody
            section={data.events}
            render={(events) =>
              events.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No in-app events.</p>
              ) : (
                <ul className="space-y-1.5">
                  {events.map((event) => (
                    <li key={event.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">{event.name}</span>
                      {stateBadge(event.state)}
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Card>

        <Card
          icon={LayoutTemplate}
          title="Custom product pages"
          badge={data.productPages.ok ? <Badge variant="neutral">{data.productPages.data.length}</Badge> : undefined}
        >
          <SectionBody
            section={data.productPages}
            render={(pages) =>
              pages.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No custom product pages.</p>
              ) : (
                <ul className="space-y-1.5">
                  {pages.map((page) => (
                    <li key={page.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">{page.name}</span>
                      <Badge variant={page.visible ? 'success' : 'neutral'}>{page.visible ? 'Visible' : 'Hidden'}</Badge>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Card>

        <Card
          icon={FlaskConical}
          title="A/B experiments"
          badge={data.experiments.ok ? <Badge variant="neutral">{data.experiments.data.length}</Badge> : undefined}
        >
          <SectionBody
            section={data.experiments}
            render={(experiments) =>
              experiments.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No product page experiments.</p>
              ) : (
                <ul className="space-y-1.5">
                  {experiments.map((exp) => (
                    <li key={exp.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">
                        {exp.name}
                        {exp.trafficProportion !== null && (
                          <span className="text-muted-foreground"> · {exp.trafficProportion}%</span>
                        )}
                      </span>
                      {stateBadge(exp.state)}
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Card>

        <Card
          icon={PlayCircle}
          title="App previews"
          badge={data.previewSets.ok ? <Badge variant="neutral">{data.previewSets.data.length} sets</Badge> : undefined}
        >
          <SectionBody
            section={data.previewSets}
            render={(sets) =>
              sets.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No video previews on the primary language. Upload them in App Store Connect.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {sets.map((set) => (
                    <li key={set.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span>{set.previewType.replace(/_/g, ' ')}</span>
                      <span className="text-[12px] text-muted-foreground">
                        {set.previewCount} {set.previewCount === 1 ? 'video' : 'videos'}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Card>

        <Card icon={FileText} title="License agreement">
          <SectionBody
            section={data.eula}
            render={(text) => (
              <p className="text-[12px] text-muted-foreground">
                {text ? `Custom EULA (${text.length.toLocaleString()} characters).` : 'Uses Apple’s standard EULA.'}
              </p>
            )}
          />
        </Card>

        <Card icon={Lock} title="Encryption compliance">
          <SectionBody
            section={data.encryption}
            render={(declarations) =>
              declarations.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No encryption declarations on file.</p>
              ) : (
                <ul className="space-y-1.5">
                  {declarations.slice(0, 3).map((declaration) => (
                    <li key={declaration.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="text-muted-foreground">
                        {declaration.usesEncryption === false ? 'No non-exempt encryption' : 'Uses encryption'}
                      </span>
                      {stateBadge(declaration.state)}
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Card>
      </div>
    </div>
  );
}

// ---- Subscriptions (create + submit for review) ----

const PERIOD_LABELS: Record<string, string> = {
  ONE_WEEK: 'Weekly',
  ONE_MONTH: 'Monthly',
  TWO_MONTHS: 'Every 2 months',
  THREE_MONTHS: 'Every 3 months',
  SIX_MONTHS: 'Every 6 months',
  ONE_YEAR: 'Yearly',
};

/** Subscriptions Apple will accept a review submission for. */
const SUBMITTABLE_SUB_STATES = new Set(['MISSING_METADATA', 'READY_TO_SUBMIT', 'DEVELOPER_ACTION_NEEDED', 'REJECTED']);

function SubscriptionsCard({
  storeId,
  appId,
  platform,
  section,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  section: AppExtrasResult['subscriptionGroups'];
  onDone: () => void;
}) {
  const { user } = useSession();
  const canIap = !!user && can(user, 'manageIap', storeId, appId);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [subOpen, setSubOpen] = useState<string | null>(null); // groupId
  const [sub, setSub] = useState({ name: '', productId: '', period: 'ONE_MONTH', displayName: '', description: '' });

  const createGroup = useMutation({
    mutationFn: () => api.subscriptionGroupCreate({ storeId, appId, platform, referenceName: groupName.trim() }),
    onSuccess: () => {
      toast.success('Subscription group created');
      setGroupOpen(false);
      setGroupName('');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t create group', { description: callableMessage(err) }),
  });
  const createSub = useMutation({
    mutationFn: (groupId: string) =>
      api.subscriptionCreate({
        storeId,
        appId,
        platform,
        groupId,
        name: sub.name.trim(),
        productId: sub.productId.trim(),
        period: sub.period,
        displayName: (sub.displayName || sub.name).trim(),
        description: sub.description.trim(),
      }),
    onSuccess: () => {
      toast.success('Subscription created', { description: 'Add pricing in App Store Connect, then submit it for review.' });
      setSubOpen(null);
      setSub({ name: '', productId: '', period: 'ONE_MONTH', displayName: '', description: '' });
      onDone();
    },
    onError: (err) => toast.error('Couldn’t create subscription', { description: callableMessage(err) }),
  });
  const submitSub = useMutation({
    mutationFn: (target: { id: string; name: string }) =>
      api.subscriptionSubmit({ storeId, appId, platform, subscriptionId: target.id, name: target.name }),
    onSuccess: () => {
      toast.success('Subscription sent for review');
      onDone();
    },
    onError: (err) => toast.error('Couldn’t submit subscription', { description: callableMessage(err) }),
  });

  return (
    <Card
      icon={Repeat}
      title="Subscriptions"
      badge={
        section.ok ? (
          <Badge variant="neutral">{section.data.reduce((n, g) => n + g.subscriptions.length, 0)}</Badge>
        ) : undefined
      }
    >
      <SectionBody
        section={section}
        render={(groups) => (
          <div className="space-y-2.5">
            {groups.length === 0 && <p className="text-[12px] text-muted-foreground">No subscription groups yet.</p>}
            {groups.map((group) => (
              <div key={group.id}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.name}
                  </div>
                  {canIap && (
                    <button
                      type="button"
                      onClick={() => setSubOpen(group.id)}
                      className="text-[11px] font-medium text-primary hover:underline"
                    >
                      + Add
                    </button>
                  )}
                </div>
                <ul className="mt-1 space-y-1">
                  {group.subscriptions.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">
                        {item.name}
                        <span className="text-[11px] text-muted-foreground"> · {PERIOD_LABELS[item.period] ?? item.period}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {stateBadge(item.state)}
                        {canIap && SUBMITTABLE_SUB_STATES.has(item.state) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            loading={submitSub.isPending && submitSub.variables?.id === item.id}
                            onClick={() => submitSub.mutate({ id: item.id, name: item.name })}
                          >
                            <Rocket className="size-3" /> Submit
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                  {group.subscriptions.length === 0 && (
                    <li className="text-[12px] text-muted-foreground">Empty group.</li>
                  )}
                </ul>
              </div>
            ))}
            {canIap && (
              <Button variant="outline" size="sm" onClick={() => setGroupOpen(true)}>
                <Plus className="size-3.5" /> New group
              </Button>
            )}
          </div>
        )}
      />

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader title="New subscription group" description="An internal reference name — shoppers never see it." />
          <div className="space-y-1.5">
            <Label>Reference name</Label>
            <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Premium" maxLength={64} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupOpen(false)}>Cancel</Button>
            <Button disabled={!groupName.trim()} loading={createGroup.isPending} onClick={() => createGroup.mutate()}>
              Create group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={subOpen !== null} onOpenChange={(open) => !open && setSubOpen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader
            title="New subscription"
            description="Creates the subscription in App Store Connect. Pricing is set in ASC afterwards (it needs territory-by-territory price points)."
          />
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Reference name</Label>
              <Input value={sub.name} onChange={(e) => setSub({ ...sub, name: e.target.value })} placeholder="e.g. Pro Monthly" maxLength={64} />
            </div>
            <div className="space-y-1.5">
              <Label>Product ID</Label>
              <Input value={sub.productId} onChange={(e) => setSub({ ...sub, productId: e.target.value })} placeholder="e.g. com.yourapp.pro.monthly" maxLength={100} />
              <FieldHint>Permanent — can never be reused, even after deletion.</FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label>Billing period</Label>
              <Select value={sub.period} onValueChange={(v) => setSub({ ...sub, period: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PERIOD_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Display name (shown to shoppers)</Label>
              <Input value={sub.displayName} onChange={(e) => setSub({ ...sub, displayName: e.target.value })} placeholder="Defaults to the reference name" maxLength={30} />
            </div>
            <div className="space-y-1.5">
              <Label>Short description (optional)</Label>
              <Input value={sub.description} onChange={(e) => setSub({ ...sub, description: e.target.value })} placeholder="e.g. Unlock every workout plan" maxLength={45} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubOpen(null)}>Cancel</Button>
            <Button
              disabled={!sub.name.trim() || !sub.productId.trim()}
              loading={createSub.isPending}
              onClick={() => subOpen && createSub.mutate(subOpen)}
            >
              Create subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---- TestFlight (groups + testers) ----

function TestFlightCard({
  storeId,
  appId,
  platform,
  data,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  data: AppExtrasResult;
}) {
  const { user } = useSession();
  const canManage = !!user && can(user, 'manageTestFlight', storeId, appId);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  return (
    <Card
      icon={TestTubes}
      title="TestFlight"
      badge={data.recentBuilds.ok ? <Badge variant="neutral">{data.recentBuilds.data.length} builds</Badge> : undefined}
    >
      <div className="space-y-2.5">
        <SectionBody
          section={data.betaGroups}
          render={(groups) => (
            <ul className="space-y-1">
              {groups.map((g) => (
                <li key={g.id} className="rounded-lg border">
                  <button
                    type="button"
                    onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[13px]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {openGroup === g.id ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                      <span className="truncate">{g.name}</span>
                    </span>
                    <Badge variant={g.isInternal ? 'neutral' : 'accent'}>{g.isInternal ? 'Internal' : 'External'}</Badge>
                  </button>
                  {openGroup === g.id && (
                    <TestersList storeId={storeId} appId={appId} platform={platform} groupId={g.id} canManage={canManage} />
                  )}
                </li>
              ))}
            </ul>
          )}
        />
        <SectionBody
          section={data.recentBuilds}
          render={(builds) =>
            builds.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No builds uploaded.</p>
            ) : (
              <div className="text-[12px] text-muted-foreground">
                Latest build {builds[0]!.version} · {describeBuildState(builds[0]!.processingState)}
              </div>
            )
          }
        />
      </div>
    </Card>
  );
}

function TestersList({
  storeId,
  appId,
  platform,
  groupId,
  canManage,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  groupId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const key = ['tf-testers', storeId, appId, groupId];
  const testers = useQuery({
    queryKey: key,
    queryFn: () => api.testflightTestersList({ storeId, appId, platform, groupId }),
    staleTime: 30_000,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' });

  const add = useMutation({
    mutationFn: () =>
      api.testflightTesterAdd({
        storeId,
        appId,
        platform,
        groupId,
        email: form.email.trim(),
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Tester invited', { description: `${form.email.trim()} will get a TestFlight invite from Apple.` });
      setAddOpen(false);
      setForm({ email: '', firstName: '', lastName: '' });
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error('Couldn’t add tester', { description: callableMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: (tester: { id: string; email: string }) =>
      api.testflightTesterRemove({ storeId, appId, platform, groupId, testerId: tester.id, email: tester.email }),
    onSuccess: () => {
      toast.success('Tester removed from group');
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error('Couldn’t remove tester', { description: callableMessage(err) }),
  });

  return (
    <div className="border-t px-2.5 py-2">
      {testers.isLoading ? (
        <Skeleton className="h-10" />
      ) : testers.isError ? (
        <p className="text-[12px] text-muted-foreground">Couldn’t load testers: {callableMessage(testers.error)}</p>
      ) : (
        <ul className="space-y-1">
          {testers.data!.testers.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="min-w-0 truncate">
                {t.firstName || t.lastName ? `${t.firstName} ${t.lastName}`.trim() : t.email}
                {(t.firstName || t.lastName) && <span className="text-muted-foreground"> · {t.email}</span>}
              </span>
              {canManage && (
                <button
                  type="button"
                  title="Remove from this group"
                  onClick={() => remove.mutate({ id: t.id, email: t.email })}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </li>
          ))}
          {testers.data!.testers.length === 0 && (
            <li className="text-[12px] text-muted-foreground">No testers in this group yet.</li>
          )}
        </ul>
      )}
      {canManage && (
        <Button variant="outline" size="sm" className="mt-2 h-7 text-[12px]" onClick={() => setAddOpen(true)}>
          <UserPlus className="size-3" /> Add tester
        </Button>
      )}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader title="Invite a beta tester" description="Apple emails them a TestFlight invitation for this group." />
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="tester@example.com" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>First name (optional)</Label>
                <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Last name (optional)</Label>
                <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button disabled={!/.+@.+\..+/.test(form.email.trim())} loading={add.isPending} onClick={() => add.mutate()}>
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Pricing (editable) ----

function PricingCard({
  storeId,
  appId,
  platform,
  section,
  onDone,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  section: AppExtrasResult['price'];
  onDone: () => void;
}) {
  const { user } = useSession();
  const canPrice = !!user && can(user, 'manageIap', storeId, appId);
  const [editOpen, setEditOpen] = useState(false);
  const [selected, setSelected] = useState<string>('');

  const points = useQuery({
    queryKey: ['price-points', storeId, appId],
    queryFn: () => api.pricePointsList({ storeId, appId, platform }),
    enabled: editOpen,
    staleTime: 30 * 60_000, // Apple's tier list barely changes — don't refetch needlessly
  });

  const save = useMutation({
    mutationFn: () => {
      const point = points.data?.pricePoints.find((pp) => pp.id === selected);
      return api.priceScheduleSet({ storeId, appId, platform, pricePointId: selected, customerPrice: point?.customerPrice });
    },
    onSuccess: () => {
      toast.success('Price updated', { description: 'Apple applies it across all territories from the US base price.' });
      setEditOpen(false);
      onDone();
    },
    onError: (err) => toast.error('Couldn’t update the price', { description: callableMessage(err) }),
  });

  const fmt = (v: string) => (v === '0.0' || v === '0.00' || v === '0' ? 'Free' : `$${v}`);

  return (
    <Card
      icon={CreditCard}
      title="Pricing"
      badge={
        canPrice ? (
          <button type="button" onClick={() => setEditOpen(true)} className="text-[11px] font-medium text-primary hover:underline">
            Edit
          </button>
        ) : undefined
      }
    >
      <SectionBody
        section={section}
        render={(p) => (
          <div className="space-y-1 text-[13px]">
            <div className="text-lg font-semibold tabular-nums">
              {p.customerPrice === null ? '—' : fmt(p.customerPrice)}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {p.baseTerritory ? `Base territory ${p.baseTerritory}` : 'No base price set yet'}
              {p.proceeds && p.proceeds !== '0.0' && p.proceeds !== '0.00' ? ` · your proceeds $${p.proceeds}` : ''}
            </div>
          </div>
        )}
      />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader
            title="Set the app's price"
            description="Pick a US base price — Apple derives every other territory from it automatically. Takes effect right away."
          />
          {points.isLoading ? (
            <Skeleton className="h-10" />
          ) : points.isError ? (
            <p className="text-[13px] text-muted-foreground">{callableMessage(points.error)}</p>
          ) : (
            <div className="space-y-1.5">
              <Label>Price (USD)</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a price…" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(points.data?.pricePoints ?? []).map((pp) => (
                    <SelectItem key={pp.id} value={pp.id}>
                      {fmt(pp.customerPrice)}
                      {Number(pp.customerPrice) > 0 ? ` — you keep $${pp.proceeds}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>Showing Apple’s standard tiers. Proceeds shown before any Small Business Program adjustment.</FieldHint>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button disabled={!selected} loading={save.isPending} onClick={() => save.mutate()}>
              Save price
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
