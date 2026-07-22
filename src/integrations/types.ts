export interface InstallOptions {
  baseUrl: string
  global?: boolean
}

export interface InstallResult {
  configPath: string
  existed: boolean
}

/** Result of removing the OpenTrace entry from a config (disconnect). */
export interface RemoveResult {
  configPath: string
  /** true if an OpenTrace entry was present and has now been removed */
  removed: boolean
}

export interface PluginInstallResult {
  configPath: string
  /** true if the marketplace + plugin were already enabled before this call */
  alreadyEnabled: boolean
}

/**
 * A plugin capability that a target environment supports. The CLI acts as the
 * control plane: it only installs a plugin where the target can accept one
 * (e.g. Claude Code), and silently skips targets that cannot (MCP still lands).
 */
export interface PluginCapability {
  /** Marketplace name, used as the key in extraKnownMarketplaces and the suffix in enabledPlugins */
  marketplaceName: string
  /** Plugin name from the marketplace manifest, used as the prefix in enabledPlugins */
  pluginName: string
  /** Where the settings file that declares the plugin lives for the given scope */
  getConfigPath(projectDir: string, opts: Pick<InstallOptions, "global">): string
  /** true if this marketplace + plugin are already declared in the settings file */
  isEnabled(projectDir: string, opts: Pick<InstallOptions, "global">): boolean
  /** Declare the marketplace and enable the plugin, merging into existing settings */
  install(projectDir: string, opts: Pick<InstallOptions, "global">): PluginInstallResult
  /**
   * Pre-seed the plugin's `mcp_url` userConfig so its bundled MCP targets `mcpUrl`.
   * Written to USER settings, since Claude Code reads pluginConfigs from there only.
   */
  setMcpUrl(mcpUrl: string): { configPath: string }
  /** Remove the marketplace + plugin declaration (and any pluginConfigs) from settings */
  remove(projectDir: string, opts: Pick<InstallOptions, "global">): RemoveResult
}

export interface Integration {
  id: string
  label: string
  helpText: string
  detect(): boolean
  getConfigPath(projectDir: string, opts: Pick<InstallOptions, "global">): string
  hasEntry(projectDir: string, opts: Pick<InstallOptions, "global">): boolean
  install(projectDir: string, opts: InstallOptions): InstallResult
  /** Remove the OpenTrace MCP server entry from this integration's config. */
  remove(projectDir: string, opts: Pick<InstallOptions, "global">): RemoveResult
  /** Present only on targets that can host an OpenTrace plugin (control-plane capability matrix) */
  plugin?: PluginCapability
}
