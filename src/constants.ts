export const SERVER_NAME = "withings-mcp-server";
export const SERVER_VERSION = "0.1.0";
export const NPM_PACKAGE_NAME = "withings-mcp-unofficial";
export const PINNED_NPM_PACKAGE = `${NPM_PACKAGE_NAME}@${SERVER_VERSION}`;

export const WITHINGS_API_BASE_URL = "https://wbsapi.withings.net";
export const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
export const WITHINGS_TOKEN_PATH = "/v2/oauth2";
export const WITHINGS_SIGNATURE_PATH = "/v2/signature";
export const WITHINGS_DEVELOPER_PORTAL_URL = "https://account.withings.com/partner/dashboard_oauth2";
export const WITHINGS_DOCS_URL = "https://developer.withings.com/api-reference/";

export const DEFAULT_SCOPES = [
  "user.activity",
  "user.metrics"
];

export const DEFAULT_LIMIT = 30;
export const MAX_WITHINGS_LIMIT = 100;
export const DEFAULT_MAX_PAGES = 1;
export const MAX_PAGES = 10;
