import assert from 'node:assert/strict';
import { applyPrivacy } from '../dist/services/privacy.js';
import { decodeMeasure } from '../dist/services/measures.js';
import { buildCollectionOutput } from '../dist/services/collection.js';
import { formatCollection } from '../dist/services/format.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWithingsTools } from '../dist/tools/withings-tools.js';

const group = { grpid: 900000001, date: 1781056800, category: 1, attrib: 0,
  deviceid: '0000000000000000000000000000000000000001',
  measures: [{ type: 1, value: 72400, unit: -3, futureQuality: 99 },
    { type: 6, value: 1820, unit: -2 }, { type: 88, value: 3210, unit: -3 },
    { type: 155, value: 41, unit: 0 }, { type: 99999, value: 123, unit: -1 }] };
const output = buildCollectionOutput('/measure', 'structured', { records: [group], pages_fetched: 1 });
assert.equal(output.source, undefined);
assert.equal(output.fetched_at, undefined);
assert.equal(output.records[0].measured_at, new Date(group.date * 1000).toISOString());
assert.equal(output.records[0].date, group.date);
assert.equal(output.records[0].measures[0].decoded_value, 72.4);
assert.equal(output.records[0].measures[0].futureQuality, 99);
assert.equal(output.records[0].measures[1].decoded_value, 18.2);
assert.equal(output.records[0].measures[2].decoded_value, 3.21);
assert.equal(output.records[0].measures[3].label, 'vascular_age');
assert.equal(output.records[0].measures[3].unit_label, undefined, 'the reference documents no unit for vascular age');
assert.equal(output.records[0].measures[4].decoded_value, 12.3);
assert.equal(output.records[0].measures[4].unit_label, undefined, 'unknown types must not invent physical units');
for (const mode of ['structured', 'raw']) {
  const result = buildCollectionOutput('/measure', mode, { records: [group], pages_fetched: 1 });
  const markdown = formatCollection('Body measures', result.records, result);
  assert.ok(markdown.includes('72.4 kg') && markdown.includes('18.2 %') && markdown.includes('3.21 kg'));
  assert.ok(markdown.includes('type_99999') && markdown.includes('unit unknown'));
  assert.ok(!markdown.includes('sport/type'));
}
assert.deepEqual(applyPrivacy('/measure', group, 'raw'), group);
for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(decodeMeasure({ type: 1, value, unit: -3 }).decoded_value, undefined);
}
assert.equal(decodeMeasure({ type: 1, value: 0, unit: -3 }).decoded_value, 0);

// withings_list_body_measures requests real measurements (category 1), never user goals.
const home = await mkdtemp(join(tmpdir(), 'withings-measure-output-'));
const originalFetch = globalThis.fetch;
const requests = [];
try {
  const tokenPath = join(home, 'tokens.json');
  await writeFile(tokenPath, JSON.stringify({ access_token: 'synthetic', expires_at: Math.floor(Date.now() / 1000) + 7200 }));
  Object.assign(process.env, { HOME: home, WITHINGS_CLIENT_ID: 'synthetic', WITHINGS_CLIENT_SECRET: 'synthetic',
    WITHINGS_REDIRECT_URI: 'http://127.0.0.1:3000/callback', WITHINGS_TOKEN_PATH: tokenPath, WITHINGS_NO_CACHE: '1' });
  globalThis.fetch = async (_url, init) => {
    requests.push(new URLSearchParams(String(init.body)));
    return Response.json({ status: 0, body: { measuregrps: [group], more: false } });
  };
  const server = new McpServer({ name: 'measure-output-test', version: '0.0.0' });
  registerWithingsTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'measure-output-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'withings_list_body_measures', arguments: { response_format: 'json' } });
  assert.equal(result.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get('action'), 'getmeas');
  assert.equal(requests[0].get('category'), '1');
  await client.close();
} finally { globalThis.fetch = originalFetch; await rm(home, { recursive: true, force: true }); }

console.log(JSON.stringify({ ok: true, units: true, timestamps: true, real_measures_only: true,
  original_values_preserved: true, unknown_types: true, markdown: true }));
