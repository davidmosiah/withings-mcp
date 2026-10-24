import assert from 'node:assert/strict';
import { applyPrivacy } from '../dist/services/privacy.js';
import { decodeMeasure } from '../dist/services/measures.js';
import { buildCollectionOutput } from '../dist/services/collection.js';
import { formatCollection } from '../dist/services/format.js';

const group = { grpid: 900000001, date: 1781056800, category: 1, attrib: 0,
  deviceid: '0000000000000000000000000000000000000001',
  measures: [{ type: 1, value: 72400, unit: -3, futureQuality: 99 },
    { type: 6, value: 1820, unit: -2 }, { type: 88, value: 3210, unit: -3 },
    { type: 99999, value: 123, unit: -1 }] };
const output = buildCollectionOutput('/measure', 'structured', { records: [group], pages_fetched: 1 });
assert.equal(output.source, 'withings');
assert.ok(Number.isFinite(Date.parse(output.fetched_at)));
assert.equal(output.records[0].measured_at, new Date(group.date * 1000).toISOString());
assert.equal(output.records[0].date, group.date);
assert.equal(output.records[0].measures[0].decoded_value, 72.4);
assert.equal(output.records[0].measures[0].futureQuality, 99);
assert.equal(output.records[0].measures[1].decoded_value, 18.2);
assert.equal(output.records[0].measures[2].decoded_value, 3.21);
assert.equal(output.records[0].measures[3].decoded_value, 12.3);
assert.equal(output.records[0].measures[3].unit_label, undefined, 'unknown types must not invent physical units');
for (const mode of ['structured', 'raw']) {
  const result = buildCollectionOutput('/measure', mode, { records: [group], pages_fetched: 1 });
  const markdown = formatCollection('Body measures', result.records, result);
  assert.ok(markdown.includes('72.4 kg') && markdown.includes('18.2 %') && markdown.includes('3.21 kg'));
  assert.ok(markdown.includes('type_99999') && markdown.includes('unit unknown'));
  assert.ok(!markdown.includes('sport/type'));
}
assert.deepEqual(applyPrivacy('/measure', group, 'raw'), group);
for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(decodeMeasure({ type: 1, value, unit: -3 }).decoded_value, undefined);
}
assert.equal(decodeMeasure({ type: 1, value: 0, unit: -3 }).decoded_value, 0);
console.log(JSON.stringify({ ok: true, units: true, timestamps: true, source: true,
  original_values_preserved: true, unknown_types: true, markdown: true }));
