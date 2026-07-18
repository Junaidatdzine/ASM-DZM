import { useEffect } from 'react';
import { Link, useRouteError } from 'react-router-dom';
import { AppMark } from '@/components/AppMark';
import { Button } from '@/components/ui/Button';

const RELOAD_GUARD_KEY = 'asm-chunk-reload-at';

/** True for the "old tab after a new deploy" failure: a hashed chunk that no longer exists. */
export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String((error as { message?: string })?.message ?? '');
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('error loading dynamically imported module')
  );
}

/** Reload once to pick up the freshly deployed build; guarded against reload loops. */
export function reloadForNewBuild(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
  if (Date.now() - last < 15_000) return false; // already tried very recently — don't loop
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

/**
 * Router-level error screen. Stale-chunk errors self-heal with a reload (a new
 * version was deployed while this tab was open); anything else gets a calm,
 * branded recovery screen instead of a developer stack.
 */
export function RouteError() {
  const error = useRouteError();
  const stale = isStaleChunkError(error);

  useEffect(() => {
    if (stale) reloadForNewBuild();
  }, [stale]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <AppMark hero />
      {stale ? (
        <p className="max-w-md text-[13px] text-muted-foreground">
          A new version of Dzinemedia ASM was just deployed — refreshing to load it…
        </p>
      ) : (
        <>
          <p className="max-w-md text-[13px] text-muted-foreground">
            Something went wrong loading this page. Your data is safe — reloading usually fixes it.
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Link to="/" className="text-[13px] text-primary hover:underline">
              Go to dashboard
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
