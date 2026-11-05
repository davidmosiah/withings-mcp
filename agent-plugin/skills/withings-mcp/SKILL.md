---
name: withings-mcp
description: >-
  Read the user's Withings weight, body composition, blood pressure, sleep and activity through the local withings MCP server. Use when the user asks about scale or blood-pressure readings, body composition trends, Withings sleep, or a weekly Withings summary. Starts with connection status, uses synthetic demo data before OAuth, and never asks for secrets in chat.
---

# Withings

MCP server `withings` from the `withings-mcp-unofficial@0.6.0` npm package, run locally through `npx`. It reads weight and body composition, blood pressure, sleep and activity. Data source: the official Withings Public API.

## Workflow

1. Start with `withings_connection_status`. Then pick what fits the question: `withings_daily_summary`, `withings_weekly_summary`.
2. If `withings_connection_status` reports the connector is not ready, call `withings_demo` for clearly labelled synthetic data so the user sees the shape of the answer, then give them the setup commands below to run in their own terminal.
3. Lead with the answer to the user's question, then the two or three numbers that support it, with dates. Say when data is missing or stale instead of filling gaps.

## Setup (the user runs this in a terminal, not in chat)

```bash
npx -y withings-mcp-unofficial@0.6.0 setup --client generic
npx -y withings-mcp-unofficial@0.6.0 auth
npx -y withings-mcp-unofficial@0.6.0 doctor
```

`setup` asks for the Withings developer app client ID and secret and saves them locally (`--client generic` because this plugin already registers the server with Hermes); `auth` opens the Withings consent page in the browser and stores the OAuth tokens under `~/.withings-mcp/` with 0600 permissions; `doctor` confirms readiness.

## Safety

- Upgrades and rollbacks require stopping every Withings instance sharing the token file and upgrading all clients together; old and new token locks do not coordinate. Do not delete live locks or restore an old token backup after rotation. Legacy tokens without `userid` require reauthorization before refresh or multi-page reads. See the repository's `docs/migration-0.6.0.md`; never stop clients or change credentials without the user's request.
- Never ask the user to paste client secrets, passwords, tokens or MFA codes into the chat; setup happens in their terminal.
- Tools that change local state: withings_profile_update (local profile only), withings_exchange_code (stores OAuth tokens locally). Use them only when the user asks.
- Destructive: withings_revoke_access (revokes the Withings grant and deletes local tokens). Confirm with the user first.
- Not medical advice: the data supports personal reflection and planning, not diagnosis or treatment. Point the user to a clinician for symptoms, medication or anything urgent.
