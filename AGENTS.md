# AppStore Manager production-fix workflow

These instructions apply to future agents working in this repository.

## Firebase-first diagnosis

When the user reports that a production action failed, crashed, returned a generic error, or asks to “fix everything,” inspect Firebase production logs before guessing at a code change.

1. Identify the callable/function from the UI action and the approximate failure time.
2. Read its recent logs first:

   ```sh
   FIREBASE_CLI_DISABLE_UPDATE_CHECK=true firebase functions:log --only FUNCTION_NAME --project appstoremanager-701cd --lines 50
   ```

3. If the failing function is unclear, inspect recent project-wide function errors, then narrow to the responsible callable. Do not dump excessive unrelated logs.
4. Correlate the deployed revision, callable verification, timestamp, and complete server exception with the UI error.
5. Never expose Firebase tokens, ASC keys, user content, or other secrets in commentary, commits, fixtures, or reports. Summarize sensitive log context.

## Fix and verification

- Check the UI payload and server Zod schema together so role/locale/field limits stay aligned.
- Check shared types, Firestore writes, callable authorization, and client wrappers for the same contract.
- For Firestore errors, verify delete/server-timestamp sentinels are only used in supported top-level or dotted update paths.
- Run `pnpm typecheck` and `pnpm build` after changes.
- The current `pnpm test` command reports no test files; do not describe that as a passing test suite. Add focused tests when a pure regression seam exists.
- Deploy the in-scope functions and hosting to `appstoremanager-701cd`, confirm the deploy completed, then re-read the affected function logs after the user retries or after an automated request can safely reproduce it.
- Verify both `https://asm.dzinemedia.com/` and Firebase Hosting return the same successful release response.
- Use the signed-in browser for interaction checks when available. If no browser session is available, state that limitation and rely on build, deployment, HTTP, schema, and runtime-log evidence without claiming click-through verification.

## Persistence

Do not stop at a generic client toast. Fix the underlying production exception, deploy it, and check for the same error on the active revision. Preserve unrelated user changes in the worktree.
