import type { KeyClient } from "./types.js"
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

export type { KeyClient, KeyClientResult } from "./types.js"
