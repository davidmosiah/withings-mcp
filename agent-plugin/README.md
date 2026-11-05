# Withings — Agent Plugins package

Portable [Agent Plugins](https://agent-plugins.org/) v1 package for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) and other Agent Plugins clients:
the `withings` MCP server (`withings-mcp-unofficial@0.6.0` over stdio) plus the `withings-mcp` workflow skill.

## Install (Hermes Agent)

```bash
hermes plugins install davidmosiah/withings-mcp/agent-plugin --no-enable
hermes plugins enable withings-mcp
```

Requires Node.js 20+ (`npx` on PATH). The skill loads as `withings-mcp:withings-mcp`.

## Connector setup

Before upgrading from 0.5.x, stop every Withings connector instance sharing the token file and upgrade all clients together. Old and new builds use different token-lock implementations and must not run concurrently; rollback requires the same coordinated stop. Keep the current token file and do not delete live locks. See [migration notes](../docs/migration-0.6.0.md). Legacy tokens without `userid` require reauthorization before refresh or multi-page reads.

```bash
npx -y withings-mcp-unofficial@0.6.0 setup --client generic
npx -y withings-mcp-unofficial@0.6.0 auth
npx -y withings-mcp-unofficial@0.6.0 doctor
```

`setup` asks for the Withings developer app client ID and secret and saves them locally (`--client generic` because this plugin already registers the server with Hermes); `auth` opens the Withings consent page in the browser and stores the OAuth tokens under `~/.withings-mcp/` with 0600 permissions; `doctor` confirms readiness.

## Disclosure

Runs the `withings-mcp-unofficial@0.6.0` npm package locally over stdio through `npx` (Node.js 20+ required); the package is downloaded from npm on first start. Data source: the official Withings Public API. Credentials and OAuth tokens are created by the connector's own `setup`/`auth` commands in the user's terminal and stay on the machine (`~/.withings-mcp/`); the plugin declares no environment variables and reads no Hermes credentials. Tools that change state: withings_profile_update (local profile only); withings_exchange_code (stores OAuth tokens locally); withings_revoke_access (revokes the Withings grant and deletes local tokens). The tool set comes from the pinned npm version, not from this repository's source tree.
