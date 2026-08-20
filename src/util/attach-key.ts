// How an API key gets attached to a client, in one place. Both `otx connect
// otk_…` and the interactive `otx install` flow authenticate the same way, and
// the two mechanisms differ per client, so they live here rather than being
// re-derived at each call site.

import { storeToken, KeychainUnavailableError } from "./keychain.js"
import { writePluginToken } from "./plugin-token.js"
import type { PluginCapability } from "../integrations/types.js"
import type { KeyClient } from "../key-clients/types.js"

export interface PluginKeyResult {
  /** User settings file that now carries the plugin's mcp_url. */
  urlConfigPath: string
  /** The 0600 file the plugin's headersHelper reads the key from. */
  tokenPath: string
}

/**
 * Attach a key to a plugin-hosted MCP (Claude Code): seed the plugin's
 * `mcp_url` so it never prompts for an endpoint, then drop the key in the
 * headersHelper token file. The token file — not a config header — is the
 * plugin's source of truth, which is why nothing is written to the MCP config
 * here and why `disconnect --plugin` clears it.
 *
 * Assumes `plugin.install()` has already run; this only supplies the auth.
 */
export function attachPluginKey(
  plugin: PluginCapability,
  mcpUrl: string,
  token: string,
): PluginKeyResult {
  const { configPath } = plugin.setMcpUrl(mcpUrl)
  return { urlConfigPath: configPath, tokenPath: writePluginToken(token) }
}

export interface ClientKeyResult {
  configPath: string
  /** Extra client-specific guidance (e.g. the mcp-remote bridge needs npx). */
  note?: string
  keychainStored: boolean
  /** Set when the keychain was unavailable; the connection still works without it. */
  keychainError?: string
}

/**
 * Attach a key to a client that authenticates with a bearer header (Cursor,
 * Claude Desktop): write the user-scoped MCP entry carrying the token, then
 * record it in the OS keychain.
 *
 * The keychain write is best-effort by design — the client config already holds
 * the token, so a headless Linux box with no Secret Service still ends up
 * connected. The failure is reported rather than thrown so the caller can word
 * its own warning.
 */
export function attachClientKey(
  client: KeyClient,
  mcpUrl: string,
  token: string,
): ClientKeyResult {
  if (!client.write) {
    // A removal-only client has no key to attach — callers pick from
    // writableKeyClients(), so reaching here is a programming error, not a
    // user-facing state.
    throw new Error(`${client.label} is no longer configured by otx.`)
  }
  const { configPath, note } = client.write(mcpUrl, token)
  try {
    storeToken(mcpUrl, token)
    return { configPath, note, keychainStored: true }
  } catch (err) {
    if (err instanceof KeychainUnavailableError) {
      return { configPath, note, keychainStored: false, keychainError: err.message }
    }
    throw err
  }
}
