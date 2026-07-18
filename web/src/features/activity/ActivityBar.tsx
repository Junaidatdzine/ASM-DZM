import { useMemo } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { Loader2 } from 'lucide-react';
import type { OperationDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';

/**
 * A slim always-there progress strip under the topbar that appears while any of the
 * user's operations are running — so long jobs (sync, push, AI, uploads) are always
 * visible and followable, with a live progress bar.
 */
export function ActivityBar() {
  const { uid } = useSession();
  const running = useLiveQuery<OperationDoc>(
    useMemo(
      () =>
        uid
          ? query(
              collection(db, 'operations'),
              where('startedBy', '==', uid),
              where('status', '==', 'running'),
              orderBy('startedAt', 'desc'),
            )
          : null,
      [uid],
    ),
    `running-ops-${uid}`,
  );

  if (running.rows.length === 0) return null;
  const top = running.rows[0]!.data;
  const pct = top.progress && top.progress.total > 0 ? Math.round((top.progress.done / top.progress.total) * 100) : null;

  return (
    <div className="border-b bg-primary/5">
      <div className="flex items-center gap-3 px-4 py-1.5">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        <span className="truncate text-[12px] font-medium">
          {top.label}
          {top.progress ? ` · ${top.progress.done}/${top.progress.total}` : ''}
          {running.rows.length > 1 ? `  (+${running.rows.length - 1} more)` : ''}
        </span>
        <div className="ml-auto h-1 w-40 overflow-hidden rounded-full bg-primary/15">
          <div
            className={pct === null ? 'h-full w-1/3 animate-pulse rounded-full bg-primary' : 'h-full rounded-full bg-primary transition-[width] duration-500'}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
