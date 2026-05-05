# withings-mcp-server

[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-7C3AED?style=flat-square&logo=anthropic&logoColor=white)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Provider: Withings](https://img.shields.io/badge/data-Withings-00B0B9?style=flat-square)](https://withings.com)
[![npm version](https://img.shields.io/npm/v/withings-mcp-unofficial?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/withings-mcp-unofficial)
[![Delx Wellness](https://img.shields.io/badge/part%20of-Delx%20Wellness-0ea5a3?style=flat-square)](https://github.com/davidmosiah/delx-wellness)

**Local-first MCP server that connects AI agents to your Withings body, sleep, activity and heart data.**

> **Unofficial project.** Not affiliated with, endorsed by or supported by Withings. Withings is a trademark of its respective owner. Use this only with your own Withings account and in line with the Withings Public API terms.

Built by [David Mosiah](https://github.com/davidmosiah) for people who use Claude, Cursor, Hermes, OpenClaw or other MCP-compatible agents to think about body composition, sleep and long-term health trends — without copy-pasting numbers from the Withings app.

Part of [Delx Wellness](https://github.com/davidmosiah/delx-wellness), a registry of local-first wellness MCP connectors.

## Why this exists

Withings has the longest-running consumer body-composition and sleep ecosystem (smart scales, Sleep Analyzer, ScanWatch). The data is rich — punctual weight + body fat + muscle mass measurements, sleep stages, ECG-grade heart records — but the Withings Public API uses a signed-token OAuth flow that's heavier than most consumer APIs.

This package handles the signed OAuth dance locally, normalizes responses, and exposes Withings through the Model Context Protocol. Tokens never leave your machine. Privacy-mode defaults keep raw payloads opt-in.

## Setup in 60 seconds

You'll need a Withings app ([create one here](https://account.withings.com/partner/dashboard_oauth2)) with redirect URI `http://127.0.0.1:3000/callback`.

```bash
npx -y withings-mcp-unofficial setup    # interactive: paste client id + secret
npx -y withings-mcp-unofficial auth     # opens browser, captures the OAuth code
npx -y withings-mcp-unofficial doctor   # verifies you're ready
```

Recommended scopes:

```text
user.activity user.metrics
```

Then add this to your MCP client config:

```json
{
  "mcpServers": {
    "withings": {
      "command": "npx",
      "args": ["-y", "withings-mcp-unofficial"]
    }
  }
}
```

For Claude Desktop, run `setup --client claude` and the snippet is written for you.

> **Note:** Withings OAuth authorization codes are short-lived (a few minutes). Don't pause between approving the consent screen and `withings_exchange_code` running.

## Try it with your agent

Three things to ask first:

```text
Use withings_connection_status to check setup, then run withings_daily_summary.
Give me a 5-line wellness brief for today.
```

```text
Call withings_weekly_summary with response_format=json. Identify my biggest
sleep/body bottleneck and give me a next-week plan.
```

```text
Use the withings_body_sleep_investigation prompt, after=2026-04-01.
Walk me through what changed in body composition + sleep.
```

## Data availability

This package uses the official Withings Public API. When this README says `raw`, it means the upstream Withings JSON for a supported endpoint — not raw device sensor streams.

| Data | Available | Notes |
|---|:---:|---|
| Body measures (weight, fat %, muscle, bone, water) | ✓ | Requires `user.metrics` scope |
| Daily activity (steps, calories, distance, intensity) | ✓ | Requires `user.activity` scope |
| Workouts + sport metadata | ✓ | Requires `user.activity` scope |
| Sleep summaries (duration, stages, efficiency, HR) | ✓ | Requires `user.activity` scope |
| Sleep detail records | ✓ | When the device exposes them |
| Heart records (ECG, BP, etc.) | ✓ | Requires `user.metrics` scope; varies by device/plan |
| Continuous sensor telemetry | — | Not exposed by Withings Public API |

## Tools

**Start with these:**

- `withings_connection_status` — verify local setup before calling Withings
- `withings_daily_summary` — body, sleep, activity and heart brief for today
- `withings_weekly_summary` — scorecard, comparison vs prior week, next-week plan

**Auth & diagnostics**

- `withings_capabilities`, `withings_agent_manifest`, `withings_privacy_audit`, `withings_cache_status`
- `withings_get_auth_url`, `withings_exchange_code`, `withings_revoke_access`

**Body & metrics**

- `withings_list_body_measures` — punctual weight/composition records
- `withings_list_heart` — heart records when device/plan permit

**Activity**

- `withings_list_activity` — daily activity summaries
- `withings_list_workouts` — logged workouts

**Sleep**

- `withings_list_sleep_summary` — daily sleep summaries with HR/stage fields
- `withings_list_sleep` — detailed sleep records

## Prompts

- `withings_daily_checkin` — practical daily health and body check-in
- `withings_weekly_review` — review trends across body, sleep, activity
- `withings_body_sleep_investigation` — investigate body measures + sleep together

## Resources

- `withings://capabilities`, `withings://agent-manifest`
- `withings://latest/activity`, `withings://latest/sleep`
- `withings://summary/daily`, `withings://summary/weekly`

## Privacy & security

- OAuth tokens are stored in `~/.withings-mcp/tokens.json` with `0600` permissions and are never returned by tools.
- Withings uses a signed-request OAuth flow — the package handles signing locally; client secrets never reach the MCP client.
- The server never prints access or refresh tokens.
- `WITHINGS_PRIVACY_MODE` defaults to `structured`. Raw Withings JSON is opt-in via `raw` mode or per-call override.
- `withings_revoke_access` clears local tokens; full account-side token revocation depends on your Withings plan.
- The MCP client never sees access or refresh tokens.
- This is **not medical advice**. Withings exposes data that may resemble medical signals (ECG, blood pressure) but this server is for personal AI workflows, not diagnosis or treatment.

## Configuration

`setup` writes most of these into `~/.withings-mcp/config.json` (`0600`). Manual env override is supported:

```bash
WITHINGS_CLIENT_ID=…
WITHINGS_CLIENT_SECRET=…
WITHINGS_REDIRECT_URI=http://127.0.0.1:3000/callback

# Optional
WITHINGS_SCOPES="user.activity user.metrics"
WITHINGS_PRIVACY_MODE=structured        # summary | structured | raw
WITHINGS_CACHE=sqlite                   # optional read-through cache
WITHINGS_TOKEN_PATH=~/.withings-mcp/tokens.json
WITHINGS_CACHE_PATH=~/.withings-mcp/cache.sqlite
```

## Hermes / remote setup

```bash
npx -y withings-mcp-unofficial setup --client hermes --no-auth
npx -y withings-mcp-unofficial auth                      # run locally if browser auth is needed
npx -y withings-mcp-unofficial doctor --client hermes
hermes mcp test withings
```

After Hermes config changes, use `/reload-mcp` or `hermes mcp test withings`. Don't restart the gateway for normal data access.

If browser OAuth has to happen on a different machine than Hermes, run `auth` locally and copy `~/.withings-mcp/tokens.json` to the server with `chmod 600`.

## Requirements

- Node.js 20+
- A Withings app at <https://account.withings.com/partner/dashboard_oauth2> with redirect URI `http://127.0.0.1:3000/callback`

## Development

```bash
git clone https://github.com/davidmosiah/withingsmcp.git
cd withingsmcp
npm install
npm test
npm run build
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Links

- npm: <https://www.npmjs.com/package/withings-mcp-unofficial>
- Docs site: <https://wellness.delx.ai/connectors/withings>
- Legacy docs: <https://withingsmcp.vercel.app/>
- GitHub: <https://github.com/davidmosiah/withingsmcp>
- Delx Wellness registry: <https://github.com/davidmosiah/delx-wellness>
- Connector quality standard: <https://github.com/davidmosiah/delx-wellness/blob/main/docs/connector-quality-standard.md>
- Withings Public API docs: <https://developer.withings.com/api-reference/>

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

This software is provided as-is. It is not a medical device, does not provide medical advice, and should not be used for diagnosis or treatment. Withings exposes data that may resemble medical signals (ECG, blood pressure, body composition) — always consult qualified professionals for medical concerns.
