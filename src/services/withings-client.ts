import { createHmac } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { DEFAULT_LIMIT, MAX_WITHINGS_LIMIT, WITHINGS_API_BASE_URL, WITHINGS_AUTH_URL, WITHINGS_SIGNATURE_PATH, WITHINGS_TOKEN_PATH } from "../constants.js";
import type { WithingsConfig, WithingsTokenSet } from "../types.js";
import { disabledCacheStatus, type CacheStatus, WithingsCache } from "./cache.js";
import { fetchWithCache, getCacheStats } from "./http-cache.js";
import { fetchWithRetry } from "./http-retry.js";
import { redactErrorMessage } from "./redaction.js";
import { TokenStore } from "./token-store.js";

export interface ListParams {
  after?: string;
  before?: string;
  page?: number;
  limit?: number;
  all_pages?: boolean;
  max_pages?: number;
}

type WithingsActionParams = Record<string, string | number | boolean | undefined>;

export class WithingsClient {
  private readonly tokenStore: TokenStore;
  private cache?: WithingsCache;

  constructor(private readonly config: WithingsConfig) {
    this.tokenStore = new TokenStore(config.tokenPath, config.tokenEncryptionKey);
  }

  authUrl(state?: string, scopes?: string[]): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: (scopes?.length ? scopes : this.config.scopes).join(",")
    });
    if (state) params.set("state", state);
    return `${WITHINGS_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(input: string): Promise<{ ok: true; token_path: string; scope?: string; expires_at?: number }> {
    const code = this.extractCode(input);
    const tokens = await this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri
    });
    const redirectScope = this.extractScope(input);
    await this.tokenStore.withLock(async () => this.tokenStore.write({ ...tokens, scope: tokens.scope ?? redirectScope }));
    return { ok: true, token_path: this.config.tokenPath, scope: tokens.scope ?? redirectScope, expires_at: tokens.expires_at };
  }

  async get(path: string, params?: WithingsActionParams): Promise<unknown> {
    return this.request(path, params);
  }

  async post(path: string, body?: WithingsActionParams): Promise<unknown> {
    return this.request(path, body);
  }

  async revokeAccess(): Promise<{ ok: true; token_path: string; local_tokens_cleared: boolean }> {
    await this.tokenStore.withLock(async () => this.tokenStore.clear());
    return { ok: true, token_path: this.config.tokenPath, local_tokens_cleared: true };
  }

  cacheStatus(): CacheStatus {
    const httpStats = getCacheStats();
    const http_cache = {
      size: httpStats.size,
      hit_count: httpStats.hit_count,
      miss_count: httpStats.miss_count,
      hit_rate: httpStats.hit_rate,
      default_ttl_seconds: 60,
      bypass_env_var: "WITHINGS_NO_CACHE"
    };
    if (!this.config.cacheEnabled) return { ...disabledCacheStatus(this.config.cachePath), http_cache };
    return { ...this.getCache().status(), http_cache };
  }

  async list(path: string, params: ListParams & WithingsActionParams = {}): Promise<{ records: unknown[]; next_page?: number; pages_fetched: number; cached?: boolean; cached_at?: string }> {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_WITHINGS_LIMIT);
    const maxPages = params.all_pages ? Math.max(1, params.max_pages ?? 1) : 1;
    const maxRecords = limit * maxPages;
    const records: unknown[] = [];
    let offset = Math.max(((params.page ?? 1) - 1) * limit, 0);
    let pages = 0;
    let hasMore = false;
    let cachedAt: string | undefined;

    while (pages < maxPages) {
      const payload = await this.get(path, buildListRequestParams(params, offset, limit));
      if (isObject(payload) && payload.cached === true && typeof payload.cached_at === "string" &&
          (!cachedAt || payload.cached_at < cachedAt)) cachedAt = payload.cached_at;
      const pageRecords = extractRecords(payload);
      const remaining = maxRecords - records.length;
      records.push(...pageRecords.slice(0, remaining));
      pages += 1;
      const more = extractMore(payload);
      hasMore = more || pageRecords.length > remaining;
      if (!params.all_pages || !more || pageRecords.length < limit || records.length >= maxRecords) break;
      offset += limit;
    }

    return { records, next_page: hasMore ? (params.page ?? 1) + pages : undefined, pages_fetched: pages,
      ...(cachedAt ? { cached: true, cached_at: cachedAt } : {}) };
  }

  private extractCode(input: string): string {
    try {
      const url = new URL(input);
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      // Not a URL; treat as raw code.
    }
    return input;
  }

  private extractScope(input: string): string | undefined {
    try {
      const url = new URL(input);
      return url.searchParams.get("scope") ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async request(path: string, body: WithingsActionParams = {}): Promise<unknown> {
    const token = await this.getValidToken();
    const cleanBody = cleanParams(body);
    const url = this.buildUrl(path);
    const cacheKey = `${url} ${JSON.stringify(cleanBody)}`;
    let response = await this.send(url, token.access_token, cleanBody, cacheKey);
    if (response instanceof Response && await isRejectedToken(response)) {
      const refreshed = await this.refreshToken(true, token.access_token);
      response = await this.send(url, refreshed.access_token, cleanBody, cacheKey);
    }
    if (!(response instanceof Response)) return response;
    return this.parseAndCache("POST", url, response, cacheKey);
  }

  private async send(url: string, accessToken: string, body: WithingsActionParams, cacheKey: string): Promise<Response | unknown> {
    try {
      return await this.fetchWithRetry(url, {
        method: "POST",
        headers: this.formHeaders(accessToken),
        body: new URLSearchParams(stringifyParams(body)).toString()
      });
    } catch (error) {
      // A network failure is transient: a marked earlier response may stand in.
      return this.cachedFallback(cacheKey, error);
    }
  }

  private buildUrl(path: string): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return new URL(`${WITHINGS_API_BASE_URL}${cleanPath}`).toString();
  }

  private async getValidToken(): Promise<WithingsTokenSet> {
    const tokens = await this.tokenStore.read();
    if (!tokens?.access_token) {
      throw new Error("Withings token not found. Run withings-mcp-server auth, or use withings_get_auth_url then withings_exchange_code.");
    }
    const expiresAt = tokens.expires_at ?? 0;
    const shouldRefresh = Boolean(tokens.refresh_token && expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 3600);
    return shouldRefresh ? this.refreshToken(false) : tokens;
  }

  private async refreshToken(force: boolean, rejectedToken?: string): Promise<WithingsTokenSet> {
    return this.tokenStore.withLock(async () => {
      const current = await this.tokenStore.read();
      if (!current?.refresh_token) {
        throw new Error("Withings refresh token not found. Re-authorize with withings-mcp-server auth.");
      }
      // Another caller may already have rotated the token while we waited.
      if (force && rejectedToken && current.access_token !== rejectedToken) return current;
      if (!force && current.expires_at && current.expires_at - Math.floor(Date.now() / 1000) >= 3600) return current;

      const refreshed = await this.requestTokens({ grant_type: "refresh_token", refresh_token: current.refresh_token });
      if (current.userid && refreshed.userid && current.userid !== refreshed.userid) {
        throw new Error("Withings refresh returned a different user; saved credentials were preserved.");
      }
      const next = { ...current, ...refreshed, userid: refreshed.userid ?? current.userid, scope: refreshed.scope ?? current.scope };
      await this.tokenStore.write(next);
      return next;
    });
  }

  private async requestTokens(params: WithingsActionParams): Promise<WithingsTokenSet> {
    const nonce = await this.getNonce();
    const body = {
      action: "requesttoken",
      client_id: this.config.clientId,
      ...params,
      nonce
    };
    const signed = { ...body, signature: this.sign(body) };
    const response = await this.fetchWithRetry(this.buildUrl(WITHINGS_TOKEN_PATH), {
      method: "POST",
      headers: this.publicFormHeaders(),
      body: new URLSearchParams(stringifyParams(signed)).toString()
    }, true);
    const data = await this.parseResponse(response) as Record<string, unknown>;
    const tokenBody = isObject(data.body) ? data.body : data;
    const expiresIn = typeof tokenBody.expires_in === "number" ? tokenBody.expires_in : undefined;
    if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token ||
        typeof tokenBody.refresh_token !== "string" || !tokenBody.refresh_token ||
        !expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Withings token response was incomplete; saved credentials were preserved.");
    }
    return {
      userid: typeof tokenBody.userid === "number" || typeof tokenBody.userid === "string" ? String(tokenBody.userid) : undefined,
      access_token: String(tokenBody.access_token ?? ""),
      refresh_token: typeof tokenBody.refresh_token === "string" ? tokenBody.refresh_token : undefined,
      token_type: typeof tokenBody.token_type === "string" ? tokenBody.token_type : undefined,
      scope: Array.isArray(tokenBody.scope) ? tokenBody.scope.join(",") : typeof tokenBody.scope === "string" ? tokenBody.scope : undefined,
      expires_in: expiresIn,
      expires_at: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined
    };
  }

  private async getNonce(): Promise<string> {
    const timestamp = Math.round(Date.now() / 1000);
    const body = { action: "getnonce", client_id: this.config.clientId, timestamp };
    const signed = { ...body, signature: this.sign(body) };
    const response = await this.fetchWithRetry(this.buildUrl(WITHINGS_SIGNATURE_PATH), {
      method: "POST",
      headers: this.publicFormHeaders(),
      body: new URLSearchParams(stringifyParams(signed)).toString()
    });
    const payload = await this.parseResponse(response) as Record<string, unknown>;
    const bodyPayload = isObject(payload.body) ? payload.body : payload;
    const nonce = bodyPayload.nonce;
    if (typeof nonce !== "string" || !nonce) throw new Error("Withings nonce response did not include a nonce.");
    return nonce;
  }

  private sign(params: WithingsActionParams): string {
    const values = Object.keys(params)
      .filter((key) => ["action", "client_id", "nonce", "timestamp"].includes(key))
      .sort()
      .map((key) => params[key])
      .join(",");
    return createHmac("sha256", this.config.clientSecret).update(values).digest("hex");
  }

  private formHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Accept-Language": "en_US",
      "User-Agent": "withings-mcp-server/0.1.0"
    };
  }

  private publicFormHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Accept-Language": "en_US",
      "User-Agent": "withings-mcp-server/0.1.0"
    };
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const details = payload && typeof payload === "object" ? JSON.stringify(payload) : text;
      throw withTransient(new Error(`Withings API HTTP ${response.status}: ${redactErrorMessage(details || response.statusText)}`), response.status >= 500);
    }
    if (isObject(payload) && typeof payload.status === "number" && payload.status !== 0) {
      throw withTransient(new Error(`Withings API status ${payload.status}: ${redactErrorMessage(JSON.stringify(payload))}`), payload.status === RATE_LIMITED_STATUS);
    }
    return payload ?? {};
  }

  private async parseAndCache(method: "POST", url: string, response: Response, cacheKey: string): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await this.parseResponse(response);
    } catch (error) {
      if (!(error as { transient?: boolean }).transient) throw error;
      return this.cachedFallback(cacheKey, error);
    }
    if (this.config.cacheEnabled) this.getCache().set(method, cacheKey, payload);
    return payload;
  }

  // Only transient failures (network, HTTP 5xx, rate limit) may fall back to an
  // earlier response, marked as cached. Authorization and parameter errors stay
  // errors so a cached success cannot conceal revoked access.
  private cachedFallback(cacheKey: string, error: unknown): unknown {
    const entry = this.config.cacheEnabled ? this.getCache().entry("POST", cacheKey) : undefined;
    if (!entry || !isObject(entry.payload)) throw error;
    return { ...entry.payload, cached: true, cached_at: entry.cached_at };
  }

  private getCache(): WithingsCache {
    this.cache ??= new WithingsCache(this.config.cachePath);
    return this.cache;
  }

  private async fetchWithRetry(url: string, init: RequestInit, noRetry = false): Promise<Response> {
    // A signed token request contains a single-use nonce and authorization code
    // or rotating refresh credential. Never blindly replay that same payload.
    const retryWrappedFetch = (u: string, i?: RequestInit) => fetchWithRetry(u, i ?? {}, noRetry ? { noRetry: true } : {});
    return fetchWithCache(url, init, {
      defaultTtlSeconds: 60,
      envVarBypass: "WITHINGS_NO_CACHE",
      innerFetch: retryWrappedFetch
    });
  }
}

const INTERNAL_LIST_PARAM_KEYS = new Set([
  "after",
  "before",
  "page",
  "limit",
  "all_pages",
  "max_pages",
  "privacy_mode",
  "response_format"
]);

// Withings is inconsistent across actions (same class of vendor bug as Polar #4):
// - getmeas / sleep get / heart list → startdate/enddate as Unix epoch seconds
// - getactivity / getworkouts / sleep getsummary → startdateymd/enddateymd as YYYY-MM-DD
// Sending epoch params to ymd endpoints is ignored or rejected, so filters silently drop.
const YMD_DATE_ACTIONS = new Set(["getactivity", "getworkouts", "getsummary"]);

export type WithingsDateParamStyle = "epoch" | "ymd";

export function dateParamStyleForAction(action: unknown): WithingsDateParamStyle {
  return typeof action === "string" && YMD_DATE_ACTIONS.has(action) ? "ymd" : "epoch";
}

function buildListRequestParams(params: ListParams & WithingsActionParams, offset: number, limit: number): WithingsActionParams {
  return {
    ...pickUpstreamParams(params),
    ...withingsDateRange(params),
    offset,
    limit
  };
}

function pickUpstreamParams(params: WithingsActionParams): WithingsActionParams {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !INTERNAL_LIST_PARAM_KEYS.has(key))) as WithingsActionParams;
}

function withingsDateRange(params: ListParams & WithingsActionParams): Record<string, string | number> {
  const style = dateParamStyleForAction(params.action);
  if (style === "ymd") {
    const range: Record<string, string> = {};
    if (params.after) range.startdateymd = toYmdDate(params.after, "after");
    if (params.before) range.enddateymd = toYmdDate(params.before, "before");
    if (range.startdateymd && range.enddateymd && range.startdateymd > range.enddateymd) {
      throw new Error("Invalid Withings date range: after must be earlier than before.");
    }
    return range;
  }

  const range: Record<string, number> = {};
  if (params.after) range.startdate = toEpochSeconds(params.after, "after");
  if (params.before) range.enddate = toEpochSeconds(params.before, "before");
  if (range.startdate !== undefined && range.enddate !== undefined && range.startdate > range.enddate) {
    throw new Error("Invalid Withings date range: after must be earlier than before.");
  }
  return range;
}

function toYmdDate(value: string, field: "after" | "before"): string {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[Tt ])/);
  if (match) {
    const date = match[1];
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid Withings ${field} filter: ${value}`);
    }
    return date;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Withings ${field} filter: use YYYY-MM-DD or an ISO 8601 date-time, for example 2026-06-09 or 2026-06-09T00:00:00Z.`);
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function toEpochSeconds(value: string, field: "after" | "before"): number {
  const trimmed = value.trim();
  // Date-only bounds expand to start/end of UTC day so a plain before=YYYY-MM-DD keeps the final day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = field === "before" ? "T23:59:59Z" : "T00:00:00Z";
    return Math.floor(Date.parse(`${trimmed}${suffix}`) / 1000);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Withings ${field} filter: use YYYY-MM-DD or an ISO 8601 date-time with timezone, for example 2026-06-09 or 2026-06-09T00:00:00Z.`);
  }
  return Math.floor(parsed / 1000);
}

