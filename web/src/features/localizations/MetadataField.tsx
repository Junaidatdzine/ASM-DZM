import { useState } from 'react';
import { GitMerge, Lock, RotateCcw, Sparkles } from 'lucide-react';
import { FIELD_SPECS } from '@asm/shared';
import { CharCounter, Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { FieldView } from './model';

export function MetadataFieldRow({
  view,
  canEdit,
  onChange,
  onRevert,
  onKeepMine,
}: {
  view: FieldView;
  canEdit: boolean;
  onChange: (value: string) => void;
  onRevert: () => void;
  onKeepMine: () => void;
}) {
  const spec = FIELD_SPECS[view.field];
  const editable = canEdit && view.status.editable;
  const [focused, setFocused] = useState(false);

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-card transition-colors',
        focused && 'border-primary/40',
        view.conflict && 'border-warning/60',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[13px] font-semibold">{spec.label}</span>
          {view.status.pushTarget === 'livePromo' && (
            <Tooltip content="Apple allows promotional text to change on the live version without a new release.">
              <span className="rounded-full bg-success/12 px-2 py-0.5 text-[10px] font-medium text-success">
                live-editable
              </span>
            </Tooltip>
          )}
          {view.isDraft && !view.conflict && (
            <Tooltip content={`Unsaved change${view.draftBy ? ` · edited by ${view.draftAi ? 'AI for ' : ''}${view.draftBy.slice(0, 8)}…` : ''} — will be included in the next push`}>
              <span className="size-2 rounded-full bg-primary" />
            </Tooltip>
          )}
          {view.draftAi && (
            <Tooltip content="This value was drafted by AI — review before pushing.">
              <Sparkles className="size-3.5 text-primary" />
            </Tooltip>
          )}
          {!view.status.editable && view.status.lockReason && (
            <Tooltip content={view.status.lockReason}>
              <Lock className="size-3.5 text-muted-foreground" />
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2">
          {view.isDraft && (
            <Tooltip content="Discard this change (revert to App Store value)">
              <button
                onClick={onRevert}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </Tooltip>
          )}
          <CharCounter value={view.value} max={spec.maxLength} />
        </div>
      </div>

      {view.conflict && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-warning/12 px-3 py-2">
          <div className="flex items-center gap-2 text-[12px] text-warning">
            <GitMerge className="size-3.5 shrink-0" />
            Changed remotely since you started editing.
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={onKeepMine}>
              Keep mine
            </Button>
            <Button size="sm" variant="outline" onClick={onRevert}>
              Take theirs
            </Button>
          </div>
        </div>
      )}

      {spec.multiline ? (
        <Textarea
          value={view.value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={!editable}
          rows={spec.field === 'description' ? 8 : 3}
          placeholder={editable ? `Add ${spec.label.toLowerCase()}…` : undefined}
          className={cn(!editable && 'bg-muted/40 text-muted-foreground')}
        />
      ) : (
        <Input
          value={view.value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={!editable}
          placeholder={editable ? `Add ${spec.label.toLowerCase()}…` : undefined}
          className={cn('h-9', !editable && 'bg-muted/40 text-muted-foreground')}
        />
      )}
      {spec.help && <p className="mt-1.5 text-[11px] text-muted-foreground/80">{spec.help}</p>}
    </div>
  );
}
