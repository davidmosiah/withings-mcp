import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPES, WITHINGS_DEVELOPER_PORTAL_URL } from "../constants.js";
import type { PrivacyMode, WithingsConfig } from "../types.js";
import { loadConfigSources } from "./local-config.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function getConfig(): WithingsConfig {
  const sources = loadConfigSources(process.env, homedir());
  const value = (name: keyof typeof sources.values) => env(name) ?? sources.values[name];
  const clientId = value("WITHINGS_CLIENT_ID");
  const clientSecret = value("WITHINGS_CLIENT_SECRET");
  const redirectUri = value("WITHINGS_REDIRECT_URI");
  const tokenPath = value("WITHINGS_TOKEN_PATH") ?? join(homedir(), ".withings-mcp", "tokens.json");
  const cachePath = value("WITHINGS_CACHE_PATH") ?? join(homedir(), ".withings-mcp", "cache.sqlite");
  const scopes = (value("WITHINGS_SCOPES")?.split(/[ ,]+/).filter(Boolean)) ?? DEFAULT_SCOPES;
  const privacyMode = parsePrivacyMode(value("WITHINGS_PRIVACY_MODE"));
  const cacheEnabled = parseBool(value("WITHINGS_CACHE"), false);

  const missing = [
    ["WITHINGS_CLIENT_ID", clientId],
    ["WITHINGS_CLIENT_SECRET", clientSecret],
    ["WITHINGS_REDIRECT_URI", redirectUri]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required WITHINGS environment variables: ${missing.join(", ")}. ` +
      `Create an app at ${WITHINGS_DEVELOPER_PORTAL_URL} and set these variables before using Withings tools.`
    );
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    scopes,
    tokenPath,
    privacyMode,
    cacheEnabled,
    cachePath
  };
}

function parsePrivacyMode(value: string | undefined): PrivacyMode {
  if (value === "summary" || value === "structured" || value === "raw") return value;
  return "structured";
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on", "sqlite"].includes(value.toLowerCase());
}
