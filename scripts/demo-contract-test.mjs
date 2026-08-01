/**
 * Contract gate for `withings_demo`.
 *
 * The demo tool exists so agents can see the payload shape before spending an
 * OAuth round-trip on the real Withings API. A hand-written example nobody
 * compares against reality drifts silently, and an agent that trusts it writes a
 * parser for fields that never arrive.
 *
 * This gate runs the REAL builders over a stubbed Withings client and compares
 * key sets against the demo payload, failing in both directions:
 *
 *   - a key in the demo that the builders never emit  -> invented contract
 *   - a key the builders emit that the demo omits     -> incomplete contract
 *
 * Both sides are compared after a JSON round-trip, because that is the wire
 * shape an MCP client actually receives (undefined-valued keys disappear).
 *
 * The collection sample is checked against the UNION of two real invocations —
 * a page with more results and a last page — because `next_page` only exists on
 * the former and either alone under-describes the shape. Same reason the samsung
 * gate unions across array elements: one populated day does not describe a week.
 *
 * The repo has no recorded Withings fixture (this server talks to a live OAuth
 * API, it does not parse an export file), so the stub below is the cheapest
 * thing that still exercises the real code: vendor-shaped responses fed through
 * the real `WithingsClient.list`, the real privacy normalizer and the real
 * summary/context builders. Nothing about the payload shape is asserted by hand.
 */
import assert from 'node:assert/strict';
import { buildDailySummary } from '../dist/services/summary.js';
import { buildWellnessContext } from '../dist/services/context.js';
import { buildCollectionOutput } from '../dist/services/collection.js';
import { buildDemoPayload } from '../dist/services/demo.js';
import { WithingsClient } from '../dist/services/withings-client.js';

const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Keys the builders only emit when the account happens to hold that record type.
 * The demo shows them because they are part of the contract an agent may meet;
 * the stub may or may not produce them. Each entry needs a reason.
 *
 * Deliberately narrow. Adding a key here to silence the gate defeats the gate —
 * only list fields that are genuinely conditional on the data.
 */
const OPTIONAL_IN_REAL = new Map([
  // No allowances needed today: the stub exercises every documented field.
  // Kept as the explicit, reviewable place to record one if that ever changes.
]);

/** Vendor-shaped Withings responses. Synthetic values, obviously fake device ids. */
const MEASUREGRP = {
  grpid: 900000001,
  attrib: 0,
  date: Math.floor(Date.parse(`${TODAY}T09:12:00Z`) / 1000),
  created: Math.floor(Date.parse(`${TODAY}T09:12:00Z`) / 1000),
  category: 1,
  deviceid: '0000000000000000000000000000000000000001',
  measures: [
    { value: 72500, type: 1, unit: -3 },
    { value: 185, type: 6, unit: -1 },
    { value: 56100, type: 76, unit: -3 }
  ]
};

const stubClient = {
  async get(endpoint) {
    if (endpoint.includes('/v2/measure')) {
      return { body: { activities: [{ date: TODAY, steps: 8421, calories: 489, distance: 6870, active_duration: 2460 }] } };
    }
    if (endpoint.includes('/v2/sleep')) {
      return {
        body: {
          series: [{
            date: TODAY,
            data: {
              sleep_score: 78,
              total_sleep_time: 26880,
              total_timeinbed: 29520,
              sleep_efficiency: 0.91,
              deepsleepduration: 5040,
              remsleepduration: 5760,
              hr_average: 56
            }
          }]
        }
      };
    }
    if (endpoint === '/measure') return { body: { measuregrps: [MEASUREGRP] } };
    if (endpoint.includes('/v2/heart')) return { body: { heart: [{ date: TODAY, hr_average: 56 }] } };
    throw new Error(`unexpected endpoint ${endpoint}`);
  }
};

const STUB_CONFIG = {
  clientId: 'demo-contract-test',
  clientSecret: 'demo-contract-test',
  redirectUri: 'http://localhost/callback',
  scopes: ['user.metrics'],
  tokenPath: '/dev/null',
  privacyMode: 'structured',
  cacheEnabled: false,
  cachePath: '/dev/null'
};

