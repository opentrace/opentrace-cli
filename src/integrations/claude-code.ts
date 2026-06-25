import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult } from "./types.js"

interface McpConfig {
  mcpServers: Record<string, { type: string; url: string }>
}

const claudeCode: Integration = {
  id: "claude-code",
  label: "Claude Code",
  helpText: ".mcp.json  (--global: ~/.claude/mcp.json)",

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".claude"))
  },

  getConfigPath(projectDir, { global: isGlobal }) {
    return isGlobal
      ? path.join(os.homedir(), ".claude", "mcp.json")
      : path.join(projectDir, ".mcp.json")
  },

  hasEntry(projectDir, opts) {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return false
    try {
      const config = readJsonConfig<McpConfig>(configPath, { mcpServers: {} })
      return SERVER_KEY in config.mcpServers
    } catch { return false }
  },

  install(projectDir, opts): InstallResult {
    const configPath = this.getConfigPath(projectDir, opts)
    const config = readJsonConfig<McpConfig>(configPath, { mcpServers: {} })
    const existed = SERVER_KEY in config.mcpServers
    config.mcpServers[SERVER_KEY] = { type: "http", url: buildMcpUrl(opts.baseUrl) }
    writeJsonConfig(configPath, config)
    return { configPath, existed }
  },
}

export default claudeCode
