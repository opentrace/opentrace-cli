import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult } from "./types.js"

function configPath(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "JetBrains", "AIAssistant", "mcp.json")
    : path.join(os.homedir(), ".config", "JetBrains", "AIAssistant", "mcp.json")
}

function detectDir(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "JetBrains")
    : path.join(os.homedir(), ".config", "JetBrains")
}

interface JetBrainsMcpConfig {
  mcpServers: Record<string, { type: string; url: string }>
}

const jetbrains: Integration = {
  id: "jetbrains",
  label: "JetBrains AI",
  helpText: "~/…/JetBrains/AIAssistant/mcp.json",

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
      const config = readJsonConfig<JetBrainsMcpConfig>(filePath, { mcpServers: {} })
      return SERVER_KEY in config.mcpServers
    } catch { return false }
  },

  install(_projectDir, opts): InstallResult {
    const filePath = configPath()
    const config = readJsonConfig<JetBrainsMcpConfig>(filePath, { mcpServers: {} })
    const existed = SERVER_KEY in config.mcpServers
    config.mcpServers[SERVER_KEY] = { type: "http", url: buildMcpUrl(opts.baseUrl) }
    writeJsonConfig(filePath, config)
    return { configPath: filePath, existed }
  },
}

export default jetbrains
