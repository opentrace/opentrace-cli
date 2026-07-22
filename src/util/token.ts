// OpenTrace API key ("otk") handling. The key authenticates against the MCP
// mount only (REST endpoints reject it), so we never validate it via REST —
// shape-check locally, then confirm with an MCP handshake (see mcp-probe.ts).

/** otk_ followed by exactly 43 URL-safe base64 chars (total length 47). */
export const TOKEN_REGEX = /^otk_[A-Za-z0-9_-]{43}$/

/** True if the argument looks like an OpenTrace API key (used to overload `connect`). */
export function looksLikeToken(arg: string): boolean {
  return arg.startsWith("otk_")
}

/** Fail-fast shape validation. Returns an error message, or null if the shape is valid. */
export function validateTokenShape(token: string): string | null {
  if (TOKEN_REGEX.test(token)) return null
  if (!token.startsWith("otk_")) {
    return 'API key must start with "otk_".'
  }
  return `API key must be "otk_" followed by 43 URL-safe characters (got ${token.length} chars total, expected 47).`
}

/** Mask a token for display — never print the secret. */
export function maskToken(token: string): string {
  if (token.length < 12) return "otk_…"
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}
