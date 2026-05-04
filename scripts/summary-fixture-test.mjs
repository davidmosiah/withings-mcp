import assert from 'node:assert/strict';
import { buildDailySummary, buildWeeklySummary } from '../dist/services/summary.js';

const today = new Date().toISOString().slice(0, 10);

const fakeClient = {
  async get(endpoint) {
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

const weekly = await buildWeeklySummary(fakeClient, { days: 7, compare_days: 7, timezone: 'UTC' });
assert.equal(weekly.kind, 'weekly_summary');
assert.equal(weekly.scorecard.current.days, 7);
assert.equal(weekly.scorecard.current.avg_sleep_hours, 7.17);
assert.equal(weekly.scorecard.current.avg_sleep_score, 88);
assert.ok(weekly.diagnostic.bottlenecks.length >= 1);

console.log(JSON.stringify({ ok: true, daily: daily.kind, weekly: weekly.kind }, null, 2));
