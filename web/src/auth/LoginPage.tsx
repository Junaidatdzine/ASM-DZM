import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from './AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Skeleton';
import { AppMark } from '@/components/AppMark';
import { usingEmulators } from '@/lib/firebase';

function GoogleG() {
  return (
    <svg className="size-4" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.97 10.97 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

export function LoginPage() {
  const { status, error, signInGoogle } = useSession();
  const [devEmail, setDevEmail] = useState('junaidkamoka@aol.com');

  if (status === 'ready') return <Navigate to="/" replace />;
  if (status === 'unprovisioned') return <Navigate to="/request-access" replace />;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(600px 400px at 50% -10%, oklch(from var(--primary) l c h / 14%), transparent 70%)',
        }}
      />
      <div className="relative w-full max-w-sm px-6">
        <div className="rounded-2xl border bg-card p-8 shadow-card">
          <AppMark hero className="mb-7" />
          <h1 className="text-center text-lg font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-center text-[13px] text-muted-foreground">
            Manage apps, metadata, releases, performance, access and activity in one place.
          </p>

          {usingEmulators && (
            <div className="mt-6">
              <Input
                value={devEmail}
                onChange={(e) => setDevEmail(e.target.value)}
                placeholder="dev identity email"
                aria-label="Dev identity email"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Emulator mode — signs in as a fake Google account with this email.
              </p>
            </div>
          )}
          <Button
            variant="outline"
            size="lg"
            className={usingEmulators ? 'mt-3 w-full' : 'mt-6 w-full'}
            onClick={() => void signInGoogle(devEmail)}
            disabled={status === 'loading'}
          >
            {status === 'loading' ? <Spinner /> : <GoogleG />}
            Continue with Google
          </Button>

          {status === 'disabled' && (
            <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              Your account has been disabled. Contact an admin.
            </p>
          )}
          {error && (
            <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Access is invite-only. Sign in with the Google account your admin added.
          </p>
        </div>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          A{' '}
          <a
            href="https://www.dzinemedia.com/"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            dzinemedia.com
          </a>{' '}
          product
        </p>
      </div>
    </div>
  );
}
