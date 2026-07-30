import assert from 'node:assert/strict';
import { buildDailySummary, buildWeeklySummary } from '../dist/services/summary.js';
import { buildWellnessContext } from '../dist/services/context.js';

const today = new Date().toISOString().slice(0, 10);
const summaryCalls = [];

const fakeClient = {
  async get(endpoint, params) {
    summaryCalls.push({ endpoint, params: { ...(params ?? {}) } });
    if (endpoint.includes('/v2/measure')) {
      return { body: { activities: [{ date: today, steps: 9000, calories: 520, distance: 7200, active_duration: 3600 }] } };
    }
    if (endpoint.includes('/v2/sleep')) {
      return { body: { series: [{ date: today, data: { sleep_score: 88, total_sleep_time: 25800, sleep_efficiency: 0.91, deepsleepduration: 5400, remsleepduration: 6300, hr_average: 58 } }] } };
    }
    if (endpoint === '/measure') {
      return { body: { measuregrps: [{ date: today, measures: [{ type: 1, value: 8000, unit: -2 }] }] } };
    }
    if (endpoint.includes('/v2/heart')) {
      return { body: { heart: [{ date: today, hr_average: 58 }] } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }
};

const daily = await buildDailySummary(fakeClient, { days: 7, timezone: 'UTC' });
assert.equal(daily.kind, 'daily_summary');
assert.equal(daily.scorecard.steps, 9000);
assert.equal(daily.scorecard.sleep_minutes, 430);
assert.equal(daily.scorecard.average_heart_rate, 58);
assert.equal(daily.scorecard.weight_kg, 80);
assert.ok(daily.diagnostic.action_candidates.length >= 2);

// Summary must use civil ymd params for activity + sleep summary, epoch for measures + heart.
const activityCall = summaryCalls.find((call) => call.params.action === 'getactivity');
const sleepSummaryCall = summaryCalls.find((call) => call.params.action === 'getsummary');
const measuresCall = summaryCalls.find((call) => call.params.action === 'getmeas');
const heartCall = summaryCalls.find((call) => call.params.action === 'list');
assert.ok(activityCall, 'daily summary must request getactivity');
assert.equal(activityCall.params.startdateymd, today);
assert.equal(activityCall.params.enddateymd, today);
assert.equal(activityCall.params.startdate, undefined);
assert.ok(sleepSummaryCall, 'daily summary must request sleep getsummary');
assert.equal(sleepSummaryCall.params.startdateymd, today);
assert.equal(sleepSummaryCall.params.enddateymd, today);
assert.equal(sleepSummaryCall.params.startdate, undefined);
assert.ok(measuresCall);
assert.equal(typeof measuresCall.params.startdate, 'number');
assert.equal(typeof measuresCall.params.enddate, 'number');
assert.equal(measuresCall.params.startdateymd, undefined);
assert.ok(heartCall);
assert.equal(typeof heartCall.params.startdate, 'number');
assert.equal(heartCall.params.startdateymd, undefined);

const weekly = await buildWeeklySummary(fakeClient, { days: 7, compare_days: 7, timezone: 'UTC' });
assert.equal(weekly.kind, 'weekly_summary');
assert.equal(weekly.scorecard.current.days, 7);
assert.equal(weekly.scorecard.current.avg_sleep_hours, 7.17);
assert.equal(weekly.scorecard.current.avg_sleep_score, 88);
assert.ok(weekly.diagnostic.bottlenecks.length >= 1);

const context = await buildWellnessContext(fakeClient, { days: 7, timezone: 'UTC' });
assert.equal(context.source, 'withings');
assert.equal(context.sleep_score, 88);
assert.equal(context.recent_training_load, 'normal');

let capturedStderr = '';
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
  capturedStderr += String(chunk);
  return true;
};
try {
  const partialClient = {
    async get(endpoint, params) {
      if (endpoint.includes('/v2/sleep')) throw new Error('synthetic Withings sleep failure');
      return fakeClient.get(endpoint, params);
    },
  };
  await buildDailySummary(partialClient, { days: 7, timezone: 'UTC' });
} finally {
  process.stderr.write = originalStderrWrite;
}
assert.match(capturedStderr, /\[withings-mcp\] summary domain error: synthetic Withings sleep failure/);

console.log(JSON.stringify({ ok: true, daily: daily.kind, weekly: weekly.kind }, null, 2));
