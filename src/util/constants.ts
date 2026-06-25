export const DEFAULT_BASE_URL = "https://api.opentrace.ai"
export const SERVER_KEY = "opentrace"

export function buildMcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/mcp/v1/`
}
