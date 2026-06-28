# GTFS-RT Data Quality & Simulation Design Analysis

**Collected:** 2026-06-28 10:56–11:02 UTC (Sunday ~9pm Melbourne local)  
**Window:** 6 minutes 4 seconds, 13 samples at ~30s intervals  
**Raw snapshots:** `scratchpad/rt-snapshots.jsonl` (13 × full vehicle arrays)

---

## 1. Fleet Overview

| Metric | Value |
|---|---|
| Active vehicles | 88–92 across the window |
| Lines | 15 (all Melbourne metro lines) |
| Samples | 13 |

**Vehicles by line (snapshot 1):**

| Line | Trains |
|---|---|
| Glen Waverley | 12 |
| Sunbury | 10 |
| Werribee | 8 |
| Williamstown | 7 |
| Pakenham | 7 |
| Frankston | 6 |
| Hurstbridge | 6 |
| Sandringham | 6 |
| Lilydale | 5 |
| Cranbourne | 5 |
| Belgrave | 4 |
| Craigieburn | 4 |
| Mernda | 4 |
| Upfield | 3 |
| Alamein | 1 |

---

## 2. PTV Update Cadence

PTV publishes GTFS-RT VP (vehicle position) updates asynchronously per vehicle. **Not all vehicles are updated on every feed fetch.**

### Update interval distribution (from timestamp deltas across all trips)

| Bucket | Count |
|---|---|
| <15s | 18 (3%) |
| 15–30s | 206 (34%) |
| 30–60s | 314 (51%) |
| 60–120s | 58 (9%) |
| >120s | 16 (3%) |

**Mean: 44s, P50: 31s, P90: 65s, Max: 827s**

**Key finding:** PTV updates most vehicles every 30–60 seconds. Our 30s poll interval is well-matched. Polling faster than 20s would return mostly the same data and waste quota. Polling slower than 60s would mean each consumer waits up to 2 update cycles before seeing a change.

### Stagger

In any given 32s sample interval, only ~57% of vehicles received a new PTV timestamp. Updates are **staggered across vehicles** — not a single bulk dump. This is actually useful: it means our streamer's interpolation is always working from a "just updated" position for most vehicles, preventing a coordinated stale jump across the whole fleet at once.

---

## 3. Data Staleness

`ageSec` = `now - pos.timestamp` at the time we published to Redis.

### Distribution across all 1161 vehicle readings

| Age range | Count | % |
|---|---|---|
| <30s | 0 | 0% |
| 30–60s | 611 | 53% |
| 60–120s | 181 | 16% |
| 120–300s | 101 | 9% |
| >300s (stale) | 268 | 23% |

**Min: 30s, P50: 57s, P90: 576s, P99: 837s, Max: 1000s**

The bimodal distribution is stark: **~69% of readings are fresh (<120s)** and **23% are severely stale (>300s)**. These are not the same vehicles cycling through — the stale vehicles are persistently stale (see zombie trains below).

---

## 4. Zombie Trains (22 vehicles, 24%)

**22 out of 90 distinct vehicles** maintained an identical GPS timestamp for the entire 6-minute window. Their `ageSec` grew from e.g. 311s to 673s with no PTV updates.

**Example zombie:**
```
02-WER--52-T3-6489 (werribee)
  All 13 samples: ts=1782643866  canonX=0.5161  lat=-37.8997
  ageSec: 311 → 673
```

**What they are:** These are trains that PTV stopped publishing position updates for — likely because:
1. They reached a terminus/depot and are awaiting their next service
2. Their GPS transponder dropped out
3. PTV's internal system stopped feeding them into the RT endpoint

**Anomaly:** Many zombie trains have `canonicalX = 0` or `canonicalX = 1` — parked at a terminus. Some have positions mid-segment (e.g. werribee at 0.5161), which means the train froze mid-journey. These will appear to the frontend as a static dot on the map, gradually growing staler with no movement — eventually they should be culled.

**Our current response:** We write a 120s Redis TTL on each vehicle key. Zombie trains do expire, but they survive the TTL if PTV keeps publishing their frozen position. This means they remain visible but frozen.

---

## 5. Data Completeness

| Field | Coverage (snapshot 1, n=88) |
|---|---|
| `upcomingStops` populated | 68/88 (77%) |
| `scheduledNextArrivalEpoch > 0` | 63/88 (72%) |
| `predictedNextArrivalEpoch > 0` | 63/88 (72%) |
| `segmentSpeedKmh` populated | 59/88 (67%) |
| `canonicalX` in [0,1] | 88/88 (100%) |

**Delays (snapshot 1):**
- Min: −120s (2 min early), Max: +480s (8 min late), Mean: +31s
- On-time (−30s to +60s): 62/88 (70%)
- Early: 12/88 (14%), Late: 14/88 (16%)

---

## 6. Current Simulation Approach

### Architecture

