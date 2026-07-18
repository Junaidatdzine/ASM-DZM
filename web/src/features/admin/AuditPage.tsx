import { useMemo, useState } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import type { AuditLogDoc, StoreDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useLiveQuery } from '@/lib/hooks';
import { Page } from '@/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { StoreDot } from '@/components/StoreGlyph';
import { cn, timeAgo } from '@/lib/utils';

const actionVariant = (action: string): 'accent' | 'success' | 'destructive' | 'neutral' | 'warning' => {
  if (action.startsWith('user.') || action.startsWith('settings.')) return 'accent';
  if (action.startsWith('ai.')) return 'warning';
  if (action.includes('delete') || action.includes('remove') || action.includes('disable')) return 'destructive';
  if (action.includes('push') || action.includes('add')) return 'success';
  return 'neutral';
};

function Row({ row, storeName, storeColor }: { row: AuditLogDoc; storeName?: string; storeColor?: string }) {
  const [open, setOpen] = useState(false);
  const hasChanges = (row.changes?.length ?? 0) > 0;
  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => hasChanges && setOpen(!open)}
        className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left', hasChanges && 'transition-colors hover:bg-muted/50')}
      >
        {hasChanges ? (
          open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <Badge variant={actionVariant(row.action)}>{row.action}</Badge>
        {storeName && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <StoreDot color={storeColor} seed={row.storeId} /> {storeName}
          </span>
        )}
        <span className="truncate text-[13px] text-muted-foreground">
          {row.actor.email}
          {row.detail ? <span className="text-foreground"> · {row.detail}</span> : null}
          {row.locale ? ` · ${row.locale}` : ''}
        </span>
        {row.result !== 'ok' && <Badge variant={row.result === 'error' ? 'destructive' : 'warning'}>{row.result}</Badge>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeAgo(row.at)}</span>
      </button>
      {open && hasChanges && (
        <div className="space-y-2 bg-muted/30 px-11 py-3">
          {row.changes!.map((c, i) => (
            <div key={i} className="text-[12px]">
              <span className="font-medium">{c.field}</span>
              {c.from && <div className="mt-0.5 text-muted-foreground line-through decoration-muted-foreground/50">{c.from}</div>}
              <div className="mt-0.5 whitespace-pre-wrap text-success">{c.to ?? ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AuditPage() {
  const logs = useLiveQuery<AuditLogDoc>(
    useMemo(() => query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(300)), []),
    'audit',
  );
  const stores = useLiveQuery<StoreDoc>(useMemo(() => query(collection(db, 'stores')), []), 'audit-stores');
  const storeMap = useMemo(() => new Map(stores.rows.map((s) => [s.id, s.data])), [stores.rows]);

  const [filter, setFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('all');

  const visible = logs.rows.filter((r) => {
    if (storeFilter !== 'all' && r.data.storeId !== storeFilter) return false;
    if (!filter.trim()) return true;
    const f = filter.trim().toLowerCase();
    return (
      r.data.action.toLowerCase().includes(f) ||
      r.data.actor.email.toLowerCase().includes(f) ||
      (r.data.detail ?? '').toLowerCase().includes(f) ||
      (r.data.locale ?? '').toLowerCase().includes(f)
    );
  });

  return (
    <Page
      title="Audit Log"
      description="Every change — which store, which app, which user did what. Kept 180 days."
      actions={
        <div className="flex gap-2">
          <Select value={storeFilter} onValueChange={setStoreFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stores</SelectItem>
              {stores.rows.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.data.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input className="w-56" placeholder="Filter action, user, detail…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      }
    >
      {logs.loading ? (
        <Skeleton className="h-64" />
      ) : visible.length === 0 ? (
        <EmptyState icon={ScrollText} title={filter || storeFilter !== 'all' ? 'Nothing matches' : 'No activity yet'} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          {visible.map((r) => {
            const store = r.data.storeId ? storeMap.get(r.data.storeId) : undefined;
            return <Row key={r.id} row={r.data} storeName={store?.name} storeColor={store?.color} />;
          })}
        </div>
      )}
    </Page>
  );
}
