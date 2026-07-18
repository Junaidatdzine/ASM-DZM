import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { doc } from 'firebase/firestore';
import { Globe, Mail, Send, ShieldCheck, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { AI_MODELS, DEFAULT_SETTINGS, type GlobalSettingsDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';
import { useLiveDoc } from '@/lib/hooks';
import { Page } from '@/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label, FieldHint } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { cn } from '@/lib/utils';

export function AdminSettingsPage() {
  const settings = useLiveDoc<GlobalSettingsDoc>(useMemo(() => doc(db, 'settings', 'global'), []));
  const s = settings.data ?? DEFAULT_SETTINGS;

  const [model, setModel] = useState(s.aiModel);
  const [domains, setDomains] = useState<string[]>(s.allowedDomains ?? []);
  const [domainInput, setDomainInput] = useState('');
  const [idle, setIdle] = useState<string>(s.idleTimeoutMinutes ? String(s.idleTimeoutMinutes) : '');
  const [reportEmails, setReportEmails] = useState<string[]>(s.reportEmails ?? []);
  const [reportEmailInput, setReportEmailInput] = useState('');
  const [reportHour, setReportHour] = useState<number>(s.reportHour ?? 11);

  useEffect(() => {
    if (settings.exists) {
      setModel(s.aiModel);
      setDomains(s.allowedDomains ?? []);
      setIdle(s.idleTimeoutMinutes ? String(s.idleTimeoutMinutes) : '');
      setReportEmails(s.reportEmails ?? []);
      setReportHour(s.reportHour ?? 11);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.exists]);

  const save = useMutation({
    mutationFn: () =>
      api.settingsUpdate({
        aiModel: model,
        allowedDomains: domains,
        idleTimeoutMinutes: idle.trim() ? Number(idle) : null,
        reportEmails,
        reportHour,
      }),
    onSuccess: () => toast.success('Settings saved'),
    onError: (err) => toast.error('Save failed', { description: callableMessage(err) }),
  });

  const sendNow = useMutation({
    // Persist the recipients/hour shown on screen first, then send — no hidden
    // "you forgot to save" trap.
    mutationFn: async () => {
      await api.settingsUpdate({ reportEmails, reportHour });
      return api.reportSendNow({});
    },
    onSuccess: (res) => toast.success('Report sent', { description: res.summary }),
    onError: (err) => toast.error('Couldn’t send report', { description: callableMessage(err) }),
  });

  const addReportEmail = () => {
    const email = reportEmailInput.trim().toLowerCase();
    if (!/.+@.+\..+/.test(email)) {
      toast.error('Enter a valid email address');
      return;
    }
    if (!reportEmails.includes(email)) setReportEmails([...reportEmails, email]);
    setReportEmailInput('');
  };

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
      toast.error('Enter a bare domain like acme.com');
      return;
    }
    if (!domains.includes(d)) setDomains([...domains, d]);
    setDomainInput('');
  };

  return (
    <Page title="Workspace settings" description="AI model, sign-in restrictions and sessions.">
      <div className="space-y-4">
        {/* Sign-in restriction */}
        <section className="rounded-xl border bg-card p-5 shadow-card">
          <div className="mb-1 flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Allowed email domains</h2>
          </div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            When set, only Google accounts on these domains can request access. Invited users and
            admins always get in regardless. Leave empty to allow any Google account (invite-only still applies).
          </p>
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <Badge key={d} variant="accent" className="gap-1 pr-1">
                <Globe className="size-3" /> {d}
                <button onClick={() => setDomains(domains.filter((x) => x !== d))} className="rounded-full p-0.5 hover:bg-black/10">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {domains.length === 0 && <span className="text-[13px] text-muted-foreground">No restriction — any domain.</span>}
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="acme.com"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDomain())}
              className="max-w-xs"
            />
            <Button variant="outline" onClick={addDomain}>
              Add domain
            </Button>
          </div>
        </section>

        {/* AI model */}
        <section className="rounded-xl border bg-card p-5 shadow-card">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">AI model</h2>
          </div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Used for translation & generation. Flash Lite is cheapest — translations batch every
            language into one request to keep costs low.
          </p>
          <div className="grid max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
            {AI_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  model === m.id ? 'border-primary/60 bg-accent/60' : 'hover:bg-muted',
                )}
              >
                <div className="text-[13px] font-semibold">{m.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{m.note}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Daily email report */}
        <section className="rounded-xl border bg-card p-5 shadow-card">
          <div className="mb-1 flex items-center gap-2">
            <Mail className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Daily email report</h2>
          </div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            One email per day with proceeds, downloads, store totals and top apps across every store.
            Sent automatically at the chosen hour (Pakistan time) to every address below.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {reportEmails.map((email) => (
              <Badge key={email} variant="accent" className="gap-1.5">
                {email}
                <button onClick={() => setReportEmails(reportEmails.filter((e) => e !== email))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {reportEmails.length === 0 && (
              <span className="text-[12px] text-muted-foreground">No recipients — reports are off.</span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              type="email"
              placeholder="reports@dzinemedia.com"
              value={reportEmailInput}
              onChange={(e) => setReportEmailInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addReportEmail(); } }}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={addReportEmail}>Add email</Button>
            <div className="ml-auto flex items-center gap-2">
              <Label className="mb-0 whitespace-nowrap text-[12px] text-muted-foreground">Send at</Label>
              <Select value={String(reportHour)} onValueChange={(v) => setReportHour(Number(v))}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00 PKT
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendNow.mutate()}
                loading={sendNow.isPending}
                disabled={reportEmails.length === 0}
              >
                <Send className="size-3.5" /> Send now
              </Button>
            </div>
          </div>
          <FieldHint>
            “Send now” saves the recipients and hour shown here, sends immediately, and counts as today’s email.
          </FieldHint>
        </section>

        {/* Idle timeout */}
        <section className="rounded-xl border bg-card p-5 shadow-card">
          <h2 className="text-sm font-semibold">Idle auto sign-out</h2>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Sign users out after this many minutes of inactivity — including time away with the browser closed.
            Blank = the default of 10080 minutes (7 days).
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={5}
              placeholder="10080"
              value={idle}
              onChange={(e) => setIdle(e.target.value)}
              className="w-32"
            />
            <span className="text-[13px] text-muted-foreground">minutes</span>
          </div>
          <FieldHint>Example: 10080 = 1 week, 1440 = 1 day. Applies to every user on their next visit.</FieldHint>
        </section>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </div>
    </Page>
  );
}
