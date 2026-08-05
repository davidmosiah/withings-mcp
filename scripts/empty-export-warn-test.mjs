import assert from 'node:assert/strict';
import { buildCollectionOutput } from '../dist/services/collection.js';
import { formatCollection } from '../dist/services/format.js';

const empty = buildCollectionOutput('/v2/measure', 'structured', { records: [], pages_fetched: 1 });
assert.equal(empty.count, 0);
assert.equal(empty.empty, true);
assert.match(empty.warning ?? '', /zero rows/i);

const md = formatCollection('Withings Measures', empty.records, empty);
assert.match(md, /zero rows/i);

const filled = buildCollectionOutput('/v2/measure', 'structured', {
  records: [{ id: 1, type: 'weight' }],
  pages_fetched: 1
});
assert.equal(filled.empty, false);
assert.equal(filled.warning, undefined);

console.log(JSON.stringify({ ok: true, suite: 'empty-export-warn', empty: empty.empty }));
