import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AgentManifestInputSchema,
  AgentManifestOutputSchema,
  AuthUrlInputSchema,
  AuthUrlOutputSchema,
  CacheStatusOutputSchema,
  CapabilitiesOutputSchema,
  CollectionInputSchema,
  CollectionOutputSchema,
  ConnectionStatusInputSchema,
  ConnectionStatusOutputSchema,
  DailySummaryInputSchema,
  ExchangeCodeInputSchema,
  ExchangeCodeOutputSchema,
  PrivacyAuditOutputSchema,
  RevokeAccessOutputSchema,
  ResponseOnlyInputSchema,
  SummaryOutputSchema,
  WeeklySummaryInputSchema
} from "../schemas/common.js";
import { buildAgentManifest, formatAgentManifestMarkdown } from "../services/agent-manifest.js";
import { buildPrivacyAudit } from "../services/audit.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildConnectionStatus } from "../services/connection-status.js";
import { getConfig } from "../services/config.js";
import { bulletList, formatCollection, makeError, makeResponse } from "../services/format.js";
import { applyPrivacy, resolvePrivacyMode } from "../services/privacy.js";
import { buildDailySummary, buildWeeklySummary, formatSummaryMarkdown } from "../services/summary.js";
import { WithingsClient } from "../services/withings-client.js";

const SLEEP_SUMMARY_FIELDS = [
  "sleep_score",
  "total_sleep_time",
  "total_timeinbed",
  "sleep_efficiency",
  "deepsleepduration",
  "lightsleepduration",
  "remsleepduration",
  "wakeupduration",
  "hr_average",
  "hr_min",
  "hr_max",
  "rr_average",
  "snoring",
  "snoringepisodecount"
].join(",");

function client(): WithingsClient {
  return new WithingsClient(getConfig());
}

function registerCollectionTool(server: McpServer, name: string, title: string, endpoint: string, action: string, description: string, extra: Record<string, string | number | boolean> = {}): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: CollectionInputSchema.shape,
      outputSchema: CollectionOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (params) => {
      try {
        const config = getConfig();
        const privacyMode = resolvePrivacyMode(config, params.privacy_mode);
        const result = await new WithingsClient(config).list(endpoint, { ...params, action, ...extra });
        const records = applyPrivacy(endpoint, { records: result.records }, privacyMode) as { records: unknown[] };
        const output = {
          endpoint,
          privacy_mode: privacyMode,
          count: records.records.length,
          records: records.records,
          next_page: result.next_page,
          has_more: Boolean(result.next_page),
          pages_fetched: result.pages_fetched
        };
        return makeResponse(output, params.response_format, formatCollection(title, records.records, output));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );
}

