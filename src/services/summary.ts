import type { WithingsClient } from "./withings-client.js";
import { decodeMeasure } from "./measures.js";
import { redactErrorMessage } from "./redaction.js";

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

function validateDays(value: number, min: number, max: number, name = "days"): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function shiftDate(date: string, days: number): string {
  // UTC is used only for Gregorian calendar arithmetic, never as the user's day boundary.
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function summaryCalendar(timezone = "UTC") {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit"
    });
  } catch {
    throw new Error("Invalid timezone: use an IANA timezone such as America/Toronto or UTC.");
  }
  const dateAt = (epochSeconds: number) => {
    const parts = formatter.formatToParts(epochSeconds * 1000);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const starts = new Map<string, number>();
  const startOfDay = (date: string): number => {
    const cached = starts.get(date);
    if (cached !== undefined) return cached;
    const nominal = Date.parse(`${date}T00:00:00Z`) / 1000;
    // Find the first second of this civil day, including midnight DST transitions.
    // A skipped civil date resolves to the next day's start (an empty interval).
    let low = nominal - 2 * DAY_MS / 1000;
    let high = nominal + 2 * DAY_MS / 1000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dateAt(middle) < date) low = middle + 1;
      else high = middle;
    }
    starts.set(date, low);
    return low;
  };
  return { today: dateAt(Math.floor(Date.now() / 1000)), startOfDay };
}

async function safeGet(client: Pick<WithingsClient, "get">, endpoint: string, params?: Record<string, string | number>): Promise<unknown> {
  try {
    return await client.get(endpoint, params);
  } catch (error) {
    const message = redactErrorMessage(error instanceof Error ? error.message : String(error));
    process.stderr.write(`[withings-mcp] summary domain error: ${message}\n`);
    return { error: message, endpoint };
  }
}

