// API-key client writers. Distinct from src/integrations/ (which writes
// headerless OAuth MCP config, often project-scoped): these write a
// USER-scoped MCP entry that embeds the bearer token, so the file must stay
// in the user's home dir (never committed) and be locked down (0600).

export interface KeyClientResult {
  configPath: string
  /** Extra guidance to show the user (e.g. the mcp-remote bridge requires npx). */
  note?: string
}

export interface KeyClientRemoveResult {
  configPath: string
  /** true if an OpenTrace entry was present and has now been removed */
  removed: boolean
  /** The MCP endpoint that was configured, so the keychain entry can be cleaned up too. */
  url?: string
}

export interface KeyClient {
  id: string
  label: string
  /**
   * False for a client otx no longer configures but must still clean up after.
   * The Claude app's chat surface is the case: otx used to write an `mcp-remote`
   * stdio bridge into `claude_desktop_config.json`, and that entry is still on
   * users' machines, so `remove()` has to keep working long after `write()` went
   * away. Defaults to writable when absent.
   */
  writable?: boolean
  /** True if this client appears installed on the machine. */
  detect(): boolean
  /** Absolute path of the config file this client writes to. */
  configPath(): string
  /** Write/replace the OpenTrace MCP entry carrying the bearer token. `mcpUrl` ends in /mcp/v1/. Absent when `writable` is false. */
  write?(mcpUrl: string, token: string): KeyClientResult
  /** Remove the OpenTrace MCP entry from this client's config. Returns the URL it carried, if any. */
  remove(): KeyClientRemoveResult
}
