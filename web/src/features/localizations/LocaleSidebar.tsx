import { Plus, Star, Trash2, TriangleAlert } from 'lucide-react';
import type { AppDoc, DraftDoc, LocaleDoc, Platform } from '@asm/shared';
import { localeInfo } from '@asm/shared';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import { draftCount, localeCompletion } from './model';

export function LocaleSidebar({
  app,
  platform,
  locales,
  drafts,
  selected,
  onSelect,
  onAddLanguage,
  onRemoveLanguage,
  canAdd,
  canRemove,
}: {
  app: AppDoc;
  platform: Platform;
  locales: Map<string, LocaleDoc>;
  drafts: Map<string, DraftDoc>;
  selected: string | null;
  onSelect: (locale: string) => void;
  onAddLanguage: () => void;
  onRemoveLanguage: (locale: string) => void;
  canAdd: boolean;
  canRemove: boolean;
}) {
  const all = app.locales ?? [];

  return (
    <aside className="w-full shrink-0 lg:w-60">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Languages ({all.length})
        </span>
        {canAdd && (
          <Tooltip content="Add languages">
            <button
              onClick={onAddLanguage}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-4" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="space-y-0.5">
        {all.map((code) => {
          const info = localeInfo(code);
          const localeDoc = locales.get(code) ?? null;
          const draft = drafts.get(code) ?? null;
          const completion = localeCompletion(app, platform, localeDoc, draft);
          const dCount = draftCount(draft);
          const isPrimary = code === app.primaryLocale;
          const missing = localeDoc?.missingRemote;
          return (
            <div
              key={code}
              className={cn(
                'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
                selected === code ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
              )}
            >
              <button onClick={() => onSelect(code)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <span className="text-base leading-none">{info.flag}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{info.name}</span>
                    {isPrimary && (
                      <Tooltip content="Primary language">
                        <Star className="size-3 shrink-0 fill-warning text-warning" />
                      </Tooltip>
                    )}
                    {missing && (
                      <Tooltip content="This language disappeared from App Store Connect but still has local edits.">
                        <TriangleAlert className="size-3 shrink-0 text-warning" />
                      </Tooltip>
                    )}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {completion}% complete
                    {dCount > 0 && <span className="text-primary"> · {dCount} edit{dCount === 1 ? '' : 's'}</span>}
                  </span>
                </span>
              </button>
              {canRemove && !isPrimary ? (
                <Tooltip content={`Remove ${info.name}`}>
                  <button
                    onClick={() => onRemoveLanguage(code)}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Tooltip>
              ) : (
                dCount > 0 && <span className="size-1.5 shrink-0 rounded-full bg-primary" />
              )}
            </div>
          );
        })}
        {all.length === 0 && (
          <p className="px-2.5 py-4 text-[12px] text-muted-foreground">
            No languages synced yet — hit Sync above.
          </p>
        )}
      </div>
    </aside>
  );
}
