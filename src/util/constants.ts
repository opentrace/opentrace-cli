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

// Claude Code plugin distribution (declarative marketplace onboarding).
// The marketplace manifest lives at .claude-plugin/marketplace.json in this repo.
export const MARKETPLACE_NAME = "opentrace"
export const PLUGIN_NAME = "opentrace"
export const MARKETPLACE_REPO = "opentrace/opentrace-cli"

/** enabledPlugins identifier, e.g. "opentrace@opentrace" */
export function pluginId(pluginName = PLUGIN_NAME, marketplaceName = MARKETPLACE_NAME): string {
  return `${pluginName}@${marketplaceName}`
}
