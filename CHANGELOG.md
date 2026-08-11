## 0.5.1 - 2026-08-05

### Added
- Empty list/export warning: `empty` + `warning` on collection outputs when zero rows.


## 0.5.0 - 2026-08-01

### Fixed

- **`withings_demo` described a server that does not exist.** The tool exists so an agent can
  learn the payload shape before spending an OAuth round-trip — and every one of its three
  examples had drifted from the real builders. An agent that trusted it wrote a parser for
  fields that never arrive:
  - `withings_daily_summary`: **26 invented keys, 37 real keys missing**. The example advertised
    `body`, `blood_pressure`, `sleep` and `activity` objects. The builder returns none of them —
    it returns a flat `scorecard` inside `kind` / `generated_at` / `window` / `data_quality` /
    `diagnostic` / `safety`. Not one key matched.
  - `withings_wellness_context`: **7 invented keys, 14 missing**. `recommendation`, presented as
    the payload's main deliverable, does not exist — the context tool hands structured signals to
    another agent instead of advising. `sleep_score` was the only field that was ever real.
  - `withings_list_body_measures`: **3 invented keys, 14 missing**. The example promised decoded
    `weight_kg` / `body_fat_pct` / `muscle_mass_kg` per record. Withings returns measure *groups*:
    `measures: [{ value: 72500, type: 1, unit: -3 }]`, where the real number is `value * 10 ** unit`
    and `type` is a measure-type code. An agent following the demo had no reason to implement that
    decoding — and a naive fallback to `measures[0].value` reports **72500 kg**. It also omitted
    `endpoint`, `privacy_mode`, `next_page`, `has_more` and `pages_fetched`, so paging was invisible.
- The demo now shows what the tools actually return, including the value/unit decoding rule and
  where blood pressure really lives (`withings_list_body_measures`, not the daily scorecard).

### Added

- `npm run test:demo-contract` (wired into `npm test`): runs the real `buildDailySummary`,
  `buildWellnessContext` and `buildCollectionOutput` over a stubbed Withings transport, then
  compares key paths against the demo and **fails in both directions** — keys the demo invents and
  contract keys the demo omits. The collection sample is checked against the union of a
  more-results page and a last page, so `next_page` cannot silently vanish from the example.
  This is what makes the drift above impossible to reintroduce quietly.

### Changed

- Collection payload shaping moved to `src/services/collection.ts` (`buildCollectionOutput`) and the
  demo payload to `src/services/demo.ts` (`buildDemoPayload`), so the gate can exercise the real code
  instead of re-describing it. Tool responses are byte-identical.

## 0.4.11 - 2026-07-30

### Added / Fixed

- exchange_code description documents explicit user OAuth action (scorecard 100).

# Changelog

## 0.5.2

- Security: override `fast-uri@3.1.5` and `ip-address@10.4.0` (high transitive).



## 0.4.10 - 2026-07-30

### Security

- Security: require explicit_user_intent on revoke/disconnect tools so agents cannot wipe OAuth grants autonomously.

## 0.4.9 - 2026-07-30

### Fixed

