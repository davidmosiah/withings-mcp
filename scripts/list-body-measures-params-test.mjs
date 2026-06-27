import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WithingsClient } from '../dist/services/withings-client.js';

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
  scopes: ['user.metrics'],
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
  return new Response(JSON.stringify({
    status: 0,
    body: {
      measuregrps: Array.from({ length: 994 }, (_, i) => ({
        grpid: i + 1,
        date: 1780953600 + i,
        measures: [{ type: 1, value: 8000 + i, unit: -2 }]
      })),
      more: false
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const client = new WithingsClient(config);
  const result = await client.list('/measure', {
    action: 'getmeas',
    after: '2026-06-09T00:00:00Z',
    before: '2026-06-15T23:59:59Z',
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
  assert.equal(calls[0].body.get('startdate'), '1780963200');
  assert.equal(calls[0].body.get('enddate'), '1781567999');
  assert.equal(calls[0].body.get('offset'), '0');
  assert.equal(calls[0].body.get('limit'), '10');

  for (const internalKey of ['after', 'before', 'page', 'all_pages', 'max_pages', 'privacy_mode', 'response_format']) {
    assert.equal(calls[0].body.has(internalKey), false, `${internalKey} must not be sent to Withings`);
  }

  assert.equal(result.records.length, 10, 'local output cap must protect MCP clients even if upstream ignores limit');
  assert.equal(result.next_page, 2, 'local truncation should advertise a follow-up page');
  assert.equal(result.pages_fetched, 1);

  await assert.rejects(
    () => client.list('/measure', { action: 'getmeas', after: 'not-a-date', limit: 10 }),
    /Invalid Withings after filter/
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({ ok: true, sanitized_upstream_params: true, local_output_cap: true }, null, 2));
