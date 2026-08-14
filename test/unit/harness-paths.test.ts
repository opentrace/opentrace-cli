// The harness restates one piece of production logic it cannot reuse: where the
// Claude desktop app keeps its config. `claudeAppDir()` resolves against the test
// process's own HOME, not the sandbox's, so the harness computes its own copy.
//
// That copy drifted. Tests hardcoded `.config/Claude`, which is the Linux answer,
// so three of them passed on Linux while asserting nothing at all on macOS — the
// CLI wrote to ~/Library/Application Support/Claude and the assertions looked
// somewhere empty. Pinned here: on whatever platform this runs, the sandbox must
// agree with the code under test. CI covers Linux and macOS, so the matrix checks
// both halves of the switch.

import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { claudeAppDir, claudeDesktopConfigPath } from "../../src/util/claude-app.js"
import { createSandbox } from "../harness.js"

describe("harness path agreement", () => {
  it("resolves the Claude app directory the same way the CLI does", async () => {
    const sb = await createSandbox()
    // The env the harness hands its child, applied here so the production
    // helpers resolve against the sandbox rather than the real home.
    const saved = { ...process.env }
    process.env.HOME = sb.home
    process.env.USERPROFILE = sb.home
    process.env.XDG_CONFIG_HOME = path.join(sb.home, ".config")
    process.env.APPDATA = path.join(sb.home, "AppData", "Roaming")
    try {
      assert.equal(sb.claudeAppDir(), claudeAppDir(), `disagreement on ${process.platform}`)
      assert.equal(sb.claudeDesktopConfigPath(), claudeDesktopConfigPath())
      // And the sandbox's answer really is inside the sandbox.
      assert.ok(sb.claudeAppDir().startsWith(sb.home), "app dir escaped the sandbox home")
    } finally {
      for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"]) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      await sb.cleanup()
    }
  })

  it("seeds the desktop surfaces where detection looks for them", async () => {
    const sb = await createSandbox()
    const saved = { ...process.env }
    process.env.HOME = sb.home
    process.env.USERPROFILE = sb.home
    process.env.XDG_CONFIG_HOME = path.join(sb.home, ".config")
    process.env.APPDATA = path.join(sb.home, "AppData", "Roaming")
    try {
      const app = await import(`../../src/util/claude-app.js?${os.tmpdir().length}-a`)
      assert.equal(app.isClaudeAppInstalled(), false)
      sb.seedClaudeApp()
      assert.equal(app.isClaudeAppInstalled(), true, "seedClaudeApp did not land where detection looks")
      assert.equal(app.hasClaudeCodeDesktop(), false)
      sb.seedClaudeCodeDesktop()
      assert.equal(app.hasClaudeCodeDesktop(), true, "seedClaudeCodeDesktop did not land where detection looks")
    } finally {
      for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"]) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      await sb.cleanup()
    }
  })
})
