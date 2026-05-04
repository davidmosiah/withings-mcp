import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerWithingsPrompts(server: McpServer): void {
  server.registerPrompt("withings_daily_checkin", {
    title: "Withings Daily Check-in",
    description: "Ask an agent to create a practical daily health and training check-in from Withings.",
    argsSchema: { focus: z.string().optional().describe("Optional focus, e.g. sleep, body measures, activity, recovery, heart records.") }
  }, ({ focus }) => userPrompt(`Use Withings MCP for a daily check-in${focus ? ` focused on ${focus}` : ""}.

Required flow:
1. Call withings_connection_status.
2. If ready, call withings_daily_summary with response_format=json.
3. Only drill into low-level tools if the summary shows a concrete question.

Return:
- main signal
- what changed or needs attention
- 3 practical actions for today
- confidence and missing data
- no medical diagnosis.`));

  server.registerPrompt("withings_weekly_review", {
    title: "Withings Weekly Review",
    description: "Ask an agent to review Withings trends across activity, sleep and heart context.",
    argsSchema: { goal: z.string().optional().describe("Optional goal, e.g. fat loss, tennis conditioning, endurance base, sleep repair.") }
  }, ({ goal }) => userPrompt(`Use Withings MCP for a weekly review${goal ? ` for this goal: ${goal}` : ""}.

Required flow:
1. Call withings_connection_status.
2. Call withings_weekly_summary with response_format=json.
3. Use withings_list_sleep_summary, withings_list_sleep, withings_list_activity or withings_list_body_measures only to investigate specific bottlenecks.

Return:
- scorecard
- bottlenecks
- next-week actions
- risks/unknowns
- no medical diagnosis.`));

  server.registerPrompt("withings_body_sleep_investigation", {
    title: "Withings Body Sleep Investigation",
    description: "Investigate Withings body measures and adjacent sleep context.",
    argsSchema: { after: z.string().describe("ISO 8601 start date-time"), before: z.string().optional().describe("Optional ISO 8601 end date-time") }
  }, ({ after, before }) => userPrompt(`Call withings_list_body_measures and withings_list_sleep_summary with after=${after}${before ? `, before=${before}` : ""}, response_format=json.

Explain:
- what the measures can and cannot prove
- notable periods or missing data
- whether follow-up should use sleep/activity tools
- no diagnosis or alarmism.`));
}
