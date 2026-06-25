import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult } from "./types.js"

// VS Code MCP config is workspace-scoped only via the file API (.vscode/mcp.json).
// User-level config requires the `code --add-mcp` CLI — not handled here.
// --global is intentionally ignored; the path is always project-level.

interface VscodeMcpConfig {
  // VS Code uses "servers", not "mcpServers" — unique among all tools
  servers: Record<string, { type: string; url: string }>
}

const vscode: Integration = {
  id: "vscode",
  label: "VS Code / Copilot",
  helpText: '.vscode/mcp.json  (key: "servers", not "mcpServers")',

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".vscode"))
  },

  getConfigPath(projectDir, _opts) {
    return path.join(projectDir, ".vscode", "mcp.json")
  },

  hasEntry(projectDir, opts) {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return false
    try {
      const config = readJsonConfig<VscodeMcpConfig>(configPath, { servers: {} })
      return SERVER_KEY in config.servers
    } catch { return false }
  },

  install(projectDir, opts): InstallResult {
    const configPath = this.getConfigPath(projectDir, opts)
    const config = readJsonConfig<VscodeMcpConfig>(configPath, { servers: {} })
    const existed = SERVER_KEY in config.servers
    config.servers[SERVER_KEY] = { type: "http", url: buildMcpUrl(opts.baseUrl) }
    writeJsonConfig(configPath, config)
    return { configPath, existed }
  },
}

export default vscode
