import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult } from "./types.js"

function configPath(): string {
  switch (process.platform) {
    case "darwin": return path.join(os.homedir(), "Library", "Application Support", "Zed", "settings.json")
    case "win32":  return path.join(process.env["APPDATA"] ?? os.homedir(), "Zed", "settings.json")
    default:       return path.join(os.homedir(), ".local", "share", "zed", "settings.json")
  }
}

function detectDir(): string {
  switch (process.platform) {
    case "darwin": return path.join(os.homedir(), "Library", "Application Support", "Zed")
    case "win32":  return path.join(process.env["APPDATA"] ?? os.homedir(), "Zed")
    default:       return path.join(os.homedir(), ".local", "share", "zed")
  }
}

interface ZedSettings {
  context_servers?: Record<string, { transport: string; url: string }>
  [key: string]: unknown
}

const zed: Integration = {
  id: "zed",
  label: "Zed",
  helpText: "~/…/Zed/settings.json  (key: context_servers)",

  detect() {
    return fs.existsSync(detectDir())
  },

  getConfigPath(_projectDir, _opts) {
    return configPath()
  },

  hasEntry(_projectDir, _opts) {
    const filePath = configPath()
    if (!fs.existsSync(filePath)) return false
    try {
      const config = readJsonConfig<ZedSettings>(filePath, {})
      return SERVER_KEY in (config.context_servers ?? {})
    } catch { return false }
  },

  install(_projectDir, opts): InstallResult {
    const filePath = configPath()
    const config = readJsonConfig<ZedSettings>(filePath, {})
    const existed = SERVER_KEY in (config.context_servers ?? {})
    config.context_servers = {
      ...(config.context_servers ?? {}),
      [SERVER_KEY]: { transport: "http", url: buildMcpUrl(opts.baseUrl) },
    }
    writeJsonConfig(filePath, config)
    return { configPath: filePath, existed }
  },
}

export default zed
