import { useEffect, useRef, useState } from 'react';
import { CloudOff, Wifi } from 'lucide-react';

type NetState = 'online' | 'offline' | 'restored';

/**
 * Always-honest connectivity strip for unreliable networks. While offline the app
 * keeps working from the local cache (Firestore persistence) — this tells the user
 * exactly that, instead of silently showing stale data.
 */
export function ConnectionBanner() {
  const [state, setState] = useState<NetState>(navigator.onLine ? 'online' : 'offline');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const goOffline = () => {
      if (timer.current) clearTimeout(timer.current);
      setState('offline');
    };
    const goOnline = () => {
      setState('restored');
      timer.current = setTimeout(() => setState('online'), 4000);
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (state === 'online') return null;
  if (state === 'offline') {
    return (
      <div className="flex items-center justify-center gap-2 bg-warning/15 px-3 py-1.5 text-[12px] font-medium text-warning">
        <CloudOff className="size-3.5" />
        😴 No internet — showing saved data. Changes and syncs resume automatically when you’re back.
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-2 bg-success/12 px-3 py-1.5 text-[12px] font-medium text-success">
      <Wifi className="size-3.5" />
      🎉 Back online — everything is syncing again!
    </div>
  );
}
