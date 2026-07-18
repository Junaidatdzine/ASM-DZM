import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, DraftDoc, LocaleDoc, Platform } from '@asm/shared';
import { FIELD_SPECS, decodeFieldKey, localeInfo } from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { buildFieldViews } from './model';
import { ALL_FIELDS } from '@asm/shared';

interface DiffRow {
  key: string;
  label: string;
  from: string;
  to: string;
  conflict: boolean;
}

function truncate(v: string, n = 160): string {
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

type LocaleResult = { locale: string; ok: boolean; error?: string };

export function PushDrawer({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  app,
  locales,
  drafts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  locales: Map<string, LocaleDoc>;
  drafts: Map<string, DraftDoc>;
}) {
  const perLocale = useMemo(() => {
    const out: Array<{ locale: string; rows: DiffRow[] }> = [];
    for (const [locale, draft] of drafts) {
      const keys = Object.keys(draft.fields ?? {});
      if (keys.length === 0) continue;
      const localeDoc = locales.get(locale) ?? null;
      const views = buildFieldViews(app, platform, localeDoc, draft, ALL_FIELDS);
      const rows: DiffRow[] = [];
      for (const key of keys) {
        const decoded = decodeFieldKey(key);
        if (!decoded) continue;
        const view = views.find((v) => v.key === key);
        rows.push({
          key,
          label: FIELD_SPECS[decoded.field].label,
          from: draft.base?.[key] ?? '',
          to: draft.fields[key] ?? '',
          conflict: view?.conflict ?? false,
        });
      }
      if (rows.length > 0) out.push({ locale, rows });
    }
    return out.sort((a, b) => a.locale.localeCompare(b.locale));
  }, [drafts, locales, app, platform]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, LocaleResult> | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(new Set(perLocale.map((p) => p.locale)));
      setResults(null);
    }
  }, [open, perLocale.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: () =>
      api.locPush({ storeId, appId, platform, locales: [...selected] }),
    onSuccess: (res) => {
      const map = new Map<string, LocaleResult>();
      for (const r of res.results) map.set(r.locale, r);
      setResults(map);
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.length - ok;
      if (fail === 0) {
        toast.success(`Pushed ${ok} ${ok === 1 ? 'language' : 'languages'} to App Store Connect`);
      } else {
        toast.warning(`Pushed ${ok}, ${fail} failed`, { description: 'Failed languages keep their drafts.' });
      }
    },
    onError: (err) => toast.error('Push failed', { description: callableMessage(err) }),
  });

  const startPush = () => {
    const languageCount = selected.size;
    const changeCount = totalFields;
    mutation.mutate();
    onOpenChange(false);
    toast.info(`Pushing ${changeCount} change${changeCount === 1 ? '' : 's'}`, {
      description: `Live progress for ${languageCount} language${languageCount === 1 ? '' : 's'} is shown at the top of the workspace.`,
    });
  };

  const totalFields = perLocale
    .filter((p) => selected.has(p.locale))
    .reduce((n, p) => n + p.rows.length, 0);
  const anyConflict = perLocale.some((p) => selected.has(p.locale) && p.rows.some((r) => r.conflict));

  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? () => {} : onOpenChange}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title="Review & push to App Store Connect"
          description="Only what you see here changes on Apple's side. Failed languages keep their drafts."
        />
        {results ? (
          <div className="space-y-2">
            {[...results.values()].map((r) => (
              <div key={r.locale} className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5">
                {r.ok ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <AlertCircle className="size-4 text-destructive" />
                )}
                <span className="text-base leading-none">{localeInfo(r.locale).flag}</span>
                <span className="text-[13px] font-medium">{localeInfo(r.locale).name}</span>
                <span className={cn('ml-auto text-[12px]', r.ok ? 'text-success' : 'text-destructive')}>
                  {r.ok ? 'Pushed' : (r.error ?? 'Failed')}
                </span>
              </div>
            ))}
          </div>
        ) : perLocale.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">No pending changes.</p>
        ) : (
          <div className="space-y-3">
            {anyConflict && !results && (
              <div className="rounded-lg bg-warning/12 px-3 py-2 text-[12px] text-warning">
                Some fields changed remotely while you edited. Pushing overwrites the remote value —
                resolve conflicts in the editor first if unsure.
              </div>
            )}
            {perLocale.map(({ locale, rows }) => {
              const info = localeInfo(locale);
              const checked = selected.has(locale);
              return (
                <div key={locale} className={cn('rounded-xl border', !checked && 'opacity-50')}>
                  <label className="flex cursor-pointer items-center gap-2.5 border-b bg-muted/40 px-3.5 py-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(locale);
                        else next.delete(locale);
                        setSelected(next);
                      }}
                      className="size-3.5 accent-[var(--primary)]"
                    />
                    <span className="text-base leading-none">{info.flag}</span>
                    <span className="text-[13px] font-medium">{info.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {rows.length} field{rows.length === 1 ? '' : 's'}
                    </span>
                  </label>
                  <div className="divide-y">
                    {rows.map((row) => (
                      <div key={row.key} className="px-3.5 py-2.5">
                        <div className="flex items-center gap-2 text-[12px] font-medium">
                          {row.label}
                          {row.conflict && (
                            <span className="rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">conflict</span>
                          )}
                        </div>
                        {row.from && (
                          <div className="mt-1 text-[12px] text-muted-foreground line-through decoration-muted-foreground/50">
                            {truncate(row.from)}
                          </div>
                        )}
                        <div className="mt-0.5 whitespace-pre-wrap text-[12px] text-success">
                          {truncate(row.to) || <span className="italic text-muted-foreground">(cleared)</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={startPush}
                disabled={selected.size === 0 || totalFields === 0}
                loading={mutation.isPending}
              >
                {mutation.isPending ? 'Pushing…' : (
                  <>
                    <Rocket className="size-3.5" /> Push {totalFields} change{totalFields === 1 ? '' : 's'}
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
