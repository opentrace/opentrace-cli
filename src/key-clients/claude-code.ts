import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import { isClaudeAppInstalled } from "../util/claude-app.js"
import type { KeyClient, KeyClientResult, KeyClientRemoveResult } from "./types.js"

// Claude Code stores user-scoped MCP servers in ~/.claude.json under a top-level
// "mcpServers" key. Native HTTP transport with custom headers is supported.
// Local sessions in the desktop app's Code tab read this same file, so one write
// serves both surfaces.

interface HttpServer {
  type: "http"
  url: string
  headers: Record<string, string>
}

interface ClaudeJson {
  mcpServers: Record<string, HttpServer | Record<string, unknown>>
}

function configFile(): string {
  return path.join(os.homedir(), ".claude.json")
}

const claudeCode: KeyClient = {
  id: "claude-code",
  label: "Claude Code",

  detect() {
    return (
      fs.existsSync(path.join(os.homedir(), ".claude")) ||
      fs.existsSync(configFile()) ||
      isClaudeAppInstalled()
    )
  },

  configPath() {
    return configFile()
  },

  write(mcpUrl, token): KeyClientResult {
    const configPath = configFile()
    const config = readJsonConfig<ClaudeJson>(configPath, { mcpServers: {} })
    config.mcpServers[SERVER_KEY] = {
      type: "http",
      url: mcpUrl,
      headers: { Authorization: `Bearer ${token}` },
    }
    writeJsonConfig(configPath, config, { secret: true })
    return { configPath }
  },

  remove(): KeyClientRemoveResult {
    const configPath = configFile()
    if (!fs.existsSync(configPath)) return { configPath, removed: false }
    let url: string | undefined
    try {
      const config = readJsonConfig<ClaudeJson>(configPath, { mcpServers: {} })
      const entry = config.mcpServers[SERVER_KEY] as HttpServer | undefined
      url = entry?.url
    } catch {
      return { configPath, removed: false }
    }
    return { configPath, removed: removeJsonEntry(configPath, "mcpServers", SERVER_KEY), url }
  },
}

export default claudeCode
