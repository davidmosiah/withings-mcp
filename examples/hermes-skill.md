# Withings MCP Skill

Use this skill whenever a user asks Hermes to inspect Withings activity, sleep, body measures, heart records, workouts, daily summaries or weekly summaries.

Rules:

- Start with `mcp_withings_withings_connection_status`.
- Prefer `mcp_withings_withings_daily_summary` and `mcp_withings_withings_weekly_summary` before low-level endpoint calls.
- Treat Withings data as sensitive. Do not request raw payloads unless the user explicitly asks.
- Do not diagnose or treat medical conditions.
- Reload MCP with `/reload-mcp` or `hermes mcp test withings`; do not restart the gateway for normal data access.
