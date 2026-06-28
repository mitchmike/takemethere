# Future Work

## Simulation Quality Improvements

Identified from GTFS-RT data analysis (see [gtfs-rt-analysis.md](gtfs-rt-analysis.md)).

---

### P1 — Zombie train culling (streamer.ts)

**Problem:** ~24% of active vehicles have frozen GPS timestamps (no PTV updates for 5+ min). These appear as motionless dots on the map, indistinguishable from real-time trains.

**Fix:** In the streamer loop, skip emitting to rooms if `now - pos.timestamp > 180`. The train disappears from the live map but reappears immediately if PTV resumes updates. 180s is safe — City Loop tunnel transits are ≤3 min.

---

### P2 — Include current delay in segment-advance ETA (streamer.ts)

**Problem:** When `tryAdvanceSegment` fires (interpolation crosses a stop), the next segment's predicted arrival uses `segDurationSec` alone — ignoring the train's known delay.

**Fix:** One line in `tryAdvanceSegment`:
```ts
predictedNextArrivalEpoch = nowSec + segDurationSec + pos.delay;
```
Improves accuracy for the ~16% of trains running >60s late.

---

### P3 — Pass `ageSec` to frontend for stale-position opacity

**Problem:** Stale positions (ageSec >120s) display identically to fresh ones. The user can't tell which trains are real-time vs approximate.

**Fix:** Include `ageSec` in `StreamedPosition`. In `TrainDot`, reduce opacity based on age:
- <60s: full opacity
- 60–120s: 0.7
- >120s: greyed out with a visual indicator

---

### P4 — Smoothstep interpolation (streamer.ts)

**Problem:** Linear `t = elapsed / total` ignores train acceleration/deceleration. Trains appear to move at constant speed between stops, visually wrong near platforms.

**Fix:** Replace linear `t` with smoothstep in `computeInterpolatedX`:
```ts
const t_linear = Math.min(1, elapsed / total);
const t = t_linear * t_linear * (3 - 2 * t_linear);  // smoothstep
```
Or a three-phase curve (ease-in 0–20%, cruise 20–80%, ease-out 80–100%) for a more physically accurate profile.

---

### P5 — GPS lag correction in fraction calculation (segment.ts / publisher.ts)

**Problem:** GPS positions are 30–60s old when processed. The computed `fraction` is where the train *was*, not where it *is*. This causes a visible "jump" forward when the next poll arrives and snaps to a newer position.

**Fix:** Before computing `fraction`, extrapolate the GPS position forward by the lag:
```ts
const gpsLag = now - gpsTimestamp;               // typically 30–60s
const lagCx  = (gpsLag / segDurationSec) * segCxLen * direction;
const correctedCx = clamp(canonicalX + lagCx, prevStop.cx, nextStop.cx);
// Then anchor predictedNextArrivalEpoch to `now` instead of `gpsTimestamp`
```
Reduces the inter-poll jump artifact. Must clamp so correction never overshoots the next stop.
