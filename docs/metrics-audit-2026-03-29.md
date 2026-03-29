# Metrics Audit — 2026-03-29

Telemetry review of 437,606 samples over 3 days (March 27-29, 2026). Build 23, iOS 26.3.1, iPhone 16 Pro.

## Fixed This Session

| Issue | Before | After | Commit |
|-------|--------|-------|--------|
| Session list API waste | 729 MB/day (416 calls x 1.8 MB) | ~3 MB/day (lazy load + gzip) | `8864e93b`, `0812f2dc` |
| MetricKit window timestamps | Receipt time (wrong) | Actual payload window | `619dce5d` |
| MetricKit Grafana panels | Missing | 8 panels + section | `d8af4aef` |

## Tier 1 — "Staring at nothing" (blocks content)

### queue_sync (p50=128ms, p95=54s, max=107s)

After reconnect or session switch, events replay to reconstruct the timeline. 78.9% resolve under 1s, but **10% take over 5 seconds and 4.5% take over a minute**.

| Bucket | Count | % |
|--------|-------|---|
| < 1s | 1,128 | 78.9% |
| 1-5s | 121 | 8.5% |
| 5-15s | 39 | 2.7% |
| 15-30s | 33 | 2.3% |
| 30-60s | 44 | 3.1% |
| 60s+ | 65 | 4.5% |

**User feel:** Tap a session, see blank screen for up to a minute while events replay.

### fresh_content_lag (p50=688ms, p95=4s, max=100s)

Time from session open to first visible content. Combines cache load, reducer, and initial render.

| Bucket | Count | % |
|--------|-------|---|
| instant (<500ms) | 369 | 34.0% |
| fast (0.5-1.5s) | 481 | 44.3% |
| noticeable (1.5-3s) | 142 | 13.1% |
| slow (3-10s) | 79 | 7.3% |
| painful (10s+) | 14 | 1.3% |

**User feel:** Open a session, stare at empty/loading state. 8.6% wait over 3 seconds.

### cache_load + reducer_load (p95=341ms + 448ms)

Disk-to-memory pipeline for session data. Combined p95 is ~800ms just to load + process the session state before rendering can start.

**User feel:** Contributes to fresh_content_lag. Large sessions with 1000+ messages are the worst.

## Tier 2 — "Scroll feels bad" (quality/smoothness)

### timeline_apply (p50=12ms, p95=64ms, max=1.77s)

Diffable data source snapshot applies. 36% miss the 16ms frame budget. 1.4% cause visible scroll hitches (>100ms).

| Bucket | Count | % |
|--------|-------|---|
| within budget (<=16ms) | 35,389 | 63.8% |
| 1 frame drop (17-33ms) | 12,923 | 23.3% |
| 2-3 frame drops (34-66ms) | 4,634 | 8.4% |
| 4-6 frame drops (67-100ms) | 1,784 | 3.2% |
| scroll hitch (100ms+) | 764 | 1.4% |

### cell_configure (p50=2ms, p95=22ms, max=1.34s)

Cell rendering cost. p95 is 2x over the 10ms budget. Tool output cells and code blocks are the heaviest.

### jank_pct (session-level smoothness)

| Feel | Sessions | % |
|------|----------|---|
| smooth (<10%) | 103 | 13.7% |
| occasional (10-25%) | 374 | 49.8% |
| noticeable (25-50%) | 235 | 31.3% |
| janky (50%+) | 39 | 5.2% |

36.5% of sessions feel noticeably janky or worse.

### session_list_compute (p50=11ms, p95=48ms)

Session list view body computation. Should improve with lazy loading (fewer sessions to compute).

## Tier 3 — "Minor papercuts"

| Metric | p95 | Note |
|--------|-----|------|
| voice_prewarm | 755ms | First use only |
| connected_dispatch | 573ms | Post-connect message delay |
| subscribe_ack | 1.9s | Usually masked by other loading |

## Out of scope (not our control)

| Metric | p95 | Why |
|--------|-----|-----|
| TTFT | 33.2s | LLM provider response time |
| voice_first_result | 6.86s | Speech recognition + LLM |

## MetricKit Device-Level (daily aggregates, build 23)

| Metric | Value | Concern |
|--------|-------|---------|
| Hang events | 2,219/day (87 buckets) | 22 over 1s, max 9.6s |
| Crashes | 5 on 3/28, 4 on 3/27 | New in build 23 |
| CPU time | 7,224s/day (10h foreground) | ~20% avg utilization |
| Peak memory | 645-705 MB | High for chat app |
| Disk writes | 4.7-6.1 GB/day | Session JSONL + coalescer |
| WiFi download | 1,834 MB/day | Mostly fixed (session list was 729 MB) |

## Next Steps

1. Investigate Tier 1 metrics (queue_sync, fresh_content_lag, cache_load)
2. Trace worst-case sessions to understand the spikes
3. Propose targeted fixes for each
