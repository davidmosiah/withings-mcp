# Hermes Example

```bash
npx -y withings-mcp-unofficial setup --client hermes --no-auth
npx -y withings-mcp-unofficial auth
npx -y withings-mcp-unofficial doctor --client hermes
```

Useful direct tools:

- `mcp_withings_withings_connection_status`
- `mcp_withings_withings_daily_summary`
- `mcp_withings_withings_weekly_summary`
- `mcp_withings_withings_list_body_measures`
- `mcp_withings_withings_list_sleep_summary`
- `mcp_withings_withings_list_heart`

Keep `WITHINGS_CLIENT_SECRET` and OAuth tokens out of prompts, logs and public repos.
