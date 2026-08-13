// Where a CLI key this machine already holds can be found. Two places, in
// order: the OS keychain (written by `connect`/`install` for header clients) and
// the Claude Code plugin's token file. Onboarding, `login` and the notice banner
// all need the same lookup, so it lives here rather than in three copies.

import { getToken, KeychainUnavailableError } from "./keychain.js"
import { readPluginToken } from "./plugin-token.js"

export type StoredKeySource = "keychain" | "plugin"

export interface StoredKey {
  token: string
  source: StoredKeySource
}

/** Where the key came from, for messages that tell the user what was checked. */
export function storedKeySourceLabel(source: StoredKeySource): string {
  return source === "keychain" ? "OS keychain" : "Claude Code plugin"
}

/**
 * A CLI key on this machine for `mcpUrl`, if there is one.
 *
 * The keychain is endpoint-scoped (keyed by MCP URL), so it can only ever return
 * a key minted for this endpoint. The plugin token file is NOT scoped — it holds
 * whatever key was attached last — which is why consulting it is the caller's
 * choice: a run pointed at another deployment must not probe (or offer to keep)
 * a key that belongs somewhere else.
 */
export function findStoredKey(
  mcpUrl: string,
  opts: { includePluginToken: boolean },
): StoredKey | undefined {
  try {
    const fromKeychain = getToken(mcpUrl)
    if (fromKeychain) return { token: fromKeychain, source: "keychain" }
  } catch (err) {
    // A missing Secret Service is not a failure — the plugin token file below is
    // checked next, and every caller has a path that works without either.
    if (!(err instanceof KeychainUnavailableError)) throw err
  }
  if (!opts.includePluginToken) return undefined
  const fromPlugin = readPluginToken()
  return fromPlugin ? { token: fromPlugin, source: "plugin" } : undefined
}
