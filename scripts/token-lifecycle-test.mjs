import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WithingsClient } from '../dist/services/withings-client.js';
import { TokenStore } from '../dist/services/token-store.js';
import { buildConnectionStatus } from '../dist/services/connection-status.js';

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
let oldTokenResponse = () => Response.json({ status: 401, body: {} });
let dataFailure;
let encryptionKey;
globalThis.fetch = async (_url, init) => {
  const form = new URLSearchParams(init.body);
  if (form.get('action') === 'getnonce') return Response.json({ status: 0, body: { nonce: 'synthetic-nonce' } });
  if (form.get('action') === 'requesttoken') {
    refreshes++;
    if (transient) return new Response('synthetic transient token error', { status: 503 });
    return Response.json({ status: 0, body: incomplete ? {} : { access_token: 'synthetic-new',
      refresh_token: 'synthetic-rotated', userid: user, expires_in: 10800, scope: 'user.metrics' } });
  }
  if (dataFailure) return dataFailure();
  if (reject) return Response.json({ status: 401, body: {} });
  if (init.headers.Authorization === 'Bearer synthetic-old') return oldTokenResponse();
  const saved = await new TokenStore(tokenPath, encryptionKey).read();
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

  // Only Withings' invalid-token answers refresh: HTTP 401 and JSON 100-102, 200, 401.
  for (const answer of [() => new Response('', { status: 401 }),
    ...[100, 101, 102, 200, 401].map((status) => () => Response.json({ status, body: {} }))]) {
    await writeFile(tokenPath, JSON.stringify(initial)); oldTokenResponse = answer;
    const before = refreshes;
    await new WithingsClient(config).get('/measure');
    assert.equal(refreshes, before + 1);
  }
  // JSON 343 is a notification-callback error, not an expired token.
  await writeFile(tokenPath, JSON.stringify(initial)); oldTokenResponse = () => Response.json({ status: 343, body: {} });
  const beforeCallbackError = refreshes;
  await assert.rejects(new WithingsClient(config).get('/measure'), /status 343/);
  assert.equal(refreshes, beforeCallbackError);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, 'utf8')), initial);
  oldTokenResponse = () => Response.json({ status: 401, body: {} });

  // Cache-enabled requests must surface a revoked authorization, not prior data.
  const cached = new WithingsClient({ ...config, cacheEnabled: true });
  const fresh = await cached.get('/measure');
  await cached.list('/measure', { action: 'getmeas' }); reject = true;
  assert.equal(fresh.cached, undefined);
  await assert.rejects(cached.get('/measure'), /status 401/);
  reject = false;
  // Parameter and other non-transient statuses also stay errors.
  for (const answer of [() => Response.json({ status: 503, body: {} }), () => Response.json({ status: 2555, body: {} }),
    () => new Response('bad request', { status: 400 })]) {
    dataFailure = answer;
    await assert.rejects(cached.get('/measure'), /Withings API/);
  }
  // Transient failures (network, HTTP 5xx, rate limit) return the earlier response, marked.
  const retryEnv = process.env.WITHINGS_NO_RETRY;
  process.env.WITHINGS_NO_RETRY = '1';
  try {
    for (const answer of [() => { throw new TypeError('fetch failed'); }, () => new Response('unavailable', { status: 503 }),
      () => Response.json({ status: 601, body: {} })]) {
      dataFailure = answer;
      const stale = await cached.get('/measure');
      assert.equal(stale.cached, true);
      assert.match(stale.cached_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(stale.body, { measuregrps: [] });
      const listed = await cached.list('/measure', { action: 'getmeas' });
      assert.equal(listed.cached, true);
      assert.match(listed.cached_at, /^\d{4}-\d{2}-\d{2}T/);
    }
    // Without an earlier response the transient failure itself is reported.
    dataFailure = () => new Response('unavailable', { status: 503 });
    await assert.rejects(new WithingsClient(config).get('/measure'), /HTTP 503/);
  } finally {
    dataFailure = undefined;
    if (retryEnv === undefined) delete process.env.WITHINGS_NO_RETRY; else process.env.WITHINGS_NO_RETRY = retryEnv;
  }

  // Another process holding the lock excludes us until it releases.
  const moduleUrl = new URL('../dist/services/token-store.js', import.meta.url).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { TokenStore } from ${JSON.stringify(moduleUrl)}; await new TokenStore(process.argv[1]).withLock(async () => { process.stdout.write('locked;'); await new Promise((r) => setTimeout(r, 1000)); process.stdout.write('releasing;'); });`, tokenPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    holder.stdout.on('data', (chunk) => { output += chunk; });
    await Promise.race([once(holder.stdout, 'data'), once(holder, 'exit').then(() => { throw new Error('lock holder exited early'); })]);
    await new TokenStore(tokenPath).withLock(async () => {
      assert.match(output, /releasing;/, 'lock excluded a second process while held');
    });
  } finally { holder.kill('SIGKILL'); }

  // A process killed inside the critical section leaves no orphan lock.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { TokenStore } from ${JSON.stringify(moduleUrl)}; await new TokenStore(process.argv[1]).withLock(async () => { process.stdout.write('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });`, tokenPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('lock child exited early'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const start = Date.now(); await new TokenStore(tokenPath).withLock(async () => {});
    assert.ok(Date.now() - start < 2000, 'kernel lock released on process death');
  } finally { child.kill('SIGKILL'); }

  // The same real refresh path must persist only authenticated ciphertext.
  encryptionKey = Buffer.alloc(32, 42).toString('base64url');
  const encrypted = new TokenStore(tokenPath, encryptionKey);
  await encrypted.write(initial);
  const firstCiphertext = await readFile(tokenPath, 'utf8');
  assert.ok(!firstCiphertext.includes(initial.access_token) && !firstCiphertext.includes(initial.refresh_token));
  assert.ok(!firstCiphertext.includes('access_token') && !firstCiphertext.includes(encryptionKey));
  await encrypted.write(initial);
  assert.notEqual(await readFile(tokenPath, 'utf8'), firstCiphertext, 'fresh nonce on every write');
  await new WithingsClient({ ...config, tokenEncryptionKey: encryptionKey }).get('/measure');
  assert.equal((await encrypted.read()).refresh_token, 'synthetic-rotated');
  const status = await buildConnectionStatus({ homeDir: home, env: {
    WITHINGS_TOKEN_PATH: tokenPath, WITHINGS_TOKEN_ENCRYPTION_KEY: encryptionKey } });
  assert.equal(status.token.readable, true);
  assert.ok(!JSON.stringify(status).includes(encryptionKey));
  await assert.rejects(new TokenStore(tokenPath).read(), /Cannot read Withings token store/);
  await assert.rejects(new TokenStore(tokenPath, Buffer.alloc(32, 43).toString('base64url')).read(), /Cannot read Withings token store/);
  assert.throws(() => new TokenStore(tokenPath, 'invalid-secret-key'), /32 bytes encoded/);
  const envelope = JSON.parse(await readFile(tokenPath, 'utf8'));
  const corrupt = Buffer.from(envelope.ciphertext, 'base64url'); corrupt[0] ^= 1;
  await writeFile(tokenPath, JSON.stringify({ ...envelope, ciphertext: corrupt.toString('base64url') }));
  await assert.rejects(encrypted.read(), /Cannot read Withings token store/);
  await writeFile(tokenPath, JSON.stringify(initial));
  await assert.rejects(encrypted.read(), /Cannot read Withings token store/);
  console.log(JSON.stringify({ ok: true, json_auth_refresh: true, concurrent_rotation: true,
    preserve_identity: true, invalid_token_statuses: true, transient_cache_fallback: true, lock_exclusion: true, reject_incomplete_tokens: true, no_stale_success: true, crash_recovery: true,
    encrypted_at_rest: true, reject_tampering: true, no_plaintext_fallback: true }));
} finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
