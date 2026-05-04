import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectionStatus } from '../dist/services/connection-status.js';
import { formatCollection } from '../dist/services/format.js';

const dir = mkdtempSync(join(tmpdir(), 'withings-mcp-agent-readiness-'));

try {
  const markdown = formatCollection('Withings Activities', [
    { id: 1, name: 'Morning Tennis', sport_type: 'Tennis', start_date: '2026-04-27T12:30:43Z', distance: 41.3 },
    { id: 2, name: 'Afternoon Tennis', sport_type: 'Tennis', start_date: '2026-04-26T20:05:51Z', distance: 4557 }
  ], {
    endpoint: '/1/user/-/activities/list.json',
    privacy_mode: 'summary',
    count: 2,
    records: [{ id: 1 }, { id: 2 }],
    pages_fetched: 1
  });

  assert.doesNotMatch(markdown, /\[object Object\]/, 'Markdown previews must never leak JavaScript object stringification.');
  assert.doesNotMatch(markdown, /\*\*records\*\*/i, 'Collection markdown should not duplicate full record arrays in metadata.');
  assert.match(markdown, /Morning Tennis/);

  const tokenPath = join(dir, 'tokens.json');
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'user.metrics'
  }), { mode: 0o600 });

  const limited = await buildConnectionStatus({
    env: {
      WITHINGS_CLIENT_ID: 'client-id',
      WITHINGS_CLIENT_SECRET: 'client-secret',
      WITHINGS_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      WITHINGS_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });

  assert.equal(limited.ready_for_withings_api, false, 'A metrics-only token should not be reported as fully ready for Withings health tools.');
  assert.equal(limited.ok, false);
  assert.deepEqual(limited.oauth.granted_scopes, ['user.metrics']);
  assert.ok(limited.oauth.missing_recommended_scopes.includes('user.activity'));
  assert.equal(limited.oauth.activity_tools_ready, false);
  assert.equal(limited.oauth.profile_tools_ready, true);
  assert.ok(limited.next_steps.some((step) => /re-authorize/i.test(step) && /user\.activity/.test(step)));

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
      WITHINGS_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });

  assert.equal(ready.ok, true);
  assert.equal(ready.ready_for_withings_api, true);
  assert.deepEqual(ready.oauth.missing_recommended_scopes, []);
  assert.equal(ready.oauth.activity_tools_ready, true);

  console.log(JSON.stringify({ ok: true, markdown: true, scope_diagnostics: true }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
