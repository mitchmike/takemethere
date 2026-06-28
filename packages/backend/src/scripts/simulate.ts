/**
 * Train simulation CLI.
 *
 * Usage:
 *   pnpm tsx src/scripts/simulate.ts [--session <path>] [--trip <tripId>] [--line <lineId>]
 *
 * If --session is omitted, lists available sessions in data/sim-captures/.
 * If --trip is omitted, shows a trip picker.
 * If --line is given, restricts the trip picker to that line.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { parseSnapshots, listTrips, simulateTrip, type TripSimResult, type IntervalResult } from '../gtfs-rt/simulator.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, '../../data/sim-captures');
const TRACK_WIDTH = 60;   // characters for the canonicalX bar
const ACCURACY_THRESHOLD = 0.02; // canonicalX — ~1km on a 50km line

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

const b  = (s: string) => `${C.bold}${s}${C.reset}`;
const g  = (s: string) => `${C.green}${s}${C.reset}`;
const r  = (s: string) => `${C.red}${s}${C.reset}`;
const y  = (s: string) => `${C.yellow}${s}${C.reset}`;
const d  = (s: string) => `${C.dim}${s}${C.reset}`;
const cy = (s: string) => `${C.cyan}${s}${C.reset}`;

function fmt3(n: number): string { return n.toFixed(3); }
function fmtSgn(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(3); }

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ─── Track renderer ────────────────────────────────────────────────────────────
// Returns a 60-char string with A (actual), P (predicted), X (overlap), · (empty)

function renderTrack(actualCx: number, predictedCx: number | null): string {
  const track = Array(TRACK_WIDTH).fill('·');
  const aIdx = Math.round(Math.max(0, Math.min(1, actualCx)) * (TRACK_WIDTH - 1));
  const pIdx = predictedCx !== null
    ? Math.round(Math.max(0, Math.min(1, predictedCx)) * (TRACK_WIDTH - 1))
    : -1;

  if (pIdx >= 0 && pIdx === aIdx) {
    track[aIdx] = 'X'; // overlap
  } else {
    track[aIdx] = 'A';
    if (pIdx >= 0) track[pIdx] = 'P';
  }

  // Colour the characters
  return track.map((ch, i) => {
    if (ch === 'A') return `${C.cyan}A${C.reset}`;
    if (ch === 'P') return `${C.yellow}P${C.reset}`;
    if (ch === 'X') return `${C.green}X${C.reset}`;
    return `${C.gray}·${C.reset}`;
  }).join('');
}

// ─── Accuracy badge ────────────────────────────────────────────────────────────

function errBadge(absError: number): string {
  if (absError < 0.02) return g('✓');
  if (absError < 0.05) return y('~');
  return r('✗');
}

function scoreBadge(pct: number): string {
  if (pct >= 80) return g(`${pct.toFixed(0)}%`);
  if (pct >= 50) return y(`${pct.toFixed(0)}%`);
  return r(`${pct.toFixed(0)}%`);
}

// ─── Render functions ─────────────────────────────────────────────────────────

function renderHeader(result: TripSimResult, sessionName: string): void {
  const w = 80;
  const line = '═'.repeat(w);
  console.log(`\n${b(line)}`);
  console.log(b(`  TRAIN SIMULATOR`));
  console.log(`  ${cy(result.tripId)}  ${d('(')}${result.lineId}${d(')')}`);
  console.log(`  Session: ${d(sessionName)}  │  ${result.presenceCount} snapshots  │  ${timeOf(result.firstCapturedAt)}–${timeOf(result.lastCapturedAt)}`);
  console.log(b(line));
}

function renderTrackLegend(): void {
  console.log();
  console.log(`  Track legend:  ${cy('A')} = actual GPS position   ${y('P')} = engine prediction   ${g('X')} = overlap`);
  console.log(`  Scale: 0.000 ${'─'.repeat(TRACK_WIDTH)} 1.000  (full Melbourne metro canonical range)`);
  console.log();
}

function renderIntervalTable(result: TripSimResult): void {
  // Header
  console.log(
    `  ${b('#')}   ${b('TIME')}      ${b('GPS')}  ${b('AGE')}   ` +
    `${b('ACT.X')}  ${b('PRED.X')}  ${b('ERR')}    ${b('OK')}  TRACK`
  );
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(9)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(3)} ${'─'.repeat(TRACK_WIDTH)}`);

  // First row = baseline (no prediction yet)
  const first = result.intervals[0];
  console.log(
    `  ${d('S0')}  ${d(timeOf(first.fromCapturedAt))}  ${d('base')} ${d(first.fromGpsAgeSec.toFixed(0).padStart(4))}s ` +
    `${fmt3(first.fromCanonicalX)}  ${d('   —   ')}  ${d('   —  ')}  ${d('—')}  ` +
    renderTrack(first.fromCanonicalX, null)
  );

  for (const iv of result.intervals) {
    const gpsTag = iv.gpsUpdated ? g('new ') : r('frz ');
    const flags = [
      iv.segmentChanged ? y('[seg]') : '',
      iv.largeActualJump ? r('[jump]') : '',
      iv.isZombie ? d('[zmb]') : '',
      iv.clampedAtStop ? d('[clmp]') : '',
    ].filter(Boolean).join(' ');

    const errStr = fmtSgn(iv.error).padStart(7);
    const errColored = iv.absError < 0.02 ? g(errStr)
                     : iv.absError < 0.05 ? y(errStr)
                     : r(errStr);

    console.log(
      `  ${d('S' + (iv.index))}  ${timeOf(iv.toCapturedAt)}  ${gpsTag} ${iv.actualGpsAgeSec.toFixed(0).padStart(4)}s ` +
      `${fmt3(iv.actualCanonicalX)}  ${fmt3(iv.predictedCanonicalX)}  ${errColored}  ${errBadge(iv.absError)}  ` +
      renderTrack(iv.actualCanonicalX, iv.predictedCanonicalX) +
      (flags ? `  ${flags}` : '')
    );
  }
}

function renderSummary(result: TripSimResult): void {
  // Find worst interval
  const worst = result.intervals.reduce((w, r) => r.absError > w.absError ? r : w, result.intervals[0]);
  // Approximate km (assume 50km average line length)
  const maeKm = (result.mae * 50).toFixed(1);
  const maxKm = (result.maxAbsError * 50).toFixed(1);

  console.log();
  console.log(b(`  ACCURACY SUMMARY`));
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Score:         ${scoreBadge(result.accuracyPct)}  (${result.intervals.filter(r => r.absError < ACCURACY_THRESHOLD).length}/${result.intervals.length} intervals within ±${ACCURACY_THRESHOLD})`);
  console.log(`  MAE:           ${b(fmt3(result.mae))}  (~${maeKm} km on ~50 km line)`);
  console.log(`  Max error:     ${b(fmt3(result.maxAbsError))}  (~${maxKm} km  ←  at ${timeOf(worst.toCapturedAt)})`);
  console.log(`  Bias:          ${fmtSgn(result.bias).trim()}  (${result.bias > 0 ? 'engine runs ahead of GPS' : 'engine lags behind GPS'})`);
  console.log();
  console.log(`  Intervals:     ${result.intervals.length} total | ${g(result.freshIntervals + ' GPS updated')} | ${r(result.staleIntervals + ' GPS frozen')}`);
  if (result.clampedCount)        console.log(`  Clamped at stop:  ${result.clampedCount}  (engine hit next stop; awaiting next segment)`);
  if (result.segmentChangedCount) console.log(`  Segment changed:  ${y(result.segmentChangedCount.toString())}  (prevStop or nextStop ID flipped between snapshots)`);
  if (result.largeJumpCount)      console.log(`  Large jumps:      ${r(result.largeJumpCount.toString())}  (actual canonicalX moved >0.05 in one interval)`);
  if (result.zombieFromCount)     console.log(`  Zombie intervals: ${r(result.zombieFromCount.toString())}  (GPS was >180s stale at start of interval)`);

  // Observations
  console.log();
  console.log(b(`  OBSERVATIONS`));
  if (result.mae < 0.01) {
    console.log(g('  ✓ Excellent accuracy — engine closely tracks GPS reality'));
  } else if (result.mae < 0.03) {
    console.log(g('  ✓ Good accuracy — minor prediction lag acceptable'));
  } else if (result.mae < 0.06) {
    console.log(y('  ~ Moderate accuracy — consider GPS lag correction (future-work P2)'));
  } else {
    console.log(r('  ✗ Poor accuracy — significant systematic error'));
  }

  if (result.zombieFromCount > 0) {
    console.log(r(`  ✗ ${result.zombieFromCount} interval(s) started from a zombie (stale GPS >180s) — culling recommended (future-work P1)`));
  }
  if (result.clampedCount > result.freshIntervals * 0.5) {
    console.log(y('  ~ Engine frequently clamped at next stop — segment advance would help smooth this'));
  }
  if (result.bias > 0.02) {
    console.log(y('  ~ Positive bias: engine consistently predicts train is further along than GPS shows'));
    console.log(y('    This is expected — GPS is 30–60s old, engine extrapolates forward'));
  }
  if (result.staleIntervals > result.freshIntervals) {
    console.log(r('  ✗ More frozen intervals than fresh — this trip is largely a zombie'));
  }
  console.log();
}

// ─── Session picker ────────────────────────────────────────────────────────────

function listSessions(): string[] {
  try {
    return readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .map(f => join(DATA_DIR, f));
  } catch {
    return [];
  }
}

async function pickSession(rl: readline.Interface): Promise<string> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.error(`No session files found in ${DATA_DIR}`);
    process.exit(1);
  }
  if (sessions.length === 1) return sessions[0];

  console.log('\nAvailable sessions:');
  sessions.forEach((s, i) => console.log(`  ${i + 1}. ${s.split(/[\\/]/).pop()}`));
  const ans = await rl.question('Pick session (number or path): ');
  const n = parseInt(ans);
  if (!isNaN(n) && n >= 1 && n <= sessions.length) return sessions[n - 1];
  return ans.trim();
}

async function pickTrip(
  rl: readline.Interface,
  snapshots: ReturnType<typeof parseSnapshots>,
  lineFilter: string | null,
): Promise<string> {
  const trips = listTrips(snapshots)
    .filter(t => !lineFilter || t.lineId === lineFilter);

  if (trips.length === 0) {
    console.error(`No trips found${lineFilter ? ` for line '${lineFilter}'` : ''}`);
    process.exit(1);
  }

  console.log(`\n  ${'#'.padEnd(4)} ${'TRIP ID'.padEnd(28)} ${'LINE'.padEnd(14)} SNAPSHOTS`);
  console.log(`  ${'─'.repeat(60)}`);
  trips.slice(0, 30).forEach((t, i) => {
    console.log(`  ${String(i + 1).padEnd(4)} ${t.tripId.padEnd(28)} ${t.lineId.padEnd(14)} ${t.snapshotCount}`);
  });
  if (trips.length > 30) console.log(`  ... and ${trips.length - 30} more`);

  const ans = await rl.question('\nPick trip (number or tripId): ');
  const n = parseInt(ans);
  if (!isNaN(n) && n >= 1 && n <= trips.length) return trips[n - 1].tripId;
  return ans.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  let sessionPath = get('--session');
  let tripId      = get('--trip');
  const lineFilter = get('--line');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 1. Pick session
    if (!sessionPath) sessionPath = await pickSession(rl);
    const sessionName = sessionPath.split(/[\\/]/).pop() ?? sessionPath;

    let raw: string;
    try {
      raw = readFileSync(sessionPath, 'utf8');
    } catch {
      console.error(`Cannot read session file: ${sessionPath}`);
      process.exit(1);
    }

    const snapshots = parseSnapshots(raw);
    if (snapshots.length < 2) {
      console.error(`Session has fewer than 2 snapshots — nothing to simulate`);
      process.exit(1);
    }
    console.log(`\nLoaded ${snapshots.length} snapshots from ${sessionName}`);

    // 2. Pick trip
    if (!tripId) tripId = await pickTrip(rl, snapshots, lineFilter);

    // 3. Simulate
    const result = simulateTrip(snapshots, tripId);
    if (!result) {
      console.error(`Trip '${tripId}' found in fewer than 2 snapshots — cannot simulate`);
      process.exit(1);
    }

    // 4. Render
    renderHeader(result, sessionName);
    renderTrackLegend();
    renderIntervalTable(result);
    renderSummary(result);

  } finally {
    rl.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
