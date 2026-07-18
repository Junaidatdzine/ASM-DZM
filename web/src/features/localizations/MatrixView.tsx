import { useMemo, useState } from 'react';
import { Copy, Lock, Search, Sparkles, Monitor, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, DraftDoc, LocaleDoc, MetadataField, Platform } from '@asm/shared';
import { FIELD_SPECS, INFO_FIELDS, VERSION_FIELDS, fieldKeyFor, localeInfo, sortLocales } from '@asm/shared';
import { CharCounter } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import { buildFieldViews } from './model';
import { useMatrixEditor } from './useMatrixEditor';

/**
 * "By field" view: each metadata field is a section listing every language, so you can
 * scan and edit one field across all languages at once (the all-languages-in-one-place view).
 */
export function MatrixView({
  storeId,
  appId,
  platform,
  app,
  locales,
  drafts,
  canEdit,
  selectedField,
  onSelectField,
  aiEnabled,
  onOpenAi,
  onFocusLocale,
}: {
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  locales: Map<string, LocaleDoc>;
  drafts: Map<string, DraftDoc>;
  canEdit: boolean;
  selectedField: MetadataField;
  onSelectField: (field: MetadataField) => void;
  aiEnabled: boolean;
  onOpenAi: () => void;
  onFocusLocale: (locale: string) => void;
}) {
  const editor = useMatrixEditor(storeId, appId);
  const orderedLocales = sortLocales(app.locales ?? [], app.primaryLocale);
  const fields = ([...INFO_FIELDS, ...VERSION_FIELDS] as MetadataField[]).filter((field) =>
    buildFieldViews(app, platform, null, null, [field]).some((view) => view.status.visible),
  );
  const field = fields.includes(selectedField)
    ? selectedField
    : (fields[0] ?? 'name');
  const spec = FIELD_SPECS[field];

  // One-click propagation for URL fields: URLs are language-independent, so the
  // primary value can fill (or overwrite) every language as reviewable drafts.
  const copyFromPrimary = (mode: 'missing' | 'all') => {
    const source = rows.find((row) => row.locale === app.primaryLocale)?.value.trim() ?? '';
    if (!source) {
      toast.error(`Add the ${spec.label} in ${localeInfo(app.primaryLocale).name} first.`);
      return;
    }
    let changed = 0;
    for (const row of rows) {
      if (!row.view.status.editable || row.value === source) continue;
      if (mode === 'missing' && row.value.trim() !== '') continue;
      editor.set(row.locale, row.view.key, source, row.view.cache);
      changed += 1;
    }
    toast.success(
      changed === 0
        ? 'Nothing to change — every language already matches.'
        : `${spec.label} ${mode === 'missing' ? 'filled in' : 'replaced in'} ${changed} ${changed === 1 ? 'language' : 'languages'}`,
      { description: changed === 0 ? undefined : 'Saved as drafts. Review them before pushing to Apple.' },
    );
  };
  const fieldStatus = buildFieldViews(app, platform, null, null, [field])[0]?.status;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'drafts'>('all');

  const rows = useMemo(
    () =>
      orderedLocales.map((locale) => {
        const view = buildFieldViews(
          app,
          platform,
          locales.get(locale) ?? null,
          drafts.get(locale) ?? null,
          [field],
        )[0]!;
        return { locale, view, value: editor.overlay(locale, view.key, view.value) };
      }),
    [app, drafts, editor, field, locales, orderedLocales, platform],
  );

  const counts = useMemo(
    () => ({
      complete: rows.filter((row) => row.value.trim() !== '').length,
      drafts: rows.filter((row) => row.view.isDraft).length,
      conflicts: rows.filter((row) => row.view.conflict).length,
      missing: rows.filter((row) => row.value.trim() === '').length,
    }),
    [rows],
  );

  const visibleRows = rows.filter((row) => {
    const info = localeInfo(row.locale);
    const needle = query.trim().toLowerCase();
    const matchesQuery =
      needle === '' ||
      info.name.toLowerCase().includes(needle) ||
      row.locale.toLowerCase().includes(needle) ||
      row.value.toLowerCase().includes(needle);
    const matchesFilter =
      filter === 'all' ||
      (filter === 'drafts' && row.view.isDraft) ||
      (filter === 'attention' && (row.view.conflict || row.value.trim() === ''));
    return matchesQuery && matchesFilter;
  });

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto border-b">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Metadata fields">
          {fields.map((item) => {
            const itemSpec = FIELD_SPECS[item];
            const filled = orderedLocales.filter((locale) => {
              const view = buildFieldViews(
                app,
                platform,
                locales.get(locale) ?? null,
                drafts.get(locale) ?? null,
                [item],
              )[0];
              return !!view?.value.trim();
            }).length;
            const active = item === field;
            return (
              <button
                key={item}
                role="tab"
                aria-selected={active}
                onClick={() => onSelectField(item)}
                className={cn(
                  'relative min-w-28 px-3 pb-3 pt-1 text-left transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="block text-[12px] font-semibold">{itemSpec.label}</span>
                <span className="mt-0.5 block text-[10px] tabular-nums">{filled}/{orderedLocales.length} filled</span>
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="border-b px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold">{spec.label}</h2>
                <Badge variant="neutral" title="You are editing this platform's metadata">
                  {platform === 'MAC_OS' ? <Monitor className="size-3" /> : <Smartphone className="size-3" />}
                  {platform === 'MAC_OS' ? 'Mac' : platform === 'IOS' ? 'iOS' : platform.replace('_OS', ' OS')}
                </Badge>
                {fieldStatus?.editable ? (
                  <Badge variant={fieldStatus.pushTarget === 'livePromo' ? 'success' : 'accent'}>
                    {fieldStatus.pushTarget === 'livePromo' ? 'Live editable' : 'Editable'}
                  </Badge>
                ) : (
                  <Tooltip content={fieldStatus?.lockReason ?? 'This field is locked by Apple.'}>
                    <span><Badge variant="outline"><Lock className="size-3" /> Locked</Badge></span>
                  </Tooltip>
                )}
              </div>
              <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">
                {spec.help ?? `Compare and edit ${spec.label.toLowerCase()} across every App Store language.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
              <span><strong className="font-semibold text-foreground">{counts.complete}</strong> complete</span>
              <span><strong className={cn('font-semibold', counts.missing ? 'text-warning' : 'text-foreground')}>{counts.missing}</strong> missing</span>
              <span><strong className={cn('font-semibold', counts.drafts ? 'text-primary' : 'text-foreground')}>{counts.drafts}</strong> drafts</span>
              {counts.conflicts > 0 && <span><strong className="font-semibold text-warning">{counts.conflicts}</strong> conflicts</span>}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {aiEnabled && spec.aiEligible && (
                <Button size="sm" onClick={onOpenAi}>
                  <Sparkles className="size-3.5" /> AI for {spec.label}
                </Button>
              )}
              {canEdit && URL_FIELDS.has(field) && (
                <>
                  <Button variant="outline" size="sm" onClick={() => copyFromPrimary('missing')}>
                    <Copy className="size-3.5" /> Fill missing from primary
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => copyFromPrimary('all')}>
                    <Copy className="size-3.5" /> Replace all
                  </Button>
                </>
              )}
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                {([
                  ['all', `All ${orderedLocales.length}`],
                  ['attention', `Needs attention ${counts.missing + counts.conflicts}`],
                  ['drafts', `Drafts ${counts.drafts}`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                      filter === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="relative block w-full sm:w-56">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find language or value…"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[12px] outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
              />
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[820px]">
            <div className="grid grid-cols-[190px_minmax(380px,1fr)_110px_82px] gap-3 border-b bg-muted/35 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
              <span>Language</span>
              <span>Store value</span>
              <span>Status</span>
              <span className="text-right">Usage</span>
            </div>
            <div className="divide-y">
              {visibleRows.map((row) => (
                <MatrixRow
                  key={row.locale}
                  field={field}
                  locale={row.locale}
                  app={app}
                  platform={platform}
                  localeDoc={locales.get(row.locale) ?? null}
                  draft={drafts.get(row.locale) ?? null}
                  canEdit={canEdit}
                  editor={editor}
                  onFocusLocale={onFocusLocale}
                  isPrimary={row.locale === app.primaryLocale}
                />
              ))}
              {visibleRows.length === 0 && (
                <p className="px-5 py-10 text-center text-[12px] text-muted-foreground">
                  No languages match this filter.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

const URL_FIELDS: ReadonlySet<string> = new Set(['supportUrl', 'marketingUrl', 'privacyPolicyUrl', 'privacyChoicesUrl']);

function MatrixRow({
  field,
  locale,
  app,
  platform,
  localeDoc,
  draft,
  canEdit,
  editor,
  onFocusLocale,
  isPrimary,
}: {
  field: MetadataField;
  locale: string;
  app: AppDoc;
  platform: Platform;
  localeDoc: LocaleDoc | null;
  draft: DraftDoc | null;
  canEdit: boolean;
  editor: ReturnType<typeof useMatrixEditor>;
  onFocusLocale: (locale: string) => void;
  isPrimary: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const view = buildFieldViews(app, platform, localeDoc, draft, [field])[0]!;
  const spec = FIELD_SPECS[field];
  const info = localeInfo(locale);
  const key = fieldKeyFor(platform, field);
  const editable = canEdit && view.status.editable;
  const value = editor.overlay(locale, key, view.value);
  const missing = value.trim() === '';
  // A persisted AI failure for this locale+field stays red until a later run succeeds.
  const aiFailure =
    app.aiFailures?.[locale] && (app.aiFailures[locale]!.fields ?? []).includes(field)
      ? app.aiFailures[locale]!
      : null;
  const status = draft?.status === 'pushing'
    ? { label: 'Pushing…', variant: 'accent' as const }
    : view.conflict
    ? { label: 'Conflict', variant: 'warning' as const }
    : view.isDraft
      ? { label: 'Draft', variant: 'accent' as const }
      : missing
        ? { label: 'Missing', variant: 'warning' as const }
        : { label: 'Complete', variant: 'success' as const };

  return (
    <div className={cn('grid grid-cols-[190px_minmax(380px,1fr)_110px_82px] items-start gap-3 px-4 py-2.5 sm:px-5', focused && 'bg-accent/25')}>
      <button
        onClick={() => onFocusLocale(locale)}
        className="flex min-w-0 items-center gap-2 text-left"
        title="Open this language"
      >
        <span className="text-base leading-none">{info.flag}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium">{info.name}</span>
            {isPrimary && <span className="text-[10px] text-warning">★</span>}
          </span>
          <span className="block text-[10px] text-muted-foreground">{locale}</span>
        </span>
      </button>
      <div className="min-w-0">
        {spec.multiline ? (
          <textarea
            value={value}
            onChange={(e) => editor.set(locale, key, e.target.value, view.cache)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={!editable}
            rows={focused ? (field === 'description' ? 7 : 4) : 1}
            placeholder={editable ? `Add ${spec.label.toLowerCase()}…` : '—'}
            className={cn(
              'min-h-8 w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[13px] leading-5 transition-colors',
              'focus:border-input focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/30',
              !editable && 'text-muted-foreground',
            )}
          />
        ) : (
          <input
            value={value}
            onChange={(e) => editor.set(locale, key, e.target.value, view.cache)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={!editable}
            placeholder={editable ? `Add ${spec.label.toLowerCase()}…` : '—'}
            className={cn(
              'h-8 w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] transition-colors',
              'focus:border-input focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/30',
              !editable && 'text-muted-foreground',
            )}
          />
        )}
      </div>
      <div className="flex flex-col items-start gap-1 pt-1">
        <Badge variant={status.variant}>{status.label}</Badge>
        {aiFailure && (
          <Tooltip content={`${aiFailure.error} — try AI again or fill it manually.`}>
            <span><Badge variant="destructive">AI failed</Badge></span>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-1.5">
        {!view.status.editable && (
          <Tooltip content={view.status.lockReason ?? 'Locked'}>
            <Lock className="size-3 text-muted-foreground" />
          </Tooltip>
        )}
        <CharCounter value={value} max={spec.maxLength} />
      </div>
    </div>
  );
}
