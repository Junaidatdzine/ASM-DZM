import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, callableMessage } from '@/lib/callables';
import { AppMark } from '@/components/AppMark';
import { Spinner } from '@/components/ui/Skeleton';

/**
 * Google OAuth redirect target for the AdMob connection. Reads the auth code,
 * pairs it with the client credentials stashed by the connect dialog, and
 * finishes the exchange server-side.
 */
export function OauthAdmobPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const code = params.get('code');
    const state = params.get('state');
    const denied = params.get('error');
    const stashed = sessionStorage.getItem('admob-oauth');

    if (denied) {
      setError(`Google authorization was cancelled (${denied}).`);
      return;
    }
    if (!code || !stashed) {
      setError('Missing authorization data — start the AdMob connection again from Ads & Spend.');
      return;
    }
    const { label, clientId, clientSecret, state: expectedState, redirectUri } = JSON.parse(stashed) as {
      label?: string;
      // Absent when the workspace OAuth client is already saved server-side.
      clientId?: string;
      clientSecret?: string;
      state: string;
      redirectUri: string;
    };
    if (state !== expectedState) {
      setError('Authorization state mismatch — start the connection again.');
      return;
    }

    void api
      .admobConnect({ label: label || 'AdMob', clientId, clientSecret, code, redirectUri })
      .then((res) => {
        sessionStorage.removeItem('admob-oauth');
        toast.success('AdMob connected', { description: `${res.publisherId} · reporting in ${res.currencyCode}` });
        navigate('/admin/ads', { replace: true });
      })
      .catch((err) => {
        sessionStorage.removeItem('admob-oauth');
        setError(callableMessage(err));
      });
  }, [params, navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <AppMark hero />
      {error ? (
        <>
          <p className="max-w-md text-[13px] text-destructive">{error}</p>
          <Link to="/admin/ads" className="text-[13px] text-primary hover:underline">
            Back to Ads &amp; Spend
          </Link>
        </>
      ) : (
        <>
          <Spinner />
          <p className="text-[13px] text-muted-foreground">Finishing the AdMob connection…</p>
        </>
      )}
    </div>
  );
}
