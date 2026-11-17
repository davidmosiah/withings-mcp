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

// All regression fixtures below are synthetic and never contact Withings.
const { test } = await import('node:test');
const fixedNow = Date.now;
async function at(instant, run) {
  Date.now = () => Date.parse(instant);
  try { await run(); } finally { Date.now = fixedNow; }
}
function fixtureClient(respond = () => undefined) {
  const calls = [];
  return {
    calls,
    async get(endpoint, params) {
      calls.push({ endpoint, params });
      const response = respond(endpoint, params);
      if (response !== undefined) return response;
      const key = endpoint === '/v2/measure' ? 'activities' : endpoint === '/v2/sleep' ? 'series' : endpoint === '/measure' ? 'measuregrps' : 'heart';
      return { body: { [key]: [] } };
    }
  };
}

await test('daily uses the selected civil date and DST-aware epoch interval', async () => {
  for (const [instant, timezone, date, start, end] of [
    ['2026-11-17T04:30:00Z', 'America/Toronto', '2026-11-16', '2026-11-16T05:00:00Z', '2026-11-17T04:59:59Z'],
    ['2026-11-16T15:30:00Z', 'Asia/Tokyo', '2026-11-17', '2026-11-16T15:00:00Z', '2026-11-17T14:59:59Z'],
    ['2026-03-08T17:00:00Z', 'America/Toronto', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59Z'],
    ['2026-11-01T17:00:00Z', 'America/Toronto', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T04:59:59Z'],
    ['2026-11-16T18:30:00Z', 'Asia/Kathmandu', '2026-11-17', '2026-11-16T18:15:00Z', '2026-11-17T18:14:59Z'],
    ['2026-11-17T04:30:00Z', 'UTC', '2026-11-17', '2026-11-17T00:00:00Z', '2026-11-17T23:59:59Z']
  ]) {
    await at(instant, async () => {
      const client = fixtureClient();
      const result = await buildDailySummary(client, { days: 1, timezone });
      assert.equal(result.window.date, date, timezone);
      for (const call of client.calls) {
        if (call.params.startdateymd) {
          assert.equal(call.params.startdateymd, date, timezone);
          assert.equal(call.params.enddateymd, date, timezone);
        } else {
          assert.equal(call.params.startdate, Date.parse(start) / 1000, timezone);
          assert.equal(call.params.enddate, Date.parse(end) / 1000, timezone);
        }
      }
      assert.equal(client.calls.length, 4, 'one-day summaries need no extra lookback call');
    });
  }
});

await test('empty daily and weekly responses are missing, not healthy or zero sleep', async () => {
  const dailyEmpty = await buildDailySummary(fixtureClient(), { days: 1 });
  assert.equal(dailyEmpty.data_quality.confidence, 'low');
  assert.deepEqual(dailyEmpty.data_quality.missing_or_failed, { activity: true, sleep: true, measures: true, heart: true });
  assert.equal(dailyEmpty.diagnostic.readiness_context, 'unknown');
  assert.match(dailyEmpty.diagnostic.primary_signal, /insufficient|no data/i);
  const weeklyEmpty = await buildWeeklySummary(fixtureClient(), { days: 7, compare_days: 7 });
  assert.equal(weeklyEmpty.data_quality.confidence, 'low');
  assert.equal(weeklyEmpty.scorecard.current.total_steps, undefined);
  assert.equal(weeklyEmpty.diagnostic.load_classification, 'unknown');
  assert.ok(!weeklyEmpty.diagnostic.bottlenecks.some((message) => /sleep is below|no obvious/i.test(message)));
});

await test('observed zero metrics stay available while unobserved domains stay missing', async () => {
  const client = fixtureClient((endpoint) => endpoint === '/v2/measure'
    ? { body: { activities: [{ steps: 0, calories: 0 }] } }
    : endpoint === '/v2/sleep' ? { body: { series: [{ data: { total_sleep_time: 0 } }] } } : undefined);
  const result = await buildDailySummary(client, { days: 1 });
  assert.equal(result.scorecard.steps, 0);
  assert.equal(result.scorecard.sleep_minutes, 0);
  assert.equal(result.data_quality.missing_or_failed.activity, false);
  assert.equal(result.data_quality.missing_or_failed.sleep, false);
  assert.equal(result.data_quality.missing_or_failed.heart, true);
  assert.equal(result.data_quality.confidence, 'partial');
  assert.equal(result.diagnostic.readiness_context, 'sleep_limited');
  const week = await buildWeeklySummary(client, { days: 7, compare_days: 0 });
  assert.equal(week.scorecard.current.total_steps, 0);
  assert.equal(week.diagnostic.load_classification, 'sleep_limited');
});

await test('daily days controls dated recent activity without substituting historical data for today', async () => {
  await at('2026-11-17T04:30:00Z', async () => {
    const client = fixtureClient((endpoint, params) => {
      if (endpoint !== '/v2/measure' || params.startdateymd === params.enddateymd) return undefined;
      return { body: { activities: [
        { date: '2026-11-14', steps: 0 },
        { date: '2026-11-15', steps: 12000 },
        { date: '2026-11-15', steps: 12000 },
        { date: '2026-11-13', steps: 999999 },
        { date: '2026-11-17', steps: 999999 }
      ] } };
    });
    const result = await buildDailySummary(client, { days: 3, timezone: 'America/Toronto' });
    assert.equal(result.scorecard.date, '2026-11-16');
    assert.equal(result.scorecard.steps, undefined);
    assert.equal(result.data_quality.confidence, 'low');
    assert.equal(result.diagnostic.readiness_context, 'unknown');
    assert.equal(result.recent_activity.start_date, '2026-11-14');
    assert.equal(result.recent_activity.end_date, '2026-11-16');
    assert.equal(result.recent_activity.days_with_activity, 2);
    assert.equal(result.recent_activity.avg_steps, 6000, 'average covers observed days, not missing days or duplicate records');
    assert.equal(result.recent_activity.total_steps, 12000);
    assert.equal(client.calls.length, 5, 'lookback requires at most one additional range request');
    const contextResult = await buildWellnessContext(client, { days: 3, timezone: 'America/Toronto' });
    assert.equal(contextResult.sleep_score, undefined);
    assert.equal(contextResult.recent_training_load, 'normal');
    assert.equal(contextResult.window.date, '2026-11-16');
    assert.equal(contextResult.recent_activity.days_with_activity, 2);
  });
});

await test('weekly windows are contiguous civil days even across DST and a clock rollover', async () => {
  await at('2026-03-09T03:30:00Z', async () => {
    const client = fixtureClient(() => {
      // A request crossing midnight must not move later bundles into the next day.
      Date.now = () => Date.parse('2026-03-09T05:30:00Z');
    });
    const result = await buildWeeklySummary(client, { days: 7, compare_days: 2, timezone: 'America/Toronto' });
    assert.equal(result.window.start_date, '2026-03-02');
    assert.equal(result.window.end_date, '2026-03-08');
    assert.equal(result.window.comparison_start_date, '2026-02-28');
    assert.equal(result.window.comparison_end_date, '2026-03-01');
    const activityDates = client.calls.filter((call) => call.params.action === 'getactivity').map((call) => call.params.startdateymd).sort();
    assert.deepEqual(activityDates, ['2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
    const epochs = client.calls.filter((call) => call.endpoint === '/measure').map((call) => call.params).sort((a, b) => a.startdate - b.startdate);
    assert.equal(epochs[0].startdate, Date.parse('2026-02-28T05:00:00Z') / 1000);
    assert.equal(epochs.at(-1).enddate, Date.parse('2026-03-09T03:59:59Z') / 1000);
    for (let i = 1; i < epochs.length; i++) assert.equal(epochs[i - 1].enddate + 1, epochs[i].startdate);
  });
});

await test('invalid zones and unbounded windows fail before making provider requests', async () => {
  for (const [builder, options] of [
    [buildDailySummary, { days: 1, timezone: 'Not/AZone' }],
    [buildWeeklySummary, { days: 7, timezone: 'Not/AZone' }],
    [buildDailySummary, { days: 31 }],
    [buildDailySummary, { days: 0 }],
    [buildDailySummary, { days: 1.5 }],
    [buildWeeklySummary, { days: 61 }],
    [buildWeeklySummary, { days: 7, compare_days: -1 }],
    [buildWeeklySummary, { days: 7, compare_days: Infinity }]
  ]) {
    const client = fixtureClient();
    await assert.rejects(builder(client, options), /timezone|days/i);
    assert.equal(client.calls.length, 0);
  }
});


await test('heart-only failure marks daily and weekly coverage partial, without losing other domains', async () => {
  const client = {
    async get(endpoint, params) {
      if (endpoint === '/v2/heart') throw new Error('synthetic heart unavailable');
      return fakeClient.get(endpoint, params);
    }
  };
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const day = await buildDailySummary(client, { days: 1 });
    assert.equal(day.data_quality.domains.heart, 'error');
    assert.equal(day.data_quality.confidence, 'partial');
    assert.equal(day.scorecard.sleep_score, 88);
    const week = await buildWeeklySummary(client, { days: 7, compare_days: 0 });
    assert.equal(week.data_quality.failed_domain_requests, 7);
    assert.equal(week.data_quality.confidence, 'partial');
    assert.equal(week.scorecard.current.avg_sleep_score, 88);
  } finally {
    process.stderr.write = write;
  }
});
