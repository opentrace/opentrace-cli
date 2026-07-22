import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsonConfig, writeJsonConfig, removeJsonEntry } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import type { KeyClient, KeyClientResult, KeyClientRemoveResult } from "./types.js"

// Cursor stores user-scoped MCP servers in ~/.cursor/mcp.json. Remote entries
// use `url` (+ optional headers); the `type` field is not required.

interface RemoteServer {
  url: string
  headers: Record<string, string>
}

interface CursorMcp {
  mcpServers: Record<string, RemoteServer | Record<string, unknown>>
}

function configFile(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json")
}

const cursor: KeyClient = {
  id: "cursor",
  label: "Cursor",

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".cursor"))
  },

  configPath() {
    return configFile()
  },

  write(mcpUrl, token): KeyClientResult {
    const configPath = configFile()
    const config = readJsonConfig<CursorMcp>(configPath, { mcpServers: {} })
    config.mcpServers[SERVER_KEY] = {
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
      const config = readJsonConfig<CursorMcp>(configPath, { mcpServers: {} })
      const entry = config.mcpServers[SERVER_KEY] as RemoteServer | undefined
      url = entry?.url
    } catch {
      return { configPath, removed: false }
    }
    return { configPath, removed: removeJsonEntry(configPath, "mcpServers", SERVER_KEY), url }
  },
}

export default cursor