export function registerWithingsTools(server: McpServer): void {
  server.registerTool("withings_agent_manifest", {
    title: "Withings Agent Manifest",
    description: "Machine-readable install, runtime and client guidance for AI agents. Does not call Withings or expose secrets.",
    inputSchema: AgentManifestInputSchema.shape,
    outputSchema: AgentManifestOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ client: targetClient, response_format }) => {
    const manifest = buildAgentManifest(targetClient);
    return makeResponse(manifest, response_format, formatAgentManifestMarkdown(manifest));
  });

  server.registerTool("withings_capabilities", {
    title: "Withings MCP Capabilities",
    description: "Explain supported Withings data, privacy boundaries, recommended agent workflow and project links.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: CapabilitiesOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const capabilities = buildCapabilities();
    return makeResponse(capabilities, response_format, bulletList("Withings MCP Capabilities", {
      project: capabilities.project,
      unofficial: capabilities.unofficial,
      api_boundary: capabilities.api_boundary.source,
      recommended_first_tools: "withings_connection_status, withings_daily_summary, withings_weekly_summary",
      docs: capabilities.links.docs
    }));
  });

  server.registerTool("withings_get_auth_url", {
    title: "Get Withings OAuth URL",
    description: "Generate a Withings OAuth authorization URL. Use this first when no local token exists.",
    inputSchema: AuthUrlInputSchema.shape,
    outputSchema: AuthUrlOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (params) => {
    try {
      const config = getConfig();
      const url = new WithingsClient(config).authUrl(params.state, params.scopes);
      const output = { auth_url: url, redirect_uri: config.redirectUri, scopes: params.scopes?.length ? params.scopes : config.scopes, next_step: "Open auth_url, approve access, then pass the returned code or full redirect URL to withings_exchange_code within Withings' short authorization-code window." };
      return makeResponse(output, params.response_format, bulletList("Withings OAuth URL", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("withings_exchange_code", {
    title: "Exchange Withings OAuth Code",
    description: "Exchange a Withings OAuth authorization code for local tokens using Withings signed request flow. Tokens are stored locally and never returned.",
    inputSchema: ExchangeCodeInputSchema.shape,
    outputSchema: ExchangeCodeOutputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (params) => {
    try {
      const result = await client().exchangeCode(params.code);
      const output = { ...result, note: "Token values were stored locally and intentionally omitted from this response." };
      return makeResponse(output, params.response_format, bulletList("Withings OAuth Exchange", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  registerCollectionTool(server, "withings_list_body_measures", "Withings Body Measures", "/measure", "getmeas", "List Withings punctual measurements such as weight and body composition. Requires user.metrics scope.");
  registerCollectionTool(server, "withings_list_activity", "Withings Daily Activity", "/v2/measure", "getactivity", "List Withings daily activity summaries. Requires user.activity scope.");
  registerCollectionTool(server, "withings_list_workouts", "Withings Workouts", "/v2/measure", "getworkouts", "List Withings workouts. Requires user.activity scope.");
  registerCollectionTool(server, "withings_list_sleep_summary", "Withings Sleep Summaries", "/v2/sleep", "getsummary", "List Withings sleep summaries with common sleep fields. Requires user.activity scope.", { data_fields: SLEEP_SUMMARY_FIELDS });
  registerCollectionTool(server, "withings_list_sleep", "Withings Sleep Detail", "/v2/sleep", "get", "List detailed Withings sleep data where available. Requires user.activity scope.");
  registerCollectionTool(server, "withings_list_heart", "Withings Heart Records", "/v2/heart", "list", "List Withings heart records where available. Requires user.metrics scope.");

  server.registerTool("withings_connection_status", {
    title: "Withings Connection Status",
    description: "Check local Withings config, token file, Node version, privacy mode, cache readiness and optional MCP client readiness without calling Withings or exposing secrets.",
    inputSchema: ConnectionStatusInputSchema.shape,
    outputSchema: ConnectionStatusOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format, client: targetClient }) => {
    const status = await buildConnectionStatus({ client: targetClient });
    return makeResponse(status, response_format, bulletList("Withings Connection Status", {
      ok: status.ok,
      ready_for_withings_api: status.ready_for_withings_api,
      missing_env: status.missing_env.join(", ") || "none",
      scope_status: status.oauth.scope_status,
      token_path: status.token.path,
      token_exists: status.token.exists,
      privacy_mode: status.privacy_mode,
      next_steps: status.next_steps.join(" | ")
    }));
  });

  server.registerTool("withings_cache_status", {
    title: "Withings Cache Status",
    description: "Show optional local SQLite cache status. Enable with WITHINGS_CACHE=sqlite or WITHINGS_CACHE=true.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: CacheStatusOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    try {
      const status = client().cacheStatus();
      return makeResponse(status, response_format, bulletList("Withings Cache Status", status));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("withings_privacy_audit", {
    title: "Withings Privacy Audit",
    description: "Return local privacy, cache, token-path and env-presence posture without revealing secret values.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: PrivacyAuditOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const audit = buildPrivacyAudit();
    return makeResponse(audit, response_format, bulletList("Withings Privacy Audit", audit));
  });

  server.registerTool("withings_revoke_access", {
    title: "Clear Withings Local Access",
    description: "Delete the local Withings token file. Withings token revocation support varies by app/API plan, so this tool only clears local access.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: RevokeAccessOutputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ response_format }) => {
    try {
      const result = await client().revokeAccess();
      const output = { ...result, note: "Local Withings tokens were removed. Re-authorize before future API calls." };
      return makeResponse(output, response_format, bulletList("Withings Local Access Cleared", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("withings_daily_summary", {
    title: "Withings Daily Wellness Summary",
    description: "Build a practical daily summary from Withings activity, sleep and body/heart data when available. Read-only and non-medical.",
    inputSchema: DailySummaryInputSchema.shape,
    outputSchema: SummaryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const summary = await buildDailySummary(client(), params);
      return makeResponse(summary, params.response_format, formatSummaryMarkdown(summary));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("withings_weekly_summary", {
    title: "Withings Weekly Wellness Review",
    description: "Build a weekly Withings scorecard with sleep, activity, body measures, bottlenecks and actions. Read-only and non-medical.",
    inputSchema: WeeklySummaryInputSchema.shape,
    outputSchema: SummaryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const summary = await buildWeeklySummary(client(), params);
      return makeResponse(summary, params.response_format, formatSummaryMarkdown(summary));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });
}
