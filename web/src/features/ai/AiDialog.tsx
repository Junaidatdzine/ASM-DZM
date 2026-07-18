import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, MetadataField, Platform } from '@asm/shared';
import { ALL_FIELDS, FIELD_SPECS, aiCreditsRemaining, can, localeInfo } from '@asm/shared';
import { api, callableMessage } from '@/lib/callables';
import { useSession } from '@/auth/AuthProvider';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Tabs, TabsContent } from '@/components/ui/Tabs';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils';

const AI_FIELDS = ALL_FIELDS.filter((f) => FIELD_SPECS[f].aiEligible);
const DEFAULT_FIELDS: MetadataField[] = ['subtitle', 'description', 'keywords', 'promotionalText', 'whatsNew'];
type GenerateKind = 'name' | 'keywords' | 'subtitle' | 'improve-description' | 'promotional-text' | 'whatsnew';

const GENERATE_KIND_BY_FIELD: Partial<Record<MetadataField, GenerateKind>> = {
  name: 'name',
  subtitle: 'subtitle',
  description: 'improve-description',
  keywords: 'keywords',
  promotionalText: 'promotional-text',
  whatsNew: 'whatsnew',
};

export function AiDialog({
  open,
  onOpenChange,
  storeId,
  appId,
  platform,
  app,
  currentLocale,
  selectedField,
  onApplyToDraft,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  appId: string;
  platform: Platform;
  app: AppDoc;
  currentLocale: string | null;
  selectedField?: MetadataField | null;
  onApplyToDraft: (fieldKey: string, value: string) => void;
}) {
  const { user } = useSession();
  const credits = user ? aiCreditsRemaining(user) : 0;
  const canTranslate = !!user?.ai?.features.translate;
  const canGenerate = !!user?.ai?.features.generate;
  const [activeTab, setActiveTab] = useState<'translate' | 'generate'>('translate');

  // ---- Translate state ----
  const [source, setSource] = useState(app.primaryLocale);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState<Set<MetadataField>>(new Set(DEFAULT_FIELDS));
  const [overwrite, setOverwrite] = useState(false);
  const [autoPush, setAutoPush] = useState(false);
  const [results, setResults] = useState<Array<{ locale: string; ok: boolean; fieldsWritten: number; error?: string }> | null>(null);
  const canPush = !!user && can(user, 'push', storeId, appId);

  useEffect(() => {
    if (open) {
      setSource(app.primaryLocale);
      setTargets(new Set((app.locales ?? []).filter((l) => l !== app.primaryLocale)));
      setFields(
        new Set(
          selectedField
            ? FIELD_SPECS[selectedField].aiEligible
              ? [selectedField]
              : []
            : DEFAULT_FIELDS,
        ),
      );
      setOverwrite(false);
      setAutoPush(false);
      setResults(null);
      setActiveTab(canTranslate ? 'translate' : 'generate');
    }
  }, [open, app.primaryLocale, app.locales, selectedField, canGenerate, canTranslate]);

  const translate = useMutation({
    mutationFn: () =>
      api.aiTranslate({
        storeId,
        appId,
        platform,
        sourceLocale: source,
        targetLocales: [...targets],
        fields: [...fields],
        overwrite,
      }),
    onSuccess: (res) => {
      setResults(res.results);
      const drafted = res.results.reduce((n, r) => n + r.fieldsWritten, 0);
      const failed = res.results.filter((r) => !r.ok).length;
      const draftedLocales = res.results.filter((r) => r.ok && r.fieldsWritten > 0).map((r) => r.locale);
      if (failed === 0) {
        toast.success(`AI drafted ${drafted} field${drafted === 1 ? '' : 's'}`, {
          description: autoPush && draftedLocales.length > 0
            ? 'Pushing them to Apple now…'
            : 'Nothing touched Apple — review the drafts, then push.',
        });
      } else {
        toast.warning(`Some languages failed (${failed})`, { description: res.results.find((r) => !r.ok)?.error });
      }
      // One-go mode: the fresh drafts go straight to Apple, no second visit needed.
      if (autoPush && draftedLocales.length > 0) {
        api
          .locPush({ storeId, appId, platform, locales: draftedLocales })
          .then((push) => {
            const failedPush = push.results.filter((r) => !r.ok).length;
            if (failedPush === 0) {
              toast.success(`Pushed ${draftedLocales.length} language${draftedLocales.length === 1 ? '' : 's'} to Apple`, {
                description: push.summary,
              });
            } else {
              toast.warning('Some pushes failed', { description: push.results.find((r) => !r.ok)?.error });
            }
          })
          .catch((err) => toast.error('Push failed', { description: callableMessage(err) }));
      }
    },
    onError: (err) => toast.error('Translation failed', { description: callableMessage(err) }),
  });

  const startTranslation = () => {
    const targetCount = targets.size;
    const mode = overwrite ? 'Retranslation' : 'Translation';
    translate.mutate();
    onOpenChange(false);
    toast.info(`${mode} started for ${targetCount} language${targetCount === 1 ? '' : 's'}`, {
      description: autoPush
        ? 'Drafts push to Apple automatically when the translation finishes.'
        : 'Live progress is shown at the top of the workspace.',
    });
  };

  // ---- Generate state ----
  const [kind, setKind] = useState<GenerateKind>('keywords');
  const [context, setContext] = useState('');
  const [options, setOptions] = useState<{ list: string[]; fieldKey: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const scopedKind = selectedField ? GENERATE_KIND_BY_FIELD[selectedField] : undefined;
    if (scopedKind) setKind(scopedKind);
    setOptions(null);
    setContext('');
  }, [open, selectedField]);

  const generate = useMutation({
    mutationFn: () =>
      api.aiGenerate({
        storeId,
        appId,
        platform,
        locale: currentLocale ?? app.primaryLocale,
        kind,
        ...(context.trim() ? { context: context.trim() } : {}),
      }),
    onSuccess: (res) => setOptions({ list: res.options, fieldKey: res.fieldKey }),
    onError: (err) => toast.error('Generation failed', { description: callableMessage(err) }),
  });

  // One-go: generate, take the best option, fill the draft, close — a single click.
  const oneGo = useMutation({
    mutationFn: () =>
      api.aiGenerate({
        storeId,
        appId,
        platform,
        locale: currentLocale ?? app.primaryLocale,
        kind,
        ...(context.trim() ? { context: context.trim() } : {}),
      }),
    onSuccess: (res) => {
      const best = res.options[0];
      if (!best) {
        toast.warning('The AI returned nothing usable — try again.');
        return;
      }
      onApplyToDraft(res.fieldKey, best);
      onOpenChange(false);
      toast.success('Generated & filled the draft', {
        description: 'Saved automatically — push whenever you’re ready.',
      });
    },
    onError: (err) => toast.error('Generation failed', { description: callableMessage(err) }),
  });

  const targetList = useMemo(
    () => (app.locales ?? []).filter((l) => l !== source),
    [app.locales, source],
  );

  return (
    <Dialog open={open} onOpenChange={translate.isPending || generate.isPending ? () => {} : onOpenChange}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" /> AI{selectedField ? ` · ${FIELD_SPECS[selectedField].label}` : ' assistant'}
            </span>
          }
          description={`${credits} credit${credits === 1 ? '' : 's'} left this month · 1 credit = one language or one generation · results land as drafts, never directly on Apple.`}
        />
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'translate' | 'generate')}>
          <div className="mb-4 w-56">
            <Label>AI action</Label>
            <Select value={activeTab} onValueChange={(value) => setActiveTab(value as 'translate' | 'generate')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {canTranslate && <SelectItem value="translate">Translate metadata</SelectItem>}
                {canGenerate && <SelectItem value="generate">Quick generate</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <TabsContent value="translate">
            {results ? (
              <div className="space-y-2">
                {results.map((r) => (
                  <div key={r.locale} className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5">
                    {r.ok ? (
                      <CheckCircle2 className="size-4 text-success" />
                    ) : (
                      <AlertCircle className="size-4 text-destructive" />
                    )}
                    <span>{localeInfo(r.locale).flag}</span>
                    <span className="text-[13px] font-medium">{localeInfo(r.locale).name}</span>
                    <span className={cn('ml-auto text-[12px]', r.ok ? 'text-muted-foreground' : 'text-destructive')}>
                      {r.ok
                        ? r.fieldsWritten > 0
                          ? `${r.fieldsWritten} field${r.fieldsWritten === 1 ? '' : 's'} drafted`
                          : 'nothing missing'
                        : r.error}
                    </span>
                  </div>
                ))}
                <DialogFooter>
                  <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-52">
                    <Label>Translate from</Label>
                    <Select value={source} onValueChange={setSource}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(app.locales ?? []).map((code) => (
                          <SelectItem key={code} value={code}>
                            {localeInfo(code).flag} {localeInfo(code).name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <Label>Into ({targets.size})</Label>
                      <div className="flex gap-2 text-[11px]">
                        <button className="text-primary hover:underline" onClick={() => setTargets(new Set(targetList))}>
                          all
                        </button>
                        <button className="text-muted-foreground hover:underline" onClick={() => setTargets(new Set())}>
                          none
                        </button>
                      </div>
                    </div>
                    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-2">
                      {targetList.map((code) => {
                        const on = targets.has(code);
                        return (
                          <button
                            key={code}
                            onClick={() => {
                              const next = new Set(targets);
                              if (on) next.delete(code);
                              else next.add(code);
                              setTargets(next);
                            }}
                            className={cn(
                              'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                              on ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {localeInfo(code).flag} {localeInfo(code).name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div>
                  <Label>{selectedField ? 'Selected field' : 'Fields'}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(selectedField ? AI_FIELDS.filter((f) => f === selectedField) : AI_FIELDS).map((f) => {
                      const on = fields.has(f);
                      return (
                        <button
                          key={f}
                          disabled={!!selectedField}
                          onClick={() => {
                            const next = new Set(fields);
                            if (on) next.delete(f);
                            else next.add(f);
                            setFields(next);
                          }}
                          className={cn(
                            'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                            on ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {FIELD_SPECS[f].label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <Label>Translation mode</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setOverwrite(false)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        !overwrite ? 'border-primary bg-accent/45 ring-1 ring-primary/20' : 'hover:bg-muted/40',
                      )}
                    >
                      <span className="block text-[13px] font-semibold">Fill missing only</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                        Translate empty values only. Existing store values and drafts stay untouched.
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverwrite(true)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        overwrite ? 'border-primary bg-accent/45 ring-1 ring-primary/20' : 'hover:bg-muted/40',
                      )}
                    >
                      <span className="block text-[13px] font-semibold">Retranslate all</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                        Create fresh drafts for every selected language, replacing values on the next push.
                      </span>
                    </button>
                  </div>
                </div>

                {canPush && (
                  <button
                    type="button"
                    onClick={() => setAutoPush(!autoPush)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                      autoPush ? 'border-primary bg-accent/45 ring-1 ring-primary/20' : 'hover:bg-muted/40',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                        autoPush ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      )}
                    >
                      {autoPush && <CheckCircle2 className="size-3" />}
                    </span>
                    <span>
                      <span className="block text-[13px] font-semibold">Push to Apple automatically — everything in one go</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                        As soon as the translations finish, they’re sent to App Store Connect. Leave off to review drafts first.
                      </span>
                    </span>
                  </button>
                )}

                <DialogFooter className="items-center">
                  <Badge variant={overwrite && targets.size > credits ? 'destructive' : 'neutral'} className="mr-auto">
                    {overwrite
                      ? `will use ${targets.size} credit${targets.size === 1 ? '' : 's'}`
                      : `up to ${targets.size} credits · missing languages only`}
                  </Badge>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={startTranslation}
                    loading={translate.isPending}
                    disabled={targets.size === 0 || fields.size === 0 || (overwrite && targets.size > credits)}
                  >
                    <Sparkles className="size-3.5" />
                    {overwrite ? 'Retranslate all' : 'Fill missing'}
                    {autoPush ? ' & push' : ''}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </TabsContent>

          <TabsContent value="generate">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-56">
                  <Label>What to generate</Label>
                  {selectedField ? (
                    <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-[13px] font-medium">
                      {FIELD_SPECS[selectedField].label}
                    </div>
                  ) : (
                    <Select value={kind} onValueChange={(v) => setKind(v as GenerateKind)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="name">App Name ideas</SelectItem>
                        <SelectItem value="keywords">Keyword ideas</SelectItem>
                        <SelectItem value="subtitle">Subtitle ideas</SelectItem>
                        <SelectItem value="improve-description">Improve description</SelectItem>
                        <SelectItem value="promotional-text">Promotional Text</SelectItem>
                        <SelectItem value="whatsnew">What’s New from notes</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="text-[13px] text-muted-foreground">
                  for {currentLocale ? `${localeInfo(currentLocale).flag} ${localeInfo(currentLocale).name}` : '—'} · 1 credit
                </div>
              </div>
              {kind === 'whatsnew' && (
                <div>
                  <Label>What changed in this release?</Label>
                  <Textarea
                    rows={3}
                    placeholder="e.g. new sharing feature, dark mode, bug fixes"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                  />
                </div>
              )}
              {options && (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">Pick one — it fills the draft and you’re done:</p>
                  {options.list.map((option, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5">
                      <p className="whitespace-pre-wrap text-[13px]">{option}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onApplyToDraft(options.fieldKey, option);
                          toast.success('Draft filled', { description: 'Saved automatically — push whenever you’re ready.' });
                          onOpenChange(false);
                        }}
                      >
                        Use
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button
                  variant="outline"
                  onClick={() => generate.mutate()}
                  loading={generate.isPending && !oneGo.isPending}
                  disabled={credits < 1 || !currentLocale}
                >
                  <Wand2 className="size-3.5" /> Show options
                </Button>
                <Button onClick={() => oneGo.mutate()} loading={oneGo.isPending} disabled={credits < 1 || !currentLocale}>
                  <Sparkles className="size-3.5" /> Generate & fill
                </Button>
              </DialogFooter>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
