import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { collection, query } from 'firebase/firestore';
import { toast } from 'sonner';
import type { AiGrant, AppDoc, GlobalRole, StoreDoc, StoreGrant, StorePermission, StoreRole } from '@asm/shared';
import { DEFAULT_AI_GRANT, STORE_PERMISSION_OPTIONS, roleAllows } from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveQuery } from '@/lib/hooks';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label, FieldHint } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { AppGlyph } from '@/components/StoreGlyph';

function RolePicker({ value, onChange }: { value: GlobalRole; onChange: (r: GlobalRole) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(
        [
          { v: 'member', label: 'Member', hint: 'Access only to granted stores' },
          { v: 'admin', label: 'Admin', hint: 'Everything, including users & keys' },
        ] as const
      ).map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`rounded-lg border p-3 text-left transition-colors ${
            value === o.v ? 'border-primary/60 bg-accent/60' : 'hover:bg-muted'
          }`}
        >
          <div className="text-[13px] font-semibold">{o.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{o.hint}</div>
        </button>
      ))}
    </div>
  );
}

function AiEditor({ value, onChange }: { value: AiGrant; onChange: (v: AiGrant) => void }) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium">AI translate</div>
          <div className="text-xs text-muted-foreground">Auto-translate metadata into other languages</div>
        </div>
        <Switch
          checked={value.features.translate}
          onCheckedChange={(v) => onChange({ ...value, features: { ...value.features, translate: v } })}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium">AI generate</div>
          <div className="text-xs text-muted-foreground">Keyword ideas, description improvements</div>
        </div>
        <Switch
          checked={value.features.generate}
          onCheckedChange={(v) => onChange({ ...value, features: { ...value.features, generate: v } })}
        />
      </div>
      <div>
        <Label htmlFor="ai-credits">Monthly credits</Label>
        <Input
          id="ai-credits"
          type="number"
          min={0}
          value={value.monthlyCredits}
          onChange={(e) => onChange({ ...value, monthlyCredits: Math.max(0, Number(e.target.value) || 0) })}
        />
        <FieldHint>1 credit = one AI operation on one language.</FieldHint>
      </div>
    </div>
  );
}

export function useStoresList() {
  const q = useMemo(() => query(collection(db, 'stores')), []);
  return useLiveQuery<StoreDoc>(q, 'stores-all');
}

