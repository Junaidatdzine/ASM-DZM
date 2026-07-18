# App Store Connect API Coverage

Last audited: 2026-07-18 (evening — waves 2–5). Status reflects this repository, not features available only in App Store Connect's web UI.

Legend: **Implemented** = read + write in this app · **Read-only** = live snapshot surfaced in the Store tab (editing stays in ASC) · **Pending** = not yet integrated.

## App workspace

| Area | Apple resource | Status | Priority / next work |
|---|---|---:|---|
| Apps, bundle ID, SKU, primary locale | `apps` | Implemented | Keep synced |
| App name, subtitle, privacy policy/choices URL | `appInfoLocalizations` | Implemented | All four are first-class localized fields with drafts, matrix view, conflicts, and push |
| tvOS privacy policy text | `appInfoLocalizations` | Pending | Add only for tvOS |
| Description, keywords, promotional text, What's New, support/marketing URL | `appStoreVersionLocalizations` | Implemented | Existing Metadata section |
| Copyright, release type/date | `appStoreVersions` | Implemented | Version tab: copyright, release type (manual/after-approval/scheduled) and scheduled date |
| Review type | `appStoreVersions/reviewType` | Pending | Mac notarization only — add when a macOS store needs it |
| Build selection | `appStoreVersions/build` | Implemented | Version tab: pick from processed builds matching the version string; attach/detach |
| App Review contact, demo account, notes | `appStoreReviewDetails` | Implemented | Release tab; password masked for non-managers, values never audited/logged |
| App Review attachments | `appStoreReviewAttachments` | Implemented | Release tab: staged upload via Storage → reserve/upload/commit; delete |
| Screenshots and screenshot sets | `appScreenshotSets`, `appScreenshots` | Implemented | Device-first matrix: horizontal scroll, inline upload/drop, reorder, delete, preview, live progress |
| App previews | `appPreviewSets`, `appPreviews` | Read-only | Store tab lists preview sets + video counts for the primary locale; upload still in ASC |
| Version submission / review submission | `reviewSubmissions`, `reviewSubmissionItems` | Implemented | Release tab: checklist → submit; item states, rejected banner, resubmit after rejection, withdraw; deep link to Apple's message thread (Resolution Center text is not in the public API) |
| Phased release | `appStoreVersionPhasedReleases` | Implemented | Release tab: enable/pause/resume/release-to-everyone/off with day + % progress |
| Routing coverage | `routingAppCoverages` | Pending | Add only for navigation apps |
| Age rating declarations | `ageRatingDeclarations` | Implemented | Release tab: full questionnaire (12 graduated + gambling/web access + kids band) |
| Accessibility declarations | `accessibilityDeclarations` | Pending | API still stabilizing — revisit |
| App tags / search keywords | `appTags`, `searchKeywords` | Pending | Add Discoverability section |
| Custom product pages | `appCustomProductPages` | Read-only | Store tab: name + visibility |
| Product page optimization experiments | `appStoreVersionExperimentsV2` | Read-only | Store tab: name, state, traffic split |
| In-app events | `appEvents` | Read-only | Store tab: name + state |
| App availability and territories | `appAvailabilityV2` | Read-only | Store tab: territory count + new-territory setting; deep link to the ASC territory editor |
| App price schedule / price points | `appPriceSchedules`, `appPricePoints` | Implemented | Store tab: pick a US price tier (shows your proceeds) → replaces the schedule; all territories derive from the base |
| Custom EULA | `endUserLicenseAgreement` | Read-only | Store tab: standard vs custom (+length) |
| Content rights / made for kids / server notification URLs | `apps` attributes | Pending | Add App Settings section |

## Commerce and operations

