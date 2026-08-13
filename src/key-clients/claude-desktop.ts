import fs from "node:fs"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import { claudeAppDir, claudeDesktopConfigPath, hasClaudeCodeDesktop } from "../util/claude-app.js"
import type { KeyClient, KeyClientResult, KeyClientRemoveResult } from "./types.js"

// Claude Desktop's claude_desktop_config.json only validates stdio servers —
// it has no native remote-HTTP-with-headers support. The only scriptable way to
// reach a remote authenticated endpoint is the `mcp-remote` stdio bridge, which
// proxies to the HTTP mount and injects the Authorization header per request.

interface StdioServer {
  command: string
  args: string[]
}

interface DesktopConfig {
  mcpServers: Record<string, StdioServer | Record<string, unknown>>
}

const BRIDGE_NOTE =
  "Claude Desktop reaches remote servers through the `mcp-remote` bridge — it needs Node.js/npx installed, and adds a little startup latency."

/**
 * The same file feeds the app's **Code** tab, where a name collision resolves in
 * favour of this file — so writing the bridge here quietly downgrades Claude
 * Code Desktop from the native HTTP mount to the npx bridge. Unavoidable (the
 * chat surface accepts nothing else), so it is said rather than hidden.
 */
const CODE_TAB_NOTE =
  "This machine also runs Claude Code Desktop (the app's Code tab), which loads this file too and prefers it over " +
  "~/.claude.json / .mcp.json for a server of the same name — so Code-tab sessions will use the npx bridge rather than " +
  "the native HTTP mount. Remove the `opentrace` entry from this file if you would rather Code sessions used the direct endpoint."

const claudeDesktop: KeyClient = {
  id: "claude-desktop",
  label: "Claude Desktop",

  detect() {
    return fs.existsSync(claudeAppDir())
  },

  configPath() {
    return claudeDesktopConfigPath()
  },

  write(mcpUrl, token): KeyClientResult {
    const configPath = claudeDesktopConfigPath()
    const config = readJsonConfig<DesktopConfig>(configPath, { mcpServers: {} })
    config.mcpServers[SERVER_KEY] = {
      command: "npx",
      args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${token}`],
    }
    writeJsonConfig(configPath, config, { secret: true })
    return {
      configPath,
      note: hasClaudeCodeDesktop() ? `${BRIDGE_NOTE}\n  ${CODE_TAB_NOTE}` : BRIDGE_NOTE,
    }
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
