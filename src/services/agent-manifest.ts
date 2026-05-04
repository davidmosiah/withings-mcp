import { NPM_PACKAGE_NAME, PINNED_NPM_PACKAGE, SERVER_VERSION, DEFAULT_SCOPES } from "../constants.js";

export const AGENT_CLIENTS = ["generic", "claude", "cursor", "windsurf", "hermes", "openclaw"] as const;
export type AgentClientName = typeof AGENT_CLIENTS[number];

export const HERMES_DIRECT_TOOLS = [
  "mcp_withings_withings_agent_manifest",
  "mcp_withings_withings_connection_status",
  "mcp_withings_withings_daily_summary",
  "mcp_withings_withings_weekly_summary",
  "mcp_withings_withings_list_activity",
  "mcp_withings_withings_list_sleep_summary",
  "mcp_withings_withings_list_body_measures"
];

const STANDARD_TOOLS = [
  "withings_agent_manifest",
  "withings_capabilities",
  "withings_connection_status",
  "withings_get_auth_url",
  "withings_exchange_code",
  "withings_list_body_measures",
  "withings_list_activity",
  "withings_list_workouts",
  "withings_list_sleep_summary",
  "withings_list_sleep",
  "withings_list_heart",
  "withings_daily_summary",
  "withings_weekly_summary",
  "withings_privacy_audit",
  "withings_cache_status",
  "withings_revoke_access"
];

const RESOURCES = ["withings://agent-manifest", "withings://capabilities", "withings://latest/activity", "withings://latest/sleep", "withings://summary/daily", "withings://summary/weekly"];

export function parseAgentClientName(value: string): AgentClientName {
  return AGENT_CLIENTS.includes(value as AgentClientName) ? value as AgentClientName : "generic";
}

export function buildAgentManifest(client: AgentClientName = "generic") {
  return {
    project: "withings-mcp-unofficial",
    mcp_name: "io.github.davidmosiah/withingsmcp",
    client,
    unofficial: true,
    package: {
      name: NPM_PACKAGE_NAME,
      version: SERVER_VERSION,
      install_command: `npx -y ${NPM_PACKAGE_NAME}`,
      pinned_install_command: `npx -y ${PINNED_NPM_PACKAGE}`,
      binary: "withings-mcp-server"
    },
    oauth: {
      provider: "Withings Public API",
      redirect_uri: "http://127.0.0.1:3000/callback",
      scopes: DEFAULT_SCOPES,
      token_storage: "~/.withings-mcp/tokens.json with 0600 permissions",
      secret_storage: "~/.withings-mcp/config.json or WITHINGS_* environment variables; never print secrets"
    },
    recommended_first_calls: ["withings_connection_status", "withings_daily_summary", "withings_weekly_summary"],
    standard_tools: STANDARD_TOOLS,
    resources: RESOURCES,
    hermes: {
      config_path: "~/.hermes/config.yaml",
      skill_path: "~/.hermes/skills/withings-mcp/SKILL.md",
      tool_name_prefix: "mcp_withings_",
      common_tool_names: HERMES_DIRECT_TOOLS,
      recommended_config: hermesConfigSnippet(),
      use_direct_tools: true,
      avoid_terminal_workarounds: true,
      no_gateway_restart_for_data_access: true,
      reload_after_config_change: "/reload-mcp or hermes mcp test withings",
      doctor_command: "npx -y withings-mcp-unofficial doctor --client hermes --json"
    },
    agent_rules: [
      "Call withings_connection_status before Withings data tools.",
      "If setup is incomplete, guide the user through setup, auth and doctor instead of guessing token state.",
      "Treat Withings health data as sensitive. Do not expose raw payloads unless the user asks for raw mode.",
      "Body, sleep, heart and workout fields depend on the user's Withings devices, API plan, scopes and consent; explain missing data clearly.",
      "For Hermes, do not restart the gateway for normal Withings data access; reload MCP instead.",
      "Do not provide medical diagnosis or treatment instructions. Frame outputs as health/training context."
    ],
    troubleshooting: [
      { symptom: "missing WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET / WITHINGS_REDIRECT_URI", action: "Run `withings-mcp-server setup` or set WITHINGS_* env vars." },
      { symptom: "401 or expired token", action: "Run `withings-mcp-server auth` again; tokens refresh automatically when refresh_token is present." },
      { symptom: "sleep, heart or measure endpoint forbidden", action: "Confirm Withings scopes, device coverage and API-plan access; re-authorize if needed." },
      { symptom: "Hermes configured but tools unavailable", action: "Run `/reload-mcp` or `hermes mcp test withings`; do not restart gateway for normal reload." }
    ],
    links: {
      github: "https://github.com/davidmosiah/withingsmcp",
      docs: "https://withingsmcp.vercel.app/",
      npm: "https://www.npmjs.com/package/withings-mcp-unofficial",
      withings_apps: "https://account.withings.com/partner/dashboard_oauth2",
      withings_api_docs: "https://developer.withings.com/api-reference/"
    }
  };
}

export function formatAgentManifestMarkdown(manifest: ReturnType<typeof buildAgentManifest>): string {
  return `# Withings MCP Agent Manifest

Unofficial: ${manifest.unofficial}
Package: \`${manifest.package.name}\` v${manifest.package.version}
Install: \`${manifest.package.install_command}\`
Pinned install: \`${manifest.package.pinned_install_command}\`

## OAuth
Provider: ${manifest.oauth.provider}
Redirect URI: \`${manifest.oauth.redirect_uri}\`
Scopes: \`${manifest.oauth.scopes.join(" ")}\`
Tokens: ${manifest.oauth.token_storage}

## First Calls
${manifest.recommended_first_calls.map((tool) => `- \`${tool}\``).join("\n")}

## Hermes
Config: \`${manifest.hermes.config_path}\`
Skill: \`${manifest.hermes.skill_path}\`
Reload: \`${manifest.hermes.reload_after_config_change}\`
Direct tools:
${manifest.hermes.common_tool_names.map((tool) => `- \`${tool}\``).join("\n")}

## Agent Rules
${manifest.agent_rules.map((rule) => `- ${rule}`).join("\n")}
`;
}

export function hermesConfigSnippet(): string {
  return `mcp_servers:\n  withings:\n    command: npx\n    args:\n      - -y\n      - ${PINNED_NPM_PACKAGE}`;
}

export function hermesSkillMarkdown(): string {
  return `# Withings MCP Skill

Use this skill whenever a user asks Hermes to inspect Withings body measures, activity, sleep, heart records, workouts, daily summaries or weekly summaries through the Withings MCP.

## Rules
- Start with \`mcp_withings_withings_connection_status\`.
- Prefer \`mcp_withings_withings_daily_summary\` and \`mcp_withings_withings_weekly_summary\` before low-level endpoint calls.
- Treat Withings data as sensitive. Do not request raw payloads unless the user explicitly asks.
- Do not diagnose or treat medical conditions.
- Reload MCP with \`/reload-mcp\` or \`hermes mcp test withings\`; do not restart the gateway for normal data access.
`;
}
