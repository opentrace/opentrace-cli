import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import type { KeyClient, KeyClientResult } from "./types.js"

// Claude Code stores user-scoped MCP servers in ~/.claude.json under a top-level
// "mcpServers" key. Native HTTP transport with custom headers is supported.

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
    return fs.existsSync(path.join(os.homedir(), ".claude")) || fs.existsSync(configFile())
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
}

export default claudeCode
