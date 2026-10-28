/** Official Measure - Getmeas types. Unknown types retain their original fields. */
const TYPES: Record<number, [string, string?]> = {
  1: ["weight", "kg"], 4: ["height", "m"], 5: ["fat_free_mass", "kg"],
  6: ["fat_ratio", "%"], 8: ["fat_mass", "kg"],
  9: ["diastolic_pressure", "mmHg"], 10: ["systolic_pressure", "mmHg"],
  11: ["heart_pulse", "bpm"], 12: ["temperature", "°C"], 54: ["spo2", "%"],
  71: ["body_temperature", "°C"], 73: ["skin_temperature", "°C"],
  76: ["muscle_mass", "kg"], 77: ["hydration", "kg"], 88: ["bone_mass", "kg"],
  91: ["pulse_wave_velocity", "m/s"], 155: ["vascular_age"],
  168: ["extracellular_water", "kg"], 169: ["intracellular_water", "kg"]
};

export function decodeMeasure(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const measure = input as Record<string, unknown>;
  const { value, unit, type } = measure;
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      typeof unit !== "number" || !Number.isInteger(unit) || Math.abs(unit) > 308) return measure;
  const scaled = value * 10 ** unit;
  if (!Number.isFinite(scaled)) return measure;
  const known = typeof type === "number" ? TYPES[type] : undefined;
  return { ...measure, decoded_value: Number(scaled.toPrecision(15)),
    ...(known ? { label: known[0], ...(known[1] ? { unit_label: known[1] } : {}) } : {}) };
}

export function measuredAt(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || Math.abs(seconds * 1000) > 8.64e15) return undefined;
  return new Date(seconds * 1000).toISOString();
}