async function dailyBundle(client: Pick<WithingsClient, "get">, date: string, calendar: ReturnType<typeof summaryCalendar>) {
  // getactivity + sleep getsummary require civil dates (startdateymd/enddateymd).
  // getmeas + heart list require Unix epoch seconds (startdate/enddate).
  // Previously every domain used epoch, so activity/sleep summary filters were malformed
  // (same class of vendor date-param bugs as polar-mcp #4).
  const startdate = calendar.startOfDay(date);
  const enddate = calendar.startOfDay(shiftDate(date, 1)) - 1;
  if (enddate < startdate) return { date, activity: {}, sleep: {}, measures: {}, heart: {} };
  const [activity, sleep, measures, heart] = await Promise.all([
    safeGet(client, "/v2/measure", { action: "getactivity", startdateymd: date, enddateymd: date }),
    safeGet(client, "/v2/sleep", { action: "getsummary", startdateymd: date, enddateymd: date, data_fields: SLEEP_SUMMARY_FIELDS }),
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
    has_activity_data: ["steps", "calories", "calories_total", "distance", "active_duration", "moderate", "intense"].some((key) => num(activity, [key]) !== undefined),
    has_sleep_data: ["sleep_score", "total_sleep_time", "asleepduration", "sleep_efficiency", "deepsleepduration", "remsleepduration", "hr_average"].some((key) => num(sleepData, [key]) !== undefined),
    has_measures_data: extractWeightKg(measureGroup) !== undefined,
    has_heart_data: num(heart, ["hr_average", "heart_rate"]) !== undefined,
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
  const decoded = weight ? (decodeMeasure(weight) as UnknownRecord).decoded_value : undefined;
  return typeof decoded === "number" ? round(decoded, 2) : undefined;
}

function classifyReadiness(stats: ReturnType<typeof dailyStats>): string {
  if (stats.sleep_minutes === undefined && stats.sleep_score === undefined) return "unknown";
  const sleepHours = stats.sleep_minutes === undefined ? undefined : stats.sleep_minutes / 60;
  if ((stats.sleep_score ?? 100) < 60) return "low_sleep_score";
  if (sleepHours !== undefined && sleepHours < 6) return "sleep_limited";
  if ((stats.steps ?? 0) > 15_000 && sleepHours !== undefined && sleepHours < 7) return "high_activity_low_sleep";
  return "neutral";
}

function buildActions(stats: ReturnType<typeof dailyStats>, weekly?: ReturnType<typeof aggregateStats>): string[] {
  const actions: string[] = [];
  const state = classifyReadiness(stats);
  if (state === "low_sleep_score") actions.push("Keep recovery recommendations conservative: Withings sleep score is low.");
  if (state === "sleep_limited") actions.push("Treat sleep duration as the main constraint before adding training or work intensity.");
  if (state === "high_activity_low_sleep") actions.push("Activity load is high relative to sleep; bias toward lower intensity and mobility.");
  if (state === "unknown") actions.push("Insufficient sleep data for readiness; check device sync and data availability before making recovery recommendations.");
  if (state === "neutral") actions.push("Use Withings trends as baseline context and pair them with subjective energy and schedule pressure.");
  if (weekly?.avg_sleep_hours !== undefined && weekly.avg_sleep_hours < 6.5) actions.push("Weekly sleep average is below 6.5h; recovery improvements may beat training complexity.");
  actions.push("This is not medical advice; use Withings as wellness context and escalate symptoms or abnormal vitals to a clinician.");
  return [...new Set(actions)];
}

function aggregateStats(days: ReturnType<typeof dailyStats>[]) {
  return {
    days: days.length,
    total_steps: days.some((day) => day.steps !== undefined) ? round(sum(days.map((day) => day.steps)), 0) : undefined,
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

function dailyQuality(stats: ReturnType<typeof dailyStats>) {
  const domains = {
    activity: stats.has_activity_error ? "error" : stats.has_activity_data ? "available" : "no_data",
    sleep: stats.has_sleep_error ? "error" : stats.has_sleep_data ? "available" : "no_data",
    measures: stats.has_measures_error ? "error" : stats.has_measures_data ? "available" : "no_data",
    heart: stats.has_heart_error ? "error" : stats.has_heart_data ? "available" : "no_data"
  };
  const available = Object.values(domains).filter((status) => status === "available").length;
  return {
    confidence: available === 0 ? "low" : available === 4 ? "high" : "partial",
    domains,
    missing_or_failed: {
      activity: domains.activity !== "available",
      sleep: domains.sleep !== "available",
      measures: domains.measures !== "available",
      heart: domains.heart !== "available"
    }
  };
}

async function recentActivity(client: Pick<WithingsClient, "get">, bundle: Awaited<ReturnType<typeof dailyBundle>>, days: number) {
  const start = shiftDate(bundle.date, 1 - days);
  const response = days === 1 ? bundle.activity : await safeGet(client, "/v2/measure", {
    action: "getactivity", startdateymd: start, enddateymd: bundle.date
  });
  const body = bodyOf(response);
  const records = isObject(body) && Array.isArray(body.activities) ? body.activities : [];
  const byDate = new Map<string, number>();
  for (const record of records) {
    if (!isObject(record)) continue;
    const date = typeof record.date === "string" ? record.date : days === 1 ? bundle.date : "";
    const steps = num(record, ["steps"]);
    // Only observed, dated days count; duplicates must not inflate totals or the denominator.
    if (date >= start && date <= bundle.date && /^\d{4}-\d{2}-\d{2}$/.test(date) && steps !== undefined) byDate.set(date, steps);
  }
  const values = [...byDate.values()];
  return {
    start_date: start, end_date: bundle.date, days,
    days_with_activity: values.length,
    average_basis: "observed_days_only" as const,
    total_steps: values.length ? round(sum(values), 0) : undefined,
    avg_steps: round(avg(values), 0),
    status: isObject(response) && typeof response.error === "string" ? "error" : values.length ? "available" : "no_data"
  };
}

export async function buildDailySummary(client: Pick<WithingsClient, "get">, options: SummaryOptions) {
  const days = validateDays(options.days, 1, 30);
  const calendar = summaryCalendar(options.timezone);
  const date = calendar.today;
  const bundle = await dailyBundle(client, date, calendar);
  const stats = dailyStats(bundle);
  const readiness = classifyReadiness(stats);
  const recent = await recentActivity(client, bundle, days);

  return {
    kind: "daily_summary" as const,
    generated_at: new Date().toISOString(),
    window: { date, days, timezone: options.timezone ?? "UTC" },
    data_quality: dailyQuality(stats),
    scorecard: stats,
    recent_activity: recent,
    diagnostic: {
      readiness_context: readiness,
      primary_signal: readiness === "unknown"
        ? "Insufficient sleep data for today's readiness; missing records are not evidence of adequate or inadequate sleep."
        : readiness === "sleep_limited" || readiness === "low_sleep_score"
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
  const days = validateDays(options.days, 7, 60);
  const compareDays = validateDays(options.compare_days ?? 7, 0, 60, "compare_days");
  const calendar = summaryCalendar(options.timezone);
  const date = calendar.today;
  const currentBundles = await Promise.all(Array.from({ length: days }, (_, index) => dailyBundle(client, shiftDate(date, -index), calendar)));
  const current = currentBundles.map(dailyStats).reverse();
  const previous = compareDays > 0
    ? (await Promise.all(Array.from({ length: compareDays }, (_, index) => dailyBundle(client, shiftDate(date, -days - index), calendar)))).map(dailyStats).reverse()
    : [];
  const currentStats = aggregateStats(current);
  const previousStats = previous.length ? aggregateStats(previous) : undefined;
  const failedDomainRequests = current.reduce((total, day) => total + [day.has_activity_error, day.has_sleep_error, day.has_measures_error, day.has_heart_error].filter(Boolean).length, 0);
  const daysWithData = current.filter((day) => Object.values(dailyQuality(day).domains).includes("available")).length;

  return {
    kind: "weekly_summary" as const,
    generated_at: new Date().toISOString(),
    window: {
      days, compare_days: compareDays, timezone: options.timezone ?? "UTC",
      start_date: shiftDate(date, 1 - days), end_date: date,
      comparison_start_date: compareDays ? shiftDate(date, 1 - days - compareDays) : undefined,
      comparison_end_date: compareDays ? shiftDate(date, -days) : undefined
    },
    data_quality: {
      days_with_activity: currentStats.days_with_activity,
      days_with_sleep: currentStats.days_with_sleep,
      days_with_weight: currentStats.days_with_weight,
      days_with_data: daysWithData,
      failed_domain_requests: failedDomainRequests,
      confidence: daysWithData === 0 ? "low" : failedDomainRequests > 0 ? "partial"
        : currentStats.days_with_sleep >= Math.ceil(days * 0.7) || currentStats.days_with_activity >= Math.ceil(days * 0.7) ? "high"
          : currentStats.days_with_sleep >= Math.ceil(days * 0.4) ? "medium" : "low"
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
  const sleep = stats.avg_sleep_hours;
  if (sleep === undefined) return "unknown";
  const steps = stats.avg_steps ?? 0;
  if (steps >= 12_000 && sleep < 6.5) return "high_activity_low_sleep";
  if (sleep < 6.5) return "sleep_limited";
  if (steps >= 8_000 && sleep >= 7) return "good_base";
  return "neutral";
}

function inferBottlenecks(current: ReturnType<typeof aggregateStats>, previous?: ReturnType<typeof aggregateStats>): string[] {
  const bottlenecks: string[] = [];
  const sleepDelta = percentDelta(current.avg_sleep_hours, previous?.avg_sleep_hours);
  if (current.avg_sleep_hours === undefined) bottlenecks.push("Insufficient sleep-duration data to identify a recovery bottleneck.");
  if (current.avg_sleep_hours !== undefined && current.avg_sleep_hours < 6.5) bottlenecks.push("Average sleep is below 6.5h; recovery may be the limiting factor.");
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
