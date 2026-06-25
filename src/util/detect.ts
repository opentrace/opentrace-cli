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

export function findIntegration(id: string): Integration | undefined {
  return ALL_INTEGRATIONS.find((i) => i.id === id)
}
