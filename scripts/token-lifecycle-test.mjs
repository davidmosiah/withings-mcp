import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WithingsClient } from '../dist/services/withings-client.js';
import { TokenStore } from '../dist/services/token-store.js';

const home = await mkdtemp(join(tmpdir(), 'withings-tokens-'));
const tokenPath = join(home, 'tokens.json');
const initial = { access_token: 'synthetic-old', refresh_token: 'synthetic-refresh', userid: '101', expires_at: 4102444800 };
const config = { clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'http://localhost:3000/callback',
  scopes: ['user.metrics'], tokenPath, privacyMode: 'structured', cacheEnabled: false, cachePath: join(home, 'cache.sqlite') };
const original = globalThis.fetch;
let refreshes = 0;
let reject = false;
let user = 101;
let incomplete = false;
let transient = false;
globalThis.fetch = async (_url, init) => {
  const form = new URLSearchParams(init.body);
  if (form.get('action') === 'getnonce') return Response.json({ status: 0, body: { nonce: 'synthetic-nonce' } });
  if (form.get('action') === 'requesttoken') {
    refreshes++;
    if (transient) return new Response('synthetic transient token error', { status: 503 });
    return Response.json({ status: 0, body: incomplete ? {} : { access_token: 'synthetic-new',
      refresh_token: 'synthetic-rotated', userid: user, expires_in: 10800, scope: 'user.metrics' } });
  }
  if (reject || init.headers.Authorization === 'Bearer synthetic-old') return Response.json({ status: 343, body: {} });
  const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
  assert.equal(saved.refresh_token, 'synthetic-rotated', 'rotation persisted before first new-token use');
  return Response.json({ status: 0, body: { measuregrps: [] } });
};
try {
  await writeFile(tokenPath, JSON.stringify(initial));
  // Concurrent rejected requests share one refresh, including across client objects.
  await Promise.all(Array.from({ length: 6 }, () => new WithingsClient(config).get('/measure', { action: 'getmeas' })));
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(await readFile(tokenPath, 'utf8')).userid, '101');

  // Refresh must not replace the saved identity, even with a successful HTTP response.
  await writeFile(tokenPath, JSON.stringify(initial)); user = 202;
  await assert.rejects(new WithingsClient(config).get('/measure'), /different user/);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, 'utf8')), initial);
  user = 101; incomplete = true;
  await assert.rejects(new WithingsClient(config).get('/measure'), /incomplete/);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, 'utf8')), initial);
  incomplete = false;

  // Signed token requests must not blindly replay a consumed nonce or code.
  transient = true;
  const priorRefreshes = refreshes;
  await assert.rejects(new WithingsClient(config).get('/measure'), /HTTP 503/);
  assert.equal(refreshes, priorRefreshes + 1);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, 'utf8')), initial);
  transient = false;

  // Cache-enabled requests must surface a revoked authorization, not prior data.
  const cached = new WithingsClient({ ...config, cacheEnabled: true });
  await cached.get('/measure'); reject = true;
  await assert.rejects(cached.get('/measure'), /status 343/);
  reject = false;

  // A process killed inside the critical section leaves no orphan lock.
  const moduleUrl = new URL('../dist/services/token-store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { TokenStore } from ${JSON.stringify(moduleUrl)}; await new TokenStore(process.argv[1]).withLock(async () => { process.stdout.write('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });`, tokenPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('lock child exited early'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const start = Date.now(); await new TokenStore(tokenPath).withLock(async () => {});
    assert.ok(Date.now() - start < 2000, 'kernel lock released on process death');
  } finally { child.kill('SIGKILL'); }
  console.log(JSON.stringify({ ok: true, json_auth_refresh: true, concurrent_rotation: true,
    preserve_identity: true, reject_incomplete_tokens: true, no_stale_success: true, crash_recovery: true }));
} finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
