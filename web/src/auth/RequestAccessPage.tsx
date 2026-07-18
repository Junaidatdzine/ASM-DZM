import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { Clock, LogOut } from 'lucide-react';
import { useSession } from './AuthProvider';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { AppMark } from '@/components/AppMark';
import { callableMessage } from '@/lib/callables';

export function RequestAccessPage() {
  const { status, uid, email, displayName, photoUrl, signOut } = useSession();
  const [note, setNote] = useState('');
  const [requested, setRequested] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uid || status !== 'unprovisioned') return;
    const unsub = onSnapshot(doc(db, 'accessRequests', uid), (snap) => setRequested(snap.exists()));
    return unsub;
  }, [uid, status]);

  if (status === 'ready') return <Navigate to="/" replace />;
  if (status === 'signedOut' || status === 'disabled') return <Navigate to="/login" replace />;

  if (status === 'domainBlocked') {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-card">
          <AppMark className="mb-6" />
          <h1 className="text-[15px] font-semibold">Domain not allowed</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">{email}</span> isn’t on an email domain this
            workspace permits. Ask an admin to invite you directly or add your domain.
          </p>
          <button
            className="mt-6 flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void signOut()}
          >
            <LogOut className="size-3" /> Sign in with a different account
          </button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!uid || !email) return;
    setSubmitting(true);
    setError(null);
    try {
      await setDoc(doc(db, 'accessRequests', uid), {
        email,
        name: displayName ?? email.split('@')[0],
        photoUrl: photoUrl ?? null,
        ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      setError(callableMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-card">
        <AppMark className="mb-6" />
        {requested ? (
          <>
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <Clock className="size-4 text-warning" /> Request pending
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Your request as <span className="font-medium text-foreground">{email}</span> is waiting
              for an admin. This page updates automatically once you’re approved.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-[15px] font-semibold">No access yet</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">{email}</span> hasn’t been granted
              access. Ask an admin to add you, or send a request.
            </p>
            <Textarea
              className="mt-4"
              rows={2}
              placeholder="Optional note for the admin…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
            <Button
              className="mt-3 w-full"
              onClick={() => void submit()}
              loading={submitting}
              disabled={requested === null}
            >
              Request access
            </Button>
          </>
        )}
        <button
          className="mt-6 flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void signOut()}
        >
          <LogOut className="size-3" /> Sign in with a different account
        </button>
      </div>
    </div>
  );
}