| Area | Status | Notes |
|---|---:|---|
| Daily sales reports and USD normalization | Implemented | Public API reports are daily; live rolling hourly Trends are not exposed by this endpoint |
| Analytics report requests | Pending | Use for supported downloadable analytics reports, not the private Trends UI |
| In-app purchases (list, type, state) | Read-only | Store tab; full IAP editing (localizations/prices/availability) remains a large independent module |
| Subscription groups + subscriptions | Implemented (create + submit) | Store tab: create groups, create subscriptions (product ID, period, shopper-facing localization), submit for review; offers/price tiers still edited in ASC |
| Customer reviews and responses | Implemented | Reviews tab: list with ratings/territory, respond, edit + delete response (editor+) |
| TestFlight beta groups, testers + recent builds | Implemented | Store tab: expand a group → list testers, invite by email, remove from group (`betaTesters`) |
| Crash/feedback submissions and performance metrics | Pending | Add Diagnostics module; redact user data |
| Game Center | Pending | Add only when required |
| App Clips | Pending | Add only when present |
| Encryption declarations | Read-only | Store tab: latest declarations + state |
| Webhooks | Pending | Add event-driven sync after core metadata sections |
| Bundle IDs (register App IDs) | Implemented | Developer dialog per store: list/register/delete `bundleIds`; gated by the explicit `manageProvisioning` grant. Creating the app record itself has NO public API — ASC deep link provided |
| Certificates, profiles, devices | Pending | Provisioning reads possible via same key; add if certificate hygiene becomes a need |
| Promoted purchases / win-back offers / offer codes | Pending | Subscription marketing extras — after core offer editing |
| Sales finance reports (monthly financial) | Pending | Daily sales implemented; monthly `financeReports` add little for this dashboard |

## Access control

| Area | Status | Notes |
|---|---:|---|
| Store role presets | Implemented | Viewer, translator, editor, developer (release engineering), manager, and workspace admin |
| Specific-app allowlists | Implemented | A grant can cover every app or only selected apps in a store |
| Granular store permissions | Implemented | Admin can override view, drafts, AI, push, screenshots, languages, versions, store-list sync, finance, and team management; Select all/Clear all/defaults supported |
| Finance delegation | Implemented | `viewFinance` grant (default off for every role) unlocks the store Finance page, financeSync, and financeDays reads |
| Delegated team management | Implemented | `manageMembers` grant (default off): holders invite/edit users for their stores but can only pass on a subset of their own role/permissions/AI credits (server-enforced attenuation, chainable) |
| Server enforcement | Implemented | Shared resolver + `delegationViolations` used by Cloud Functions; draft editing and finance reads also enforced by Firestore rules |
| Session expiry | Implemented | Sessions end after 7 days of inactivity by default (workspace-configurable), including time away with the browser closed |
| Admin-only workspace controls | Implemented | Global user administration, API keys, workspace settings, analytics, and audit access remain admin-only |
| Per-app proceeds attribution | Implemented | Sales-report IAP/subscription rows attribute to the parent app via "Parent Identifier" → app SKU (schema v4; fixed the all-$0 Top apps bug) |

## Implementation order

1. ~~Version Information: copyright, release configuration and build.~~ **Done** — `versionInfoUpdate` + `buildsList`, Version tab, deep-sync caches release config + attached build. Review type (Mac notarization) deferred.
2. ~~App Review: contact details, credentials, notes and attachments.~~ **Done** — `reviewDetailSave` + attachment upload/delete on the Release tab.
3. ~~Compliance: age rating + encryption (read).~~ **Done** — `ageRatingSave` questionnaire; encryption shown read-only. Content rights + accessibility still pending.
4. ~~Review submission and phased release.~~ **Done** — `reviewSubmit`/`reviewSubmissionCancel`, `phasedReleaseSet` on the Release tab.
5. ~~Customer reviews.~~ **Done** — Reviews tab with responses.
6. ~~Commerce/distribution visibility.~~ **Done (read-only)** — availability, pricing, IAP, subscriptions, EULA, product pages, experiments, events, previews, TestFlight, encryption in the Store tab via one aggregated `appExtrasGet` call.
7. ~~Subscriptions create/submit, TestFlight testers, price editing, bundle IDs.~~ **Done** — `subscriptionGroupCreate`/`subscriptionCreate`/`subscriptionSubmit`, `testflightTesters*`, `priceScheduleSet`/`pricePointsList`, `bundleId*` with the `manageProvisioning`/`manageIap`/`manageTestFlight`/`manageSubmissions` grants and the developer role.
8. Remaining write-side modules, in order: full IAP editing (price tiers/offers) → preview uploads → territory availability editing → diagnostics (redacted) → webhooks → analytics report requests → discoverability (tags/search keywords) → content rights & accessibility.

Every mutation must use server-side authorization, audit logging, App Store state/editability checks, optimistic conflict handling, and background progress. Sensitive review credentials must never be written to audit details or normal client-readable documents.
