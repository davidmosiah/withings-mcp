import type { PrivacyMode } from "../types.js";
import { applyPrivacy } from "./privacy.js";

export interface CollectionListResult {
  records: unknown[];
  next_page?: number;
  pages_fetched: number;
}

/**
 * Shapes the payload every `withings_list_*` tool returns.
 *
 * Extracted from the tool handler so the demo-contract gate can run the real
 * shaping code over a stubbed client instead of reimplementing it — a gate that
 * re-describes the shape it is checking proves nothing.
 */
export function buildCollectionOutput(endpoint: string, privacyMode: PrivacyMode, result: CollectionListResult) {
  const records = applyPrivacy(endpoint, { records: result.records }, privacyMode) as { records: unknown[] };
  const count = records.records.length;
  const empty = count === 0;
  return {
    endpoint,
    privacy_mode: privacyMode,
    count,
    records: records.records,
    next_page: result.next_page,
    has_more: Boolean(result.next_page),
    pages_fetched: result.pages_fetched,
    /** True when the export/list returned zero rows — not a success that "has data". */
    empty,
    /** Agent-facing warning when empty; undefined when rows exist. */
    warning: empty
      ? "Export/list returned zero rows for this query. Treat as empty dataset, not as successful data presence."
      : undefined
  };
}
