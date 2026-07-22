// The OpenTrace Claude Code plugin authenticates its MCP via a headersHelper
// script (plugins/claude-code/bin/auth-headers.cjs) that reads the API key from
// this file. Keeping it in a fixed 0600 file (rather than user_config, which a
// headersHelper can't read) lets the CLI attach the key non-interactively while
// the plugin still falls back to OAuth when the file is absent.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Fixed path the plugin's headersHelper reads. Must match bin/auth-headers.cjs. */
export function pluginTokenPath(): string {
  return path.join(os.homedir(), ".claude", "opentrace-plugin.token")
}

export function writePluginToken(token: string): string {
  const p = pluginTokenPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `${token}\n`, "utf8")
  try {
    fs.chmodSync(p, 0o600)
  } catch {
    /* best-effort (no-op on some platforms) */
  }
  return p
}

/** Remove the plugin token file. Returns true if it existed. */
export function clearPluginToken(): boolean {
  const p = pluginTokenPath()
  if (!fs.existsSync(p)) return false
  try {
    fs.rmSync(p)
    return true
  } catch {
    return false
  }
}
