# Run Phase 1.4 to green (local)

Phase 1.4 test code is written, wired, and typecheck-green. It is **not officially complete until both
suites run green once on a real machine.** Run locally (or hand the prompt at the bottom to Codex / Claude Code).

## Commands

```bash
cd /Users/jc/Documents/Confidel
corepack enable
pnpm install
pnpm run test:e2e:install      # download Chromium for Playwright
pnpm run test:e2e             # logged-out guards must pass; role routing runs if E2E_* are set
```

Then in **Terminal A**:

```bash
cd /Users/jc/Documents/Confidel
pnpm run dev
```

In **Terminal B**:

```bash
cd /Users/jc/Documents/Confidel
export API_TEST_RUN_ID=phase14-$(date +%s)
pnpm run test:api:signup       # creates the throwaway test users (once per run id)
pnpm run test:api              # seeds the company + runs API/RLS assertions
```

If `pnpm` isn't available, use the npm equivalents (`npm install`, `npm run test:e2e:install`,
`npm run test:e2e`, `npm run dev`, `npm run test:api:signup`, `npm run test:api`). Use the **same**
`API_TEST_RUN_ID` for signup and test.

## Likely first snag

If Supabase rejects the test logins, email confirmation is on for the project. Turn off "Confirm email"
for the **dev/staging** project, or manually confirm the test users in the Supabase dashboard, then rerun
`test:api`. (Never run this against production.)

## Hand this to Codex / Claude Code

> Phase 1.4 test code is written. Now run it locally until green.
>
> Run:
> - `pnpm install`
> - `pnpm run test:e2e:install`
> - `pnpm run test:e2e`
> - `pnpm run dev`
> - `API_TEST_RUN_ID=phase14-[timestamp] pnpm run test:api:signup`
> - `API_TEST_RUN_ID=phase14-[same timestamp] pnpm run test:api`
>
> If pnpm is unavailable, use npm equivalents.
>
> If anything fails: show the exact failing test, fix the smallest correct thing, rerun only the failed
> suite, continue until both e2e and API/RLS tests pass.
>
> Do not change database schema. Do not change migrations. Do not weaken RLS or employee boundaries.
>
> At the end report: e2e pass/fail, API/RLS pass/fail, bugs fixed, whether Phase 1.4 is complete.

## Definition of done

Phase 1.4 is complete when, in one local run: `test:e2e` passes (logged-out guards green) **and**
`test:api` ends with `API integration tests completed: PASS`. Only then move on to encryption/storage.
