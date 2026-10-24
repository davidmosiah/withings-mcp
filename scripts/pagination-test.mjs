import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WithingsClient } from '../dist/services/withings-client.js';
import { buildCollectionOutput } from '../dist/services/collection.js';

const home = await mkdtemp(join(tmpdir(), 'withings-pagination-'));
const tokenPath = join(home, 'tokens.json');
await writeFile(tokenPath, JSON.stringify({ access_token: 'synthetic-access', expires_at: 4102444800 }));
const config = { clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'http://localhost:3000/callback',
  scopes: ['user.metrics'], tokenPath, privacyMode: 'structured', cacheEnabled: false, cachePath: join(home, 'cache.sqlite') };
const original = globalThis.fetch;
let pages;
let offsets;
function serve(responses) {
  pages = [...responses]; offsets = [];
  globalThis.fetch = async (_url, init) => {
    offsets.push(Number(new URLSearchParams(init.body).get('offset')));
    assert.ok(pages.length, 'unexpected request beyond supplied pages');
    return Response.json({ status: 0, body: pages.shift() });
  };
}
try {
  const client = new WithingsClient(config);
  // Numeric more, vendor offsets, and short pages must all be honored.
  serve([{ measuregrps: [{ grpid: 1 }], more: 1, offset: 37 },
    { measuregrps: [{ grpid: 2 }], more: 0 }]);
  const complete = await client.list('/measure', { action: 'getmeas', limit: 5, all_pages: true, max_pages: 3 });
  assert.deepEqual(offsets, [0, 37]);
  assert.deepEqual(complete.records.map(x => x.grpid), [1, 2]);
  assert.equal(complete.next_offset, undefined);
  assert.equal(complete.pages_fetched, 2);

  // A bounded export must expose the exact continuation, including when it
  // returns no rows on an intermediate vendor page.
  serve([{ measuregrps: [], more: true, offset: 91 }]);
  const partial = await client.list('/measure', { action: 'getmeas', limit: 2, all_pages: true, max_pages: 1 });
  assert.equal(partial.next_offset, 91);
  assert.equal(buildCollectionOutput('/measure', 'raw', partial).has_more, true);
  serve([{ measuregrps: [{ grpid: 3 }], more: false }]);
  await client.list('/measure', { action: 'getmeas', offset: partial.next_offset, page: 99, limit: 2 });
  assert.deepEqual(offsets, [91]);

  // Local caps must not jump straight to the vendor's next offset.
  serve([{ measuregrps: [1, 2, 3, 4], more: 1, offset: 37 }]);
  const capped = await client.list('/measure', { action: 'getmeas', offset: 10, limit: 2 });
  assert.deepEqual(capped.records, [1, 2]);
  assert.equal(capped.next_offset, 12);

  for (const offset of [0, -1]) {
    serve([{ measuregrps: [], more: 1, offset }]);
    await assert.rejects(client.list('/measure', { action: 'getmeas' }), /pagination did not advance/);
  }
  console.log(JSON.stringify({ ok: true, numeric_more: true, vendor_offset: true, short_pages: true,
    exact_continuation: true, local_cap: true, stalled_cursor: true }));
} finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
