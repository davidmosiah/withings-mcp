import { DEFAULT_SCOPES } from "../constants.js";

export function buildCapabilities() {
  return {
    project: "withings-mcp-unofficial",
    mcp_name: "io.github.davidmosiah/withingsmcp",
    creator: { name: "David Mosiah", github: "https://github.com/davidmosiah" },
    unofficial: true,
    api_boundary: {
      source: "Official Withings Public API with OAuth 2.0 and signed token requests",
      raw_definition: "Raw means the full JSON response returned by supported Withings Public API endpoints. Device coverage varies by user devices and API plan.",
      does_not_include: [
        "Advanced Research API raw accelerometer or PPG streams",
        "continuous unrestricted sensor streams",
        "private Withings mobile app endpoints",
        "write/upload actions by default",
        "medical diagnosis or treatment guidance"
      ]
    },
    auth_model: {
      type: "OAuth 2.0 authorization code with refresh tokens",
      token_storage: "Local token file with user-only permissions",
      recommended_redirect_uri: "http://127.0.0.1:3000/callback",
      default_scopes: DEFAULT_SCOPES
    },
    privacy_modes: [
      { mode: "summary", use_when: "Default-safe interpretation with identifiers and profile details minimized." },
      { mode: "structured", use_when: "Normalized activity, sleep, body measure, heart and workout metrics for agents." },
      { mode: "raw", use_when: "The user explicitly needs upstream Withings payloads for debugging or deep analysis." }
    ],
    supported_data: [
      { name: "Body measures", examples: ["weight", "body composition", "blood pressure-capable measure groups"], tools: ["withings_list_body_measures"] },
      { name: "Activity and workouts", examples: ["steps", "calories", "distance", "workout summaries"], tools: ["withings_list_activity", "withings_list_workouts"] },
      { name: "Sleep", examples: ["sleep score", "duration", "sleep efficiency", "stages", "snoring where available"], tools: ["withings_list_sleep_summary", "withings_list_sleep", "withings_daily_summary", "withings_weekly_summary"] },
      { name: "Heart records", examples: ["heart lists/records where available by device and scope"], tools: ["withings_list_heart"] }
    ],
    recommended_agent_flow: [
      "Call withings_agent_manifest when installing or operating inside a server agent such as Hermes.",
      "Call withings_connection_status before calling Withings data tools.",
      "If setup is incomplete, guide the user through setup, auth and doctor.",
      "Use withings_daily_summary or withings_weekly_summary before low-level endpoint tools.",
      "Treat health data as sensitive; avoid raw payloads unless explicitly requested.",
      "Use Withings as trend context, not medical diagnosis. Escalate symptoms or abnormal vitals to clinicians."
    ],
    client_aliases: {
      hermes: {
        tool_prefix: "mcp_withings_",
        direct_tools: ["mcp_withings_withings_agent_manifest", "mcp_withings_withings_connection_status", "mcp_withings_withings_daily_summary", "mcp_withings_withings_weekly_summary"],
        reload_command: "/reload-mcp",
        gateway_restart_required_for_data_access: false
      }
    },
    contribution_paths: [
      "Improve non-technical setup UX.",
      "Add more MCP client examples and screenshots.",
      "Add richer Withings endpoint coverage for goals, devices and notifications after API-plan validation.",
      "Add evaluations for realistic health and training questions.",
      "Consider optional write tools only behind explicit opt-in and safety gates."
    ],
    links: {
      github: "https://github.com/davidmosiah/withingsmcp",
      docs: "https://withingsmcp.vercel.app/",
      npm: "https://www.npmjs.com/package/withings-mcp-unofficial",
      withings_api_docs: "https://developer.withings.com/api-reference/",
      withings_auth_docs: "https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/oauth-web-flow/",
      withings_apps: "https://account.withings.com/partner/dashboard_oauth2"
    }
  };
}
