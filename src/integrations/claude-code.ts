import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { clearPluginToken } from "../util/plugin-token.js"
import { isClaudeAppInstalled } from "../util/claude-app.js"
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
  // Claude Code expects a record keyed by "plugin@marketplace" → boolean. Older
  // builds of this CLI wrote a string[]; normalizePlugins() heals that on write.
  enabledPlugins: Record<string, boolean> | string[]
}

/** Coerce enabledPlugins to the record form Claude Code expects, repairing a legacy array. */
function normalizePlugins(settings: ClaudeSettings): Record<string, boolean> {
  const ep = settings.enabledPlugins
  if (Array.isArray(ep)) {
    const rec: Record<string, boolean> = {}
    for (const id of ep) rec[id] = true
    return rec
  }
  return ep ?? {}
}

// pluginConfigs (userConfig values, e.g. mcp_url) is read from USER settings only —
// project-scoped pluginConfigs is ignored by Claude Code — so it always lives here.
interface UserSettings {
  pluginConfigs?: Record<string, { options?: Record<string, string | number | boolean>; mcpServers?: Record<string, unknown> }>
  [key: string]: unknown
}

function userSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json")
}

/** Seed the plugin's mcp_url userConfig value in user settings; returns the file written. */
function writePluginMcpUrl(mcpUrl: string): string {
  const configPath = userSettingsPath()
  const settings = readJsonConfig<UserSettings>(configPath, {})
  const id = pluginId()
  const pluginConfigs = settings.pluginConfigs ?? {}
  const existing = pluginConfigs[id] ?? {}
  pluginConfigs[id] = { ...existing, options: { ...(existing.options ?? {}), mcp_url: mcpUrl } }
  settings.pluginConfigs = pluginConfigs
  writeJsonConfig(configPath, settings)
  return configPath
}

/** Drop the plugin's entry from user-settings pluginConfigs. Returns true if anything changed. */
function clearPluginConfig(): boolean {
  const configPath = userSettingsPath()
  if (!fs.existsSync(configPath)) return false
  try {
    const settings = readJsonConfig<UserSettings>(configPath, {})
    const id = pluginId()
    if (!settings.pluginConfigs || !(id in settings.pluginConfigs)) return false
    delete settings.pluginConfigs[id]
    writeJsonConfig(configPath, settings)
    return true
  } catch {
    return false
  }
}

/** Strip the marketplace + enabledPlugins declaration from one settings file. Returns true if it changed. */
function stripDeclaration(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false
  try {
    const settings = readJsonConfig<ClaudeSettings>(configPath, { extraKnownMarketplaces: {}, enabledPlugins: {} })
    const enabled = normalizePlugins(settings)
    const id = pluginId()
    if (!(MARKETPLACE_NAME in settings.extraKnownMarketplaces) && !(id in enabled)) return false
    delete settings.extraKnownMarketplaces[MARKETPLACE_NAME]
    delete enabled[id]
    settings.enabledPlugins = enabled
    writeJsonConfig(configPath, settings)
    return true
  } catch {
    return false
  }
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
        enabledPlugins: {},
      })
      return (
        MARKETPLACE_NAME in settings.extraKnownMarketplaces &&
        normalizePlugins(settings)[pluginId()] === true
      )
    } catch {
      return false
    }
  },

  install(projectDir, opts): PluginInstallResult {
    const configPath = this.getConfigPath(projectDir, opts)
    const settings = readJsonConfig<ClaudeSettings>(configPath, {
      extraKnownMarketplaces: {},
      enabledPlugins: {},
    })
    const enabled = normalizePlugins(settings)

    const marketplaceKnown = MARKETPLACE_NAME in settings.extraKnownMarketplaces
    const id = pluginId()
    const alreadyEnabled = marketplaceKnown && enabled[id] === true

    settings.extraKnownMarketplaces[MARKETPLACE_NAME] = {
      source: { source: "github", repo: MARKETPLACE_REPO },
    }
    enabled[id] = true
    settings.enabledPlugins = enabled // always persist the record form (heals a legacy array)

    writeJsonConfig(configPath, settings)
    return { configPath, alreadyEnabled }
  },

  setMcpUrl(mcpUrl): { configPath: string } {
    return { configPath: writePluginMcpUrl(mcpUrl) }
  },

  // Scope-complete: clears the declaration from both the project file and user
  // settings, plus the user-scoped pluginConfigs (mcp_url) and the API-key token
  // file. Idempotent; `opts` is accepted for interface parity but unused.
  remove(projectDir, _opts): RemoveResult {
    const projectPath = this.getConfigPath(projectDir, { global: false })
    const userPath = this.getConfigPath(projectDir, { global: true })
    let removed = false
    if (stripDeclaration(projectPath)) removed = true
    if (userPath !== projectPath && stripDeclaration(userPath)) removed = true
    if (clearPluginConfig()) removed = true // pluginConfigs.mcp_url in user settings
    if (clearPluginToken()) removed = true // ~/.claude/opentrace-plugin.token
    return { configPath: userPath, removed }
  },
}

const claudeCode: Integration = {
  id: "claude-code",
  label: "Claude Code",
  helpText: ".mcp.json  (--global: ~/.claude/mcp.json)",

  // Covers both surfaces: the terminal CLI and the desktop app's Code tab, which
  // runs the same engine off the same config files. A machine with only the app
  // installed still has Claude Code to configure — reporting "not found" there
  // was the whole of what otx got wrong about the desktop app.
  detect() {
    return fs.existsSync(path.join(os.homedir(), ".claude")) || isClaudeAppInstalled()
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
