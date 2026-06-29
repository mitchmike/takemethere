# TakeMeThere — Claude Code Project Config

## Project overview

Melbourne metro train app. Web-first, then Android/iOS. Uses PTV GTFS static + GTFS-RT feeds for live train positions and journey planning.

## Permissions

All file edits and writes are pre-approved for this repo. No need to confirm before editing or creating files within this project.

## Developer context

- Michael is a software engineer — assume solid technical background
- Prefer terse, direct responses; no hand-holding on standard concepts
- Long planning and programming tasks can be run independently without frequent check-ins

## Notifications

- Send a push notification (PushNotification tool) when a task is complete. The user has Remote Control enabled and push notifications turned on in /config.

# Development Governance

## AI Persona & Workflow Constraints
* CRITICAL: You must always operate in **Plan Mode** before writing code.
* NEVER implement code on the first turn. Iterate on the plan first.

## The 4-Step Engineering Protocol
1. **Plan Mode:** Propose a written plan. Explain *what* will change and *why*.
2. **Refine Plan:** Wait for user feedback or a subagent audit. Adjust the plan.
3. **Write Tests First (TDD):** Implement or update the tests *before* touching application logic. Run tests to see them fail.
4. **Implementation:** Write the minimal application code to make the tests pass.

## Testing Rules
- Every new function or module must have unit tests — no exceptions
- When modifying existing code, update or extend tests to cover the change; don't leave tests behind
- Tests live in a `test/` folder within each package, mirroring the `src/` structure (e.g. `test/simulator/engine.test.ts` for `src/simulator/engine.ts`)
- Every commit must include tests for the code it changes — no code commit without a corresponding test change
* CRITICAL: Never claim a test passes unless you explicitly run the test command and output the raw terminal results. Do not hallucinate test successes.
* Always print the raw terminal stdout summary (e.g., "OK (3 tests, 4 assertions)").

### Test types

| Type | Command | What it covers |
|---|---|---|
| Unit | `pnpm --filter <pkg> test` | Pure logic, no I/O |
| Integration | `pnpm --filter @takemethere/backend test:integration` | Routes hitting real Postgres/Redis |
| Simulator accuracy | included in `test:integration` | `test/simulator/engine.test.ts` — runs `simulateTrip` against all `data/sim-captures/*.jsonl` sessions and asserts `mae < 0.06` and `accuracyPct >= 50`. Skips automatically if no captures exist. |
| E2E | `cd packages/frontend && npx playwright test --headless` | Full browser flows via Playwright |

**PostToolUse hook** (`.claude/settings.json`): the matching package's unit tests run automatically after every file edit. Failures are surfaced inline.

**Pre-commit hook** (`.git/hooks/pre-commit`): all package unit tests must pass before a commit is accepted. E2E excluded from pre-commit.

### Integration testing
Set up integration tests against real or recorded feed snapshots for each new pipeline stage. Record GTFS-RT payloads as fixtures in `test/fixtures/` so tests are deterministic. See `test/fixtures/trip-updates.pb` and `vehicle-positions.pb` for existing examples.

## E2E Testing Protocol
* DO NOT interact with the browser directly in the main chat context.
* Write Playwright tests in `packages/frontend/e2e/` (existing: `map-smoke.spec.ts`, `interactions.spec.ts`).
* Execute: `cd packages/frontend && npx playwright test --headless`
* For ad-hoc verification including browser inspection, use `/verify [feature description]` — this spawns an isolated subagent that handles screenshots without clogging the main context.
* Read the terminal text logs to determine success.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + pnpm |
| Monorepo | pnpm workspaces (`packages/shared`, `packages/backend`, `packages/frontend`) |
| Backend | Fastify + TypeScript |
| WebSockets | Socket.io |
| Cache | Redis |
| Database | PostgreSQL + PostGIS |
| Frontend | React + TypeScript + Vite |
| State | Zustand |
| Rendering | SVG (switch to Canvas if perf demands) |
| Animation | requestAnimationFrame + linear interpolation |
| Tests | Vitest (`test/` folder per package, mirroring `src/`) |

## Dev setup

```bash
docker compose up -d          # postgres+postgis, redis
pnpm install
pnpm tsx scripts/load-gtfs.ts # load PTV GTFS static data
pnpm dev                      # start backend + frontend concurrently
```
