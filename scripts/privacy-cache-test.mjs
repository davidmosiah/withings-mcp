import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrivacyAudit } from '../dist/services/audit.js';
import { WithingsCache } from '../dist/services/cache.js';
import { applyPrivacy, normalizeStreams } from '../dist/services/privacy.js';
import { redactErrorMessage, redactSensitive } from '../dist/services/redaction.js';

const activity = {
  id: 123,
  name: 'Morning Ride',
  activity: 'Ride',
  distance: 42,
  calories: 520,
  start_latlng: [40.1, -73.1],
  map: { summary_polyline: 'encoded' },
  average_heart_rate: 142
};

const structured = applyPrivacy('/v2/measure', activity, 'structured');
assert.equal(structured.id, 123);
assert.equal(structured.average_heart_rate, 142);
assert.equal(structured.start_latlng, undefined);
assert.equal(structured.map, undefined);

const summary = applyPrivacy('/v2/measure', activity, 'summary');
assert.equal(summary.activity, 'Ride');
assert.equal(summary.calories, 520);
assert.equal(summary.map, undefined);

const raw = applyPrivacy('/v2/measure', activity, 'raw');
assert.equal(raw.map.summary_polyline, 'encoded');

const streams = normalizeStreams({ heartrate: { data: [120, 121] }, latlng: { data: [[1, 2]] } }, 'structured', false);
assert.equal(streams.latlng, undefined);
assert.deepEqual(streams.heartrate.data, [120, 121]);

assert.equal(redactSensitive({ access_token: 'abc', nested: { client_secret: 'def' } }).access_token, '[REDACTED]');
assert.match(redactErrorMessage('Authorization: Bearer abc.def.ghi'), /REDACTED/);
assert.equal(buildPrivacyAudit().unofficial, true);
assert.equal(buildPrivacyAudit().gps_redaction_default, true);

const dir = mkdtempSync(join(tmpdir(), 'withings-mcp-cache-'));
try {
  const path = join(dir, 'cache.sqlite');
  const cache = new WithingsCache(path);
  cache.set('GET', 'https://example.com/a', { ok: true });
  assert.deepEqual(cache.get('GET', 'https://example.com/a'), { ok: true });
  assert.equal(cache.status().entries, 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, privacy: true, cache: true, redaction: true, audit: true }, null, 2));
