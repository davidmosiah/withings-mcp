# OAuth

Create a Withings app at https://account.withings.com/partner/dashboard_oauth2.

Callback URL:

```text
http://127.0.0.1:3000/callback
```

Recommended scopes:

```text
user.activity user.metrics
```

Run:

```bash
npx -y withings-mcp-unofficial setup
npx -y withings-mcp-unofficial auth
npx -y withings-mcp-unofficial doctor
```
