import type { AuditChange, Platform } from '@asm/shared';
import { Timestamp, refs } from './firestore';

const AUDIT_TTL_DAYS = 180;
const VALUE_TRUNCATE = 600;

export interface AuditEntry {
  action: string;
  storeId?: string;
  appId?: string;
  locale?: string;
  platform?: Platform;
  changes?: AuditChange[];
  result?: 'ok' | 'error' | 'partial';
  error?: string;
  detail?: string;
}

const trunc = (v: string | null) =>
  v && v.length > VALUE_TRUNCATE ? `${v.slice(0, VALUE_TRUNCATE)}…` : v;

export async function writeAudit(
  actor: { uid: string; email: string },
  entry: AuditEntry,
): Promise<void> {
  const expireAt = Timestamp.fromMillis(Date.now() + AUDIT_TTL_DAYS * 24 * 3600 * 1000);
  try {
    await refs.auditLogs().add({
      at: Timestamp.now(),
      actor,
      action: entry.action,
      ...(entry.storeId ? { storeId: entry.storeId } : {}),
      ...(entry.appId ? { appId: entry.appId } : {}),
      ...(entry.locale ? { locale: entry.locale } : {}),
      ...(entry.platform ? { platform: entry.platform } : {}),
      ...(entry.changes
        ? { changes: entry.changes.map((c) => ({ ...c, from: trunc(c.from), to: trunc(c.to) })) }
        : {}),
      result: entry.result ?? 'ok',
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      expireAt,
    });
  } catch (err) {
    // Audit failures must never fail the user action; they do get logged loudly.
    console.error('audit write failed', entry.action, err);
  }
}
