import { readFileSync } from "node:fs"

/**
 * The package manifest, read at runtime so nothing has to be kept in sync by
 * hand. dist/util/version.js → ../../package.json resolves to the package root,
 * which npm always ships.
 */
function manifest(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name?: string
      version?: string
    }
  } catch {
    // Never let a missing/unreadable manifest break a command — both fields are
    // cosmetic (--version, MCP clientInfo, the update-check URL).
    return {}
  }
}

export function packageVersion(): string {
  return manifest().version ?? "0.0.0"
}

/** The published npm name, used to look up the latest release. */
export function packageName(): string {
  return manifest().name ?? "@opentrace/cli"
}

/**
 * Is `latest` a newer release than `current`? Prereleases are never offered as
 * an update, but a prerelease of the version now released does count as behind
 * it (0.5.0 is newer than 0.5.0-rc.1).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  if (latest.includes("-")) return false
  const [currentBase, currentPre] = current.split("-", 2)
  const a = latest.split(".").map(Number)
  const b = currentBase.split(".").map(Number)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    const l = a[i] ?? 0
    const c = b[i] ?? 0
    if (l !== c) return l > c
  }
  return currentPre !== undefined
}
