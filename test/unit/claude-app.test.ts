// Which Claude Code surfaces a machine has. The desktop app's Code tab reads the
// same config as the CLI, so this only decides labelling and detection — but
// getting it wrong is what made a desktop-only machine report "not found".

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved.HOME = process.env.HOME
  saved.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-app-"))
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, ".config")
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(home, { recursive: true, force: true })
})

async function load() {
  return import(`../../src/util/claude-app.js?${Math.random()}`)
}

function seedCli(): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
}
function seedApp(): void {
  fs.mkdirSync(path.join(home, ".config", "Claude"), { recursive: true })
}
function seedCodeTab(): void {
  fs.mkdirSync(path.join(home, ".config", "Claude", "claude-code", "2.1.222"), { recursive: true })
}

describe("claudeCodeSurfaces", () => {
  it("reports nothing on a machine with neither", async () => {
    const m = await load()
    assert.deepEqual(m.claudeCodeSurfaces(), [])
    assert.equal(m.isClaudeAppInstalled(), false)
    assert.equal(m.hasClaudeCodeDesktop(), false)
  })

  it("reports CLI only", async () => {
    seedCli()
    const m = await load()
    assert.deepEqual(m.claudeCodeSurfaces(), ["CLI"])
  })

  it("reports Desktop for an installed app whose Code tab has never run", async () => {
    // The engine downloads on first use, so the surface is still there to
    // configure for — this is the case that used to read as "not found".
    seedApp()
    const m = await load()
    assert.deepEqual(m.claudeCodeSurfaces(), ["Desktop"])
    assert.equal(m.hasClaudeCodeDesktop(), false)
  })

  it("reports both, and never lists Desktop twice", async () => {
    seedCli()
    seedCodeTab()
    const m = await load()
    assert.deepEqual(m.claudeCodeSurfaces(), ["CLI", "Desktop"])
    assert.equal(m.hasClaudeCodeDesktop(), true)
  })

  it("holds the invariant detectionTag relies on: app present implies a surface", async () => {
    seedApp()
    const m = await load()
    assert.equal(m.isClaudeAppInstalled(), true)
    assert.ok(m.claudeCodeSurfaces().length > 0)
  })

  it("puts the chat config inside the app directory", async () => {
    const m = await load()
    assert.equal(m.claudeDesktopConfigPath(), path.join(m.claudeAppDir(), "claude_desktop_config.json"))
  })
})
