/**
 * Seeds the Firestore EMULATOR with first-run data:
 *  - allowlist entries (admin role) for the configured emails
 *  - global settings doc
 * Uses the emulator REST API with the owner bypass token — no admin SDK needed.
 * Run while emulators are up:  pnpm seed
 */
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = process.env.SEED_PROJECT ?? 'demo-asm';
const ADMIN_EMAILS = (process.env.SEED_ADMIN_EMAILS ?? 'junaidkamoka@aol.com,junaidatdzine@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const base = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { mapValue: { fields: Record<string, Value> } };

const s = (v: string): Value => ({ stringValue: v });
const i = (v: number): Value => ({ integerValue: String(v) });
const b = (v: boolean): Value => ({ booleanValue: v });
const ts = (d = new Date()): Value => ({ timestampValue: d.toISOString() });
const m = (fields: Record<string, Value>): Value => ({ mapValue: { fields } });

async function put(path: string, fields: Record<string, Value>) {
  const res = await fetch(`${base}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  console.log(`✓ ${path}`);
}

for (const email of ADMIN_EMAILS) {
  await put(`allowlist/${encodeURIComponent(email)}`, {
    role: s('admin'),
    grants: m({}),
    ai: m({
      features: m({ translate: b(true), generate: b(true) }),
      monthlyCredits: i(500),
    }),
    addedBy: s('seed'),
    addedAt: ts(),
  });
}

await put('settings/global', {
  aiModel: s('gemini-2.5-flash-lite'),
  idleTimeoutMinutes: { nullValue: null },
});

console.log(`Seeded ${ADMIN_EMAILS.length} admin allowlist entries on ${PROJECT} @ ${HOST}`);