```
PTV GTFS-RT VP feed (30s)          PTV GTFS-RT TU feed (30s)
          │                                    │
          └──────────── poller.ts ─────────────┘
                              │ publishPositions()
                              ▼
                      publisher.ts
                              │
               ┌──────────────┴──────────────┐
               │                             │
          Redis (TTL 120s)            Socket.io rooms
               │                      per lineId
               ▼
          streamer.ts (1s tick)
               │
          vehicles:stream → frontend trainsStore
               │
          useAnimationFrame + applyStream()
               │
          interpolated canonicalX on SVG
```

### Position determination (publisher.ts)

**Step 1 — GPS→canonicalX projection:**
```
canonicalX = projectToLine(lat, lon, lineStops)
```
Nearest-point projection onto the sequence of stop coordinates. This gives a [0,1] value representing where on the line the train is.

**Step 2 — Segment detection (segment.ts):**
Priority order:
1. TU `nextStopId` (authoritative — the GTFS-RT Trip Update knows the actual next stop)
2. Name-based fallback (alternate platform IDs)
3. GPS canonicalX fallback

**Step 3 — ETA prediction (computeSegmentPrediction):**
```
fraction = |canonicalX - prevStop.canonicalX| / |nextStop.canonicalX - prevStop.canonicalX|
timeToNextSec = (1 - fraction) × segDurationSec
predictedNextArrivalEpoch = gpsTimestamp + timeToNextSec
```

Where `segDurationSec = nextSchedule.arrivalSec - prevSchedule.departureSec` from GTFS static.

**Key design choice:** anchored to `gpsTimestamp` (not `now`). Since GPS may be 30–60s old when we process it, using `now` would inflate `total` by the GPS lag, making trains appear much slower than reality.

### Animation (streamer.ts, frontend)

**Backend streamer (1s tick):**
```
elapsed = now - pos.timestamp      (grows from GPS capture moment)
total   = predictedNextArrivalEpoch - pos.timestamp
t       = clamp(elapsed / total, 0, 1)
interpX = canonicalX + t × (nextStopCanonicalX - canonicalX)
```

When `t = 1` (next stop reached), `tryAdvanceSegment` fires: prevStop ← nextStop, nextStop ← following stop, new prediction from GTFS static schedule.

**Frontend:** receives `StreamedPosition` every 1s via Socket.io, stores `streamedX` in `trainsStore`. `TrainDot` renders at `streamedX` directly (no additional client-side interpolation — the server does all the math).

---

## 7. Weaknesses of Current Approach

### W1 — Single-point GPS anchor
The dead-reckoning formula assumes the GPS point is a reliable ground-truth position. But:
- GPS accuracy for trains is ±15–50m, which is ~0.001–0.003 in canonicalX
- At slow speeds near platforms, the GPS projection can jump by one stop
- PTV's VP feed sometimes has 30–60s old positions; the train has moved since

### W2 — Linear interpolation ignores actual speed
`t = elapsed / total` assumes constant speed between stops. Melbourne trains:
- Accelerate from 0 to ~70 km/h leaving a station
- Cruise at line speed (~80 km/h)
- Decelerate to 0 approaching the next stop

With linear interpolation, a train looks like it moves too slowly for the first 30% of a segment (acceleration phase) and too fast for the last 20% (deceleration phase). The visual effect is a stutter near stations.

### W3 — 22/90 zombie trains (24%)
Frozen trains with no timestamp updates remain on the map indefinitely (as long as PTV keeps publishing them). The user sees a motionless dot that looks like a stalled train but is likely an out-of-service train at a depot.

### W4 — 23% of readings stale >5 minutes
For the stale (but non-zombie) population, `predictedNextArrivalEpoch` is anchored to an old GPS timestamp. `elapsed = now - pos.timestamp` grows to 300–900s, making `t` far exceed 1 — the train would appear to shoot past its next stop. The current code clamps `t` at 1, so these trains freeze at `nextStopCanonicalX`. Better than teleporting, but misleading.

### W5 — Segment advance from schedule durations, not actual speed
When `tryAdvanceSegment` fires (train "crosses" a stop in the interpolation), it computes the next segment's `predictedNextArrivalEpoch = nowSec + segDurationSec`. This is purely schedule-based. If the train is 8 minutes late (max observed: +480s), the segment duration is right but the absolute epoch is wrong until the next real GPS update arrives.

### W6 — `upcomingStops` missing for 23% of vehicles
Likely caused by TU feed not covering all vehicles. For these trains, `predictedNextArrivalEpoch` falls back to `nextArrivalEpoch = scheduled + delay`, which is the coarsest ETA. Arrival times in the times strip are computed from this, so they can be off by the delta between schedule+delay and real progress.

---

## 8. Proposed Improvements

### P1 — Zombie train culling heuristic ⭐ High value, low risk

**Problem:** 22 trains (24%) are frozen with no position updates for 5+ minutes.

**Proposal:** In `publisher.ts`, after computing `ageSec = now - pos.timestamp`, skip publishing to Socket.io rooms (but still write Redis key) if `ageSec > 180`. The train disappears from the live map but reappears immediately if PTV resumes updates.

