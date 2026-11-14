import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserOpenCommand, parseLocalRedirectUri } from '../dist/cli/auth.js';
import { buildConnectionStatus } from '../dist/services/connection-status.js';

const dir = mkdtempSync(join(tmpdir(), 'withings-mcp-cli-'));

try {
  const missing = await buildConnectionStatus({ env: {}, homeDir: dir, nowMs: 1_000_000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.ready_for_withings_api, false);
  assert.deepEqual(missing.missing_env, ['WITHINGS_CLIENT_ID', 'WITHINGS_CLIENT_SECRET', 'WITHINGS_REDIRECT_URI']);
  assert.ok(missing.next_steps.some((step) => step.includes('WITHINGS_CLIENT_ID')));

  const tokenPath = join(dir, 'tokens.json');
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'user.activity,user.metrics'
  }), { mode: 0o600 });

  const ready = await buildConnectionStatus({
    env: {
      WITHINGS_CLIENT_ID: 'client-id',
      WITHINGS_CLIENT_SECRET: 'client-secret',
      WITHINGS_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      WITHINGS_TOKEN_PATH: tokenPath,
      WITHINGS_PRIVACY_MODE: 'summary',
      WITHINGS_CACHE: 'sqlite'
    },
    homeDir: dir,
    nowMs: 1_000_000
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.ready_for_withings_api, true);
  assert.equal(ready.privacy_mode, 'summary');
  assert.equal(ready.cache.enabled, false);
  assert.equal(ready.token.exists, true);
  assert.equal(ready.token.secure_permissions, true);
  assert.equal(ready.token.has_refresh_token, true);
  assert.equal(ready.oauth.scope_status, 'ok');

  assert.deepEqual(parseLocalRedirectUri('http://127.0.0.1:4567/callback'), {
    host: '127.0.0.1',
    port: 4567,
    path: '/callback'
  });
  assert.throws(() => parseLocalRedirectUri('https://example.com/callback'), /local redirect URI/i);

  const authUrl = 'https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcallback&scope=user.metrics&state=1234';
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { command, args } = browserOpenCommand(authUrl, platform);
    assert.notEqual(command, 'cmd', `${platform} must not open the auth URL through cmd.exe, which splits it at &`);
    assert.equal(args.at(-1), authUrl, `${platform} must pass the full auth URL as one argument`);
  }

  const doctor = spawnSync(process.execPath, ['dist/index.js', 'doctor', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir
    }
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorPayload = JSON.parse(doctor.stdout);
  assert.equal(doctorPayload.ok, false);
  assert.ok(doctorPayload.next_steps.some((step) => step.includes('WITHINGS_CLIENT_ID')));

  const typo = spawnSync(process.execPath, ['dist/index.js', 'docter'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir
    }
  });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown command: docter/);

  const authWithoutEnv = spawnSync(process.execPath, ['dist/index.js', 'auth', '--no-open'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir
    }
  });
  assert.equal(authWithoutEnv.status, 1);
  assert.match(authWithoutEnv.stderr, /Missing required WITHINGS environment variables/);
  assert.doesNotMatch(authWithoutEnv.stderr, new RegExp('at .*dist/'));

  const setup = spawnSync(process.execPath, [
    'dist/index.js',
    'setup',
    '--client',
    'generic',
    '--client-id',
    'client-id-from-setup',
    '--client-secret',
    'client-secret-from-setup',
    '--redirect-uri',
    'http://127.0.0.1:4567/callback',
    '--privacy-mode',
    'summary',
    '--cache',
    'sqlite',
    '--no-auth',
    '--json'
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir
    }
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.ok, true);
  assert.match(setupPayload.config_path, /config\.json$/);
  assert.match(setupPayload.client_config_path, /generic\.json$/);

  const configPath = join(dir, '.withings-mcp', 'config.json');
  const configMode = (statSync(configPath).mode & 0o777).toString(8);
  assert.equal(configMode, '600');
  const savedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(savedConfig.WITHINGS_CLIENT_ID, 'client-id-from-setup');
  assert.equal(savedConfig.WITHINGS_CLIENT_SECRET, 'client-secret-from-setup');
  assert.equal(savedConfig.WITHINGS_SCOPES, 'user.activity user.metrics');
  assert.equal(savedConfig.WITHINGS_PRIVACY_MODE, 'summary');
  assert.equal(savedConfig.WITHINGS_CACHE, 'sqlite');

  const doctorAfterSetup = spawnSync(process.execPath, ['dist/index.js', 'doctor', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir
    }
  });
  assert.equal(doctorAfterSetup.status, 0, doctorAfterSetup.stderr);
  const doctorAfterSetupPayload = JSON.parse(doctorAfterSetup.stdout);
  assert.deepEqual(doctorAfterSetupPayload.missing_env, []);
  assert.equal(doctorAfterSetupPayload.config.source, 'local_config');
  assert.equal(doctorAfterSetupPayload.automatic_auth_supported, true);
  assert.ok(doctorAfterSetupPayload.next_steps.some((step) => step.includes('auth')));

  console.log(JSON.stringify({ ok: true, cli_ux: true, doctor: true, status: true, auth_plan: true, setup: true }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
