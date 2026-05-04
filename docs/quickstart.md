# Withings MCP Quickstart

1. Create a Withings app at https://account.withings.com/partner/dashboard_oauth2
2. Set callback URL: `http://127.0.0.1:3000/callback`
3. Use scopes: `user.activity user.metrics`
4. Run:

```bash
npx -y withings-mcp-unofficial setup
npx -y withings-mcp-unofficial auth
npx -y withings-mcp-unofficial doctor
```

Add to your MCP client:

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
