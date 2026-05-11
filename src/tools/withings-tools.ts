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
  DataInventoryOutputSchema,
  ExchangeCodeInputSchema,
  ExchangeCodeOutputSchema,
  PrivacyAuditOutputSchema,
  ResponseOnlyInputSchema,
  RevokeAccessOutputSchema,
  SummaryOutputSchema,
  WeeklySummaryInputSchema,
  WellnessContextInputSchema,
  WellnessContextOutputSchema
} from "../schemas/common.js";
import { z } from "zod";
import { buildAgentManifest, formatAgentManifestMarkdown } from "../services/agent-manifest.js";
import { buildPrivacyAudit } from "../services/audit.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildDataInventory, formatInventoryMarkdown } from "../services/inventory.js";
import { buildConnectionStatus } from "../services/connection-status.js";
import { getConfig } from "../services/config.js";
import { bulletList, formatCollection, makeError, makeResponse } from "../services/format.js";
import { applyPrivacy, resolvePrivacyMode } from "../services/privacy.js";
import {
  buildProfileSummary,
  getOnboardingFlow,
  getProfile,
  getProfilePath,
  missingCriticalFields,
  updateProfile,
  type WellnessProfileDocument
} from "../services/profile-store.js";
import { buildDailySummary, buildWeeklySummary, formatSummaryMarkdown } from "../services/summary.js";
import { buildWellnessContext, formatWellnessContextMarkdown } from "../services/context.js";
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
  server.registerTool("withings_data_inventory", {
    title: "Withings Data Inventory",
    description: "Inventory supported Withings data domains, auth scope requirements, privacy boundary and recommended first calls. Does not call Withings APIs or expose user data.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: DataInventoryOutputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async ({ response_format }) => {
    const inventory = buildDataInventory();
    return makeResponse(inventory, response_format, formatInventoryMarkdown(inventory));
  });
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

  server.registerTool(
    "withings_quickstart",
    {
      title: "Withings Quickstart",
      description:
        "Personalized 3-step setup walkthrough for the human user. Adapts to current state (env vars set? token present? what's next?). Call this first when the user asks 'how do I connect Withings?'",
      inputSchema: ResponseOnlyInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ response_format }) => {
      const status = await buildConnectionStatus();
      const hasEnv = status.missing_env.length === 0;
      const hasToken = status.ready_for_withings_api;
      const steps = [
        {
          step: 1,
          title: hasEnv ? "(done) Withings developer credentials configured" : "Sign up at https://account.withings.com/partner/dashboard_oauth2",
          action: hasEnv
            ? "WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REDIRECT_URI are all set."
            : `Create a Withings developer app, register a redirect URI (use ${status.redirect_uri ?? "http://127.0.0.1:3000/callback"}), then set: ${status.missing_env.join(", ")}.`,
          done: hasEnv,
        },
        {
          step: 2,
          title: hasToken ? "(done) Local token present — ready to read Withings data" : "Run the OAuth dance",
          action: hasToken
            ? "Tokens stored under ~/.withings-mcp/tokens.json. The connector will refresh automatically when needed."
            : "Run `withings-mcp-server auth` (or call withings_get_auth_url + withings_exchange_code from the agent). Open the URL, grant access, paste the code within Withings' short authorization-code window.",
          done: hasToken,
        },
        {
          step: 3,
          title: "Verify with the agent",
          action: "Call withings_connection_status, then withings_daily_summary or withings_wellness_context. Pair with wellness-nourish for weight-aware meal coaching.",
          example: hasToken
            ? "withings_wellness_context() → sleep + body composition + activity handoff for nourish/cycle-coach."
            : "Until step 2 is done, the data tools will surface a clear 'auth required' message.",
          done: false,
        },
      ];
      const payload = {
        ok: true,
        ready: hasEnv && hasToken,
        steps,
        next: steps.find((s) => !s.done) ?? steps[steps.length - 1],
        cross_connector_hints: [
          "Pair Withings body composition with wellness-nourish for weight-trend-aware meal coaching.",
          "Pair Withings sleep + HR with wellness-cycle-coach for late-luteal load adjustments.",
          "Pair Withings BP + sleep with wellness-cgm-mcp glucose for metabolic-stress signals.",
        ],
      };
      const markdown = bulletList("Withings Quickstart", {
        ready: payload.ready,
        next: payload.next.title,
      });
      return makeResponse(payload, response_format, markdown);
    }
  );

  server.registerTool(
    "withings_demo",
    {
      title: "Withings Demo",
      description:
        "Returns realistic example payloads of withings_daily_summary, withings_wellness_context, and withings_list_body_measures so agents see the contract before calling real Withings APIs.",
      inputSchema: ResponseOnlyInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ response_format }) => {
      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        ok: true,
        is_demo: true,
        sample: {
          withings_daily_summary: {
            date: today,
            body: { weight_kg: 72.5, body_fat_pct: 18.5, muscle_mass_kg: 56.1, water_pct: 58.4, bone_mass_kg: 3.2 },
            blood_pressure: { systolic_mmhg: 118, diastolic_mmhg: 76, heart_rate_bpm: 62 },
            sleep: { sleep_score: 78, total_sleep_min: 448, sleep_efficiency: 0.91, deep_min: 84, rem_min: 96, light_min: 268, hr_average_bpm: 56, hr_min_bpm: 50 },
            activity: { steps: 8_421, active_calories: 489, distance_m: 6_870, moderate_min: 41, intense_min: 12 },
          },
          withings_wellness_context: {
            window: "last_24h",
            sleep_score: 78,
            sleep_duration_min: 448,
            weight_kg: 72.5,
            body_fat_pct: 18.5,
            blood_pressure: "118/76",
            resting_hr_bpm: 56,
            recommendation: "Solid sleep duration (7h28m) and stable weight trend — good baseline for moderate training today. Hydrate before noon; resting HR is slightly elevated.",
          },
          withings_list_body_measures: {
            count: 3,
            records: [
              { date: today, weight_kg: 72.5, body_fat_pct: 18.5, muscle_mass_kg: 56.1 },
              { date: yesterdayISO(), weight_kg: 72.7, body_fat_pct: 18.7, muscle_mass_kg: 55.9 },
              { date: dayBeforeISO(), weight_kg: 72.9, body_fat_pct: 18.9, muscle_mass_kg: 55.8 },
            ],
          },
        },
        notes: [
          "All sample data is synthetic; tagged with is_demo=true.",
          "Real calls return live data from the Withings Public API after OAuth setup.",
        ],
      };
      const markdown = bulletList("Withings Demo", {
        is_demo: true,
        weight_kg: 72.5,
        body_fat_pct: 18.5,
        blood_pressure: "118/76",
        sleep_duration: "7h28m",
        recommendation: payload.sample.withings_wellness_context.recommendation,
      });
      return makeResponse(payload, response_format, markdown);
    }
  );

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

  registerCollectionTool(server, "withings_list_body_measures", "Withings Body Measures", "/measure", "getmeas", "List Withings punctual measurements such as weight and body composition. Requires user.metrics scope. Not medical advice.");
  registerCollectionTool(server, "withings_list_activity", "Withings Daily Activity", "/v2/measure", "getactivity", "List Withings daily activity summaries. Requires user.activity scope.");
  registerCollectionTool(server, "withings_list_workouts", "Withings Workouts", "/v2/measure", "getworkouts", "List Withings workouts. Requires user.activity scope.");
  registerCollectionTool(server, "withings_list_sleep_summary", "Withings Sleep Summaries", "/v2/sleep", "getsummary", "List Withings sleep summaries with common sleep fields. Requires user.activity scope. Not medical advice.", { data_fields: SLEEP_SUMMARY_FIELDS });
  registerCollectionTool(server, "withings_list_sleep", "Withings Sleep Detail", "/v2/sleep", "get", "List detailed Withings sleep data where available. Requires user.activity scope. Not medical advice.");
  registerCollectionTool(server, "withings_list_heart", "Withings Heart Records", "/v2/heart", "list", "List Withings heart records where available. Requires user.metrics scope. Not medical advice.");

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

  server.registerTool("withings_wellness_context", {
    title: "Withings Wellness Context",
    description: "Normalize Withings sleep and activity load into the shared wellness_context shape for recommendation engines.",
    inputSchema: WellnessContextInputSchema.shape,
    outputSchema: WellnessContextOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const context = await buildWellnessContext(client(), params);
      return makeResponse(context, params.response_format, formatWellnessContextMarkdown(context));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool(
    "withings_profile_get",
    {
      title: "Get Delx Wellness Profile",
      description:
        "Read the shared Delx Wellness profile from ~/.delx-wellness/profile.json. Returns preferred name, goals, devices, training/nutrition/exercise/agent preferences and safety flags. NEVER contains OAuth tokens or API secrets. Read-only.",
      inputSchema: ResponseOnlyInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ response_format }) => {
      try {
        const profile = await getProfile();
        const payload = {
          ok: true,
          profile,
          summary: buildProfileSummary(profile),
          missing_critical: missingCriticalFields(profile),
          storage_path: getProfilePath()
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Profile", {
          summary: payload.summary,
          missing_critical: payload.missing_critical,
          storage_path: payload.storage_path
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );

  server.registerTool(
    "withings_profile_update",
    {
      title: "Update Delx Wellness Profile",
      description:
        "Persist a partial patch to ~/.delx-wellness/profile.json. Requires explicit_user_intent=true (otherwise returns USER_ACTION_REQUIRED). Rejects secret-like fields (oauth, token, secret, password, cookie, refresh, api_key, session) at write time. Use to record preferred name, goals, devices, training context, nutrition context, exercise preferences, agent preferences, and safety flags.",
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe("Partial WellnessProfileDocument patch. Top-level keys: profile, goals, devices, training, nutrition, preferences, safety, notes."),
        explicit_user_intent: z.boolean().optional().describe("Must be true to persist. Prevents accidental writes from agent inference."),
        response_format: z.enum(["markdown", "json"]).default("markdown")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ patch, explicit_user_intent, response_format }) => {
      try {
        if (explicit_user_intent !== true) {
          return makeResponse(
            {
              ok: false,
              error: "USER_ACTION_REQUIRED",
              message: "Profile update requires explicit_user_intent=true. Confirm with the user before persisting."
            },
            response_format,
            bulletList("Delx Wellness Profile Update", {
              ok: false,
              error: "USER_ACTION_REQUIRED",
              hint: "Set explicit_user_intent=true once the user has confirmed."
            })
          );
        }
        const updated = await updateProfile(patch as Partial<WellnessProfileDocument>);
        const payload = {
          ok: true,
          profile: updated,
          summary: buildProfileSummary(updated),
          missing_critical: missingCriticalFields(updated),
          storage_path: getProfilePath()
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Profile Updated", {
          summary: payload.summary,
          missing_critical: payload.missing_critical,
          storage_path: payload.storage_path
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );

  server.registerTool(
    "withings_onboarding",
    {
      title: "Delx Wellness Onboarding Flow",
      description:
        "Return the 11-question onboarding flow plus the current profile state and missing fields. Read-only — does NOT persist anything. Pair with withings_profile_update once the user answers. Cross-connector: the same profile is shared by every Delx Wellness MCP (whoop, garmin, oura, fitbit, strava, polar, withings, apple-health, samsung-health, google-health, nourish, cycle-coach, cgm, air).",
      inputSchema: {
        locale: z.enum(["en", "pt-BR"]).optional().describe("Onboarding locale. Defaults to en."),
        response_format: z.enum(["markdown", "json"]).default("markdown")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ locale, response_format }) => {
      try {
        const flow = getOnboardingFlow(locale ?? "en");
        const profile = await getProfile();
        const payload = {
          ok: true,
          flow,
          current_profile: profile,
          missing_critical: missingCriticalFields(profile),
          cross_connector_hint:
            "This profile is shared across all Delx Wellness connectors. Answering once populates context for whoop, garmin, oura, fitbit, strava, polar, withings, apple-health, samsung-health, google-health, nourish, cycle-coach, cgm, and air."
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Onboarding", {
          locale: flow.locale,
          questions: `${flow.questions.length} questions`,
          storage_path: flow.storage_path,
          missing_critical: payload.missing_critical,
          privacy_note: flow.privacy_note
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );
}

function yesterdayISO(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

function dayBeforeISO(): string {
  return new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
}
