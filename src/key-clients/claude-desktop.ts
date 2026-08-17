import fs from "node:fs"
import path from "node:path"
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

const BRIDGE_NOTE = "Claude Desktop connects through the `mcp-remote` bridge, which needs npx."

/**
 * The app injects this file's servers into local Code-tab sessions as well, and
 * the plugin's own server is scoped (`plugin:opentrace:opentrace`), so the two
 * never merge — those sessions end up listing OpenTrace twice. Unavoidable while
 * the chat surface accepts nothing but a stdio command, so it is said rather than
 * hidden.
 */
const CODE_TAB_NOTE =
  "Code-tab sessions will list this bridge as a second `opentrace` server, alongside the plugin's own."

/**
 * Is `npx` on PATH? The bridge IS an npx invocation, so without it the entry we
 * write is a server that cannot start. Checked by looking rather than by running
 * `npx --version`, which costs a subprocess boot to answer a question about a
 * file's existence.
 */
export function npxAvailable(): boolean {
  const names = process.platform === "win32" ? ["npx.cmd", "npx.exe", "npx"] : ["npx"]
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) =>
      names.some((name) => {
        try {
          fs.accessSync(path.join(dir, name), fs.constants.X_OK)
          return true
        } catch {
          return false
        }
      }),
    )
}

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
