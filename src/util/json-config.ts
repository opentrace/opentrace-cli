import fs from "node:fs"
import path from "node:path"

export function readJsonConfig<T extends object>(filePath: string, defaults: T): T {
  if (!fs.existsSync(filePath)) return { ...defaults }
  const raw = fs.readFileSync(filePath, "utf8")
  try {
    return { ...defaults, ...(JSON.parse(raw) as T) }
  } catch {
    throw new Error(`${filePath} is not valid JSON`)
  }
}

export function writeJsonConfig(filePath: string, config: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(config, null, 4) + "\n", "utf8")
}
