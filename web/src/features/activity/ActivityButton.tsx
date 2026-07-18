import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Activity, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { OperationDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';
import { Avatar } from '@/components/ui/Avatar';
import { OperationDetailsDialog, type OperationSelection } from './OperationDetailsDialog';
import { cn, timeAgo } from '@/lib/utils';

function StatusIcon({ op }: { op: OperationDoc }) {
  if (op.status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (op.status === 'error') return <AlertCircle className="size-3.5 shrink-0 text-destructive" />;
  if (op.status === 'partial') return <AlertCircle className="size-3.5 shrink-0 text-warning" />;
  return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
}

export function ActivityButton() {
  const { uid, user } = useSession();
  const [open, setOpen] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<OperationSelection | null>(null);
  const q = useMemo(() => {
    if (!uid) return null;
    return query(
      collection(db, 'operations'),
      where('startedBy', '==', uid),
      orderBy('startedAt', 'desc'),
      limit(20),
    );
  }, [uid]);
  const ops = useLiveQuery<OperationDoc>(q, `ops-${uid}`);
  const running = ops.rows.filter((r) => r.data.status === 'running').length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          title="Activity"
          className={cn(
            'relative flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-muted',
            running > 0 ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {running > 0 ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
          {running > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
              {running}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-80 rounded-xl border bg-popover p-2 shadow-pop data-[state=open]:animate-in"
        >
          <div className="px-2 py-1.5 text-[13px] font-semibold">Activity</div>
          {ops.rows.length === 0 ? (
            <p className="px-2 pb-2 pt-1 text-[13px] text-muted-foreground">
              Syncs, pushes and AI runs show up here.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {ops.rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setSelectedOperation({ id: r.id, operation: r.data, actor: user });
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
                >
                  <div className="mt-0.5">
                    <StatusIcon op={r.data} />
                  </div>
                  <Avatar src={user?.photoUrl} name={user?.name ?? user?.email ?? 'Unknown'} seed={r.data.startedBy} className="size-6" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{r.data.label}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {r.data.status === 'running' && r.data.progress
                        ? `${r.data.progress.done}/${r.data.progress.total} · `
                        : ''}
                      {r.data.status === 'error' ? (r.data.error ?? 'failed') + ' · ' : ''}
                      {timeAgo(r.data.startedAt)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
      <OperationDetailsDialog selection={selectedOperation} onOpenChange={(next) => { if (!next) setSelectedOperation(null); }} />
    </Popover.Root>
  );
}
