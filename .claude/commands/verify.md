# /verify — App Verification

Verify that the TakeMeThere app is working correctly after a change.

**Feature/change to verify:** $ARGUMENTS

---

## Protocol

Run steps 1–3 yourself in the terminal. For step 4 (browser), spawn an isolated Agent so screenshots and DOM dumps stay out of the main context.

### Step 1: Unit tests

Run tests for any packages touched in the current task:

```bash
pnpm --filter @takemethere/shared test
pnpm --filter @takemethere/backend test
pnpm --filter @takemethere/frontend test
```

Report raw pass/fail output for each.

### Step 2: Simulator accuracy (integration)

```bash
pnpm --filter @takemethere/backend test:integration
```

This includes `test/simulator/engine.test.ts`, which asserts accuracy thresholds against all recorded sim-captures. If no captures exist the test self-skips — note that in the report.

### Step 3: Playwright E2E regression

```bash
cd packages/frontend && npx playwright test --headless
```

Report: N passed / N failed, list any failing spec names.

### Step 4: Browser verification (spawn isolated Agent)

Spawn an Agent with the following instructions — keep browser output out of the main context:

```
You are verifying the TakeMeThere app in Chrome.

Goal: confirm the app loads without JS errors and that this feature works correctly:
"$ARGUMENTS"

Steps:
1. Use mcp__claude-in-chrome__tabs_context_mcp to check if the app is already open at localhost:5173.
   If not, navigate to http://localhost:5173 in a new tab.
2. Wait for the map to render (look for SVG elements or a canvas).
3. Use mcp__claude-in-chrome__read_console_messages to capture all console output.
   Filter for errors: pattern "error|Error|TypeError|ReferenceError".
4. Take a screenshot with mcp__claude-in-chrome__computer.
5. If a specific feature was described, interact with the UI to exercise it and take a second screenshot.
6. Return a compact report:
   - Console errors: none / [list]
   - App rendered: yes/no
   - Feature check ("$ARGUMENTS"): pass/fail + one-line description of what you observed
   Do NOT include raw DOM dumps or full screenshot data in your reply — just the summary + screenshots via SendUserFile.
```

### Step 5: Summary

Output a verification table:

| Check | Result | Notes |
|---|---|---|
| Unit tests | ✓/✗ | |
| Simulator accuracy | ✓/✗/skipped | |
| E2E regression | ✓/✗ | N passed, N failed |
| JS console errors | ✓/✗ | |
| Feature: $ARGUMENTS | ✓/✗ | |
