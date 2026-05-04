import type { WithingsClient } from "./withings-client.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SLEEP_SUMMARY_FIELDS = "sleep_score,total_sleep_time,total_timeinbed,sleep_efficiency,deepsleepduration,lightsleepduration,remsleepduration,wakeupduration,hr_average,hr_min,hr_max,rr_average";

type UnknownRecord = Record<string, unknown>;

export interface SummaryOptions {
  days: number;
  compare_days?: number;
  timezone?: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bodyOf(value: unknown): unknown {
  return isObject(value) && isObject(value.body) ? value.body : value;
}

function firstSeries(value: unknown): UnknownRecord {
  const body = bodyOf(value);
  if (Array.isArray(body)) return isObject(body[0]) ? body[0] : {};
  if (!isObject(body)) return {};
  for (const key of ["series", "activities", "measuregrps", "heart"]) {
    if (Array.isArray(body[key])) return isObject((body[key] as unknown[])[0]) ? (body[key] as UnknownRecord[])[0] : {};
  }
  return body;
}

function num(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function round(value?: number, digits = 1): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function avg(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return nums.length ? sum(nums) / nums.length : undefined;
}

function percentDelta(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

function dateString(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function epochSeconds(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

async function safeGet(client: Pick<WithingsClient, "get">, endpoint: string, params?: Record<string, string | number>): Promise<unknown> {
  try {
    return await client.get(endpoint, params);
  } catch (error) {
    return { error: (error as Error).message, endpoint };
  }
}

async function dailyBundle(client: Pick<WithingsClient, "get">, date: string) {
  const startdate = epochSeconds(date);
  const enddate = startdate + 86_399;
  const [activity, sleep, measures, heart] = await Promise.all([
    safeGet(client, "/v2/measure", { action: "getactivity", startdate, enddate }),
    safeGet(client, "/v2/sleep", { action: "getsummary", startdate, enddate, data_fields: SLEEP_SUMMARY_FIELDS }),
    safeGet(client, "/measure", { action: "getmeas", startdate, enddate }),
    safeGet(client, "/v2/heart", { action: "list", startdate, enddate })
  ]);
  return { date, activity, sleep, measures, heart };
}

function dailyStats(bundle: Awaited<ReturnType<typeof dailyBundle>>) {
  const activity = firstSeries(bundle.activity);
  const sleepSeries = firstSeries(bundle.sleep);
  const sleepData = isObject(sleepSeries.data) ? sleepSeries.data : sleepSeries;
  const measureGroup = firstSeries(bundle.measures);
  const heart = firstSeries(bundle.heart);
  const totalSleepSeconds = num(sleepData, ["total_sleep_time", "asleepduration"]);

  return {
    date: bundle.date,
    steps: num(activity, ["steps"]),
    calories: num(activity, ["calories", "calories_total"]),
    distance_m: num(activity, ["distance"]),
    active_minutes: secondsToMinutes(num(activity, ["active_duration", "moderate", "intense"])),
    sleep_score: num(sleepData, ["sleep_score"]),
    sleep_minutes: secondsToMinutes(totalSleepSeconds),
    sleep_efficiency: normalizePercent(num(sleepData, ["sleep_efficiency"])),
    deep_sleep_minutes: secondsToMinutes(num(sleepData, ["deepsleepduration"])),
    rem_sleep_minutes: secondsToMinutes(num(sleepData, ["remsleepduration"])),
    average_heart_rate: num(sleepData, ["hr_average"]) ?? num(heart, ["hr_average", "heart_rate"]),
    weight_kg: extractWeightKg(measureGroup),
    has_activity_error: isObject(bundle.activity) && typeof bundle.activity.error === "string",
    has_sleep_error: isObject(bundle.sleep) && typeof bundle.sleep.error === "string",
    has_measures_error: isObject(bundle.measures) && typeof bundle.measures.error === "string",
    has_heart_error: isObject(bundle.heart) && typeof bundle.heart.error === "string"
  };
}

function secondsToMinutes(value?: number): number | undefined {
  return value === undefined ? undefined : round(value / 60, 0);
}

function normalizePercent(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return value <= 1 ? round(value * 100, 1) : round(value, 1);
}

function extractWeightKg(group: UnknownRecord): number | undefined {
  const measures = Array.isArray(group.measures) ? group.measures as UnknownRecord[] : [];
  const weight = measures.find((measure) => num(measure, ["type"]) === 1);
  const value = weight ? num(weight, ["value"]) : undefined;
  const unit = weight ? num(weight, ["unit"]) : undefined;
  return value === undefined || unit === undefined ? undefined : round(value * (10 ** unit), 2);
}

function classifyReadiness(stats: ReturnType<typeof dailyStats>): string {
  const sleepHours = (stats.sleep_minutes ?? 0) / 60;
  if ((stats.sleep_score ?? 100) < 60) return "low_sleep_score";
  if (sleepHours > 0 && sleepHours < 6) return "sleep_limited";
  if ((stats.steps ?? 0) > 15_000 && sleepHours > 0 && sleepHours < 7) return "high_activity_low_sleep";
  return "neutral";
}

function buildActions(stats: ReturnType<typeof dailyStats>, weekly?: ReturnType<typeof aggregateStats>): string[] {
  const actions: string[] = [];
  const state = classifyReadiness(stats);
  if (state === "low_sleep_score") actions.push("Keep recovery recommendations conservative: Withings sleep score is low.");
  if (state === "sleep_limited") actions.push("Treat sleep duration as the main constraint before adding training or work intensity.");
  if (state === "high_activity_low_sleep") actions.push("Activity load is high relative to sleep; bias toward lower intensity and mobility.");
  if (state === "neutral") actions.push("Use Withings trends as baseline context and pair them with subjective energy and schedule pressure.");
  if (weekly?.avg_sleep_hours !== undefined && weekly.avg_sleep_hours < 6.5) actions.push("Weekly sleep average is below 6.5h; recovery improvements may beat training complexity.");
  actions.push("This is not medical advice; use Withings as wellness context and escalate symptoms or abnormal vitals to a clinician.");
  return [...new Set(actions)];
}

function aggregateStats(days: ReturnType<typeof dailyStats>[]) {
  return {
    days: days.length,
    total_steps: round(sum(days.map((day) => day.steps)), 0),
    avg_steps: round(avg(days.map((day) => day.steps)), 0),
    avg_sleep_score: round(avg(days.map((day) => day.sleep_score)), 1),
    avg_sleep_hours: round(avg(days.map((day) => day.sleep_minutes).map((minutes) => minutes === undefined ? undefined : minutes / 60)), 2),
    avg_sleep_efficiency: round(avg(days.map((day) => day.sleep_efficiency)), 1),
    avg_heart_rate: round(avg(days.map((day) => day.average_heart_rate)), 0),
    latest_weight_kg: [...days].reverse().find((day) => day.weight_kg !== undefined)?.weight_kg,
    days_with_activity: days.filter((day) => day.steps !== undefined).length,
    days_with_sleep: days.filter((day) => day.sleep_minutes !== undefined || day.sleep_score !== undefined).length,
    days_with_weight: days.filter((day) => day.weight_kg !== undefined).length
  };
}

export async function buildDailySummary(client: Pick<WithingsClient, "get">, options: SummaryOptions) {
  const date = dateString(0);
  const bundle = await dailyBundle(client, date);
  const stats = dailyStats(bundle);
  const readiness = classifyReadiness(stats);

  return {
    kind: "daily_summary" as const,
    generated_at: new Date().toISOString(),
    window: { date, days: options.days, timezone: options.timezone ?? "UTC" },
    data_quality: {
      confidence: [stats.has_activity_error, stats.has_sleep_error, stats.has_measures_error].filter(Boolean).length === 0 ? "high" : "partial",
      missing_or_failed: {
        activity: stats.has_activity_error,
        sleep: stats.has_sleep_error,
        measures: stats.has_measures_error,
        heart: stats.has_heart_error
      }
    },
    scorecard: stats,
    diagnostic: {
      readiness_context: readiness,
      primary_signal: readiness === "sleep_limited" || readiness === "low_sleep_score"
        ? "Sleep is the limiting context today; keep recommendations conservative."
        : "Use Withings sleep, activity and body measures as wellness context, not diagnosis.",
      action_candidates: buildActions(stats)
    },
    safety: {
      medical_advice: false,
      api_boundary: "Withings Public API exposes processed activity, sleep, body measure and heart records; this MCP does not expose raw research sensors."
    }
  };
}

export async function buildWeeklySummary(client: Pick<WithingsClient, "get">, options: SummaryOptions) {
  const days = Math.max(options.days, 7);
  const compareDays = options.compare_days ?? 7;
  const currentBundles = await Promise.all(Array.from({ length: days }, (_, index) => dailyBundle(client, dateString(index))));
  const current = currentBundles.map(dailyStats).reverse();
  const previous = compareDays > 0
    ? (await Promise.all(Array.from({ length: compareDays }, (_, index) => dailyBundle(client, dateString(days + index))))).map(dailyStats).reverse()
    : [];
  const currentStats = aggregateStats(current);
  const previousStats = previous.length ? aggregateStats(previous) : undefined;

  return {
    kind: "weekly_summary" as const,
    generated_at: new Date().toISOString(),
    window: { days, compare_days: compareDays, timezone: options.timezone ?? "UTC" },
    data_quality: {
      days_with_activity: currentStats.days_with_activity,
      days_with_sleep: currentStats.days_with_sleep,
      days_with_weight: currentStats.days_with_weight,
      confidence: currentStats.days_with_sleep >= 5 || currentStats.days_with_activity >= 5 ? "high" : currentStats.days_with_sleep >= 3 ? "medium" : "low"
    },
    scorecard: {
      current: currentStats,
      previous: previousStats,
      delta: previousStats ? {
        steps_pct: round(percentDelta(currentStats.avg_steps, previousStats.avg_steps), 1),
        sleep_score_pct: round(percentDelta(currentStats.avg_sleep_score, previousStats.avg_sleep_score), 1),
        sleep_hours_pct: round(percentDelta(currentStats.avg_sleep_hours, previousStats.avg_sleep_hours), 1),
        heart_rate_pct: round(percentDelta(currentStats.avg_heart_rate, previousStats.avg_heart_rate), 1)
      } : undefined
    },
    diagnostic: {
      load_classification: classifyWeeklyLoad(currentStats),
      bottlenecks: inferBottlenecks(currentStats, previousStats),
      action_candidates: buildActions(current[current.length - 1] ?? current[0], currentStats),
      next_week_success_metrics: [
        "Keep sleep average above the user's sustainable baseline before increasing intensity.",
        "Track steps and sleep score together rather than optimizing one metric.",
        "Use body measures as trend context, not same-day performance judgment.",
        "If symptoms, illness or abnormal vitals appear, seek clinical guidance instead of agent optimization."
      ]
    },
    safety: {
      medical_advice: false,
      raw_sensor_boundary: "Withings MCP exposes processed Public API data, not Advanced Research API raw accelerometer or PPG streams."
    }
  };
}

function classifyWeeklyLoad(stats: ReturnType<typeof aggregateStats>): string {
  const sleep = stats.avg_sleep_hours ?? 0;
  const steps = stats.avg_steps ?? 0;
  if (steps >= 12_000 && sleep < 6.5) return "high_activity_low_sleep";
  if (sleep < 6.5) return "sleep_limited";
  if (steps >= 8_000 && sleep >= 7) return "good_base";
  return "neutral";
}

function inferBottlenecks(current: ReturnType<typeof aggregateStats>, previous?: ReturnType<typeof aggregateStats>): string[] {
  const bottlenecks: string[] = [];
  const sleepDelta = percentDelta(current.avg_sleep_hours, previous?.avg_sleep_hours);
  if ((current.avg_sleep_hours ?? 0) < 6.5) bottlenecks.push("Average sleep is below 6.5h; recovery may be the limiting factor.");
  if ((current.avg_sleep_score ?? 100) < 65) bottlenecks.push("Average sleep score is low; prioritize sleep consistency before load increases.");
  if (sleepDelta !== undefined && sleepDelta < -10) bottlenecks.push("Sleep duration decreased materially versus the comparison window.");
  if (current.days_with_weight > 0 && current.days_with_weight < 3) bottlenecks.push("Body-measure data is sparse; avoid over-interpreting weight or composition changes.");
  if (!bottlenecks.length) bottlenecks.push("No obvious Withings-only bottleneck; combine trends with subjective energy, symptoms and life stress.");
  return bottlenecks;
}

export function formatSummaryMarkdown(summary: Record<string, unknown>): string {
  const lines = [`# Withings ${summary.kind === "weekly_summary" ? "Weekly" : "Daily"} Summary`, ""];
  lines.push(`Generated: ${summary.generated_at}`);
  const diagnostic = summary.diagnostic as { primary_signal?: string; load_classification?: string; readiness_context?: string; action_candidates?: string[]; bottlenecks?: string[] } | undefined;
  if (diagnostic?.primary_signal) lines.push(`\n## Primary signal\n${diagnostic.primary_signal}`);
  if (diagnostic?.readiness_context) lines.push(`\n## Readiness context\n${diagnostic.readiness_context}`);
  if (diagnostic?.load_classification) lines.push(`\n## Load\n${diagnostic.load_classification}`);
  if (diagnostic?.bottlenecks?.length) {
    lines.push("\n## Bottlenecks");
    diagnostic.bottlenecks.forEach((item) => lines.push(`- ${item}`));
  }
  if (diagnostic?.action_candidates?.length) {
    lines.push("\n## Action candidates");
    diagnostic.action_candidates.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push("\n## Structured data");
  lines.push("```json");
  lines.push(JSON.stringify(summary, null, 2));
  lines.push("```");
  return lines.join("\n");
}
