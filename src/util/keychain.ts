// Stores the OpenTrace API key in the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service). Keyed by MCP endpoint so a machine
// can hold keys for more than one host. The header written into the client's
// MCP config is what actually authenticates requests; this is otx's own record
// for reconnect/status without re-pasting the secret.

import { Entry } from "@napi-rs/keyring"

// The keychain is the one piece of state a sandboxed HOME does NOT isolate — it
// is a machine-wide service, so a test run would read, overwrite and delete the
// real user's entries. Namespacing the service name is what makes an isolated
// test run possible at all; nothing but the test harness sets this.
const SERVICE = process.env.OTX_KEYCHAIN_SERVICE ?? "opentrace-cli"

/** Thrown when the OS keychain backend is unavailable (e.g. headless Linux with no Secret Service). */
export class KeychainUnavailableError extends Error {}

/**
 * Opt out of the keychain entirely.
 *
 * Namespacing the service name stops a test run from touching the real user's
 * entries, but it does not stop it touching the *backend* — and a backend that is
 * locked or unattended can block in a native call rather than failing, which
 * hangs the process outright. So test runs disable it: "no keychain" is a state
 * every caller already handles, since a headless Linux box has none either.
 */
function disabled(): boolean {
  const value = process.env.OTX_NO_KEYCHAIN
  return value !== undefined && value !== "" && value !== "0" && value !== "false"
}

function entryFor(mcpUrl: string): Entry {
  return new Entry(SERVICE, mcpUrl)
}

function wrap(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  throw new KeychainUnavailableError(
    `Could not access the OS keychain: ${message}. ` +
      "On Linux this needs a running Secret Service (e.g. gnome-keyring or KWallet).",
  )
}

export function storeToken(mcpUrl: string, token: string): void {
  if (disabled()) throw new KeychainUnavailableError("The keychain is disabled (OTX_NO_KEYCHAIN).")
  try {
    entryFor(mcpUrl).setPassword(token)
  } catch (err) {
    wrap(err)
  }
}

export function getToken(mcpUrl: string): string | undefined {
  if (disabled()) return undefined // same shape as "nothing stored"
  try {
    return entryFor(mcpUrl).getPassword() ?? undefined
  } catch (err) {
    // getPassword throws NoEntry when nothing is stored — treat as "not found".
    const message = err instanceof Error ? err.message : String(err)
    if (/no.?entry|not\s*found/i.test(message)) return undefined
    wrap(err)
  }
}

export function deleteToken(mcpUrl: string): void {
  if (disabled()) return // nothing can be stored, so nothing to remove
  try {
    entryFor(mcpUrl).deletePassword()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/no.?entry|not\s*found/i.test(message)) return
    wrap(err)
  }
}
