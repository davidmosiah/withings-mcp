import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expectedTools = [
  'withings_agent_manifest', 'withings_cache_status', 'withings_capabilities', 'withings_connection_status',
  'withings_daily_summary', 'withings_data_inventory', 'withings_exchange_code', 'withings_get_auth_url',
  'withings_list_activity', 'withings_list_body_measures', 'withings_list_heart', 'withings_list_sleep',
  'withings_list_sleep_summary', 'withings_list_workouts', 'withings_privacy_audit', 'withings_revoke_access',
  'withings_weekly_summary', 'withings_wellness_context'
];

const expectedResources = [
  'withings://agent-manifest', 'withings://capabilities', 'withings://inventory', 'withings://latest/activity',
  'withings://latest/sleep', 'withings://summary/daily', 'withings://summary/weekly'
];
const expectedPrompts = ['withings_body_sleep_investigation', 'withings_daily_checkin', 'withings_weekly_review'];

const client = new Client({ name: 'withings-mcp-smoke-test', version: '0.0.0' });
const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
await client.connect(transport);
try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, expectedTools.sort());

  const resources = await client.listResources();
  const resourceUris = resources.resources.map((resource) => resource.uri).sort();
  assert.deepEqual(resourceUris, expectedResources.sort());

  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
  assert.deepEqual(promptNames, expectedPrompts.sort());

  const prompt = await client.getPrompt({ name: 'withings_daily_checkin', arguments: { focus: 'sleep' } });
  assert.ok(prompt.messages[0]?.content?.type === 'text');

  const auditResult = await client.callTool({ name: 'withings_privacy_audit', arguments: { response_format: 'json' } });
  assert.equal(auditResult.structuredContent?.unofficial, true);
  assert.ok(auditResult.structuredContent?.secret_env_vars?.includes('WITHINGS_CLIENT_SECRET'));

  const capabilitiesResult = await client.callTool({ name: 'withings_capabilities', arguments: { response_format: 'json' } });
  assert.equal(capabilitiesResult.structuredContent?.unofficial, true);
  assert.ok(capabilitiesResult.structuredContent?.api_boundary?.does_not_include?.includes('Advanced Research API raw accelerometer or PPG streams'));
  assert.ok(capabilitiesResult.structuredContent?.supported_data?.some((entry) => entry.tools?.includes('withings_list_sleep_summary')));
  assert.ok(capabilitiesResult.structuredContent?.recommended_agent_flow?.some((step) => step.includes('withings_connection_status')));

  const inventoryResult = await client.callTool({ name: 'withings_data_inventory', arguments: { response_format: 'json' } });
  assert.equal(inventoryResult.structuredContent?.kind, 'data_inventory');
  assert.equal(typeof inventoryResult.structuredContent?.source, 'string');

  const manifestResult = await client.callTool({ name: 'withings_agent_manifest', arguments: { client: 'hermes', response_format: 'json' } });
  assert.equal(manifestResult.structuredContent?.client, 'hermes');
  assert.ok(manifestResult.structuredContent?.hermes?.common_tool_names?.includes('mcp_withings_withings_connection_status'));
  assert.ok(manifestResult.structuredContent?.standard_tools?.includes('withings_list_body_measures'));
  assert.equal(manifestResult.structuredContent?.hermes?.no_gateway_restart_for_data_access, true);

  const statusResult = await client.callTool({ name: 'withings_connection_status', arguments: { client: 'hermes', response_format: 'json' } });
  assert.equal(statusResult.structuredContent?.ok, false);
  assert.ok(statusResult.structuredContent?.missing_env?.includes('WITHINGS_CLIENT_ID'));
  assert.equal(statusResult.structuredContent?.client, 'hermes');

  console.log(JSON.stringify({ ok: true, tools: toolNames.length, resources: resourceUris.length, prompts: promptNames.length }, null, 2));
} finally {
  await client.close();
}
