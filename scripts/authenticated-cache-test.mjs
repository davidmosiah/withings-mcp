import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getConfig } from '../dist/services/config.js';
import { WithingsClient } from '../dist/services/withings-client.js';
import { fetchWithCache, clearCache, getCacheStats } from '../dist/services/http-cache.js';

// Synthetic identities only. Every network operation is intercepted locally.
const home = await mkdtemp(join(tmpdir(), 'withings-auth-cache-'));
const config = { clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'http://localhost/callback',
  scopes: ['user.metrics'], tokenPath: join(home, 'tokens.json'), privacyMode: 'structured',
  cacheEnabled: true, cachePath: join(home, 'legacy.sqlite') };
const originalFetch = globalThis.fetch;
const oldNoRetry = process.env.WITHINGS_NO_RETRY;
process.env.WITHINGS_NO_RETRY = 'true';
const success = identity => Response.json({ status: 0, body: { measuregrps: [{ synthetic_identity: identity }] } });
const token = identity => ({ access_token: identity, refresh_token: 'synthetic-refresh', expires_at: 4102444800 });
let dataResponse = () => success('A');
let tokenResponse = () => Response.json({ status: 0, body: { access_token: 'B-rotated', refresh_token: 'new-refresh', expires_in: 36000 } });
let calls = 0;
globalThis.fetch = async (_url, init) => {
  calls++;
  const form = new URLSearchParams(init.body);
  if (form.get('action') === 'getnonce') return Response.json({ status: 0, body: { nonce: 'synthetic-nonce' } });
  if (form.get('action') === 'requesttoken') return tokenResponse();
  return dataResponse(init);
};
try {
  const names = ['WITHINGS_CLIENT_ID', 'WITHINGS_CLIENT_SECRET', 'WITHINGS_REDIRECT_URI', 'WITHINGS_CACHE'];
  const saved = names.map(name => process.env[name]);
  try {
    process.env.WITHINGS_CLIENT_ID = 'synthetic'; process.env.WITHINGS_CLIENT_SECRET = 'synthetic';
    process.env.WITHINGS_REDIRECT_URI = 'http://localhost/callback';
    for (const value of ['true', 'sqlite', '1', 'false']) {
      process.env.WITHINGS_CACHE = value;
      assert.equal(getConfig().cacheEnabled, false);
    }
  } finally {
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  }
  // Seed the exact identity-blind legacy key, close the DB, and preserve its bytes.
  const db = new Database(config.cachePath);
  db.exec('CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY, method TEXT, url TEXT, payload TEXT, cached_at TEXT)');
  const key = 'https://wbsapi.withings.net/measure {"action":"getmeas"}';
  db.prepare('INSERT INTO api_cache VALUES (?, ?, ?, ?, ?)').run('POST ' + key, 'POST', key,
    JSON.stringify({ status: 0, body: { measuregrps: [{ synthetic_identity: 'LEGACY-A' }] } }), '2020-01-01T00:00:00Z');
  db.close();
  const before = await readFile(config.cachePath);
  const client = new WithingsClient(config);
  await writeFile(config.tokenPath, JSON.stringify(token('A')));
  assert.equal((await client.get('/measure', { action: 'getmeas' })).body.measuregrps[0].synthetic_identity, 'A');
  await writeFile(config.tokenPath, JSON.stringify(token('B')));
  for (const fail of [
    () => new Response('forbidden', { status: 403 }),
    () => new Response('unavailable', { status: 503 }),
    () => Response.json({ status: 401, body: {} }),
    () => { throw new TypeError('synthetic network failure'); },
    () => new Response('unauthorized', { status: 401 })
  ]) {
    dataResponse = fail;
    await assert.rejects(client.get('/measure', { action: 'getmeas' }));
  }
  // A refresh failure must not convert prior data into success.
  tokenResponse = () => new Response('refresh denied', { status: 403 });
  dataResponse = () => new Response('unauthorized', { status: 401 });
  await assert.rejects(client.get('/measure', { action: 'getmeas' }), /403/);
  // A successful refresh reaches the provider again rather than a cached account.
  tokenResponse = () => Response.json({ status: 0, body: { access_token: 'B-rotated', refresh_token: 'new-refresh', expires_in: 36000 } });
  await writeFile(config.tokenPath, JSON.stringify(token('B')));
  dataResponse = init => init.headers.Authorization === 'Bearer B-rotated' ? success('B') : new Response('', { status: 401 });
  assert.equal((await client.get('/measure', { action: 'getmeas' })).body.measuregrps[0].synthetic_identity, 'B');
  assert.equal(client.cacheStatus().enabled, false);
  assert.deepEqual(await readFile(config.cachePath), before, 'legacy DB is neither read for fallback nor updated');
  await client.revokeAccess();
  const beforeRevoke = calls;
  await assert.rejects(client.get('/measure'), /token not found/);
  assert.equal(calls, beforeRevoke);
  // Corrupt/unavailable legacy cache must not affect requests or status.
  const invalid = join(home, 'invalid.sqlite');
  await writeFile(invalid, 'not a database');
  await writeFile(config.tokenPath, JSON.stringify(token('B')));
  dataResponse = () => success('B');
  const corruptClient = new WithingsClient({ ...config, cachePath: invalid });
  assert.equal(corruptClient.cacheStatus().enabled, false);
  await corruptClient.get('/measure');
  assert.equal(await readFile(invalid, 'utf8'), 'not a database');
  const missing = join(home, 'missing', 'cache.sqlite');
  const missingClient = new WithingsClient({ ...config, cachePath: missing });
  missingClient.cacheStatus(); await missingClient.get('/measure');
  await assert.rejects(access(missing));

  // All legal HeadersInit forms and mixed casing bypass reads AND writes.
  for (const name of ['Authorization', 'Cookie', 'Proxy-Authorization']) {
    for (const headers of [{ [name.toUpperCase()]: 'synthetic-A' }, [[name, 'synthetic-B']], new Headers({ [name]: 'synthetic-C' })]) {
      clearCache(); let network = 0;
      const url = 'https://synthetic.invalid/shared';
      await fetchWithCache(url, {}, { innerFetch: async () => success('PUBLIC') });
      const stats = getCacheStats();
      for (const status of [200, 401, 403]) {
        const response = await fetchWithCache(url, { headers }, { innerFetch: async () => { network++; return new Response('live', { status }); } });
        assert.equal(response.status, status); assert.equal(await response.text(), 'live');
      }
      assert.equal(network, 3); assert.deepEqual(getCacheStats(), stats);
      clearCache();
      await fetchWithCache(url, { headers }, { innerFetch: async () => success('PRIVATE') });
      assert.equal(getCacheStats().size, 0);
    }
  }
  console.log(JSON.stringify({ ok: true, suite: 'authenticated-cache', identity_switch: true, legacy_sqlite_ignored: true, failures_closed: true, refresh: true, revoke: true, header_forms: true }));
} finally {
  clearCache(); globalThis.fetch = originalFetch;
  if (oldNoRetry === undefined) delete process.env.WITHINGS_NO_RETRY; else process.env.WITHINGS_NO_RETRY = oldNoRetry;
  await rm(home, { recursive: true, force: true });
}
