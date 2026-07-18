import { Page } from '@/layout/AppShell';
import { useTheme, type ThemePref } from '@/theme/ThemeProvider';
import { cn } from '@/lib/utils';

const prefs: Array<{ value: ThemePref; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function SettingsPage() {
  const { pref, setPref } = useTheme();
  return (
    <Page title="Settings" description="Personal preferences.">
      <div className="rounded-xl border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold">Appearance</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Choose how the app looks.</p>
        <div className="mt-3 inline-flex rounded-lg bg-muted p-1">
          {prefs.map((p) => (
            <button
              key={p.value}
              onClick={() => setPref(p.value)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                pref === p.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
}
