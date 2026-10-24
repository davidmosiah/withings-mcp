import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchWithRetry } from '../dist/services/http-retry.js';

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

  let calls = 0;
  await fetchWithRetry(base, {}, { sleep: async () => {}, logger: x => logs.push(x), fetchImpl: async () => {
    if (++calls === 1) throw new Error('synthetic-private-token-and-health-record');
    return new Response('ok');
  } });
  assert.ok(logs.every(x => !x.includes('synthetic-private')));
  console.log(JSON.stringify({ ok: true, header_deadline: true, body_deadline: true,
    no_retry_deadline: true, bounded_retry_after: true, private_logs: true }));
} finally { server.closeAllConnections(); server.close(); }
