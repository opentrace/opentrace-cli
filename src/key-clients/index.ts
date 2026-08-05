import fs from "node:fs"
import type { KeyClient } from "./types.js"
import { readJsonConfig } from "../util/json-config.js"
import { SERVER_KEY } from "../util/constants.js"
import claudeCode from "./claude-code.js"
import claudeDesktop from "./claude-desktop.js"
import cursor from "./cursor.js"

export const KEY_CLIENTS: KeyClient[] = [claudeCode, claudeDesktop, cursor]

/** Default client when --client is omitted. */
export const DEFAULT_KEY_CLIENT = "claude-code"

export function findKeyClient(id: string): KeyClient | undefined {
  return KEY_CLIENTS.find((c) => c.id === id)
}

export function detectKeyClients(): KeyClient[] {
  return KEY_CLIENTS.filter((c) => c.detect())
}

/**
 * Does this client's config already carry an OpenTrace entry? Every key client
 * writes to `mcpServers[SERVER_KEY]` of a JSON file (only the entry's shape
 * differs), so one reader covers all of them — which keeps this off the
 * `KeyClient` interface. Used to report added-vs-updated without re-reading
 * the file in each caller.
 */
export function hasKeyClientEntry(client: KeyClient): boolean {
  const configPath = client.configPath()
  if (!fs.existsSync(configPath)) return false
  try {
    const config = readJsonConfig<{ mcpServers?: Record<string, unknown> }>(configPath, {})
    return Boolean(config.mcpServers && SERVER_KEY in config.mcpServers)
  } catch {
    return false // unparseable config — treat as "no entry" and write a fresh one
  }
}

export type { KeyClient, KeyClientResult } from "./types.js"
