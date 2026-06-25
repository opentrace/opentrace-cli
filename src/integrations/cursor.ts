import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult } from "./types.js"

interface CursorMcpConfig {
  mcpServers: Record<string, { type: string; url: string }>
}

const cursor: Integration = {
  id: "cursor",
  label: "Cursor",
  helpText: ".cursor/mcp.json  (--global: ~/.cursor/mcp.json)",

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".cursor"))
  },

  getConfigPath(projectDir, { global: isGlobal }) {
    return isGlobal
      ? path.join(os.homedir(), ".cursor", "mcp.json")
      : path.join(projectDir, ".cursor", "mcp.json")
  },

  hasEntry(projectDir, opts) {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return false
    try {
      const config = readJsonConfig<CursorMcpConfig>(configPath, { mcpServers: {} })
      return SERVER_KEY in config.mcpServers
    } catch { return false }
  },

  install(projectDir, opts): InstallResult {
    const configPath = this.getConfigPath(projectDir, opts)
    const config = readJsonConfig<CursorMcpConfig>(configPath, { mcpServers: {} })
    const existed = SERVER_KEY in config.mcpServers
    config.mcpServers[SERVER_KEY] = { type: "http", url: buildMcpUrl(opts.baseUrl) }
    writeJsonConfig(configPath, config)
    return { configPath, existed }
  },
}

export default cursor
