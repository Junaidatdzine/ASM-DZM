import { defineSecret, defineString } from 'firebase-functions/params';

/** Master key (hex, 32 bytes) for AES-256-GCM encryption of stored .p8 keys. */
export const ASC_MASTER_KEY = defineSecret('ASC_MASTER_KEY');

/** Resend API key for outbound email (daily finance reports). */
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/** Comma-separated emails auto-provisioned as admin on first sign-in. */
export const ADMIN_EMAILS = defineString('ADMIN_EMAILS', { default: '' });

export const REGION = 'us-central1';

/** Fixture-backed ASC client for offline/emulator development. */
export function mockAscEnabled(): boolean {
  return process.env.MOCK_ASC === '1' || process.env.FUNCTIONS_EMULATOR === 'true';
}

export function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}
