# AppStore Manager

A premium web app for managing App Store localizations across **multiple App Store Connect accounts** in one place: metadata editing with a staged **draft → review → push** workflow, **screenshot management**, **AI auto-translation** (Gemini) under per-user quotas, and **granular team permissions** — built entirely on Firebase with Google-only sign-in.

**Live project:** `appstoremanager-701cd` · Region: Firestore `nam5`, Functions/Vertex `us-central1`

---

## Architecture

```
Browser (Vite + React + Tailwind SPA)
  │ Google sign-in ─ Firebase Auth (Google provider only, invite-only access)
  │ realtime listeners + IndexedDB persistence (instant loads, live updates)
  │ direct writes ONLY: drafts, own prefs, own access request  ← enforced by rules
  ▼
Firestore  (ASC cache · users/grants · drafts · operations · audit)
  ▲ cache patched from ASC responses (no refetching)
  │
Cloud Functions v2 (all mutations & all Apple traffic)
  ├── ES256 JWT → App Store Connect API   (keys AES-256-GCM encrypted, AAD=storeId)
  └── ADC → Vertex AI (Gemini)            (translations & suggestions → drafts)
Screenshots: browser → Storage staging/{uid}/ → function streams to Apple → cleanup
```

Key invariants:

- **.p8 keys never reach the browser** after entry; stored encrypted (master key in Secret Manager).
- **Everything that mutates Apple or privileged state goes through callables** with a single middleware: auth → active check → zod → permission resolver (shared with the UI) → handler → audit → friendly error mapping.
- **Drafts are 3-way merged**: `base` snapshot on first touch, sync never clobbers drafts, conflicts resolve in-editor (keep mine / take theirs), push clears only fields still equal to what was pushed.
- **Membership is denormalized** (`stores.roles`, `stores.memberUids`) so Firestore list queries are provable in rules; permission changes apply immediately (no token claims).

## Repo layout

| Path | What |
|---|---|
| `web/` | SPA (Vite, React 19, Tailwind v4, Radix, dnd-kit) |
| `functions/` | Cloud Functions v2 (TypeScript, esbuild-bundled) |
| `shared/` | Pure-TS domain package used by both: types, locales, field limits, permission resolver, editability rules, screenshot specs |
| `firestore.rules` / `storage.rules` / `firestore.indexes.json` | Security & indexes (deployed) |
| `scripts/` | Emulator wrapper + seed |

## Local development

```sh
pnpm install
pnpm dev            # emulators (demo-asm) + functions watch + Vite on :5173
pnpm seed           # seeds admin allowlist + settings into the emulator (run once, emulators up)
```

- Emulator mode is fully offline: the login page shows a **dev identity email** field (fake Google accounts), and stores can be created as **mock stores** with two realistic sample apps — every feature works without Apple or Google.
- AI in the emulator uses a deterministic pseudo-translator (`[locale] …`) so flows, limits and quotas are testable offline.
- Admin bootstrap: emails in `functions/.env` → `ADMIN_EMAILS` become admins on first sign-in (also seeded into the emulator allowlist).

## Production operations

Everything below is already provisioned on `appstoremanager-701cd` (done via CLI/REST):
web app registration → `web/.env.local`, Firestore (nam5), Storage bucket + `staging/` 1-day lifecycle purge, required APIs (incl. `aiplatform`), `ASC_MASTER_KEY` secret, security rules + composite indexes, Firestore TTL on `auditLogs.expireAt` (180 d) and `operations.expireAt` (7 d).

```sh
pnpm deploy                          # functions + hosting + rules + indexes
firebase deploy --only hosting       # frontend only
firebase functions:secrets:set ASC_MASTER_KEY   # rotate the encryption master key (re-enter store keys after!)
```

**One-time console step (Google gates this behind their UI):** Authentication → Sign-in method → **Google** → Enable (pick a support email) → Save. There is no public API for provisioning the Google OAuth client — every automation path (Terraform included) requires this single toggle once. Everything else is code/CLI.

After enabling: add your production domain under Authentication → Settings → Authorized domains (the `*.web.app` domain is pre-authorized).

## Using the app

1. **Sign in with Google** — access is invite-only: admins invite by email (Users & Access), or approve requests that appear after an uninvited sign-in.
2. **Connect a store** (admin): Stores → Add store → paste Issuer ID, Key ID and the `.p8` from App Store Connect → Users and Access → Integrations. The key is verified live, then encrypted.
3. **Open an app** — the app list and the app's localizations sync automatically when stale (12 h / 30 min) or via **Sync**.
4. **Edit metadata** — everything autosaves as team-shared drafts with per-field attribution; locked fields explain why (Apple's version states); promotional text stays editable on live versions.
5. **AI** — translate missing languages in bulk or generate keywords/subtitles/release notes. Results land as reviewable drafts, never directly on Apple. Admins assign AI features + monthly credits per user.
6. **Review & Push** — a diff of every pending change per language; push applies to App Store Connect, partial failures keep their drafts.
7. **Screenshots** — per language and device size: upload (validated against Apple's exact pixel sizes), drag-reorder, delete. Only ever touches draft versions.
8. **Languages** — add in bulk (content seeded from any language), remove with typed confirmation.
9. **Audit** — every change with before/after values, 180-day retention.

### Permissions

| Capability | viewer | editor | manager | admin |
|---|---|---|---|---|
| View store content | ✓ | ✓ | ✓ | ✓ |
| Edit drafts, push, add languages, screenshots, AI (if granted) | | ✓ | ✓ | ✓ |
| Remove languages, create versions | | | ✓ | ✓ |
| Stores/keys, users, AI quotas, audit, settings | | | | ✓ |

Members are granted per store (optionally narrowed per app). Disabling a user signs them out immediately; attached listeners drain within ≤1 h (shown in the admin UI).

## Security notes

- Client Firestore writes are limited by rules to: validated draft docs, own `userPrefs`, own access request. All else is Admin-SDK-only.
- `storeSecrets/*` is unreadable/unwritable from clients; ciphertext is bound to its store via AES-GCM AAD.
- Staging uploads: own path only, ≤12 MB, PNG/JPEG, active users; auto-purged after 1 day.
- Optional further hardening (not enabled): Firebase App Check, `beforeUserSignedIn` blocking function (needs the free Identity Platform upgrade).

## Cost

Firebase Blaze pay-as-you-go: near-zero at team scale (Firestore reads are cache-first, ASC calls are budget-aware — background syncs yield when the hourly Apple quota drops below 500). Gemini calls are billed per token on Vertex AI; credits let admins cap each user's spend.
