import fs from "node:fs"
import path from "node:path"
import { readJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import { claudeAppDir, claudeDesktopConfigPath } from "../util/claude-app.js"
import type { KeyClient, KeyClientRemoveResult } from "./types.js"

// Removal only. otx used to reach the Claude app's chat surface by writing an
// `mcp-remote` stdio bridge into claude_desktop_config.json, on the reasoning that
// the file validates stdio servers and so the bridge was the only scriptable route
// to a remote authenticated endpoint.
//
// That reasoning aimed at the wrong file. The chat surface takes its connectors
// from the claude.ai account, not from disk, and a custom connector accepts a
// remote MCP URL directly — the same runtime, transport and auth a directory
// listing uses. So the bridge bought nothing the account-level connector does not,
// and it cost:
//
//   * the raw otk_ key in the argv of the npx process, readable by any local
//     process through `ps` or /proc/<pid>/cmdline
//   * a hard dependency on Node being on PATH, and a proxy process per session
//   * a duplicate: the app injects this file's servers into local Code-tab
//     sessions, and a plugin's server is scoped `plugin:opentrace:opentrace`, so
//     the bridge never replaced it — those sessions listed OpenTrace twice
//
// otx now prints the prefilled custom-connector link instead (see
// customConnectorUrl in util/constants). Entries written by older versions are
// still out there, so `remove()` stays.

interface StdioServer {
  command: string
  args: string[]
}

interface DesktopConfig {
  mcpServers: Record<string, StdioServer | Record<string, unknown>>
}

const claudeDesktop: KeyClient = {
  id: "claude-desktop",
  label: "Claude Desktop",
  writable: false,

  detect() {
    return fs.existsSync(claudeAppDir())
  },

  configPath() {
    return claudeDesktopConfigPath()
  },

  remove(): KeyClientRemoveResult {
    const configPath = claudeDesktopConfigPath()
    if (!fs.existsSync(configPath)) return { configPath, removed: false }
    let url: string | undefined
    try {
      const config = readJsonConfig<DesktopConfig>(configPath, { mcpServers: {} })
      const entry = config.mcpServers[SERVER_KEY] as StdioServer | undefined
      // Bridge args are [-y, mcp-remote, <url>, --header, ...] — the url follows "mcp-remote".
      const args = entry?.args ?? []
      const i = args.indexOf("mcp-remote")
      if (i !== -1 && args[i + 1]) url = args[i + 1]
    } catch {
      return { configPath, removed: false }
    }
    return { configPath, removed: removeJsonEntry(configPath, "mcpServers", SERVER_KEY), url }
  },
}

export default claudeDesktop
