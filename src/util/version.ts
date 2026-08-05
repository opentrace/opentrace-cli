import { readFileSync } from "node:fs"

/**
 * The published package version, read at runtime so nothing has to be kept in
 * sync by hand. dist/util/version.js → ../../package.json resolves to the
 * package root, which npm always ships.
 */
export function packageVersion(): string {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    return version
  } catch {
    // Never let a missing/unreadable manifest break a command — the version is
    // cosmetic everywhere it is used (--version, MCP clientInfo).
    return "0.0.0"
  }
}
