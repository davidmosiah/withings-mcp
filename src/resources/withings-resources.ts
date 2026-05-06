import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { buildAgentManifest, formatAgentManifestMarkdown } from "../services/agent-manifest.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildDataInventory } from "../services/inventory.js";
import { getConfig } from "../services/config.js";
import { applyPrivacy, resolvePrivacyMode } from "../services/privacy.js";
import { buildDailySummary, buildWeeklySummary, formatSummaryMarkdown } from "../services/summary.js";
import { WithingsClient } from "../services/withings-client.js";

function textResource(uri: URL, text: string, mimeType = "text/markdown"): ReadResourceResult {
  return { contents: [{ uri: uri.toString(), mimeType, text }] };
}

async function latestSleepResource(uri: URL) {
  const config = getConfig();
  const endpoint = "/v2/sleep";
  const result = await new WithingsClient(config).list(endpoint, { action: "getsummary", limit: 1 });
  const data = applyPrivacy(endpoint, { records: result.records }, resolvePrivacyMode(config));
  return textResource(uri, JSON.stringify(data, null, 2), "application/json");
}

async function latestActivityResource(uri: URL) {
  const config = getConfig();
  const endpoint = "/v2/measure";
  const result = await new WithingsClient(config).list(endpoint, { action: "getactivity", limit: 1 });
  const data = applyPrivacy(endpoint, { records: result.records }, resolvePrivacyMode(config));
  return textResource(uri, JSON.stringify(data, null, 2), "application/json");
}

async function dailySummaryResource(uri: URL) {
  const summary = await buildDailySummary(new WithingsClient(getConfig()), { days: 7, timezone: "UTC" });
  return textResource(uri, formatSummaryMarkdown(summary));
}

async function weeklySummaryResource(uri: URL) {
  const summary = await buildWeeklySummary(new WithingsClient(getConfig()), { days: 7, compare_days: 7, timezone: "UTC" });
  return textResource(uri, formatSummaryMarkdown(summary));
}

export function registerWithingsResources(server: McpServer): void {
  server.registerResource("withings_data_inventory", "withings://inventory", { title: "Withings Data Inventory", description: "Static inventory of supported Withings data domains, privacy modes and recommended first calls.", mimeType: "application/json" }, async (uri) => textResource(uri, JSON.stringify(buildDataInventory(), null, 2), "application/json"));
  server.registerResource("withings_capabilities", "withings://capabilities", { title: "Withings MCP Capabilities", description: "Static capabilities, API boundary, privacy modes and recommended agent workflow.", mimeType: "application/json" }, async (uri) => textResource(uri, JSON.stringify(buildCapabilities(), null, 2), "application/json"));
  server.registerResource("withings_agent_manifest", "withings://agent-manifest", { title: "Withings Agent Manifest", description: "Machine-readable install and operating instructions for AI agents.", mimeType: "text/markdown" }, async (uri) => textResource(uri, formatAgentManifestMarkdown(buildAgentManifest("generic"))));
  server.registerResource("withings_latest_activity", "withings://latest/activity", { title: "Latest Withings Activity", description: "Most recent Withings activity record in the configured privacy mode.", mimeType: "application/json" }, latestActivityResource);
  server.registerResource("withings_latest_sleep", "withings://latest/sleep", { title: "Latest Withings Sleep", description: "Most recent Withings sleep summary in the configured privacy mode.", mimeType: "application/json" }, latestSleepResource);
  server.registerResource("withings_daily_summary", "withings://summary/daily", { title: "Withings Daily Summary", description: "Daily Withings health summary built from API data.", mimeType: "text/markdown" }, dailySummaryResource);
  server.registerResource("withings_weekly_summary", "withings://summary/weekly", { title: "Withings Weekly Summary", description: "Weekly Withings health review built from API data.", mimeType: "text/markdown" }, weeklySummaryResource);
}
