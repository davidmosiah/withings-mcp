# Privacy

Withings health data is sensitive. This MCP stores OAuth tokens locally under `~/.withings-mcp/` and never prints token values.

## Modes

- `summary`: minimal fields for safe agent use.
- `structured`: normalized Withings Public API data.
- `raw`: upstream Withings JSON, only when explicitly requested.

## Boundary

The MCP uses the official Withings Public API. It does not expose raw accelerometer telemetry, private Google endpoints, or medical diagnosis.
