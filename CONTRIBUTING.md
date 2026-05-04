# Contributing

Thanks for improving Withings MCP Unofficial.

Before opening a PR:

```bash
npm install
npm test
```

Guidelines:

- Use only official Withings API endpoints.
- Keep default behavior read-only.
- Treat GPS data as sensitive.
- Do not add write/upload tools without explicit safety gates.
- Do not log or return OAuth tokens.
- Update docs and tests with behavior changes.
