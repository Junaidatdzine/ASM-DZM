import { Link } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import type { AppDoc, OperationDoc, StoreDoc, UserDoc } from '@asm/shared';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { db } from '@/lib/firebase';
import { useLiveDoc } from '@/lib/hooks';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { AppGlyph, StoreGlyph } from '@/components/StoreGlyph';

export interface OperationSelection {
  id: string;
  operation: OperationDoc;
  actor: Pick<UserDoc, 'name' | 'email' | 'photoUrl'> | null;
}

function dateTime(value: OperationDoc['startedAt'] | undefined): string {
  return value ? new Date(value.toMillis()).toLocaleString() : '—';
}

function duration(operation: OperationDoc): string {
  if (!operation.finishedAt) return operation.status === 'running' ? 'In progress' : '—';
  const seconds = Math.max(0, Math.round((operation.finishedAt.toMillis() - operation.startedAt.toMillis()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function OperationDetailsDialog({
  selection,
  onOpenChange,
}: {
  selection: OperationSelection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const op = selection?.operation;
  const actor = selection?.actor;
  // Resolve ids to names — nobody should have to read raw document ids.
  const store = useLiveDoc<StoreDoc>(op?.storeId ? doc(db, 'stores', op.storeId) : null);
  const app = useLiveDoc<AppDoc>(
    op?.storeId && op?.appId ? doc(db, 'stores', op.storeId, 'apps', op.appId) : null,
  );
  if (!op) return null;
  const href = op.storeId
    ? op.appId
      ? `/stores/${op.storeId}/apps/${op.appId}`
      : `/stores/${op.storeId}`
    : null;
  const StatusIcon = op.status === 'running' ? Loader2 : op.status === 'success' ? CheckCircle2 : AlertCircle;

  return (
    <Dialog open={!!selection} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="Activity details"
          description="The recorded result, owner and scope of this operation."
        />
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border bg-muted/25 p-3">
            <StatusIcon className={`mt-0.5 size-4 shrink-0 ${op.status === 'running' ? 'animate-spin text-primary' : op.status === 'success' ? 'text-success' : op.status === 'partial' ? 'text-warning' : 'text-destructive'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{op.label}</div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={op.status === 'success' ? 'success' : op.status === 'error' ? 'destructive' : op.status === 'partial' ? 'warning' : 'accent'}>
                  {op.status}
                </Badge>
                <span className="text-[11px] text-muted-foreground">{op.type.replace(/-/g, ' ')}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Avatar src={actor?.photoUrl} name={actor?.name ?? actor?.email ?? 'Unknown user'} seed={op.startedBy} className="size-9" />
            <div>
              <div className="text-[13px] font-medium">{actor?.name ?? 'Unknown user'}</div>
              <div className="text-[11px] text-muted-foreground">{actor?.email ?? op.startedBy}</div>
            </div>
          </div>

          {(op.storeId || op.appId) && (
            <div className="flex flex-wrap items-center gap-2">
              {op.storeId && (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1">
                  <StoreGlyph color={store.data?.color} icon={store.data?.icon} seed={op.storeId} size="sm" />
                  <span className="truncate text-[12px] font-medium">{store.data?.name ?? 'Store'}</span>
                </span>
              )}
              {op.appId && (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1">
                  <AppGlyph
                    name={app.data?.name ?? 'App'}
                    iconUrl={app.data?.iconUrl}
                    seed={op.appId}
                    size="sm"
                    className="rounded-[22%]"
                  />
                  <span className="truncate text-[12px] font-medium">{app.data?.name ?? 'App'}</span>
                </span>
              )}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg border p-3 text-[12px]">
            <div><dt className="text-muted-foreground">Started</dt><dd className="mt-0.5 font-medium">{dateTime(op.startedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Duration</dt><dd className="mt-0.5 font-medium">{duration(op)}</dd></div>
            {op.progress && <div><dt className="text-muted-foreground">Progress</dt><dd className="mt-0.5 font-medium">{op.progress.done}/{op.progress.total}</dd></div>}
            {op.locale && <div><dt className="text-muted-foreground">Language</dt><dd className="mt-0.5 font-medium">{op.locale}</dd></div>}
          </dl>
          {op.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">{op.error}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {href && (
            <Link to={href} onClick={() => onOpenChange(false)} className="inline-flex h-8.5 items-center justify-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
              Open {op.appId ? (app.data?.name ?? 'app') : (store.data?.name ?? 'store')}
            </Link>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
