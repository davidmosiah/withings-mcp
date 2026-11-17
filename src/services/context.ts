import type { WithingsClient } from "./withings-client.js";
import { buildDailySummary, type SummaryOptions } from "./summary.js";

type ContextOptions = SummaryOptions & { soreness?: string[]; injury_flags?: string[]; notes?: string };
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function loadFromSteps(steps?: number): "low" | "normal" | "high" | "unknown" {
  if (steps === undefined) return "unknown";
  if (steps >= 15000) return "high";
  if (steps <= 3000) return "low";
  return "normal";
}

export async function buildWellnessContext(client: Pick<WithingsClient, "get">, options: ContextOptions) {
  const summary = await buildDailySummary(client as WithingsClient, options);
  const scorecard = record(summary.scorecard);
  const sleepScore = num(scorecard.sleep_score);
  const steps = num(summary.recent_activity.avg_steps);
  const recentTrainingLoad = loadFromSteps(steps);

  return {
    source: "withings",
    generated_at: summary.generated_at,
    window: summary.window,
    recent_activity: summary.recent_activity,
    sleep_score: sleepScore,
    recent_training_load: recentTrainingLoad,
    soreness: options.soreness ?? [],
    injury_flags: options.injury_flags ?? [],
    notes: [options.notes].filter((note): note is string => Boolean(note)),
    data_quality: summary.data_quality,
    telegram_summary: [
      "Withings wellness context",
      sleepScore !== undefined ? `Sleep: ${sleepScore}` : undefined,
      `Load: ${recentTrainingLoad}`
    ].filter(Boolean).join(" | ")
  };
}

export function formatWellnessContextMarkdown(context: Record<string, unknown>): string {
  return ["# Withings Wellness Context", "", JSON.stringify(context, null, 2)].join("\n");
}