Alternatively: filter in `admin/rt/vehicles` and in the streamer loop — do not emit to rooms if `now - pos.timestamp > 180`.

**Strength:** Eliminates the false-positive frozen dots. No false negatives (trains with real updates have ageSec ≤ 90 at P90).  
**Weakness:** A train briefly losing GPS during a tunnel will vanish and reappear. But Melbourne metro tunnels are short (City Loop ~2–3 min); a 180s threshold covers that.

---

### P2 — GPS lag correction in fraction calculation ⭐ High value, moderate complexity

**Current:**
```
fraction = |canonicalX - prevStop.canonicalX| / segCxLen
```
This is the GPS-measured fraction at `gpsTimestamp`. The train has physically moved since then.

**Proposal:** Extrapolate the GPS position forward by the GPS lag before computing fraction:
```
gpsLag = now - gpsTimestamp              // typically 30–60s
estimatedDistCx = gpsLag / segDurationSec × segCxLen
correctedCanonicalX = clamp(canonicalX + estimatedDistCx × direction, 0, 1)
fraction = |correctedCanonicalX - prevStop.canonicalX| / segCxLen
```

Then anchor `predictedNextArrivalEpoch` to `now` instead of `gpsTimestamp`:
```
predictedNextArrivalEpoch = now + (1 - fraction) × segDurationSec
```

**Strength:** The dead-reckoning starts from a better initial position. For a 45s GPS lag on a 90s segment, the uncorrected fraction is 0.5 lower than it should be — the train visually "jumps" 45s worth of movement the moment the next poll arrives.  
**Weakness:** If the GPS lag estimate is wrong (e.g. the train stopped at a red signal), the correction over-shoots. Would need to clamp so correction never pushes past the next stop.

---

### P3 — S-curve (ease in / ease out) interpolation

**Problem (W2):** Linear `t = elapsed / total` is wrong for trains that accelerate and decelerate.

**Proposal:** Replace linear `t` with a smooth step:
```
t_raw = elapsed / total
t = smoothstep(t_raw)    // 3t² − 2t³
```
Or a custom train motion curve with distinct phases:
- 0–20% of segment: ease-in (quadratic)
- 20–80%: linear cruise
- 80–100%: ease-out (quadratic)

```
function trainEase(t):
  if t < 0.2: return (t / 0.2)² × 0.2          // accelerate to 20% distance
  elif t < 0.8: return 0.2 + (t - 0.2)          // cruise
  else: return 0.8 + (1 - ((1-t)/0.2)²) × 0.2  // decelerate
```

**Strength:** Much more realistic motion profile. Stops the "too-fast mid-segment" artifact that makes trains look like they teleport.  
**Weakness:** The per-segment GTFS schedule has varying durations. Calibrating the ease curve per-segment (short 60s segments vs long 120s segments) adds complexity. Start with a global smoothstep — already a major improvement over linear.

---

### P4 — Confidence-weighted display for stale positions

**Problem (W3/W4):** Stale trains (>120s) still display as if they're real-time.

**Proposal:** Pass `ageSec` from backend to frontend. In the frontend, show a visual indicator:
- `ageSec < 60`: normal train dot
- `60 < ageSec < 120`: slightly desaturated (opacity 0.7)
- `ageSec > 120`: greyed out with a `?` indicator, frozen at last known position

This is honest to the user: "we have an old position for this train."  
**Strength:** The user understands which trains are real-time vs approximate.  
**Weakness:** More visual complexity. Start with just opacity — trivial to implement.

---

### P5 — Predictive segment advance using upcoming stops schedule

**Problem (W5):** When `tryAdvanceSegment` fires, the next segment's ETA is schedule-only.

**Proposal:** When the train crosses a stop, don't just use `segDurationSec` — also check the train's delay from the most recent TU update and apply it:
```
predictedNextArrivalEpoch = nowSec + segDurationSec + delay
```

The delay is already stored in `LivePosition.delay`. This is a one-line change in `tryAdvanceSegment` that makes segment-advance predictions significantly more accurate for delayed trains.

**Strength:** High accuracy for the 16% of trains that are >60s late.  
**Weakness:** Delay from TU might be stale too (last TU could be 60s old), but still better than ignoring it.

---

## 9. Recommended Priority Order

| Priority | Change | Effort | Value |
|---|---|---|---|
| 1 | P1: Zombie culling (180s threshold) | 1 line in streamer.ts | Eliminates 24% false positives |
| 2 | P5: Include delay in segment advance | 1 line in streamer.ts | Improves late-train accuracy |
| 3 | P4: Pass `ageSec` to frontend, opacity UI | Small (backend pass-through + CSS) | Honest UX |
| 4 | P3: Smoothstep interpolation | 10 lines in streamer.ts | Most visible visual improvement |
| 5 | P2: GPS lag correction | Moderate (new formula + clamp logic) | Reduces the post-update "jump" |

P1 and P5 are effectively free — single-line changes with immediate impact. P3 (smoothstep) is the most impactful for visual quality and is also low risk.
