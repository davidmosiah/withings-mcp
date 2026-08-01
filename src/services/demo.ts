/**
 * Synthetic example payloads for `withings_demo`.
 *
 * The stated purpose of the demo tool is that agents see the contract *before*
 * spending an OAuth round-trip on the real Withings API. That only holds if the
 * examples match what the tools actually return — an example advertising a field
 * the server never emits makes an agent write a parser for data that never
 * arrives, which is the exact opposite of the tool's purpose.
 *
 * These shapes are not hand-maintained guesses: `scripts/demo-contract-test.mjs`
 * runs the real `buildDailySummary` / `buildWellnessContext` /
 * `buildCollectionOutput` over a stubbed Withings client and fails the build when
 * the key sets diverge in either direction (keys the demo invents, and contract
 * keys the demo omits).
 *
 * If you change a builder's output shape, that gate fails and points here.
 * Update this file — do not weaken the gate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** Withings returns measure timestamps as Unix epoch seconds, not ISO strings. */
function epochSeconds(daysAgo: number, hourUtc: number): number {
  const day = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return Math.floor(Date.parse(`${day}T${String(hourUtc).padStart(2, "0")}:12:00Z`) / 1000);
}

/**
 * One representative day, matching the shape of `buildDailySummary`.
 *
 * Note what is NOT here: blood pressure and body composition percentages. The
 * daily summary derives a flat `scorecard` and only carries `weight_kg` from the
 * body-measure domain. Everything else lives in `withings_list_body_measures`.
 */
function demoDailySummary(generatedAt: string) {
  const date = isoDate(0);
  return {
    kind: "daily_summary",
    generated_at: generatedAt,
    window: {
      date,
      days: 1,
      timezone: "UTC"
    },
    data_quality: {
      confidence: "high",
      missing_or_failed: {
        activity: false,
        sleep: false,
        measures: false,
        heart: false
      }
    },
    scorecard: {
      date,
      steps: 8421,
      calories: 489,
      distance_m: 6870,
      active_minutes: 41,
      sleep_score: 78,
      sleep_minutes: 448,
      // Already normalized to a percentage by the builder (0.91 -> 91).
      sleep_efficiency: 91,
      deep_sleep_minutes: 84,
      rem_sleep_minutes: 96,
      average_heart_rate: 56,
      weight_kg: 72.5,
      has_activity_error: false,
      has_sleep_error: false,
      has_measures_error: false,
      has_heart_error: false
    },
    diagnostic: {
      readiness_context: "neutral",
      primary_signal: "Use Withings sleep, activity and body measures as wellness context, not diagnosis.",
      action_candidates: [
        "Use Withings trends as baseline context and pair them with subjective energy and schedule pressure.",
        "This is not medical advice; use Withings as wellness context and escalate symptoms or abnormal vitals to a clinician."
      ]
    },
    safety: {
      medical_advice: false,
      api_boundary: "Withings Public API exposes processed activity, sleep, body measure and heart records; this MCP does not expose raw research sensors."
    }
  };
}

/**
 * Handoff payload, matching the shape of `buildWellnessContext`.
 *
 * There is no free-text `recommendation` field: the context tool hands
 * structured signals to another agent and lets that agent do the advising.
 */
function demoWellnessContext(generatedAt: string) {
  return {
    source: "withings",
    generated_at: generatedAt,
    sleep_score: 78,
    recent_training_load: "normal",
    soreness: [],
    injury_flags: [],
    notes: [],
    data_quality: {
      confidence: "high",
      missing_or_failed: {
        activity: false,
        sleep: false,
        measures: false,
        heart: false
      }
    },
    telegram_summary: "Withings wellness context | Sleep: 78 | Load: normal"
  };
}

/**
 * Collection payload, matching the shape every `withings_list_*` tool returns.
 *
 * The records are Withings measure *groups*, not decoded metrics. Each measure
 * is `{ value, type, unit }` and the real number is `value * 10 ** unit`
 * (72500 * 10 ** -3 = 72.5 kg). `type` is a Withings measure-type code:
 * 1 weight, 6 fat ratio %, 76 muscle mass, 9 diastolic, 10 systolic, 11 pulse.
 * An agent that expects a ready-made `weight_kg` here gets nothing.
 */
function demoBodyMeasures() {
  return {
    endpoint: "/measure",
    privacy_mode: "structured",
    count: 2,
    records: [
      {
        grpid: 900000001,
        attrib: 0,
        date: epochSeconds(0, 9),
        created: epochSeconds(0, 9),
        category: 1,
        deviceid: "0000000000000000000000000000000000000001",
        measures: [
          { value: 72500, type: 1, unit: -3 },
          { value: 185, type: 6, unit: -1 },
          { value: 56100, type: 76, unit: -3 }
        ]
      },
      {
        grpid: 900000002,
        attrib: 0,
        date: epochSeconds(1, 9),
        created: epochSeconds(1, 9),
        category: 1,
        deviceid: "0000000000000000000000000000000000000002",
        measures: [
          { value: 118, type: 10, unit: 0 },
          { value: 76, type: 9, unit: 0 },
          { value: 62, type: 11, unit: 0 }
        ]
      }
    ],
    next_page: 2,
    has_more: true,
    pages_fetched: 1
  };
}

export function buildDemoPayload() {
  const generatedAt = new Date().toISOString();
  return {
    ok: true,
    is_demo: true,
    sample: {
      withings_daily_summary: demoDailySummary(generatedAt),
      withings_wellness_context: demoWellnessContext(generatedAt),
      withings_list_body_measures: demoBodyMeasures()
    },
    notes: [
      "All sample data is synthetic; tagged with is_demo=true.",
      "Real calls return live data from the Withings Public API after OAuth setup.",
      "Body measures are raw Withings groups: decode each measure as value * 10 ** unit (72500 * 10 ** -3 = 72.5 kg).",
      "Withings measure-type codes seen here: 1 weight_kg, 6 fat_ratio_pct, 76 muscle_mass, 9 diastolic_mmhg, 10 systolic_mmhg, 11 pulse_bpm.",
      "Blood pressure and body-composition percentages are not in the daily summary scorecard; read them from withings_list_body_measures.",
      "Fields the builders leave undefined (for example scorecard.weight_kg on a day with no weigh-in) are omitted from the JSON response entirely."
    ]
  };
}
