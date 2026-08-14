// Removing what installing the plugin left in Claude Code's own records.
//
// These files hold other people's plugins, so every test here is really about the
// same thing: take ours out, touch nothing else, and refuse rather than guess.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

let home: string
let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-plugins-"))
  process.env.HOME = home
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

/** Imported per test so each picks up the current HOME. */
async function load() {
  return import(`../../src/util/claude-plugins.js?${home.length}-${Math.random()}`)
}

const plugins = (): string => path.join(home, ".claude", "plugins")
const write = (file: string, value: unknown): void =>
  fs.writeFileSync(path.join(plugins(), file), JSON.stringify(value, null, 2), "utf8")
const read = (file: string): any => JSON.parse(fs.readFileSync(path.join(plugins(), file), "utf8"))

/** The shape a real machine has: our plugin plus somebody else's. */
function seedRealistic(): { ours: string; theirs: string; market: string } {
  const ours = path.join(plugins(), "cache", "opentrace", "opentrace", "0.6.0")
  const theirs = path.join(plugins(), "cache", "claude-plugins-official", "gopls-lsp", "1.0.0")
  const market = path.join(plugins(), "marketplaces", "opentrace")
  for (const d of [ours, theirs, market]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(ours, "marker"), "x")
  fs.writeFileSync(path.join(theirs, "marker"), "x")

  write("installed_plugins.json", {
    version: 2,
    plugins: {
      "gopls-lsp@claude-plugins-official": [{ scope: "user", installPath: theirs, version: "1.0.0" }],
      "opentrace@opentrace": [
        { scope: "user", installPath: ours, version: "0.6.0" },
        { scope: "project", installPath: ours, version: "0.6.0", projectPath: "/somewhere" },
      ],
    },
  })
  write("known_marketplaces.json", {
    "claude-plugins-official": {
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
      installLocation: path.join(plugins(), "marketplaces", "claude-plugins-official"),
    },
    opentrace: {
      source: { source: "github", repo: "opentrace/opentrace-cli" },
      installLocation: market,
    },
  })
  return { ours, theirs, market }
}

describe("removeInstalledPlugin", () => {
  it("takes our plugin out of the list `/plugin` reads, in every scope", async () => {
    seedRealistic()
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(r.uninstalled, true)
    const installed = read("installed_plugins.json")
    assert.equal("opentrace@opentrace" in installed.plugins, false)
    // Both the user and project entries go: disconnecting is not per-project.
    assert.equal(JSON.stringify(installed).includes("opentrace@opentrace"), false)
  })

  it("leaves other people's plugins and marketplaces exactly alone", async () => {
    const { theirs } = seedRealistic()
    const m = await load()
    m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    const installed = read("installed_plugins.json")
    assert.ok(installed.plugins["gopls-lsp@claude-plugins-official"], "other plugin survives")
    assert.equal(installed.version, 2, "schema version preserved")
    assert.ok(fs.existsSync(path.join(theirs, "marker")), "other plugin's files survive")
    const known = read("known_marketplaces.json")
    assert.ok(known["claude-plugins-official"], "other marketplace survives")
    assert.equal("opentrace" in known, false)
  })

  it("deletes the directories the records named", async () => {
    const { ours, market } = seedRealistic()
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(fs.existsSync(ours), false, "install dir deleted")
    assert.equal(fs.existsSync(market), false, "marketplace clone deleted")
    assert.ok(r.removedPaths.includes(ours))
    assert.ok(r.removedPaths.includes(market))
  })

  it("prunes the empty rungs above, but not a parent someone else is using", async () => {
    // An install path names a versioned directory (cache/opentrace/opentrace/0.6.0),
    // so deleting it alone leaves two empty levels behind.
    seedRealistic()
    const m = await load()
    m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(fs.existsSync(path.join(plugins(), "cache", "opentrace")), false, "empty rungs pruned")
    // …but `cache/` still holds another plugin, so it stays.
    assert.ok(fs.existsSync(path.join(plugins(), "cache")), "shared parent kept")
    assert.ok(fs.existsSync(path.join(plugins(), "cache", "claude-plugins-official", "gopls-lsp", "1.0.0")))
    assert.ok(fs.existsSync(plugins()), "the plugins directory itself is never removed")
  })

  it("is a no-op on a machine that never installed it", async () => {
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.deepEqual(
      { uninstalled: r.uninstalled, marketplaceForgotten: r.marketplaceForgotten, skipped: r.skipped },
      { uninstalled: false, marketplaceForgotten: false, skipped: [] },
    )
  })

  it("is idempotent", async () => {
    seedRealistic()
    const m = await load()
    assert.equal(m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace").uninstalled, true)
    assert.equal(m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace").uninstalled, false)
  })

  it("refuses an install schema it does not recognise, rather than rewriting it", async () => {
    // Rewriting a future format could break every plugin the user has, which is
    // far worse than a leftover. Report and stop.
    write("installed_plugins.json", {
      version: 99,
      plugins: { "opentrace@opentrace": [{ scope: "user" }] },
    })
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(r.uninstalled, false)
    assert.deepEqual(r.skipped, [m.installedPluginsPath()])
    assert.ok(read("installed_plugins.json").plugins["opentrace@opentrace"], "left untouched")
  })

  it("reports an unreadable record instead of claiming success", async () => {
    fs.writeFileSync(path.join(plugins(), "installed_plugins.json"), "{ not json", "utf8")
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(r.uninstalled, false)
    assert.deepEqual(r.skipped, [m.installedPluginsPath()])
  })

  it("will not delete a directory outside the plugins directory", async () => {
    // A record is data. Hand-edited or written by a future version, it must not be
    // able to point a recursive delete anywhere it likes.
    const outside = path.join(home, "precious")
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, "keep"), "x")
    write("installed_plugins.json", {
      version: 2,
      plugins: { "opentrace@opentrace": [{ scope: "user", installPath: outside }] },
    })
    const m = await load()
    const r = m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(r.uninstalled, true, "the record still goes")
    assert.ok(fs.existsSync(path.join(outside, "keep")), "the directory does not")
    assert.deepEqual(r.removedPaths, [])
  })

  it("removes the data directory only while it is an empty scaffold", async () => {
    const dataDir = path.join(plugins(), "data", "opentrace-opentrace")
    fs.mkdirSync(dataDir, { recursive: true })
    const m = await load()
    m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.equal(fs.existsSync(dataDir), false, "empty scaffold removed")

    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, "state.json"), "{}")
    m.removeInstalledPlugin("opentrace@opentrace", "opentrace", "opentrace")
    assert.ok(fs.existsSync(path.join(dataDir, "state.json")), "data is never deleted")
  })
})
