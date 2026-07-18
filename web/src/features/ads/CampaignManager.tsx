import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Pause, Play, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AdsAdGroupLive, AdsKeywordLive } from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

export interface CampaignRef {
  accountId: string;
  id: string;
  name: string;
  status: string;
  dailyBudget: { amount: number; currency: string } | null;
  countries: string[];
  accountLabel?: string;
}

const money = (amount: number, currency = 'USD') =>
  `${currency === 'USD' ? '$' : ''}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency !== 'USD' ? ` ${currency}` : ''}`;
const cnt = (n: number) => n.toLocaleString('en-US');

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  if (s === 'ENABLED' || s === 'ACTIVE') return <Badge variant="success">Running</Badge>;
  if (s === 'PAUSED') return <Badge variant="warning">Paused</Badge>;
  return <Badge variant="outline">{status.toLowerCase()}</Badge>;
}

/** Inline "value + Save" editor for a money amount (bids, budgets). */
function AmountEditor({ value, currency, onSave, pending, label }: { value: number; currency: string; onSave: (v: number) => void; pending: boolean; label: string }) {
  const [v, setV] = useState(String(value));
  const changed = Number(v) > 0 && Number(v) !== value;
  return (
    <div className="flex items-center gap-1.5">
      <Input aria-label={label} value={v} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} className="h-8 w-20 text-right tabular-nums" />
      <span className="text-[11px] text-muted-foreground">{currency}</span>
      <Button size="sm" variant="outline" disabled={!changed} loading={pending} onClick={() => onSave(Number(v))}>Save</Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Keywords + negatives + search terms for a single ad group
// ─────────────────────────────────────────────────────────────────────────────
function AdGroupDetail({ campaign, adGroup, days }: { campaign: CampaignRef; adGroup: AdsAdGroupLive; days: number }) {
  const qc = useQueryClient();
  const ctx = { accountId: campaign.accountId, campaignId: campaign.id, adGroupId: adGroup.id };
  const invalidate = () => qc.invalidateQueries({ queryKey: ['adsKeywords', adGroup.id] });

  const keywordsQ = useQuery({ queryKey: ['adsKeywords', adGroup.id, days], queryFn: () => api.adsKeywordsList({ ...ctx, days }), staleTime: 60_000 });
  const negativesQ = useQuery({ queryKey: ['adsNegatives', adGroup.id], queryFn: () => api.adsNegativeKeywordsList(ctx), staleTime: 60_000 });
  const termsQ = useQuery({ queryKey: ['adsTerms', adGroup.id, days], queryFn: () => api.adsSearchTermsList({ ...ctx, days }), staleTime: 60_000 });

  const kwUpdate = useMutation({
    mutationFn: (v: { keywordId: string; status?: 'ACTIVE' | 'PAUSED'; bid?: { amount: number; currency: string } }) => api.adsKeywordUpdate({ ...ctx, ...v }),
    onSuccess: () => { toast.success('Keyword updated'); invalidate(); },
    onError: (e) => toast.error('Update failed', { description: callableMessage(e) }),
  });

  const [newKw, setNewKw] = useState('');
  const [newMatch, setNewMatch] = useState<'EXACT' | 'BROAD'>('EXACT');
  const currency = adGroup.defaultBid?.currency ?? 'USD';
  const kwCreate = useMutation({
    mutationFn: () => api.adsKeywordsCreate({ ...ctx, keywords: newKw.split(/[\n,]/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, matchType: newMatch, bid: { amount: adGroup.defaultBid?.amount ?? 1, currency } })) }),
    onSuccess: (r) => { toast.success(`${r.created} keyword(s) added`); setNewKw(''); invalidate(); },
    onError: (e) => toast.error('Couldn’t add keywords', { description: callableMessage(e) }),
  });

  const [newNeg, setNewNeg] = useState('');
  const negAdd = useMutation({
    mutationFn: () => api.adsNegativeKeywordsAdd({ ...ctx, keywords: newNeg.split(/[\n,]/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, matchType: 'EXACT' as const })) }),
    onSuccess: () => { toast.success('Negative keywords added'); setNewNeg(''); qc.invalidateQueries({ queryKey: ['adsNegatives', adGroup.id] }); },
    onError: (e) => toast.error('Failed', { description: callableMessage(e) }),
  });
  const negDelete = useMutation({
    mutationFn: (keywordId: string) => api.adsNegativeKeywordDelete({ ...ctx, keywordId }),
    onSuccess: () => { toast.success('Removed'); qc.invalidateQueries({ queryKey: ['adsNegatives', adGroup.id] }); },
    onError: (e) => toast.error('Failed', { description: callableMessage(e) }),
  });

  const keywords = keywordsQ.data?.keywords ?? [];

  return (
    <div className="space-y-5 border-t bg-muted/20 p-4">
      {/* Keywords */}
      <div>
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Keywords</h4>
        <div className="overflow-x-auto rounded-lg border bg-card">
          {keywordsQ.isLoading ? (
            <div className="space-y-2 p-3">{[0, 1].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : keywords.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">No keywords in this ad group yet.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Keyword</th>
                  <th className="px-3 py-2 font-medium">Match</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Bid</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">Installs</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((k: AdsKeywordLive) => (
                  <tr key={k.id} className="border-b last:border-0">
                    <td className="max-w-[200px] truncate px-3 py-1.5 font-medium">{k.text}</td>
                    <td className="px-3 py-1.5"><Badge variant="outline">{k.matchType.toLowerCase()}</Badge></td>
                    <td className="px-3 py-1.5"><StatusBadge status={k.status} /></td>
                    <td className="px-3 py-1.5 text-right">
                      {k.bid ? (
                        <AmountEditor
                          label={`Bid for ${k.text}`}
                          value={k.bid.amount}
                          currency={k.bid.currency}
                          pending={kwUpdate.isPending && kwUpdate.variables?.keywordId === k.id && !!kwUpdate.variables?.bid}
                          onSave={(amount) => kwUpdate.mutate({ keywordId: k.id, bid: { amount, currency: k.bid!.currency } })}
                        />
                      ) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(k.spendAmount, k.spendCurrency)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{cnt(k.installs)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        size="iconSm"
                        variant="ghost"
                        title={k.status.toUpperCase() === 'PAUSED' ? 'Resume' : 'Pause'}
                        loading={kwUpdate.isPending && kwUpdate.variables?.keywordId === k.id && !!kwUpdate.variables?.status}
                        onClick={() => kwUpdate.mutate({ keywordId: k.id, status: k.status.toUpperCase() === 'PAUSED' ? 'ACTIVE' : 'PAUSED' })}
                      >
                        {k.status.toUpperCase() === 'PAUSED' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* Add keywords */}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <Label htmlFor={`kw-${adGroup.id}`}>Add keywords</Label>
            <Input id={`kw-${adGroup.id}`} value={newKw} placeholder="comma or newline separated" onChange={(e) => setNewKw(e.target.value)} />
          </div>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {(['EXACT', 'BROAD'] as const).map((m) => (
              <button key={m} onClick={() => setNewMatch(m)} className={cn('rounded-md px-2.5 py-1 text-[11px] font-medium', newMatch === m ? 'bg-card shadow-sm' : 'text-muted-foreground')}>{m.toLowerCase()}</button>
            ))}
          </div>
          <Button size="sm" loading={kwCreate.isPending} disabled={!newKw.trim()} onClick={() => kwCreate.mutate()}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
        <FieldHint>New keywords use the ad group default bid ({money(adGroup.defaultBid?.amount ?? 0, currency)}). Edit each bid after adding.</FieldHint>
      </div>

      {/* Negatives */}
      <div>
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Negative keywords</h4>
        <div className="flex flex-wrap gap-1.5">
          {(negativesQ.data?.negatives ?? []).map((n) => (
            <span key={n.id} className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-[12px]">
              {n.text} <span className="text-[10px] text-muted-foreground">{n.matchType.toLowerCase()}</span>
              <button className="text-muted-foreground hover:text-destructive" onClick={() => negDelete.mutate(n.id)} aria-label={`Remove ${n.text}`}><Trash2 className="size-3" /></button>
            </span>
          ))}
          {(negativesQ.data?.negatives.length ?? 0) === 0 && !negativesQ.isLoading && <span className="text-[12px] text-muted-foreground">None — add words you never want to match.</span>}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <Input value={newNeg} placeholder="add negative keywords" onChange={(e) => setNewNeg(e.target.value)} className="max-w-xs" />
          <Button size="sm" variant="outline" loading={negAdd.isPending} disabled={!newNeg.trim()} onClick={() => negAdd.mutate()}>Add negative</Button>
        </div>
      </div>

      {/* Search terms */}
      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Search className="size-3.5" /> Search terms customers used
        </h4>
        <div className="overflow-x-auto rounded-lg border bg-card">
          {termsQ.isLoading ? (
            <div className="space-y-2 p-3">{[0, 1].map((i) => <Skeleton key={i} className="h-7" />)}</div>
          ) : (termsQ.data?.terms.length ?? 0) === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">No search-term data in this range.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Search term</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">Taps</th>
                  <th className="px-3 py-2 text-right font-medium">Installs</th>
                </tr>
              </thead>
              <tbody>
                {(termsQ.data?.terms ?? []).map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="max-w-[240px] truncate px-3 py-1.5">{t.label}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(t.spendAmount, t.spendCurrency)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{cnt(t.taps)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{cnt(t.installs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign manager dialog — ad groups list + drill-down + campaign controls
// ─────────────────────────────────────────────────────────────────────────────
export function CampaignManagerDialog({ open, onOpenChange, campaign, days }: { open: boolean; onOpenChange: (o: boolean) => void; campaign: CampaignRef | null; days: number }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newAgName, setNewAgName] = useState('');
  const [newAgBid, setNewAgBid] = useState('1.00');
  const currency = campaign?.dailyBudget?.currency ?? 'USD';

  const adGroupsQ = useQuery({
    queryKey: ['adGroups', campaign?.accountId, campaign?.id, days],
    queryFn: () => api.adsAdGroupsList({ accountId: campaign!.accountId, campaignId: campaign!.id, days }),
    enabled: open && !!campaign,
    staleTime: 60_000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['adGroups', campaign?.accountId, campaign?.id] });

  const agUpdate = useMutation({
    mutationFn: (v: { adGroupId: string; status?: 'ENABLED' | 'PAUSED'; defaultBid?: { amount: number; currency: string } }) => api.adsAdGroupUpdate({ accountId: campaign!.accountId, campaignId: campaign!.id, ...v }),
    onSuccess: () => { toast.success('Ad group updated'); invalidate(); },
    onError: (e) => toast.error('Update failed', { description: callableMessage(e) }),
  });
  const agCreate = useMutation({
    mutationFn: () => api.adsAdGroupCreate({ accountId: campaign!.accountId, campaignId: campaign!.id, name: newAgName.trim(), defaultBid: { amount: Number(newAgBid) || 1, currency } }),
    onSuccess: () => { toast.success('Ad group created'); setCreating(false); setNewAgName(''); invalidate(); },
    onError: (e) => toast.error('Couldn’t create ad group', { description: callableMessage(e) }),
  });
  const campaignBudget = useMutation({
    mutationFn: (dailyBudget: number) => api.adsCampaignUpdate({ accountId: campaign!.accountId, campaignId: campaign!.id, currency, dailyBudget }),
    onSuccess: () => { toast.success('Daily budget updated'); qc.invalidateQueries({ queryKey: ['adsCampaigns'] }); },
    onError: (e) => toast.error('Couldn’t update budget', { description: callableMessage(e) }),
  });

  const adGroups = adGroupsQ.data?.adGroups ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader title={campaign?.name ?? 'Campaign'} description={`${campaign?.accountLabel ?? ''} · ${(campaign?.countries ?? []).join(', ') || 'all countries'}`} />

        {/* Campaign-level controls */}
        <div className="mb-4 flex flex-wrap items-end gap-4 rounded-xl border bg-muted/20 p-3">
          <div>
            <Label>Daily budget</Label>
            {campaign?.dailyBudget ? (
              <AmountEditor label="Daily budget" value={campaign.dailyBudget.amount} currency={currency} pending={campaignBudget.isPending} onSave={(v) => campaignBudget.mutate(v)} />
            ) : <div className="text-[13px] text-muted-foreground">—</div>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge status={campaign?.status ?? ''} />
          </div>
        </div>

        {/* Ad groups */}
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Ad groups</h3>
          <Button size="sm" variant="outline" onClick={() => setCreating((c) => !c)}><Plus className="size-3.5" /> New ad group</Button>
        </div>

        {creating && (
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
            <div className="min-w-[180px] flex-1">
              <Label htmlFor="new-ag">Name</Label>
              <Input id="new-ag" value={newAgName} placeholder="e.g. Exact — brand terms" onChange={(e) => setNewAgName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="new-ag-bid">Default bid ({currency})</Label>
              <Input id="new-ag-bid" value={newAgBid} className="w-28 text-right" onChange={(e) => setNewAgBid(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <Button size="sm" loading={agCreate.isPending} disabled={!newAgName.trim() || !(Number(newAgBid) > 0)} onClick={() => agCreate.mutate()}>Create</Button>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border bg-card">
          {adGroupsQ.isLoading ? (
            <div className="space-y-2 p-3">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : adGroups.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No ad groups yet — create one to hold your keywords.</p>
          ) : (
            adGroups.map((g) => (
              <div key={g.id} className="border-b last:border-0">
                <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setExpanded((x) => (x === g.id ? null : g.id))}>
                    <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded === g.id && 'rotate-90')} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{g.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{money(g.spendAmount, g.spendCurrency)} spend · {cnt(g.installs)} installs</span>
                    </span>
                  </button>
                  <StatusBadge status={g.status} />
                  {g.defaultBid && (
                    <AmountEditor
                      label={`Default bid for ${g.name}`}
                      value={g.defaultBid.amount}
                      currency={g.defaultBid.currency}
                      pending={agUpdate.isPending && agUpdate.variables?.adGroupId === g.id && !!agUpdate.variables?.defaultBid}
                      onSave={(amount) => agUpdate.mutate({ adGroupId: g.id, defaultBid: { amount, currency: g.defaultBid!.currency } })}
                    />
                  )}
                  <Button
                    size="iconSm"
                    variant="ghost"
                    title={g.status.toUpperCase() === 'PAUSED' ? 'Resume' : 'Pause'}
                    loading={agUpdate.isPending && agUpdate.variables?.adGroupId === g.id && !!agUpdate.variables?.status}
                    onClick={() => agUpdate.mutate({ adGroupId: g.id, status: g.status.toUpperCase() === 'PAUSED' ? 'ENABLED' : 'PAUSED' })}
                  >
                    {g.status.toUpperCase() === 'PAUSED' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  </Button>
                </div>
                {expanded === g.id && campaign && <AdGroupDetail campaign={campaign} adGroup={g} days={days} />}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create campaign dialog
// ─────────────────────────────────────────────────────────────────────────────
export function CreateCampaignDialog({ open, onOpenChange, accounts }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: Array<{ id: string; label: string }> }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ accountId: '', name: '', adamId: '', currency: 'USD', budget: '', dailyBudget: '', countries: 'US' });
  const create = useMutation({
    mutationFn: () =>
      api.adsCampaignCreate({
        accountId: form.accountId || accounts[0]?.id || '',
        name: form.name.trim(),
        adamId: Number(form.adamId),
        currency: form.currency.trim().toUpperCase() || 'USD',
        budget: Number(form.budget),
        dailyBudget: Number(form.dailyBudget),
        countries: form.countries.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c.length === 2),
      }),
    onSuccess: () => {
      toast.success('Campaign created', { description: 'It starts paused-safe — review ad groups & keywords before it spends.' });
      onOpenChange(false);
      setForm({ accountId: '', name: '', adamId: '', currency: 'USD', budget: '', dailyBudget: '', countries: 'US' });
      qc.invalidateQueries({ queryKey: ['adsCampaigns'] });
    },
    onError: (e) => toast.error('Couldn’t create campaign', { description: callableMessage(e) }),
  });

  const countries = form.countries.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c.length === 2);
  const ready = form.name.trim() && Number(form.adamId) > 0 && Number(form.budget) > 0 && Number(form.dailyBudget) > 0 && countries.length > 0 && (form.accountId || accounts.length > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!create.isPending) onOpenChange(o); }}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader title="New Search Ads campaign" description="Creates the campaign in Apple Search Ads. Add ad groups and keywords next, then it starts serving." />
        {accounts.length > 1 && (
          <div className="mb-3">
            <Label>Account</Label>
            <div className="flex flex-wrap gap-1.5">
              {accounts.map((a) => (
                <button key={a.id} onClick={() => setForm((f) => ({ ...f, accountId: a.id }))} className={cn('rounded-full border px-2.5 py-1 text-[12px] font-medium', (form.accountId || accounts[0]?.id) === a.id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>{a.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="c-name">Campaign name</Label>
            <Input id="c-name" value={form.name} placeholder="e.g. AI Detector — US Search" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="c-adam">App (Apple ID)</Label>
            <Input id="c-adam" value={form.adamId} placeholder="6754688919" onChange={(e) => setForm((f) => ({ ...f, adamId: e.target.value.replace(/[^0-9]/g, '') }))} />
            <FieldHint>The app’s numeric App Store ID (from its listing URL).</FieldHint>
          </div>
          <div>
            <Label htmlFor="c-countries">Countries</Label>
            <Input id="c-countries" value={form.countries} placeholder="US, GB, DE" onChange={(e) => setForm((f) => ({ ...f, countries: e.target.value }))} />
            <FieldHint>2-letter codes, comma separated.</FieldHint>
          </div>
          <div>
            <Label htmlFor="c-currency">Currency</Label>
            <Input id="c-currency" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))} />
          </div>
          <div>
            <Label htmlFor="c-daily">Daily budget</Label>
            <Input id="c-daily" value={form.dailyBudget} placeholder="25" onChange={(e) => setForm((f) => ({ ...f, dailyBudget: e.target.value.replace(/[^0-9.]/g, '') }))} />
          </div>
          <div>
            <Label htmlFor="c-budget">Total budget</Label>
            <Input id="c-budget" value={form.budget} placeholder="500" onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value.replace(/[^0-9.]/g, '') }))} />
            <FieldHint>Lifetime cap for the campaign.</FieldHint>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
          <Button loading={create.isPending} disabled={!ready} onClick={() => create.mutate()}>Create campaign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
