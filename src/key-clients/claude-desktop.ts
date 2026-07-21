import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import type { KeyClient, KeyClientResult } from "./types.js"

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

function configDir(): string {
  const home = os.homedir()
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude")
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude")
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude")
  }
}

function configFile(): string {
  return path.join(configDir(), "claude_desktop_config.json")
}

const claudeDesktop: KeyClient = {
  id: "claude-desktop",
  label: "Claude Desktop",

  detect() {
    return fs.existsSync(configDir())
  },

  configPath() {
    return configFile()
  },

  write(mcpUrl, token): KeyClientResult {
    const configPath = configFile()
    const config = readJsonConfig<DesktopConfig>(configPath, { mcpServers: {} })
    config.mcpServers[SERVER_KEY] = {
      command: "npx",
      args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${token}`],
    }
    writeJsonConfig(configPath, config, { secret: true })
    return {
      configPath,
      note: "Claude Desktop reaches remote servers through the `mcp-remote` bridge — it needs Node.js/npx installed, and adds a little startup latency.",
    }
  },
}

export default claudeDesktop