function GrantsEditor({
  grants,
  onChange,
}: {
  grants: Record<string, StoreGrant>;
  onChange: (g: Record<string, StoreGrant>) => void;
}) {
  const stores = useStoresList();
  if (stores.loading) return null;
  if (stores.rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No stores connected yet — grants can be assigned once a store is added.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
        <b>Viewer</b> reads · <b>Translator</b> edits drafts & uses AI but can’t push to Apple ·{' '}
        <b>Editor</b> pushes & manages screenshots · <b>Manager</b> adds/removes languages & creates versions.
      </p>
      {stores.rows.map((s) => {
        const grant = grants[s.id];
        return (
          <div key={s.id} className="rounded-lg border px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{s.data.name}</div>
                <div className="text-xs text-muted-foreground">
                  {grant ? (grant.apps ? `${Object.keys(grant.apps).length} specific apps` : 'All apps in this store') : 'No access'}
                </div>
              </div>
              <Select
                value={grant?.role ?? 'none'}
                onValueChange={(v) => {
                  const next = { ...grants };
                  if (v === 'none') delete next[s.id];
                  else next[s.id] = { ...(next[s.id] ?? {}), role: v as StoreRole };
                  onChange(next);
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No access</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="translator">Translator</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="developer">Developer</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {grant && (
              <StoreAppScope
                storeId={s.id}
                grant={grant}
                onChange={(nextGrant) => onChange({ ...grants, [s.id]: nextGrant })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StoreAppScope({
  storeId,
  grant,
  onChange,
}: {
  storeId: string;
  grant: StoreGrant;
  onChange: (grant: StoreGrant) => void;
}) {
  const apps = useLiveQuery<AppDoc>(
    useMemo(() => query(collection(db, 'stores', storeId, 'apps')), [storeId]),
    `access-apps-${storeId}`,
  );
  const specific = grant.apps !== undefined;
  const customPermissionCount = Object.keys(grant.permissions ?? {}).length;
  return (
    <div className="mt-2 border-t pt-2">
      <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
        <button
          type="button"
          onClick={() => {
            const { apps: _apps, ...rest } = grant;
            onChange(rest);
          }}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium ${!specific ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
        >
          All apps
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...grant, apps: grant.apps ?? {} })}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium ${specific ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
        >
          Specific apps
        </button>
      </div>
      {specific && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border p-1.5">
          {apps.rows.map((app) => (
            <div key={app.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
              <AppGlyph name={app.data.name} iconUrl={app.data.iconUrl} seed={app.id} size="sm" className="rounded-[22%]" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{app.data.name}</span>
              <Select
                value={grant.apps?.[app.id] ?? 'none'}
                onValueChange={(value) => {
                  const nextApps = { ...(grant.apps ?? {}) };
                  if (value === 'none') delete nextApps[app.id];
                  else nextApps[app.id] = value as StoreRole;
                  onChange({ ...grant, apps: nextApps });
                }}
              >
                <SelectTrigger className="h-7 w-32 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No access</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="translator">Translator</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="developer">Developer</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
          {!apps.loading && apps.rows.length === 0 && (
            <p className="p-2 text-center text-[11px] text-muted-foreground">No apps synced for this store.</p>
          )}
        </div>
      )}
      <div className="mt-2 rounded-lg border bg-muted/15 p-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold">Operational permissions</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {customPermissionCount > 0
                ? `${customPermissionCount} custom override${customPermissionCount === 1 ? '' : 's'} · applies to the app scope above`
                : `Using ${grant.role} role defaults`}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[10px]"
              onClick={() => {
                const { permissions: _permissions, ...rest } = grant;
                onChange(rest);
              }}
            >
              Use role defaults
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px]"
              onClick={() => onChange({
                ...grant,
                permissions: Object.fromEntries(STORE_PERMISSION_OPTIONS.map(({ key }) => [key, true])) as Record<StorePermission, boolean>,
              })}
            >
              Select all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px]"
              onClick={() => onChange({
                ...grant,
                permissions: Object.fromEntries(STORE_PERMISSION_OPTIONS.map(({ key }) => [key, false])) as Record<StorePermission, boolean>,
              })}
            >
              Clear all
            </Button>
          </div>
        </div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {STORE_PERMISSION_OPTIONS.map((permission) => {
            const explicit = grant.permissions?.[permission.key];
            const enabled = explicit ?? roleAllows(grant.role, permission.key);
            return (
              <div key={permission.key} className="flex items-start justify-between gap-3 rounded-md border bg-card px-2.5 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium">{permission.label}</p>
                  <p className="mt-0.5 text-[9px] leading-3.5 text-muted-foreground">{permission.hint}</p>
                  {explicit === undefined && (
                    <span className="text-[9px] text-muted-foreground">Inherited from {grant.role}</span>
                  )}
                </div>
                <Switch
                  checked={enabled}
                  aria-label={permission.label}
                  onCheckedChange={(checked) => onChange({
                    ...grant,
                    permissions: { ...(grant.permissions ?? {}), [permission.key]: checked },
                  })}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GlobalRole>('member');
  const [ai, setAi] = useState<AiGrant>(DEFAULT_AI_GRANT);

  useEffect(() => {
    if (!open) {
      setEmail('');
      setRole('member');
      setAi(DEFAULT_AI_GRANT);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => api.usersInvite({ email: email.trim(), role, ai }),
    onSuccess: () => {
      toast.success(`Invited ${email.trim()}`, {
        description: 'They get access the first time they sign in with Google.',
      });
      onOpenChange(false);
    },
    onError: (err) => toast.error('Invite failed', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="Invite a teammate"
          description="They sign in with this Google account email — no password, no signup form."
        />
        <div className="space-y-4">
          <div>
            <Label htmlFor="invite-email">Google account email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <Label>Role</Label>
            <RolePicker value={role} onChange={setRole} />
          </div>
          <div>
            <Label>AI access</Label>
            <AiEditor value={ai} onChange={setAi} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}
          >
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface AccessTarget {
  kind: 'user' | 'invite';
  id: string; // uid or email
  name: string;
  role: GlobalRole;
  grants: Record<string, StoreGrant>;
  ai: AiGrant;
  isSelf: boolean;
}

export function AccessDialog({
  target,
  onOpenChange,
}: {
  target: AccessTarget | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [role, setRole] = useState<GlobalRole>('member');
  const [grants, setGrants] = useState<Record<string, StoreGrant>>({});
  const [ai, setAi] = useState<AiGrant>(DEFAULT_AI_GRANT);

  useEffect(() => {
    if (target) {
      setRole(target.role);
      setGrants(target.grants);
      setAi(target.ai ?? DEFAULT_AI_GRANT);
    }
  }, [target]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!target) return;
      if (target.kind === 'user') {
        await api.usersUpdate({ uid: target.id, role, grants, ai });
      } else {
        await api.allowlistUpdate({ email: target.id, role, grants, ai });
      }
    },
    onSuccess: () => {
      toast.success('Access updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error('Update failed', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-h-[88vh] overflow-y-auto">
        <DialogHeader
          title={`Access — ${target?.name ?? ''}`}
          description="Role, per-store permissions and AI quota. Changes apply immediately."
        />
        <div className="space-y-4">
          <div>
            <Label>Role</Label>
            <RolePicker value={role} onChange={setRole} />
            {target?.isSelf && role === 'member' && target.role === 'admin' && (
              <p className="mt-1.5 text-xs text-destructive">You can’t remove your own admin role.</p>
            )}
          </div>
          {role === 'member' ? (
            <div>
              <Label>Store access</Label>
              <GrantsEditor grants={grants} onChange={setGrants} />
            </div>
          ) : (
            <Badge variant="accent">Admins have full access to every store</Badge>
          )}
          <div>
            <Label>AI access</Label>
            <AiEditor value={ai} onChange={setAi} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
