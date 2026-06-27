# TakeMeThere — Claude Code Project Config

## Project overview

Melbourne metro train app. Web-first, then Android/iOS. Uses PTV GTFS static + GTFS-RT feeds for live train positions and journey planning.

## Permissions

All file edits and writes are pre-approved for this repo. No need to confirm before editing or creating files within this project.

## Developer context

- Michael is a software engineer — assume solid technical background
- Prefer terse, direct responses; no hand-holding on standard concepts
- Long planning and programming tasks can be run independently without frequent check-ins

## Working style

- Work autonomously on well-scoped tasks; only pause for genuine ambiguity or irreversible actions
- Prefer to batch related changes and commit logically, not per-file
- No trailing summaries — diffs speak for themselves
- No comments unless the WHY is non-obvious

## Testing

- Every new function or module must have unit tests — no exceptions
- When modifying existing code, update or extend tests to cover the change; don't leave tests behind
- Tests live alongside the code they cover (co-located), not in a separate top-level test directory
- Once the stack is chosen, wire up a PostToolUse hook to run the unit test suite automatically after edits

### Integration testing (planned)
The app ingests live GTFS-RT feeds. Integration tests should cover the data pipeline end-to-end against real or recorded feed snapshots. Set this up once the ingestion layer is built — record feed payloads as fixtures so tests are deterministic.

## Stack (TBD — update as decisions are made)

_To be filled in as the project takes shape_
