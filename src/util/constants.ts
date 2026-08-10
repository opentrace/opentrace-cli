export const DEFAULT_BASE_URL = "https://api.opentrace.ai"
export const SERVER_KEY = "opentrace"

export function buildMcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/mcp/v1/`
}

/**
 * Normalize a user-supplied `--url` (a bare host base, or a URL already pointing
 * at the mount) into the canonical global MCP endpoint ending in `/mcp/v1/`.
 */
export function normalizeMcpUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (/\/mcp\/v1$/.test(trimmed)) return `${trimmed}/`
  return `${trimmed}/mcp/v1/`
}

/** Reduce a base-or-full URL to the host base (no trailing slash, no /mcp/v1 suffix). */
export function toBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "").replace(/\/mcp\/v1$/, "")
}

/**
 * Endpoint that get-or-creates the Claude Code usage (telemetry) key.
 * Authenticates with the CLI key — the same otk_ key that authenticates the
 * MCP mount. Single source of truth for the path: the server side is being
 * built against this contract, so a path change happens here and nowhere else.
 */
export function buildTelemetryKeyUrl(baseUrl: string): string {
  return `${toBaseUrl(baseUrl)}/claude-code-telemetry/key`
}

/**
 * OTLP ingest endpoint base for Claude Code telemetry. Claude Code's exporter
 * appends the signal path (/v1/metrics, /v1/logs) itself, so this deliberately
 * stops at the mount. Derived from the same host as the MCP endpoint, so
 * --url/--base-url move both together.
 */
export function buildIngestUrl(baseUrl: string): string {
  return `${toBaseUrl(baseUrl)}/ingest/claude-code`
}

// Claude Code plugin distribution (declarative marketplace onboarding).
// The marketplace manifest lives at .claude-plugin/marketplace.json in this repo.
export const MARKETPLACE_NAME = "opentrace"
export const PLUGIN_NAME = "opentrace"
export const MARKETPLACE_REPO = "opentrace/opentrace-cli"

/** enabledPlugins identifier, e.g. "opentrace@opentrace" */
export function pluginId(pluginName = PLUGIN_NAME, marketplaceName = MARKETPLACE_NAME): string {
  return `${pluginName}@${marketplaceName}`
}
