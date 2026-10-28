import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchWithRetry } from '../dist/services/http-retry.js';

// The token lock wait is derived from the request budget when the module loads.
process.env.WITHINGS_HTTP_TIMEOUT_MS = '100';
const { TokenStore } = await import('../dist/services/token-store.js');

// Exercise actual sockets and response-body reads, not a mock that ignores abort.
const server = createServer((request, response) => {
  if (request.url === '/body') { response.writeHead(200); response.flushHeaders(); }
  if (request.url === '/rate') { response.writeHead(429, { 'Retry-After': '86400' }); response.end('rate limited'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const logs = [];
try {
  for (const noRetry of [false, true]) {
    const start = Date.now();
    await assert.rejects(fetchWithRetry(base + '/hang', {}, { timeoutMs: 80, noRetry, logger: x => logs.push(x) }),
      error => error.name === 'TimeoutError');
    assert.ok(Date.now() - start < 2000);
  }
  const body = await fetchWithRetry(base + '/body', {}, { timeoutMs: 80 });
  await assert.rejects(body.text());
  const start = Date.now();
  const rate = await fetchWithRetry(base + '/rate', {}, { timeoutMs: 200, logger: x => logs.push(x) });
  assert.equal(rate.status, 429);
  assert.ok(Date.now() - start < 1000, 'oversized Retry-After must not hold a request open');

  // The budget is configurable through the environment and applies by default.
  const envStart = Date.now();
  await assert.rejects(fetchWithRetry(base + '/hang', {}), error => error.name === 'TimeoutError');
  assert.ok(Date.now() - envStart < 2000, 'WITHINGS_HTTP_TIMEOUT_MS bounds requests');
  delete process.env.WITHINGS_HTTP_TIMEOUT_MS;

  // A backoff that would pass the deadline reports the network error, not a timeout.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await assert.rejects(fetchWithRetry(base, {}, { timeoutMs: 100, logger: x => logs.push(x),
    fetchImpl: async () => { throw refused; } }), error => error === refused);

  let calls = 0;
  await fetchWithRetry(base, {}, { sleep: async () => {}, logger: x => logs.push(x), fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new Error('synthetic-private-token-and-health-record');
    if (calls === 2) throw Object.assign(new TypeError('fetch failed https://synthetic-private'), { cause: { code: 'ECONNRESET' } });
    return new Response('ok');
  } });
  assert.ok(logs.every(x => !x.includes('synthetic-private')));
  assert.match(logs.at(-2), /error=network_failure/);
  assert.match(logs.at(-1), /error=ECONNRESET/);

  // Token-lock waiters outlast a refresh (two bounded calls) and nothing more.
  const home = await mkdtemp(join(tmpdir(), 'withings-lock-'));
  try {
    const store = new TokenStore(join(home, 'tokens.json'));
    let release;
    const held = store.withLock(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const lockStart = Date.now();
    await assert.rejects(Promise.race([store.withLock(async () => {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lock wait ignored the budget')), 8000).unref())]), /Timed out/);
    const waited = Date.now() - lockStart;
    assert.ok(waited >= 2 * 100 + 5000 && waited < 7000, `lock wait ${waited}ms`);
    release(); await held;
  } finally { await rm(home, { recursive: true, force: true }); }
  console.log(JSON.stringify({ ok: true, header_deadline: true, body_deadline: true,
    no_retry_deadline: true, bounded_retry_after: true, private_logs: true, env_budget: true,
    network_error_cause: true, error_codes: true, lock_wait_covers_refresh: true }));
} finally { server.closeAllConnections(); server.close(); }
