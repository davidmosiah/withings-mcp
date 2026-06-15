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
    this.tokenStore = new TokenStore(config.tokenPath);
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

  async list(path: string, params: ListParams & WithingsActionParams = {}): Promise<{ records: unknown[]; next_page?: number; pages_fetched: number }> {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_WITHINGS_LIMIT);
    const maxPages = params.all_pages ? Math.max(1, params.max_pages ?? 1) : 1;
    const records: unknown[] = [];
    let offset = Math.max(((params.page ?? 1) - 1) * limit, 0);
    let pages = 0;

    while (pages < maxPages) {
      const payload = await this.get(path, {
        ...withingsApiParams(params),
        ...withingsDateRange(params),
        offset,
        limit
      });
      const pageRecords = extractRecords(payload);
      const remaining = limit - records.length;
      records.push(...pageRecords.slice(0, remaining));
      pages += 1;
      const more = extractMore(payload);
      if (!params.all_pages || !more || pageRecords.length < limit) break;
      offset += limit;
    }

    return { records, next_page: records.length && records.length % limit === 0 ? Math.floor(offset / limit) + 1 : undefined, pages_fetched: pages };
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
    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.formHeaders(token.access_token),
      body: new URLSearchParams(stringifyParams(cleanBody)).toString()
    });

    if (response.status === 401) {
      const refreshed = await this.refreshToken(true);
      const retry = await this.fetchWithRetry(url, {
        method: "POST",
        headers: this.formHeaders(refreshed.access_token),
        body: new URLSearchParams(stringifyParams(cleanBody)).toString()
      });
      return this.parseAndCache("POST", url, retry, cleanBody);
    }

    return this.parseAndCache("POST", url, response, cleanBody);
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

  private async refreshToken(force: boolean): Promise<WithingsTokenSet> {
    return this.tokenStore.withLock(async () => {
      const current = await this.tokenStore.read();
      if (!current?.refresh_token) {
        throw new Error("Withings refresh token not found. Re-authorize with withings-mcp-server auth.");
      }
      if (!force && current.expires_at && current.expires_at - Math.floor(Date.now() / 1000) >= 3600) return current;

      const refreshed = await this.requestTokens({ grant_type: "refresh_token", refresh_token: current.refresh_token });
      await this.tokenStore.write({ ...current, ...refreshed });
      return { ...current, ...refreshed };
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
    });
    const data = await this.parseResponse(response) as Record<string, unknown>;
    const tokenBody = isObject(data.body) ? data.body : data;
    const expiresIn = typeof tokenBody.expires_in === "number" ? tokenBody.expires_in : undefined;
    return {
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
      throw new Error(`Withings API HTTP ${response.status}: ${redactErrorMessage(details || response.statusText)}`);
    }
    if (isObject(payload) && typeof payload.status === "number" && payload.status !== 0) {
      throw new Error(`Withings API status ${payload.status}: ${redactErrorMessage(JSON.stringify(payload))}`);
    }
    return payload ?? {};
  }

  private async parseAndCache(method: "POST", url: string, response: Response, body: Record<string, string | number | boolean>): Promise<unknown> {
    const cacheKey = `${url} ${JSON.stringify(body)}`;
    try {
      const payload = await this.parseResponse(response);
      if (this.config.cacheEnabled) this.getCache().set(method, cacheKey, payload);
      return payload;
    } catch (error) {
      if (this.config.cacheEnabled) {
        const cached = this.getCache().get(method, cacheKey);
        if (cached !== undefined) return cached;
      }
      throw error;
    }
  }

  private getCache(): WithingsCache {
    this.cache ??= new WithingsCache(this.config.cachePath);
    return this.cache;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const retryWrappedFetch = (u: string, i?: RequestInit) => fetchWithRetry(u, i ?? {});
    return fetchWithCache(url, init, {
      defaultTtlSeconds: 60,
      envVarBypass: "WITHINGS_NO_CACHE",
      innerFetch: retryWrappedFetch
    });
  }
}

const LIST_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  "after", "before", "page", "limit", "all_pages", "max_pages", "privacy_mode", "response_format"
]);

function withingsApiParams(params: ListParams & WithingsActionParams): WithingsActionParams {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !LIST_INTERNAL_KEYS.has(key))
  ) as WithingsActionParams;
}

function withingsDateRange(params: ListParams): Record<string, number> {
  const range: Record<string, number> = {};
  if (params.after) range.startdate = toEpochSeconds(params.after);
  if (params.before) range.enddate = toEpochSeconds(params.before);
  return range;
}

function toEpochSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
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
