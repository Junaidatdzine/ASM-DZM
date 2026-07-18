import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { collection, query, where } from 'firebase/firestore';
import {
  AlertTriangle,
  FileKey2,
  KeyRound,
  LayoutGrid,
  LineChart,
  MoreHorizontal,
  Palette,
  Plus,
  Rows3,
  Store as StoreIcon,
  Trash2,
  UploadCloud,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  STORE_COLORS,
  STORE_ICONS,
  can,
  hasSimilarColors,
  isHexColor,
  nextDistinctColor,
  type StoreDoc,
} from '@asm/shared';
import { db, usingEmulators } from '@/lib/firebase';
import { STORE_ICON_MAP, StoreGlyph, storeColorClasses } from '@/components/StoreGlyph';
import { cn } from '@/lib/utils';
import { api, callableMessage } from '@/lib/callables';
import { useLiveQuery } from '@/lib/hooks';
import { useSession } from '@/auth/AuthProvider';
import { Page } from '@/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label, FieldHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Textarea';
import { timeAgo } from '@/lib/utils';

export function useMyStores() {
  const { uid, user } = useSession();
  const isAdmin = user?.role === 'admin';
  const q = useMemo(() => {
    if (!uid) return null;
    const col = collection(db, 'stores');
    return isAdmin ? query(col) : query(col, where('memberUids', 'array-contains', uid));
  }, [uid, isAdmin]);
  return useLiveQuery<StoreDoc>(q, `stores-${isAdmin ? 'all' : uid}`);
}

interface KeyFormState {
  issuerId: string;
  keyId: string;
  p8: string;
}

/** Drag & drop (or click) target for the AuthKey_XXXX.p8 file — also infers the Key ID. */
function P8Dropzone({
  value,
  onFile,
}: {
  value: KeyFormState;
  onFile: (p8: string, inferredKeyId: string | null, fileName: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    if (file.size > 20_000) {
      toast.error('That doesn’t look like a .p8 key (too large).');
      return;
    }
    const text = await file.text();
    if (!text.includes('BEGIN PRIVATE KEY')) {
      toast.error('That file isn’t a valid .p8 private key.');
      return;
    }
    // AuthKey_2X9R4HXF34.p8 → 2X9R4HXF34
    const inferred = /AuthKey_([A-Z0-9]{6,16})\.p8$/i.exec(file.name)?.[1] ?? null;
    setFileName(file.name);
    onFile(text, inferred, file.name);
  };

  const hasKey = value.p8.includes('BEGIN PRIVATE KEY');

  return (
    <div>
      <Label>Private key (.p8)</Label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void readFile(file);
        }}
        onClick={() => input.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging
            ? 'border-primary bg-accent/50'
            : hasKey
              ? 'border-success/50 bg-success/5'
              : 'hover:border-primary/40 hover:bg-muted/50',
        )}
      >
        {hasKey ? (
          <>
            <FileKey2 className="size-6 text-success" />
            <div className="text-[13px] font-medium">{fileName ?? 'Key loaded'}</div>
            <div className="text-[11px] text-muted-foreground">Click or drop to replace</div>
          </>
        ) : (
          <>
            <UploadCloud className={cn('size-6', dragging ? 'text-primary' : 'text-muted-foreground')} />
            <div className="text-[13px] font-medium">Drop your AuthKey_XXXX.p8 here</div>
            <div className="text-[11px] text-muted-foreground">or click to browse</div>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept=".p8,.pem,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <FieldHint className="mt-0">
          Download it from App Store Connect → Users and Access → Integrations. Verified with Apple,
          then AES-256 encrypted — it never reaches a browser again.
        </FieldHint>
        <button
          type="button"
          onClick={() => setPasteMode(!pasteMode)}
          className="shrink-0 text-[11px] text-primary hover:underline"
        >
          {pasteMode ? 'hide' : 'paste instead'}
        </button>
      </div>
      {pasteMode && (
        <Textarea
          rows={4}
          className="mt-2 font-mono text-xs"
          placeholder={'-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49…\n-----END PRIVATE KEY-----'}
          value={value.p8}
          onChange={(e) => onFile(e.target.value, null, 'pasted key')}
        />
      )}
    </div>
  );
}

