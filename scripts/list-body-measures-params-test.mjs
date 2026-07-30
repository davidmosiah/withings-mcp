import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WithingsClient, dateParamStyleForAction } from '../dist/services/withings-client.js';

const tmp = await mkdtemp(join(tmpdir(), 'withings-list-params-'));
const tokenPath = join(tmp, 'tokens.json');
await writeFile(tokenPath, JSON.stringify({
  access_token: 'test-access-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600
}));

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://127.0.0.1:3000/callback',
  scopes: ['user.metrics', 'user.activity'],
  tokenPath,
  privacyMode: 'structured',
  cacheEnabled: false,
  cachePath: join(tmp, 'cache.sqlite')
};

const originalFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const body = new URLSearchParams(String(init.body ?? ''));
  calls.push({ url: String(url), body });
  const action = body.get('action');
  let payloadBody;
  if (action === 'getmeas') {
    payloadBody = {
      measuregrps: Array.from({ length: 994 }, (_, i) => ({
        grpid: i + 1,
        date: 1780953600 + i,
        measures: [{ type: 1, value: 8000 + i, unit: -2 }]
      })),
      more: false
    };
  } else if (action === 'getactivity' || action === 'getworkouts') {
    payloadBody = { activities: [{ date: '2026-06-10', steps: 9000 }], more: false };
  } else if (action === 'getsummary' || action === 'get') {
    payloadBody = { series: [{ date: '2026-06-10' }], more: false };
  } else {
    payloadBody = { more: false };
  }
  return new Response(JSON.stringify({
    status: 0,
    body: payloadBody
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  assert.equal(dateParamStyleForAction('getmeas'), 'epoch');
  assert.equal(dateParamStyleForAction('get'), 'epoch');
  assert.equal(dateParamStyleForAction('list'), 'epoch');
  assert.equal(dateParamStyleForAction('getactivity'), 'ymd');
  assert.equal(dateParamStyleForAction('getworkouts'), 'ymd');
  assert.equal(dateParamStyleForAction('getsummary'), 'ymd');

  const client = new WithingsClient(config);

  // --- epoch style: getmeas keeps startdate/enddate Unix timestamps ---
  calls.length = 0;
  const result = await client.list('/measure', {
    action: 'getmeas',
    after: '2026-06-09T23:00:00-03:00',
    before: '2026-06-15T23:59:59-03:00',
    page: 1,
    limit: 10,
    all_pages: false,
    max_pages: 5,
    privacy_mode: 'raw',
    response_format: 'json'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://wbsapi.withings.net/measure');
  assert.equal(calls[0].body.get('action'), 'getmeas');
  assert.equal(calls[0].body.get('startdate'), '1781056800');
  assert.equal(calls[0].body.get('enddate'), '1781578799');
  assert.equal(calls[0].body.get('startdateymd'), null);
  assert.equal(calls[0].body.get('enddateymd'), null);
  assert.equal(calls[0].body.get('offset'), '0');
  assert.equal(calls[0].body.get('limit'), '10');

  for (const internalKey of ['after', 'before', 'page', 'all_pages', 'max_pages', 'privacy_mode', 'response_format']) {
    assert.equal(calls[0].body.has(internalKey), false, `${internalKey} must not be sent to Withings`);
  }

  assert.equal(result.records.length, 10, 'local output cap must protect MCP clients even if upstream ignores limit');
  assert.equal(result.next_page, 2, 'local truncation should advertise a follow-up page');
  assert.equal(result.pages_fetched, 1);

  // Plain YYYY-MM-DD expands to start/end of UTC day for epoch endpoints.
  calls.length = 0;
  await client.list('/measure', {
    action: 'getmeas',
    after: '2026-06-09',
    before: '2026-06-09',
    limit: 5
  });
  assert.equal(calls[0].body.get('startdate'), String(Math.floor(Date.parse('2026-06-09T00:00:00Z') / 1000)));
  assert.equal(calls[0].body.get('enddate'), String(Math.floor(Date.parse('2026-06-09T23:59:59Z') / 1000)));

  // --- ymd style: getactivity must send startdateymd/enddateymd, never epoch ---
  calls.length = 0;
  await client.list('/v2/measure', {
    action: 'getactivity',
    after: '2026-06-09T23:00:00-03:00',
    before: '2026-06-15T23:59:59-03:00',
    limit: 10
  });
  assert.equal(calls[0].url, 'https://wbsapi.withings.net/v2/measure');
  assert.equal(calls[0].body.get('action'), 'getactivity');
  assert.equal(calls[0].body.get('startdateymd'), '2026-06-09');
  assert.equal(calls[0].body.get('enddateymd'), '2026-06-15');
  assert.equal(calls[0].body.get('startdate'), null, 'getactivity must not send epoch startdate');
  assert.equal(calls[0].body.get('enddate'), null, 'getactivity must not send epoch enddate');

  // Plain dates for ymd endpoints stay civil dates.
  calls.length = 0;
  await client.list('/v2/measure', {
    action: 'getworkouts',
    after: '2026-07-01',
    before: '2026-07-07',
    limit: 10
  });
  assert.equal(calls[0].body.get('startdateymd'), '2026-07-01');
  assert.equal(calls[0].body.get('enddateymd'), '2026-07-07');
  assert.equal(calls[0].body.get('startdate'), null);

  // Sleep getsummary also uses ymd (unlike sleep detail `get`, which stays epoch).
  calls.length = 0;
  await client.list('/v2/sleep', {
    action: 'getsummary',
    after: '2026-06-01',
    before: '2026-06-30',
    limit: 10
  });
  assert.equal(calls[0].body.get('startdateymd'), '2026-06-01');
  assert.equal(calls[0].body.get('enddateymd'), '2026-06-30');
  assert.equal(calls[0].body.get('startdate'), null);

  calls.length = 0;
  await client.list('/v2/sleep', {
    action: 'get',
    after: '2026-06-09T00:00:00Z',
    before: '2026-06-10T00:00:00Z',
    limit: 10
  });
  assert.equal(calls[0].body.get('startdate'), '1780963200');
  assert.equal(calls[0].body.get('enddate'), '1781049600');
  assert.equal(calls[0].body.get('startdateymd'), null);

  await assert.rejects(
    () => client.list('/measure', { action: 'getmeas', after: 'not-a-date', limit: 10 }),
    /Invalid Withings after filter/
  );
  await assert.rejects(
    () => client.list('/v2/measure', {
      action: 'getactivity',
      after: '2026-07-10',
      before: '2026-07-01',
      limit: 10
    }),
    /after must be earlier than before/
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  ok: true,
  sanitized_upstream_params: true,
  local_output_cap: true,
  ymd_actions: ['getactivity', 'getworkouts', 'getsummary'],
  epoch_actions: ['getmeas', 'get', 'list']
}, null, 2));
