import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Hammer, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, callableMessage } from '@/lib/callables';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { FieldHint, Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

const PLATFORM_LABELS: Record<string, string> = {
  IOS: 'iOS',
  MAC_OS: 'Mac',
  UNIVERSAL: 'Universal',
};

/**
 * Apple Developer provisioning for this store: registered App IDs (bundle IDs)
 * with create + delete. The one thing Apple's API cannot do is create the app
 * record itself — the flow ends with a deep link into ASC where the freshly
 * registered bundle ID is ready to pick.
 */
export function DeveloperDialog({
  storeId,
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const key = ['bundle-ids', storeId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.bundleIdsList({ storeId }),
    enabled: open,
    staleTime: 60_000,
  });
  const [form, setForm] = useState({ name: '', identifier: '', platform: 'IOS' as 'IOS' | 'MAC_OS' | 'UNIVERSAL' });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; identifier: string } | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () => api.bundleIdCreate({ storeId, ...form, name: form.name.trim(), identifier: form.identifier.trim() }),
    onSuccess: (res) => {
      toast.success(`Registered ${res.bundleId.identifier}`, {
        description: 'The App ID is live in the Apple Developer account — create the app in ASC with it.',
      });
      setForm({ name: '', identifier: '', platform: 'IOS' });
      setCreating(false);
      refresh();
    },
    onError: (err) => toast.error('Couldn’t register the bundle ID', { description: callableMessage(err) }),
  });
  const del = useMutation({
    mutationFn: (target: { id: string; identifier: string }) =>
      api.bundleIdDelete({ storeId, bundleIdId: target.id, identifier: target.identifier }),
    onSuccess: () => {
      toast.success('Bundle ID deleted');
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => toast.error('Couldn’t delete', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-h-[85vh] overflow-y-auto">
        <DialogHeader
          title={
            <span className="flex items-center gap-2">
              <Hammer className="size-4 text-primary" /> Developer · App IDs
            </span>
          }
          description="Bundle identifiers registered in this store's Apple Developer account. Registering one here is step 1 of shipping a brand-new app."
        />

        {creating ? (
          <div className="space-y-3 rounded-xl border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Photo Editor Pro" maxLength={64} />
              </div>
              <div className="space-y-1.5">
                <Label>Platform</Label>
                <Select value={form.platform} onValueChange={(v) => setForm({ ...form, platform: v as typeof form.platform })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IOS">iOS</SelectItem>
                    <SelectItem value="MAC_OS">Mac</SelectItem>
                    <SelectItem value="UNIVERSAL">Universal (all platforms)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Bundle ID</Label>
              <Input
                value={form.identifier}
                onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                placeholder="e.g. com.dzinemedia.photoeditor"
                maxLength={155}
                className="font-mono text-[13px]"
              />
              <FieldHint>Reverse-DNS, permanent once an app ships with it. Letters, numbers, dots and hyphens.</FieldHint>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                size="sm"
                loading={create.isPending}
                disabled={!form.name.trim() || form.identifier.trim().length < 3}
                onClick={() => create.mutate()}
              >
                Register App ID
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> Register new bundle ID
          </Button>
        )}

        <div className="mt-3">
          {list.isError ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-[13px] text-muted-foreground">
              {callableMessage(list.error)}
            </p>
          ) : !list.data ? (
            <Skeleton className="h-32" />
          ) : (
            <ul className="divide-y rounded-xl border">
              {list.data.bundleIds.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{b.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{b.identifier}</div>
                  </div>
                  <Badge variant="neutral">{PLATFORM_LABELS[b.platform] ?? b.platform}</Badge>
                  <button
                    type="button"
                    title="Delete (only possible while no app uses it)"
                    onClick={() => setDeleteTarget({ id: b.id, identifier: b.identifier })}
                    className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
              {list.data.bundleIds.length === 0 && (
                <li className="px-3.5 py-6 text-center text-[13px] text-muted-foreground">No bundle IDs registered yet.</li>
              )}
            </ul>
          )}
        </div>

        <div className="mt-3 rounded-lg border border-dashed p-3 text-[12px] leading-relaxed text-muted-foreground">
          Step 2 happens in App Store Connect: Apple provides no API to create the app record itself, so
          after registering the bundle ID, finish there — your new App ID is ready to pick in the form.
          Once created, hit Sync here and the app appears with everything manageable from this dashboard.
        </div>

        <DialogFooter>
          <a href="https://appstoreconnect.apple.com/apps" target="_blank" rel="noreferrer">
            <Button variant="outline">
              <ExternalLink className="size-3.5" /> Create the app in ASC
            </Button>
          </a>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={() => setDeleteTarget(null)}
          title={`Delete ${deleteTarget?.identifier}?`}
          description="Only unused bundle IDs can be deleted — Apple refuses if an app ships with it."
          confirmLabel="Delete bundle ID"
          destructive
          loading={del.isPending}
          onConfirm={() => {
            if (deleteTarget) del.mutate(deleteTarget);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
