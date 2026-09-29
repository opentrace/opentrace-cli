// The OpenTrace Claude Code plugin authenticates its MCP via a headersHelper
// script (plugins/claude-code/bin/auth-headers.cjs) that reads the API key from
// this file. Keeping it in a fixed 0600 file (rather than user_config, which a
// headersHelper can't read) lets the CLI attach the key non-interactively while
// the plugin still falls back to OAuth when the file is absent.
//
// **Two files, because there are two credentials.** The MCP reads the graph and
// needs a CLI key; the telemetry hooks only post usage and hold a usage key that
// deliberately cannot read anything. Writing both to one path meant whichever
// command ran last decided which capability worked: `install` left the usage key
// where the MCP looks for it and broke the MCP outright, while `connect` left the
// CLI key where the hooks look and posted a graph-reading credential on every
// prompt. Separate paths make the two writes independent of each other's order.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Fixed path the plugin's headersHelper reads. Must match bin/auth-headers.cjs. */
export function pluginTokenPath(): string {
  return path.join(os.homedir(), ".claude", "opentrace-plugin.token")
}

/** Fixed path the telemetry hooks read their ingest key from. */
export function telemetryTokenPath(): string {
  return path.join(os.homedir(), ".claude", "opentrace-telemetry.token")
}

/**
 * Write a credential to a private file, creating it 0600 from the start.
 *
 * `writeFileSync` without a mode creates at 0666 & ~umask — commonly 0644 — so narrowing
 * with a chmod afterwards leaves the secret world-readable for the window between the two
 * calls, and does nothing for a file an older build already created loose.
 *
 * The existing path is only removed when it is a regular file whose permissions are
 * actually too wide. A symlink is someone pointing this at their own secret store, so it is
 * written *through* rather than replaced — unlinking it would silently detach whatever was
 * feeding it. `mode` applies on creation only, so a file that is kept is chmod'ed instead.
 */
function writePrivateFile(p: string, contents: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const existing = fs.lstatSync(p, { throwIfNoEntry: false })
  if (existing?.isFile() && (existing.mode & 0o077) !== 0) {
    try {
      fs.rmSync(p, { force: true })
    } catch {
      /* fall through — the write below fails loudly if the path is unusable */
    }
  }
  fs.writeFileSync(p, contents, { encoding: "utf8", mode: 0o600 })
  try {
    // Applies to a path we kept (an already-private file, or a symlink's target), and is
    // belt and braces on a platform that ignored the creation mode.
    fs.chmodSync(p, 0o600)
  } catch {
    /* best-effort (no-op on some platforms) */
  }
  return p
}

export function writePluginToken(token: string): string {
  return writePrivateFile(pluginTokenPath(), `${token}\n`)
}

/** The ingest key the telemetry hooks authenticate with. Never the MCP's key. */
export function writeTelemetryToken(token: string): string {
  return writePrivateFile(telemetryTokenPath(), `${token}\n`)
}

/** Remove the telemetry token file. Returns true if it existed. */
export function clearTelemetryToken(): boolean {
  const p = telemetryTokenPath()
  if (!fs.existsSync(p)) return false
  try {
    fs.rmSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Read the key the plugin is currently using, if any. Lets onboarding reuse a
 * key a previous `connect`/`install` already attached instead of asking again.
 */
export function readPluginToken(): string | undefined {
  const p = pluginTokenPath()
  try {
    const raw = fs.readFileSync(p, "utf8").trim()
    return raw || undefined
  } catch {
    return undefined // absent or unreadable — treat as "no key on file"
  }
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