/** Real `list()` over a stubbed transport, so paging fields come from real code. */
async function realCollection({ more }) {
  const client = new WithingsClient(STUB_CONFIG);
  client.get = async () => ({
    body: { measuregrps: [MEASUREGRP], more, offset: more ? 1 : 0 }
  });
  const result = await client.list('/measure', { action: 'getmeas', limit: 1 });
  return buildCollectionOutput('/measure', STUB_CONFIG.privacyMode, result);
}

function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    // Union across elements: one record does not describe a collection.
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.add(p);
    keyPaths(value[key], p, out);
  }
  return out;
}

function union(sets) {
  const out = new Set();
  for (const set of sets) for (const key of set) out.add(key);
  return out;
}

function diff(demoSet, realSet) {
  const invented = [...demoSet].filter((k) => !realSet.has(k)).sort();
  const missing = [...realSet]
    .filter((k) => !demoSet.has(k) && !OPTIONAL_IN_REAL.has(k))
    .sort();
  return { invented, missing };
}

function report(name, invented, missing) {
  const lines = [];
  if (invented.length > 0) {
    lines.push(
      `\n  ${name}: ${invented.length} key(s) in the demo that the real builder NEVER returns.`,
      `  An agent trusting these writes a parser for data that never arrives:`,
      ...invented.map((k) => `    - ${k}`)
    );
  }
  if (missing.length > 0) {
    lines.push(
      `\n  ${name}: ${missing.length} key(s) the real builder returns but the demo omits.`,
      `  Agents reading the demo will not know these exist:`,
      ...missing.map((k) => `    + ${k}`)
    );
  }
  return lines.join('\n');
}

const demo = buildDemoPayload().sample;

const real = {
  withings_daily_summary: [await buildDailySummary(stubClient, { days: 1, timezone: 'UTC' })],
  withings_wellness_context: [await buildWellnessContext(stubClient, { days: 1, timezone: 'UTC' })],
  withings_list_body_measures: [await realCollection({ more: true }), await realCollection({ more: false })]
};

const failures = [];
let checked = 0;

for (const [name, realPayloads] of Object.entries(real)) {
  assert.ok(demo[name], `demo payload is missing the ${name} sample entirely`);
  const demoSet = keyPaths(wire(demo[name]));
  const realSet = union(realPayloads.map((payload) => keyPaths(wire(payload))));
  const { invented, missing } = diff(demoSet, realSet);
  checked += demoSet.size;
  if (invented.length > 0 || missing.length > 0) {
    failures.push(report(name, invented, missing));
  } else {
    console.log(`PASS ${name} — ${demoSet.size} key paths match the real builder`);
  }
}

// The demo must stay honest about being synthetic, whatever the shape says.
const payload = buildDemoPayload();
assert.equal(payload.is_demo, true, 'demo payload must be tagged is_demo=true');
assert.equal(payload.ok, true, 'demo payload must be tagged ok=true');
assert.ok(Array.isArray(payload.notes) && payload.notes.length > 0, 'demo payload must carry notes');
console.log('PASS demo payload is tagged synthetic');

// A demo that leaked positional or credential-shaped values would teach agents
// the wrong contract and the wrong privacy posture at the same time.
const encoded = JSON.stringify(payload).toLowerCase();
for (const needle of ['latitude', 'longitude', 'latlng', 'access_token', 'refresh_token', 'email']) {
  assert.ok(!encoded.includes(needle), `demo payload must not contain "${needle}"`);
}
console.log('PASS demo payload carries no positional, token or contact keys');

if (failures.length > 0) {
  console.error('\nFAIL demo contract drifted from the real builders:');
  console.error(failures.join('\n'));
  console.error(
    '\nFix src/services/demo.ts so the examples match what the builders return.' +
      '\nDo not widen OPTIONAL_IN_REAL to silence this — that is how the drift got here.\n'
  );
  process.exit(1);
}

console.log(`\ndemo-contract: ${checked} key paths verified against the real builders`);
console.log(JSON.stringify({ ok: true, suite: 'demo-contract', samples: Object.keys(real).length }));
