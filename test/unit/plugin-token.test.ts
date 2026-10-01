import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  clearTelemetryToken,
  pluginTokenPath,
  readPluginToken,
  telemetryTokenPath,
  writePluginToken,
  writeTelemetryToken,
} from "../../src/util/plugin-token.js"

let dir: string
let realHome: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "otx-token-"))
  realHome = process.env.HOME
  process.env.HOME = dir
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe("private token files", () => {
  it("keeps the two credentials in separate files", () => {
    // The MCP reads the graph and needs a CLI key; the hooks only post usage and hold a key
    // that deliberately cannot read anything. One shared path meant whichever command ran
    // last decided which capability worked.
    writePluginToken("otk_mcp")
    writeTelemetryToken("otk_usage")

    assert.notEqual(pluginTokenPath(), telemetryTokenPath())
    assert.equal(readPluginToken(), "otk_mcp")
    assert.equal(fs.readFileSync(telemetryTokenPath(), "utf8").trim(), "otk_usage")
  })

  it("creates 0600 rather than creating loose and narrowing after", () => {
    // writeFileSync with no mode creates at 0666 & ~umask — commonly 0644 — leaving the
    // secret world-readable for the window before a chmod lands.
    assert.equal(mode(writePluginToken("otk_a")), 0o600)
  })

  it("recreates a file an older build left world-readable", () => {
    const p = pluginTokenPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "otk_old\n", { mode: 0o644 })

    writePluginToken("otk_new")

    assert.equal(mode(p), 0o600)
    assert.equal(readPluginToken(), "otk_new")
  })

  it("writes through a symlink instead of replacing it", () => {
    // Someone pointing this path at their own secret store. Unlinking would silently
    // detach whatever was feeding it, so the link is written through and kept.
    const target = path.join(dir, "vault-secret")
    fs.writeFileSync(target, "otk_old\n", { mode: 0o600 })
    const link = pluginTokenPath()
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link)

    writePluginToken("otk_new")

    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link must survive the write")
    assert.equal(fs.readFileSync(target, "utf8").trim(), "otk_new", "and the target receives it")
  })

  it("clears only the telemetry file", () => {
    writePluginToken("otk_mcp")
    writeTelemetryToken("otk_usage")

    assert.equal(clearTelemetryToken(), true)
    assert.equal(fs.existsSync(telemetryTokenPath()), false)
    assert.equal(readPluginToken(), "otk_mcp")
  })

  it("reports nothing to clear when monitoring was never set up", () => {
    assert.equal(clearTelemetryToken(), false)
  })
})
