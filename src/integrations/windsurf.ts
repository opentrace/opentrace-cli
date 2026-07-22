import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult, RemoveResult } from "./types.js"

const CONFIG_PATH = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json")

interface WindsurfMcpConfig {
  mcpServers: Record<string, { type: string; serverUrl: string }>
}

const windsurf: Integration = {
  id: "windsurf",
  label: "Windsurf",
  helpText: "~/.codeium/windsurf/mcp_config.json  (user-level only)",

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".codeium", "windsurf"))
  },

  getConfigPath(_projectDir, _opts) {
    return CONFIG_PATH
  },

  hasEntry(_projectDir, _opts) {
    if (!fs.existsSync(CONFIG_PATH)) return false
    try {
      const config = readJsonConfig<WindsurfMcpConfig>(CONFIG_PATH, { mcpServers: {} })
      return SERVER_KEY in config.mcpServers
    } catch { return false }
  },

  install(_projectDir, opts): InstallResult {
    const config = readJsonConfig<WindsurfMcpConfig>(CONFIG_PATH, { mcpServers: {} })
    const existed = SERVER_KEY in config.mcpServers
    // Windsurf requires serverUrl, not url — using the wrong field silently breaks the server
    config.mcpServers[SERVER_KEY] = { type: "http", serverUrl: buildMcpUrl(opts.baseUrl) }
    writeJsonConfig(CONFIG_PATH, config)
    return { configPath: CONFIG_PATH, existed }
  },

  remove(_projectDir, _opts): RemoveResult {
    return { configPath: CONFIG_PATH, removed: removeJsonEntry(CONFIG_PATH, "mcpServers", SERVER_KEY) }
  },
}

export default windsurf
