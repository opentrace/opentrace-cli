import fs from "node:fs"
import path from "node:path"

export interface McpServerEntry {
  type: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>
}

const MCP_FILE = ".mcp.json"

export function mcpConfigPath(dir: string): string {
  return path.join(dir, MCP_FILE)
}

export function readMcpConfig(dir: string): McpConfig {
  const filePath = mcpConfigPath(dir)
  if (!fs.existsSync(filePath)) {
    return { mcpServers: {} }
  }
  const raw = fs.readFileSync(filePath, "utf8")
  try {
    return JSON.parse(raw) as McpConfig
  } catch {
    throw new Error(`${filePath} is not valid JSON`)
  }
}

export function writeMcpConfig(dir: string, config: McpConfig): void {
  const filePath = mcpConfigPath(dir)
  fs.writeFileSync(filePath, JSON.stringify(config, null, 4) + "\n", "utf8")
}

export function buildOpenTraceEntry(baseUrl: string): McpServerEntry {
  return {
    type: "http",
    url: `${baseUrl.replace(/\/$/, "")}/mcp/v1/`,
  }
}