function extractRecords(payload: unknown): unknown[] {
  const body = isObject(payload) && isObject(payload.body) ? payload.body : payload;
  if (Array.isArray(body)) return body;
  if (!isObject(body)) return [];
  for (const key of ["series", "measuregrps", "activities", "workouts", "sleep", "heart", "devices", "records"]) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return [];
}

function extractMore(payload: unknown): boolean {
  const body = isObject(payload) && isObject(payload.body) ? payload.body : payload;
  return isObject(body) && body.more === true;
}

function cleanParams(input: WithingsActionParams): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")) as Record<string, string | number | boolean>;
}

function stringifyParams(input: Record<string, string | number | boolean | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
}

// Withings reports an invalid or expired access token as HTTP 401 or JSON
// status 100, 101, 102, 200 or 401. Other statuses are not token failures.
const REJECTED_TOKEN_STATUSES = new Set([100, 101, 102, 200, 401]);
const RATE_LIMITED_STATUS = 601;

async function isRejectedToken(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (!response.ok) return false;
  const payload = await response.clone().json().catch(() => null);
  return isObject(payload) && typeof payload.status === "number" && REJECTED_TOKEN_STATUSES.has(payload.status);
}

function withTransient(error: Error, transient: boolean): Error {
  return transient ? Object.assign(error, { transient: true }) : error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
