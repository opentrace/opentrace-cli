import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import {
  SERVER_KEY,
  buildMcpUrl,
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_NAME,
  pluginId,
} from "../util/constants.js"
import type {
  Integration,
  InstallOptions,
  InstallResult,
  RemoveResult,
  PluginCapability,
  PluginInstallResult,
} from "./types.js"

interface McpConfig {
  mcpServers: Record<string, { type: string; url: string }>
}

interface MarketplaceSource {
  source: "github"
  repo: string
}

interface ClaudeSettings {
  extraKnownMarketplaces: Record<string, { source: MarketplaceSource }>
  enabledPlugins: string[]
}

// Declarative plugin onboarding: write extraKnownMarketplaces + enabledPlugins into
// Claude Code settings.json. Matches how we register MCP (config-file writes, no `claude`
// binary required). Claude Code prompts the user to install once they trust the folder.
const plugin: PluginCapability = {
  marketplaceName: MARKETPLACE_NAME,
  pluginName: PLUGIN_NAME,

  getConfigPath(projectDir, { global: isGlobal }) {
    return isGlobal
      ? path.join(os.homedir(), ".claude", "settings.json")
      : path.join(projectDir, ".claude", "settings.json")
  },

  isEnabled(projectDir, opts) {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return false
    try {
      const settings = readJsonConfig<ClaudeSettings>(configPath, {
        extraKnownMarketplaces: {},
        enabledPlugins: [],
      })
      return (
        MARKETPLACE_NAME in settings.extraKnownMarketplaces &&
        settings.enabledPlugins.includes(pluginId())
      )
    } catch {
      return false
    }
  },

  install(projectDir, opts): PluginInstallResult {
    const configPath = this.getConfigPath(projectDir, opts)
    const settings = readJsonConfig<ClaudeSettings>(configPath, {
      extraKnownMarketplaces: {},
      enabledPlugins: [],
    })

    const marketplaceKnown = MARKETPLACE_NAME in settings.extraKnownMarketplaces
    const id = pluginId()
    const pluginKnown = settings.enabledPlugins.includes(id)
    const alreadyEnabled = marketplaceKnown && pluginKnown

    settings.extraKnownMarketplaces[MARKETPLACE_NAME] = {
      source: { source: "github", repo: MARKETPLACE_REPO },
    }
    if (!pluginKnown) settings.enabledPlugins.push(id)

    writeJsonConfig(configPath, settings)
    return { configPath, alreadyEnabled }
  },

  remove(projectDir, opts): RemoveResult {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return { configPath, removed: false }
    let settings: ClaudeSettings
    try {
      settings = readJsonConfig<ClaudeSettings>(configPath, { extraKnownMarketplaces: {}, enabledPlugins: [] })
    } catch {
      return { configPath, removed: false }
    }
    const id = pluginId()
    const had = MARKETPLACE_NAME in settings.extraKnownMarketplaces || settings.enabledPlugins.includes(id)
    if (!had) return { configPath, removed: false }
    delete settings.extraKnownMarketplaces[MARKETPLACE_NAME]
    settings.enabledPlugins = settings.enabledPlugins.filter((p) => p !== id)
    writeJsonConfig(configPath, settings)
    return { configPath, removed: true }
  },
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

  remove(projectDir, opts): RemoveResult {
    const configPath = this.getConfigPath(projectDir, opts)
    return { configPath, removed: removeJsonEntry(configPath, "mcpServers", SERVER_KEY) }
  },

  plugin,
}

export default claudeCode
