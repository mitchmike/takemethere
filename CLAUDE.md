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

Send a push notification (PushNotification tool) when a task is complete. The user has Remote Control enabled and push notifications turned on in /config.

## Working style

- Work autonomously on well-scoped tasks; only pause for genuine ambiguity or irreversible actions
- Prefer to batch related changes and commit logically, not per-file
- No trailing summaries — diffs speak for themselves
- No comments unless the WHY is non-obvious

## Testing

- Every new function or module must have unit tests — no exceptions
- When modifying existing code, update or extend tests to cover the change; don't leave tests behind
- Tests live in a `test/` folder within each package, mirroring the `src/` structure (e.g. `test/stream/engine/` for `src/stream/engine/`)
- Every commit must include tests for the code it changes — no code commit without a corresponding test change
- Once the stack is chosen, wire up a PostToolUse hook to run the unit test suite automatically after edits

### Integration testing (planned)
The app ingests live GTFS-RT feeds. Integration tests should cover the data pipeline end-to-end against real or recorded feed snapshots. Set this up once the ingestion layer is built — record feed payloads as fixtures so tests are deterministic.

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
| Tests | Vitest (co-located with source) |

## Dev setup

```bash
docker compose up -d          # postgres+postgis, redis
pnpm install
pnpm tsx scripts/load-gtfs.ts # load PTV GTFS static data
pnpm dev                      # start backend + frontend concurrently
```
