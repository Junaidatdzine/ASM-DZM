import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { DEFAULT_SETTINGS, type GlobalSettingsDoc, type UserDoc } from '@asm/shared';
import { auth, db, googleProvider, usingEmulators } from '@/lib/firebase';
import { api, callableMessage } from '@/lib/callables';

/** Last-seen marker for idle sign-out; survives tab closes so long absences expire. */
const LAST_ACTIVE_KEY = 'asm-last-active';

export type SessionStatus =
  | 'loading' // initial auth resolution or bootstrap in flight
  | 'signedOut'
  | 'unprovisioned' // Google-authenticated but no access granted
  | 'domainBlocked' // email domain not on the workspace allowlist
  | 'disabled'
  | 'ready';

export interface Session {
  status: SessionStatus;
  uid: string | null;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
  user: UserDoc | null; // live users/{uid} doc when ready
  error: string | null;
  /** devEmail is only honored in emulator mode (fake Google identity for local dev). */
  signInGoogle: (devEmail?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/** Human-readable "Chrome on macOS" style label for the admin users view. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux'
    : 'device';
  return `${browser} on ${os}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [fbUser, setFbUser] = useState<User | null | undefined>(undefined);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubDoc = useRef<(() => void) | null>(null);

  const stopDocWatch = () => {
    unsubDoc.current?.();
    unsubDoc.current = null;
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setFbUser(u));
    return () => {
      unsub();
      stopDocWatch();
    };
  }, []);

  // Presence heartbeat: ~2-minute pings while a tab is visible let admins see
  // who's online right now. Writes stop the moment the tab hides — dirt cheap.
  useEffect(() => {
    if (!fbUser || status !== 'ready') return;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void setDoc(doc(db, 'userPrefs', fbUser.uid), { lastSeenAt: serverTimestamp() }, { merge: true }).catch(() => {});
    };
    beat();
    const interval = setInterval(beat, 120_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [fbUser, status]);

  useEffect(() => {
    if (fbUser === undefined) return; // auth not resolved yet
    stopDocWatch();
    setUserDoc(null);
    setError(null);

    if (fbUser === null) {
      setStatus('signedOut');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    void (async () => {
      try {
        const res = await api.authBootstrap({ device: deviceLabel() });
        if (cancelled) return;
        if (res.status === 'disabled') {
          setStatus('disabled');
          await fbSignOut(auth);
          return;
        }
        if (res.status === 'unprovisioned') {
          setStatus((res as { reason?: string }).reason === 'domain' ? 'domainBlocked' : 'unprovisioned');
          return;
        }
        // active → watch own user doc; permission changes and disables apply live.
        unsubDoc.current = onSnapshot(
          doc(db, 'users', fbUser.uid),
          (snap) => {
            if (!snap.exists()) return;
            const data = snap.data() as UserDoc;
            if (data.status !== 'active') {
              setStatus('disabled');
              stopDocWatch();
              void fbSignOut(auth);
              return;
            }
            setUserDoc(data);
            setStatus('ready');
          },
          (err) => {
            console.error('user doc watch failed', err);
            setError('Lost connection to your profile.');
          },
        );
      } catch (err) {
        if (!cancelled) {
          setError(callableMessage(err));
          setStatus('signedOut');
          await fbSignOut(auth).catch(() => {});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fbUser]);

  const signInGoogle = useCallback(async (devEmail?: string) => {
    setError(null);
    try {
      // Emulator: the hosted auth handler doesn't exist on a Vite origin, so popup/redirect
      // can't complete. The Auth emulator accepts unsigned Google id-tokens — the documented
      // way to test Google-only sign-in locally. Production always uses the real flow.
      if (usingEmulators) {
        const email = (devEmail ?? '').trim().toLowerCase();
        if (!email) {
          setError('Enter a dev identity email.');
          return;
        }
        const fakeIdToken = JSON.stringify({
          sub: `dev-${email.replace(/[^a-z0-9]/g, '-')}`,
          email,
          email_verified: true,
          name: email
            .split('@')[0]!
            .replace(/[._-]+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase()),
        });
        await signInWithCredential(auth, GoogleAuthProvider.credential(fakeIdToken));
        return;
      }
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, googleProvider).catch((e) => setError(callableMessage(e)));
        return;
      }
      if (code === 'auth/unauthorized-domain') {
        setError(
          `${window.location.hostname} is not authorized for Google sign-in. Add it in Firebase Authentication → Settings → Authorized domains, then refresh this page.`,
        );
        return;
      }
      setError(callableMessage(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    stopDocWatch();
    localStorage.removeItem(LAST_ACTIVE_KEY);
    await fbSignOut(auth);
  }, []);

  // Idle expiry: sessions end after the workspace timeout (default 7 days) without
  // activity — including time away with the tab closed. Firebase keeps tokens alive
  // indefinitely, so this is the enforcement point.
  useEffect(() => {
    if (status !== 'ready') return;
    let timeoutMinutes = DEFAULT_SETTINGS.idleTimeoutMinutes ?? 10080;
    let stopped = false;

    const expireIfIdle = (): boolean => {
      const last = Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
      if (last && Date.now() - last > timeoutMinutes * 60_000) {
        stopped = true;
        void signOut();
        return true;
      }
      return false;
    };

    void getDoc(doc(db, 'settings', 'global'))
      .then((snap) => {
        const configured = (snap.data() as GlobalSettingsDoc | undefined)?.idleTimeoutMinutes;
        if (typeof configured === 'number' && configured > 0) timeoutMinutes = configured;
      })
      .catch(() => {})
      .finally(() => {
        // Returning after a long absence signs out immediately; otherwise start fresh.
        if (!expireIfIdle()) localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      });

    let lastMark = 0;
    const markActive = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastMark < 60_000) return; // 1 write/min is plenty
      lastMark = now;
      localStorage.setItem(LAST_ACTIVE_KEY, String(now));
    };
    const interval = setInterval(expireIfIdle, 5 * 60_000);
    window.addEventListener('pointerdown', markActive, { passive: true });
    window.addEventListener('keydown', markActive, { passive: true });
    return () => {
      clearInterval(interval);
      window.removeEventListener('pointerdown', markActive);
      window.removeEventListener('keydown', markActive);
    };
  }, [status, signOut]);

  const value = useMemo<Session>(
    () => ({
      status,
      uid: fbUser?.uid ?? null,
      email: fbUser?.email?.toLowerCase() ?? null,
      displayName: fbUser?.displayName ?? null,
      photoUrl: fbUser?.photoURL ?? null,
      user: userDoc,
      error,
      signInGoogle,
      signOut,
    }),
    [status, fbUser, userDoc, error, signInGoogle, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside AuthProvider');
  return ctx;
}

/** Session guaranteed ready — for components inside RequireAuth. */
export function useUser(): { uid: string; user: UserDoc } {
  const s = useSession();
  if (s.status !== 'ready' || !s.uid || !s.user) throw new Error('useUser before session ready');
  return { uid: s.uid, user: s.user };
}
