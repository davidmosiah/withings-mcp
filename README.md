# Withings MCP Unofficial

[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-7C3AED?style=flat-square&logo=anthropic&logoColor=white)](https://modelcontextprotocol.io) [![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Provider: Withings](https://img.shields.io/badge/data-Withings-00B0B9?style=flat-square&logo=withings&logoColor=white)](https://withings.com) [![npm version](https://img.shields.io/npm/v/withings-mcp-unofficial?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/withings-mcp-unofficial)


Unofficial, local-first Model Context Protocol server for connecting AI agents to user-authorized Withings data through the official Withings Public API.

It is designed for Claude, Cursor, Windsurf, Hermes, OpenClaw and other MCP clients that need safe access to Withings sleep, activity, body-measure, heart and workout context.

> Not affiliated with, endorsed by, or sponsored by Withings. Not medical advice.

## What It Supports

- OAuth 2.0 authorization code flow with local token storage.
- Body measures such as weight and body composition where available.
- Daily activity summaries and workout records.
- Sleep summaries, duration, efficiency and sleep-stage fields when Withings provides them.
- Heart records when the account, devices and scopes permit it.
- Daily and weekly agent-ready summaries.
- Privacy modes: `summary`, `structured`, `raw`.
- Hermes-focused agent manifest and setup diagnostics.

## Quick Start

Create a Withings app at [account.withings.com/partner/dashboard_oauth2](https://account.withings.com/partner/dashboard_oauth2) and set the callback URL to:

```text
http://127.0.0.1:3000/callback
```

Recommended read scopes:

```text
user.activity user.metrics
```

Then run:

```bash
npx -y withings-mcp-unofficial setup
npx -y withings-mcp-unofficial auth
npx -y withings-mcp-unofficial doctor
```

Start the MCP server:

```bash
npx -y withings-mcp-unofficial
```

## Claude / Cursor / Generic MCP Config

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

## Hermes

```bash
npx -y withings-mcp-unofficial setup --client hermes --no-auth
npx -y withings-mcp-unofficial doctor --client hermes
```

After config changes, reload MCP with `/reload-mcp` or `hermes mcp test withings`. A normal Withings data-access issue should not require restarting the Hermes gateway.

## Tools

Core setup and safety:

- `withings_agent_manifest`
- `withings_capabilities`
- `withings_connection_status`
- `withings_get_auth_url`
- `withings_exchange_code`
- `withings_privacy_audit`
- `withings_cache_status`
- `withings_revoke_access`

Data tools:

- `withings_list_body_measures`
- `withings_list_activity`
- `withings_list_sleep_summary`
- `withings_list_sleep`
- `withings_list_workouts`
- `withings_list_heart`

Workflow tools:

- `withings_daily_summary`
- `withings_weekly_summary`

## Privacy Model

Tokens are stored locally under `~/.withings-mcp/` with user-only permissions. The server never prints access tokens or refresh tokens.

Privacy modes:

- `summary`: minimal fields for safe agent use.
- `structured`: normalized Withings data for analysis.
- `raw`: upstream Withings JSON, only when explicitly requested.

Health data is sensitive. Do not paste raw payloads publicly. This MCP is for personal context and training/wellness reflection, not diagnosis or treatment.

## Development

```bash
npm install
npm test
```

## Links

- Website: https://withingsmcp.vercel.app/
- GitHub: https://github.com/davidmosiah/withingsmcp
- npm: https://www.npmjs.com/package/withings-mcp-unofficial
- Delx Wellness registry: https://github.com/davidmosiah/delx-wellness
- Connector quality standard: https://github.com/davidmosiah/delx-wellness/blob/main/docs/connector-quality-standard.md
- Withings Public API docs: https://developer.withings.com/api-reference/
