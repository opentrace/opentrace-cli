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
 * Endpoint that provisions the Claude Code usage (telemetry) key.
 * Authenticates with the CLI key — the same otk_ key that authenticates the
 * MCP mount. Matches opentrace-api's `provision_claude_code_usage_key`
 * (200 {token, created, id, name}); every call mints a fresh key (secrets are
 * stored hashed), so the CLI's reuse of a still-valid key in the settings
 * file is what keeps re-runs from sprawling.
 */
export function buildTelemetryKeyUrl(baseUrl: string): string {
  return `${toBaseUrl(baseUrl)}/claude-code-usage/key`
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

/**
 * RFC 8414 authorization-server metadata for the server's OAuth shim (issuer
 * path /oauth — the well-known segment goes between host and issuer path).
 * Served only when the deployment has DCR enabled, so a 404 means "browser
 * sign-in unsupported", never a server fault. Deliberately carries no
 * reference to the MCP mount: the sign-in exists to mint a CLI key, and
 * which surfaces that key authenticates is the server's business.
 */
export function buildAuthServerMetadataUrl(baseUrl: string): string {
  return `${toBaseUrl(baseUrl)}/.well-known/oauth-authorization-server/oauth`
}

/**
 * Endpoint that trades a browser sign-in (the IdP OAuth access token) for a
 * cli-scoped otk_ key — the `otx login` counterpart to the usage-key endpoint
 * below (200 {token, created, id, name}). Every call mints a fresh key
 * (secrets are stored hashed), so the CLI's reuse of a still-valid stored key
 * is what keeps repeat sign-ins from sprawling. A 404 means the deployment
 * predates the endpoint.
 */
export function buildCliKeyUrl(baseUrl: string): string {
  return `${toBaseUrl(baseUrl)}/cli/key`
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
