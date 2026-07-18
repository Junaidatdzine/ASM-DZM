# Production incident runbook

All Firebase callables pass through `functions/src/lib/wrap.ts`. Every failed call emits a structured `callable.failure` Cloud Logging record containing the function, safe user/store/app routing identifiers, error code, and message. Request bodies and App Store credentials are never logged.

## Standard investigation

1. Pull recent logs:

   ```sh
   FIREBASE_CLI_DISABLE_UPDATE_CHECK=true firebase functions:log --project appstoremanager-701cd --lines 200
   ```

2. Narrow to the affected callable:

   ```sh
   FIREBASE_CLI_DISABLE_UPDATE_CHECK=true firebase functions:log --only FUNCTION_NAME --project appstoremanager-701cd --lines 100
   ```

3. Search for `callable.failure`, the user-visible message, the store ID, or the app ID.
4. Reproduce with a non-destructive read or validation request when possible. Never push, delete, or overwrite production App Store data merely to reproduce an incident.
5. Fix the shared contract first when the failure is caused by transport normalization, permissions, or common middleware.
6. Run `pnpm typecheck`, `pnpm build`, and `git diff --check` before deployment.
7. Deploy only affected callables plus hosting when the client contract changed.
8. Pull the focused logs again and confirm there are no new `ERROR` records.

## Error handling rules

- Validation and expected business errors are logged as `WARNING`.
- Unexpected exceptions are logged as `ERROR` with a stack trace.
- App Store API errors stay attached to the affected language or operation so partial successes are retained.
- Long-running work must update an operation record with live progress and finish as `success`, `partial`, or `error`.
- Never log private keys, authorization headers, AI prompts, metadata content, or complete callable payloads.
