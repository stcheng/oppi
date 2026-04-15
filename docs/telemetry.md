# Telemetry and Privacy Policy (Oppi iOS + Server)

## TL;DR

- **No usage analytics are collected.**
- **No feature usage logs are used for product analytics.**
- Diagnostic uploads can be enabled or disabled via `OPPI_TELEMETRY_MODE`.

The release flow enforces this with one gate:
- `OPPI_TELEMETRY_MODE=internal`

`clients/apple/scripts/release.sh` sets this by default for TestFlight archives.
To disable remote diagnostics uploads, set `OPPI_TELEMETRY_MODE=public`.

## Single telemetry gate

Oppi uses a single mode switch for remote diagnostics behavior:

- `OPPI_TELEMETRY_MODE=public` (or `release/prod/off` aliases)
  - disables remote diagnostics uploads
- `OPPI_TELEMETRY_MODE=internal` (or `debug/test/dev` aliases)
  - enables remote diagnostics uploads

This gate controls all diagnostics transports:
1. Sentry events/breadcrumbs/traces
2. MetricKit upload (`POST /telemetry/metrickit`)
3. Chat metrics upload (`POST /telemetry/chat-metrics`)
4. Debug client-log upload (`POST /workspaces/:workspaceId/sessions/:sessionId/client-logs`)

Metric names and descriptions are defined in `server/src/types.ts` and `server/src/server-metric-registry.ts`.


## Explicit non-goals (what Oppi does not track)

Oppi is not designed to collect product analytics. We do **not** track:
- screen views
- button clicks / tap funnels
- feature adoption metrics
- retention cohorts
- “how people use the app” behavior analytics

We also do not upload conversation content as telemetry:
- prompt text
- assistant responses
- tool arguments
- session transcripts

## Channel behavior details

### Sentry

- Requires **both**:
  - telemetry mode that allows diagnostics (`internal`)
  - non-empty `SentryDSN` in `Info.plist`
- In `public` mode, Sentry is disabled even if a DSN is present.

### MetricKit + chat metrics

- Require telemetry mode that allows diagnostics (`internal`).
- In `public` mode, uploads are dropped client-side.

### Debug client-log upload

- Used for development triage tooling.
- Also governed by telemetry mode.

## Server ingestion gate

Server telemetry endpoints also honor `OPPI_TELEMETRY_MODE`:
- when mode is public/off aliases, diagnostics upload endpoints reject uploads (`/telemetry/metrickit`, `/telemetry/chat-metrics`, `/workspaces/:workspaceId/sessions/:sessionId/client-logs`)
- when mode is internal aliases, uploads are accepted

This provides defense-in-depth if a client is misconfigured.

## Storage and retention (when enabled)

- MetricKit: `<OPPI_DATA_DIR>/diagnostics/telemetry/metrickit-YYYY-MM-DD.jsonl`
- Chat metrics: `<OPPI_DATA_DIR>/diagnostics/telemetry/chat-metrics-YYYY-MM-DD.jsonl`
- MetricKit retention: `OPPI_METRICKIT_RETENTION_DAYS` (default `14`)
- Chat metrics retention: `OPPI_CHAT_METRICS_RETENTION_DAYS` (default `14`)

## Policy statement

Current default posture:

> **No behavior analytics, no usage tracking. Diagnostic uploads are controlled only by `OPPI_TELEMETRY_MODE`.**

Set `OPPI_TELEMETRY_MODE=public` to disable diagnostics uploads (Sentry, MetricKit, chat metrics, and client-log upload).