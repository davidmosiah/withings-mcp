/**
 * HTTP retry middleware with exponential backoff + jitter.
 *
 * - Retries on HTTP 408, 429, 500, 502, 503, 504, and network/fetch errors.
 * - Max 3 attempts (initial + 2 retries).
 * - Backoff schedule: 500ms, 1000ms, 2000ms — each with +/-20% jitter.
 * - Respects `Retry-After` header (seconds or HTTP-date).
 * - Logs every retry to stderr as `[withings-mcp] retry N/3 after Xms (status=Y or error=Z)`.
 * - Honors `WITHINGS_NO_RETRY=true` env var to disable (used in tests).
 */
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000, 2000];
const JITTER_FACTOR = 0.2;
const LOG_PREFIX = "[withings-mcp]";

export interface RetryOptions {
  /** Total request/retry deadline, including response-body reads. */
  timeoutMs?: number;
  /** Override env-based disable flag (for tests). */
  noRetry?: boolean;
  /** Override sleep implementation (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Override jitter source (for deterministic tests). Should return [0,1). */
  jitterRandom?: () => number;
  /** Override stderr logger (for tests). */
  logger?: (message: string) => void;
  /** Override Date.now() for HTTP-date Retry-After (for tests). */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isNoRetryEnv(): boolean {
  const value = process.env.WITHINGS_NO_RETRY;
  return value === "true" || value === "1";
}

/**
 * Parse Retry-After (seconds or HTTP-date). Returns milliseconds to wait,
 * or undefined if the header is missing/invalid.
 */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : 0;
}

function computeBackoff(attempt: number, jitterRandom: () => number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  const factor = 1 - JITTER_FACTOR + jitterRandom() * 2 * JITTER_FACTOR;
  return Math.max(0, Math.round(base * factor));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const jitterRandom = options.jitterRandom ?? Math.random;
  const logger = options.logger ?? ((message: string) => process.stderr.write(`${message}\n`));
  const now = options.now ?? Date.now;
  const noRetry = options.noRetry ?? isNoRetryEnv();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadlineSignal]) : deadlineSignal;
  const boundedInit = { ...init, signal };
  const wait = async (ms: number) => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      sleep(ms).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
    signal.throwIfAborted();
  };

  if (noRetry) {
    return fetchImpl(url, boundedInit);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(url, boundedInit);
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      if (attempt === MAX_ATTEMPTS - 1) {
        return response;
      }
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
      const delay = retryAfterMs ?? computeBackoff(attempt, jitterRandom);
      // Never retry earlier than Retry-After. Return the failure immediately if
      // respecting it would exceed the total budget.
      if (delay >= deadline - Date.now()) return response;
      logger(`${LOG_PREFIX} retry ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms (status=${response.status})`);
      await response.body?.cancel();
      await wait(delay);
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw signal.reason;
      if (attempt === MAX_ATTEMPTS - 1) {
        throw error;
      }
      const delay = computeBackoff(attempt, jitterRandom);
      // Network errors can contain request URLs, credentials or provider data.
      logger(`${LOG_PREFIX} retry ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms (error=network_failure)`);
      await wait(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("fetchWithRetry exhausted attempts");
}
