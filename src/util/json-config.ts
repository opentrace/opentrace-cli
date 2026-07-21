import fs from "node:fs"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"

export function readJsonConfig<T extends object>(filePath: string, defaults: T): T {
  if (!fs.existsSync(filePath)) return { ...defaults }
  const raw = fs.readFileSync(filePath, "utf8")
  try {
    // jsonc-parser handles // comments, /* */ block comments, and trailing commas —
    // common in editor settings files like Zed's settings.json
    const parsed = parseJsonc(raw) as T
    return { ...defaults, ...parsed }
  } catch {
    throw new Error(`${filePath} is not valid JSON or JSONC`)
  }
}

export function writeJsonConfig(filePath: string, config: unknown, opts?: { secret?: boolean }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(config, null, 4) + "\n", "utf8")
  // Files that embed an API key are locked to the owner. chmod is a no-op on Windows.
  if (opts?.secret) {
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      /* best-effort; unsupported on some platforms/filesystems */
    }
  }
}