- **Date param style by Withings action (polar-mcp #4 class).** `getactivity`, `getworkouts`, and sleep `getsummary` now send `startdateymd` / `enddateymd` as `YYYY-MM-DD`. Epoch-style actions (`getmeas`, sleep detail `get`, heart `list`) still send `startdate` / `enddate` Unix seconds. Previously every list/summary path used epoch params, so activity/workout/sleep-summary filters were malformed or dropped upstream.
- **Daily/weekly summary** now uses ymd params for activity + sleep summary (and keeps epoch for measures + heart).
- Accept plain `YYYY-MM-DD` on collection `after` / `before` (agents rarely pass offset-qualified ISO). Date-only epoch bounds expand to start/end of UTC day.

## 0.4.8 - 2026-07-16

### Fixed

- Log redacted per-domain errors from partial daily and weekly summaries to stderr instead of silently hiding upstream failures.
- Expand the executable endpoint contract to prove that Withings date-time filters retain their instant semantics when converted to Unix timestamps, including offset ISO inputs.
- Guard structured privacy output against future upstream-field loss while continuing to remove GPS and secret-bearing values.

## 0.4.7 - 2026-06-27

### Fixed

- **`withings_list_body_measures` now sends date filters as upstream Withings `startdate` / `enddate` Unix timestamps.** Internal MCP parameters such as `after`, `before`, `page`, `privacy_mode` and `response_format` are no longer forwarded to the Withings API.
- **`limit` now protects MCP clients even when the upstream endpoint returns more rows than requested.** Collection tools slice the returned records before building the MCP response, preventing large body-measure histories from exceeding client message limits.
- Invalid `after` / `before` values now fail with a clear ISO 8601 guidance message instead of silently falling back to the current time.

## 0.4.4 - 2026-05-20

### Added

- **`WITHINGS_NO_CACHE` env var now advertised in `server.json`** — the bypass already worked in 0.4.3; this release just surfaces it in the agent-facing manifest so callers discover the opt-out.

## 0.4.3 - 2026-05-20

### Added

- **HTTP response cache middleware** (`src/services/http-cache.ts`) — in-memory cache layered OUTSIDE retry (`fetchWithCache → fetchWithRetry → fetch`), so cached responses skip both network and retry. Default 60s TTL for GET only; POST/PUT/DELETE and 4xx/5xx responses are never cached. Withings's `wbsapi.withings.net` is POST-only today, so the middleware is effectively a no-op for the current call path — it ships so future GET endpoints (or callers wrapping their own GETs) inherit the same caching guarantees as the sibling connectors.
- **`WITHINGS_NO_CACHE=true` env var** — global per-process cache bypass.
- **Per-call `cache_ttl: 0`** request option — opts a single call out of cache without disabling globally.
- **Query-param-order-insensitive cache keys** — `?startdate=…&enddate=…&limit=30` and `?limit=30&enddate=…&startdate=…` share one cache entry.
- **`withings_cache_status` now reports `http_cache` stats** alongside SQLite stats: `size`, `hit_count`, `miss_count`, `hit_rate`, `default_ttl_seconds`, `bypass_env_var`.
- `scripts/http-cache-test.mjs` — eight-case unit suite covering cache hit, POST never cached, TTL expiration, query-param normalization, 4xx not cached, env-var bypass, per-call `cache_ttl: 0`, and `getCacheStats()` math.

## 0.4.2 - 2026-05-19

### Added

- **HTTP retry middleware with exponential backoff + jitter** (`src/services/http-retry.ts`). Every Withings API call (incl. nonce/token requests) now retries on `408`, `429`, `500`, `502`, `503`, `504`, and network errors. Max 3 attempts (initial + 2 retries); backoff schedule `500ms / 1000ms / 2000ms` with ±20% jitter. Honors `Retry-After` (seconds or HTTP-date). Each retry logs to stderr as `[withings-mcp] retry N/3 after Xms (status=Y or error=Z)`. Set `WITHINGS_NO_RETRY=true` to disable (used in tests). No new dependencies.

## 0.4.1 - 2026-05-11

### Fixed

- **Profile-store regex no longer false-positives on common wellness words.** Split `SECRET_PATTERNS` into `SECRET_KEY_PATTERNS` (broad, for field names like `oauth_token`) and `SECRET_VALUE_PATTERNS` (high-specificity, only credential shapes: JWTs, `Bearer <token>`, `sk_live_`, `sk-proj-`, `xoxb-`, `github_pat_`, raw `Authorization:` headers). Previously legitimate text like "5 training sessions per week", "limit cookies", "I need to refresh my approach", or "secret sauce: more sleep" was rejected.
- **Partial-profile reads no longer crash downstream.** `readProfileFile` now structurally merges with `DEFAULT_PROFILE` when legacy Hermes/OpenClaw files lacked sub-objects. Previously `buildProfileSummary` and `missingCriticalFields` would throw.
- **Onboarding `privacy_note` no longer hard-codes a single connector path.** Lists multiple example paths so the message reads correctly from every connector.

## 0.4.0 - 2026-05-11

- Add shared Delx Wellness profile support. Vendored copy of the canonical `profile-store` (delx-wellness commit ab83d1a) at `src/services/profile-store.ts` reads and writes `~/.delx-wellness/profile.json` — a single source of truth for preferred name, goals, devices, training/nutrition/exercise/agent preferences and safety flags shared across every Delx Wellness MCP connector.
- Add `withings_profile_get` — read-only return of the current shared profile plus a summary and missing-critical fields.
- Add `withings_profile_update` — partial-patch writer. Requires `explicit_user_intent=true` (otherwise returns USER_ACTION_REQUIRED). Rejects secret-like fields at write time.
- Add `withings_onboarding` — read-only 11-question onboarding flow (en / pt-BR) plus current profile state and cross-connector hint.
- Add `withings-mcp-server onboarding` CLI command — emits flow JSON to stdout and a TTY-gated Markdown summary to stderr.
- `recommended_first_calls` on the agent manifest now leads with `withings_profile_get`.
- Tool count: 20 → 23.

## 0.3.0 - 2026-05-11

- Add `withings_quickstart` tool — personalized 3-step setup walkthrough adapted to current state (env vars set? OAuth token present? what's next?). Returns cross-connector hints to pair with wellness-nourish, wellness-cycle-coach, and wellness-cgm-mcp.
- Add `withings_demo` tool — realistic example payloads of `withings_daily_summary`, `withings_wellness_context`, and `withings_list_body_measures` with weight 72.5kg, body fat 18.5%, BP 118/76, sleep 7h28m so agents see the contract before any real Withings API call.
- `recommended_first_calls` on the agent manifest now leads with `withings_quickstart` and `withings_demo`.
- Tool count: 18 → 20.

## 0.1.1

- Updated `zod` to `4.4.3` after the initial public repository dependency check.
- Kept package, runtime and MCP registry manifest versions aligned for the first public release line.

## 0.1.0

- Initial Withings MCP implementation.
- Added OAuth setup/auth/doctor CLI with local config and token storage under `~/.withings-mcp/`.
- Added 16 MCP tools, 6 resources and 3 prompts.
- Added signed Withings token flow plus Public API tools for body measures, daily activity, workouts, sleep summaries, sleep periods and heart records.
- Added daily and weekly summaries, privacy modes, SQLite cache support, privacy audit, connection status and Hermes agent manifest checks.