function KeyFields({ value, onChange }: { value: KeyFormState; onChange: (v: KeyFormState) => void }) {
  return (
    <>
      <P8Dropzone
        value={value}
        onFile={(p8, inferredKeyId) =>
          onChange({ ...value, p8, keyId: value.keyId || inferredKeyId || value.keyId })
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="issuer">Issuer ID</Label>
          <Input
            id="issuer"
            placeholder="57246542-96fe-1a63-…"
            value={value.issuerId}
            onChange={(e) => onChange({ ...value, issuerId: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="keyid">Key ID</Label>
          <Input
            id="keyid"
            placeholder="2X9R4HXF34"
            value={value.keyId}
            onChange={(e) => onChange({ ...value, keyId: e.target.value })}
          />
          <FieldHint>Auto-filled from the file name when possible.</FieldHint>
        </div>
      </div>
    </>
  );
}

const emptyKey: KeyFormState = { issuerId: '', keyId: '', p8: '' };

/** Palette + icon picker used when adding or editing a store's appearance. */
function AppearancePicker({
  color,
  icon,
  onColor,
  onIcon,
  takenColors,
  takenIcons,
}: {
  color: string;
  icon: string;
  onColor: (c: string) => void;
  onIcon: (i: string) => void;
  /** Colors/icons already used by other stores — hidden so every store stays distinct. */
  takenColors?: Set<string>;
  takenIcons?: Set<string>;
}) {
  // Unique suggestions first: generated hues maximally distant from every store's
  // color. The classic palette follows (minus taken keys) for manual taste.
  const suggestions = useMemo(() => {
    const used = [...(takenColors ?? [])];
    const out: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = nextDistinctColor([...used, ...out]);
      out.push(next);
    }
    return out;
  }, [takenColors]);
  const colors = STORE_COLORS.filter((c) => c.key === color || !takenColors?.has(c.key));
  const icons = STORE_ICONS.filter((i) => i === icon || !takenIcons?.has(i));
  const iconList = icons.length > 1 ? icons : STORE_ICONS;
  const swatch = (value: string, className: string, style?: React.CSSProperties) => (
    <button
      key={value}
      type="button"
      onClick={() => onColor(value)}
      title={isHexColor(value) ? 'Unique color' : value}
      className={`size-7 rounded-full ${className} ${
        color === value ? 'ring-2 ring-ring ring-offset-2 ring-offset-card' : ''
      }`}
      style={style}
    />
  );
  return (
    <div className="space-y-3">
      <div>
        <Label>Color · unique picks first</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {isHexColor(color) && !suggestions.includes(color) && swatch(color, '', { backgroundColor: color })}
          {suggestions.map((hex) => swatch(hex, '', { backgroundColor: hex }))}
          <span className="mx-1 h-5 w-px bg-border" />
          {colors.map((c) => swatch(c.key, storeColorClasses(c.key).dot))}
        </div>
      </div>
      <div>
        <Label>Symbol</Label>
        <div className="flex flex-wrap gap-1.5">
          {iconList.map((i) => {
            const Icon = STORE_ICON_MAP[i]!;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onIcon(i)}
                className={`flex size-8 items-center justify-center rounded-lg border transition-colors ${
                  icon === i ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-muted'
                }`}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const randomFrom = <T,>(list: T[], fallback: T): T =>
  list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : fallback;

/** New-store look: a hue no other store is close to + a free (or random) icon. */
function randomFreeAppearance(takenColors: Set<string>, takenIcons: Set<string>): { color: string; icon: string } {
  const freeIcons = STORE_ICONS.filter((i) => !takenIcons.has(i));
  return {
    color: nextDistinctColor([...takenColors]),
    icon: randomFrom(freeIcons, STORE_ICONS[Math.floor(Math.random() * STORE_ICONS.length)]!),
  };
}

function AddStoreDialog({
  open,
  onOpenChange,
  takenColors,
  takenIcons,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  takenColors: Set<string>;
  takenIcons: Set<string>;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'real' | 'mock'>(usingEmulators ? 'mock' : 'real');
  const [creds, setCreds] = useState<KeyFormState>(emptyKey);
  const [color, setColor] = useState(STORE_COLORS[0]!.key);
  const [icon, setIcon] = useState<string>('store');
  const [vendorNumber, setVendorNumber] = useState('');

  // Every new store starts with a random look no other store uses — no manual picking.
  useEffect(() => {
    if (open) {
      const fresh = randomFreeAppearance(takenColors, takenIcons);
      setColor(fresh.color);
      setIcon(fresh.icon);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      api.storesAdd({
        name: name.trim(),
        color,
        icon,
        ...(vendorNumber.trim() ? { vendorNumber: vendorNumber.trim() } : {}),
        ...(mode === 'mock' ? { mock: true } : { creds }),
      }),
    onSuccess: (res) => {
      const storeName = name.trim();
      const hasVendor = !!vendorNumber.trim();
      toast.success(`Connected “${storeName}”`, {
        description: `${res.appsCount} app${res.appsCount === 1 ? '' : 's'} found — syncing everything in the background.`,
      });
      onOpenChange(false);
      setName('');
      setCreds(emptyKey);
      // Background full fetch so the store is instantly complete on first open:
      // app list + icons first, then finance history when a vendor number exists.
      void (async () => {
        try {
          const sync = await api.storesSync({ storeId: res.storeId });
          if (!sync.skipped) {
            toast.success(`“${storeName}” apps are ready`, {
              description: `${sync.apps ?? res.appsCount} apps synced. ${hasVendor ? 'Fetching finance history next…' : ''}`,
            });
          }
          if (hasVendor) {
            const fin = await api.financeSync({ storeId: res.storeId, days: 60 });
            toast.success(`“${storeName}” finance is ready`, {
              description: `${fin.fetched} daily reports loaded — analytics will include it now.`,
            });
          }
        } catch (err) {
          toast.warning(`Background sync for “${storeName}” hit a snag`, {
            description: `${callableMessage(err)} It will retry automatically when you open the store.`,
          });
        }
      })();
    },
    onError: (err) => toast.error('Couldn’t connect the store', { description: callableMessage(err) }),
  });

  const valid =
    name.trim().length > 0 &&
    (mode === 'mock' || (creds.issuerId.trim() && creds.keyId.trim() && creds.p8.includes('PRIVATE KEY')));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader
          title="Connect an App Store Connect account"
          description="Each store is one ASC account (one API key). Apps and localizations sync from it."
        />
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <StoreGlyph color={color} icon={icon} size="lg" />
            <div className="flex-1">
              <Label htmlFor="store-name">Store name</Label>
              <Input
                id="store-name"
                placeholder="e.g. Acme Apps"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <AppearancePicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} takenColors={takenColors} takenIcons={takenIcons} />
          {usingEmulators && (
            <div className="flex gap-2 rounded-lg bg-muted p-1">
              {(
                [
                  { v: 'mock', label: 'Mock store (fixtures)' },
                  { v: 'real', label: 'Real ASC key' },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setMode(o.v)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    mode === o.v ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {mode === 'real' && <KeyFields value={creds} onChange={setCreds} />}
          <div>
            <Label htmlFor="vendor">Vendor number (optional — unlocks finance analytics)</Label>
            <Input
              id="vendor"
              placeholder="e.g. 89712345"
              value={vendorNumber}
              onChange={(e) => setVendorNumber(e.target.value)}
            />
            <FieldHint>App Store Connect → Payments and Financial Reports (top-left).</FieldHint>
          </div>
          {mode === 'mock' && (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              Emulator-only: two sample apps with realistic localizations and screenshots, no Apple
              account needed. Perfect for trying every feature.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!valid}>
            {mode === 'real' ? 'Verify & connect' : 'Create mock store'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UpdateKeyDialog({
  storeId,
  onOpenChange,
}: {
  storeId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [creds, setCreds] = useState<KeyFormState>(emptyKey);
  const mutation = useMutation({
    mutationFn: () => api.storesUpdateKey({ storeId: storeId!, creds }),
    onSuccess: () => {
      toast.success('API key updated and verified');
      onOpenChange(false);
      setCreds(emptyKey);
    },
    onError: (err) => toast.error('Key update failed', { description: callableMessage(err) }),
  });
  return (
    <Dialog open={!!storeId} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader title="Replace API key" description="The new key is verified against Apple before saving." />
        <div className="space-y-4">
          <KeyFields value={creds} onChange={setCreds} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!(creds.issuerId.trim() && creds.keyId.trim() && creds.p8.includes('PRIVATE KEY'))}
          >
            Verify & save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceDialog({
  store,
  onOpenChange,
  takenColors,
  takenIcons,
}: {
  store: (StoreDoc & { id: string }) | null;
  onOpenChange: (o: boolean) => void;
  takenColors: Set<string>;
  takenIcons: Set<string>;
}) {
  const [color, setColor] = useState(store?.color ?? STORE_COLORS[0]!.key);
  const [icon, setIcon] = useState(store?.icon ?? 'store');
  const [name, setName] = useState(store?.name ?? '');
  const [vendorNumber, setVendorNumber] = useState(store?.vendorNumber ?? '');
  useEffect(() => {
    if (store) {
      setColor(store.color ?? STORE_COLORS[0]!.key);
      setIcon(store.icon ?? 'store');
      setName(store.name);
      setVendorNumber(store.vendorNumber ?? '');
    }
  }, [store]);

  const mutation = useMutation({
    mutationFn: () =>
      api.storesRename({
        storeId: store!.id,
        color,
        icon,
        ...(name.trim() && name.trim() !== store!.name ? { name: name.trim() } : {}),
        vendorNumber: vendorNumber.trim() === '' ? null : vendorNumber.trim(),
      }),
    onSuccess: () => {
      toast.success('Store updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error('Update failed', { description: callableMessage(err) }),
  });

  return (
    <Dialog open={!!store} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Store settings" description="Name, vendor number and visual identity." />
        <div className="mb-4 flex items-end gap-3">
          <StoreGlyph color={color} icon={icon} size="lg" />
          <div className="flex-1">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="mb-4">
          <Label htmlFor="edit-vendor">Vendor number (finance analytics)</Label>
          <Input
            id="edit-vendor"
            placeholder="e.g. 89712345"
            value={vendorNumber}
            onChange={(e) => setVendorNumber(e.target.value)}
          />
          <FieldHint>App Store Connect → Payments and Financial Reports. Blank = disable finance.</FieldHint>
        </div>
        <AppearancePicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} takenColors={takenColors} takenIcons={takenIcons} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type StoresView = 'grid' | 'rows';
type TitleSize = 0 | 1 | 2 | 3;
const TITLE_CLASSES: Record<TitleSize, string> = {
  0: 'text-[13px]',
  1: 'text-[15px]',
  2: 'text-[17px]',
  3: 'text-[20px]',
};

export function StoresPage() {
  const { user } = useSession();
  const isAdmin = user?.role === 'admin';
  const stores = useMyStores();
  const [addOpen, setAddOpen] = useState(false);
  const [keyTarget, setKeyTarget] = useState<string | null>(null);
  const [appearanceTarget, setAppearanceTarget] = useState<StoreDoc & { id: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  // 60+ stores: switchable layout + adjustable title size, remembered locally.
  const [view, setView] = useState<StoresView>(() => (localStorage.getItem('asm-stores-view') === 'rows' ? 'rows' : 'grid'));
  const [titleSize, setTitleSize] = useState<TitleSize>(() => {
    const raw = Number(localStorage.getItem('asm-stores-title'));
    return (raw >= 0 && raw <= 3 ? raw : 1) as TitleSize;
  });
  const changeView = (v: StoresView) => {
    setView(v);
    localStorage.setItem('asm-stores-view', v);
  };
  const changeTitle = (delta: number) => {
    setTitleSize((prev) => {
      const next = Math.min(3, Math.max(0, prev + delta)) as TitleSize;
      localStorage.setItem('asm-stores-title', String(next));
      return next;
    });
  };

  // Looks already claimed by existing stores — new stores get something distinct.
  const takenColors = useMemo(
    () => new Set(stores.rows.map((s) => s.data.color).filter((c): c is string => !!c)),
    [stores.rows],
  );
  const takenIcons = useMemo(
    () => new Set(stores.rows.map((s) => s.data.icon).filter((i): i is string => !!i)),
    [stores.rows],
  );

  // Self-healing uniqueness: if any two stores share the same or a similar color
  // (or lack one), spread ALL stores evenly around the hue wheel — once.
  const recoloredRef = useRef(false);
  const recolor = useMutation({
    mutationFn: () => api.storesRecolor({}),
    onSuccess: (res) => toast.success('Store colors refreshed', { description: `${res.recolored} stores now have clearly distinct colors.` }),
  });
  useEffect(() => {
    if (!isAdmin || stores.loading || stores.rows.length < 2 || recoloredRef.current) return;
    if (hasSimilarColors(stores.rows.map((s) => s.data.color))) {
      recoloredRef.current = true;
      recolor.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, stores.loading, stores.rows]);

  // "synced —" means never synced: pull those app lists automatically (a couple
  // at a time) so freshly added stores fill in without anyone hunting for Sync.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!isAdmin || stores.loading || autoSyncedRef.current) return;
    const neverSynced = stores.rows.filter((s) => !s.data.appsSyncedAt && s.data.status !== 'auth_error');
    if (neverSynced.length === 0) return;
    autoSyncedRef.current = true;
    toast.info(
      neverSynced.length === 1
        ? `Syncing “${neverSynced[0]!.data.name}” for the first time…`
        : `Syncing ${neverSynced.length} never-synced stores in the background…`,
      { description: 'App lists appear as each store finishes.' },
    );
    void (async () => {
      const queue = [...neverSynced];
      await Promise.all(
        Array.from({ length: Math.min(2, queue.length) }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            await api.storesSync({ storeId: next.id }).catch(() => {});
          }
        }),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, stores.loading, stores.rows]);

  const test = useMutation({
    mutationFn: (storeId: string) => api.storesTest({ storeId }),
    onSuccess: (res) => toast.success('Connection OK', { description: `${res.appsCount} apps visible to this key.` }),
    onError: (err) => toast.error('Connection failed', { description: callableMessage(err) }),
  });

  const del = useMutation({
    mutationFn: (storeId: string) => api.storesDelete({ storeId }),
    onSuccess: () => {
      toast.success('Store removed');
      setDeleteTarget(null);
    },
    onError: (err) => toast.error('Delete failed', { description: callableMessage(err) }),
  });

  return (
    <Page
      title="Stores"
      description="Connected App Store Connect accounts."
      actions={
        <>
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
            <button
              type="button"
              title="Grid view"
              onClick={() => changeView('grid')}
              className={cn('rounded-md p-1.5', view === 'grid' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              title="Row view"
              onClick={() => changeView('rows')}
              className={cn('rounded-md p-1.5', view === 'rows' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              <Rows3 className="size-4" />
            </button>
          </div>
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
            <button
              type="button"
              title="Smaller titles"
              onClick={() => changeTitle(-1)}
              disabled={titleSize === 0}
              className="rounded-md px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              A−
            </button>
            <button
              type="button"
              title="Bigger titles"
              onClick={() => changeTitle(1)}
              disabled={titleSize === 3}
              className="rounded-md px-2 py-1 text-[14px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              A+
            </button>
          </div>
          {isAdmin && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add store
            </Button>
          )}
        </>
      }
    >
      {stores.loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : stores.rows.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title={isAdmin ? 'Connect your first store' : 'No stores yet'}
          description={
            isAdmin
              ? 'Add an App Store Connect API key and your apps appear here, ready to localize.'
              : 'An admin needs to grant you access to a store.'
          }
          action={
            isAdmin ? (
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="size-4" /> Add store
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          className={
            view === 'grid'
              ? 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'
              : 'flex flex-col gap-2'
          }
        >
          {stores.rows.map((s) => {
            const menu = isAdmin ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="relative z-10 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100">
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => test.mutate(s.id)}>
                    <Wifi className="size-3.5" /> Test connection
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAppearanceTarget({ ...s.data, id: s.id })}>
                    <Palette className="size-3.5" /> Settings & appearance
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/stores/${s.id}/finance`} className="flex items-center gap-2">
                      <LineChart className="size-3.5" /> Finance
                    </Link>
                  </DropdownMenuItem>
                  {!s.data.mock && (
                    <DropdownMenuItem onSelect={() => setKeyTarget(s.id)}>
                      <KeyRound className="size-3.5" /> Replace API key
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setDeleteTarget({ id: s.id, name: s.data.name })}>
                    <Trash2 className="size-3.5" /> Remove store
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : user && can(user, 'viewFinance', s.id) ? (
              <Link
                to={`/stores/${s.id}/finance`}
                className="relative z-10 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                title="Finance"
              >
                <LineChart className="size-4" />
              </Link>
            ) : null;

            const badges = (
              <>
                {s.data.mock && <Badge variant="outline">mock</Badge>}
                {s.data.status === 'auth_error' && (
                  <Badge variant="destructive">
                    <AlertTriangle className="size-3" /> key error
                  </Badge>
                )}
              </>
            );

            if (view === 'rows') {
              return (
                <div
                  key={s.id}
                  className="group relative flex items-center gap-3 rounded-xl border bg-card px-4 py-2.5 shadow-card transition-shadow hover:shadow-pop"
                >
                  <Link to={`/stores/${s.id}`} className="absolute inset-0" aria-label={s.data.name} />
                  <StoreGlyph color={s.data.color} icon={s.data.icon} seed={s.id} size={titleSize >= 2 ? 'lg' : 'md'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className={cn('truncate font-semibold', TITLE_CLASSES[titleSize])}>{s.data.name}</h3>
                      {badges}
                    </div>
                  </div>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {s.data.appsCount ?? 0} apps · {s.data.appsSyncedAt ? timeAgo(s.data.appsSyncedAt) : 'never synced'}
                  </span>
                  {menu}
                </div>
              );
            }

            return (
              <div
                key={s.id}
                className="group relative rounded-xl border bg-card p-5 shadow-card transition-shadow hover:shadow-pop"
              >
                <Link to={`/stores/${s.id}`} className="absolute inset-0" aria-label={s.data.name} />
                <div className="flex items-start justify-between">
                  <StoreGlyph color={s.data.color} icon={s.data.icon} seed={s.id} size="lg" />
                  {menu}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <h3 className={cn('truncate font-semibold', TITLE_CLASSES[titleSize])}>{s.data.name}</h3>
                  {badges}
                </div>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {s.data.appsCount ?? 0} apps · {s.data.appsSyncedAt ? `synced ${timeAgo(s.data.appsSyncedAt)}` : 'syncing for the first time…'}
                </p>
                {s.data.rate && (
                  <p className="mt-2 text-[11px] text-muted-foreground/70">
                    API budget: {s.data.rate.remaining}/{s.data.rate.limit} this hour
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddStoreDialog open={addOpen} onOpenChange={setAddOpen} takenColors={takenColors} takenIcons={takenIcons} />
      <AppearanceDialog
        store={appearanceTarget}
        onOpenChange={() => setAppearanceTarget(null)}
        takenColors={new Set([...takenColors].filter((c) => c !== appearanceTarget?.color))}
        takenIcons={new Set([...takenIcons].filter((i) => i !== appearanceTarget?.icon))}
      />
      <UpdateKeyDialog storeId={keyTarget} onOpenChange={() => setKeyTarget(null)} />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.name}?`}
        description="Removes the store, its encrypted key, and all cached app data from this tool. Nothing is changed on App Store Connect."
        confirmLabel="Remove store"
        destructive
        typeToConfirm={deleteTarget?.name}
        loading={del.isPending}
        onConfirm={() => {
          if (deleteTarget) del.mutate(deleteTarget.id);
        }}
      />
    </Page>
  );
}
