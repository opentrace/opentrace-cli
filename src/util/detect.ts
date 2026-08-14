import type { Integration } from "../integrations/types.js"
import claudeCode from "../integrations/claude-code.js"
import cursor from "../integrations/cursor.js"
import windsurf from "../integrations/windsurf.js"
import vscode from "../integrations/vscode.js"
import continueDev from "../integrations/continue.js"
import zed from "../integrations/zed.js"
import jetbrains from "../integrations/jetbrains.js"

export const ALL_INTEGRATIONS: Integration[] = [
  claudeCode,
  cursor,
  windsurf,
  vscode,
  continueDev,
  zed,
  jetbrains,
]

export function detectInstalled(): Integration[] {
  return ALL_INTEGRATIONS.filter((i) => i.detect())
}

/**
 * Integrations named by per-tool flags (`--cursor`, `--zed`, …). Commander gives
 * them camelCase keys. Lives here rather than in the install command because two
 * callers need the same answer: the one that acts on the flags, and the one that
 * has to warn when it cannot.
 */
export function integrationsFromFlags(toolOpts: Record<string, unknown> = {}): Integration[] {
  const camel = (id: string): string => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return ALL_INTEGRATIONS.filter((i) => Boolean(toolOpts[camel(i.id)]))
}

export function findIntegration(id: string): Integration | undefined {
  return ALL_INTEGRATIONS.find((i) => i.id === id)
}
