import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { defineSecret } from 'firebase-functions/params';
import type { ZodType } from 'zod';

type SecretParam = ReturnType<typeof defineSecret>;
import { ZodError } from 'zod';
import { AppError, notSignedIn } from './errors';
import { requireActiveUser, type Actor } from './authz';
import { writeAudit, type AuditEntry } from './audit';
import { ASC_MASTER_KEY } from '../config';

export interface CallableOpts<I, O> {
  input?: ZodType<I>;
  /** Skip the users/{uid} active check (only authBootstrap uses this). */
  allowUnprovisioned?: boolean;
  /** Attach the ASC master key secret (any function that talks to App Store Connect). */
  usesAscKey?: boolean;
  /** Additional secret bindings (e.g. RESEND_API_KEY for email senders). */
  secrets?: SecretParam[];
  timeoutSeconds?: number;
  memory?: '256MiB' | '512MiB' | '1GiB';
  authorize?: (actor: Actor, input: I) => void | Promise<void>;
  /** Build an audit entry after a successful call; return null to skip. */
  audit?: (input: I, output: O, actor: Actor) => AuditEntry | null;
}

/**
 * Composition every callable goes through:
 * auth → active-user check → zod parse → authorize → handler → audit → error mapping.
 * Never leaks internals: unknown errors become a generic message (details go to logs).
 */
export function defineCallable<I, O>(
  name: string,
  opts: CallableOpts<I, O>,
  handler: (input: I, actor: Actor, req: CallableRequest) => Promise<O>,
) {
  const boundSecrets = [
    ...(opts.usesAscKey ? [ASC_MASTER_KEY] : []),
    ...(opts.secrets ?? []),
  ];
  return onCall(
    {
      timeoutSeconds: opts.timeoutSeconds ?? 60,
      memory: opts.memory ?? '256MiB',
      ...(boundSecrets.length > 0 ? { secrets: boundSecrets } : {}),
    },
    async (req) => {
      try {
        if (!req.auth) throw notSignedIn();
        const actor: Actor = opts.allowUnprovisioned
          ? ({
              uid: req.auth.uid,
              email: (req.auth.token.email ?? '').toLowerCase(),
              user: null,
            } as unknown as Actor)
          : await requireActiveUser(req.auth.uid, (req.auth.token.email ?? '').toLowerCase());

        let input = req.data as I;
        if (opts.input) input = opts.input.parse(req.data);
        if (opts.authorize) await opts.authorize(actor, input);

        const output = await handler(input, actor, req);

        if (opts.audit) {
          const entry = opts.audit(input, output, actor);
          if (entry) await writeAudit({ uid: actor.uid, email: actor.email }, entry);
        }
        return output as object | null;
      } catch (err) {
        logCallableFailure(name, err, req);
        throw mapError(err, name);
      }
    },
  );
}

/**
 * Emit one structured Cloud Logging record for every failed callable. Only safe
 * routing identifiers are included; request bodies can contain App Store keys,
 * private key material, user content, or other secrets and are never logged.
 */
function logCallableFailure(fnName: string, err: unknown, req: CallableRequest): void {
  const data = req.data && typeof req.data === 'object' ? req.data as Record<string, unknown> : {};
  const code = err instanceof AppError
    ? err.code
    : err instanceof HttpsError
      ? err.code
      : err instanceof ZodError
        ? 'invalid-argument'
        : 'internal';
  const message = err instanceof Error ? err.message : 'Unknown error';
  const record = {
    event: 'callable.failure',
    function: fnName,
    severity: code === 'internal' ? 'ERROR' : 'WARNING',
    code,
    message,
    uid: req.auth?.uid ?? null,
    storeId: typeof data.storeId === 'string' ? data.storeId : null,
    appId: typeof data.appId === 'string' ? data.appId : null,
    locale: typeof data.locale === 'string' ? data.locale : null,
    localeCount: Array.isArray(data.locales) ? data.locales.length : null,
    issue: err instanceof ZodError
      ? err.issues[0]?.path.join('.') || 'input'
      : null,
    ...(code === 'internal' && err instanceof Error ? { stack: err.stack } : {}),
  };
  if (code === 'internal') console.error(JSON.stringify(record));
  else console.warn(JSON.stringify(record));
}

function mapError(err: unknown, fnName: string): HttpsError {
  if (err instanceof AppError) return err.toHttpsError();
  if (err instanceof HttpsError) return err;
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return new HttpsError(
      'invalid-argument',
      first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.',
    );
  }
  return new HttpsError('internal', 'Something went wrong. Try again, or check the logs.');
}
