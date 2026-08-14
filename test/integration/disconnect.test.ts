import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createSandbox, hasTelemetry, type Sandbox } from "../harness.js"
import { otk } from "../stub-server.js"

let sb: Sandbox
const CLI_KEY = otk("cli")

beforeEach(async () => {
  sb = await createSandbox()
})
afterEach(() => sb.cleanup())

describe("disconnect --usage", () => {
  it("removes the block, and only the keys otx writes", async () => {
    sb.seedTelemetry("user", otk("usage"))
    const before = sb.readSettings("user")
    sb.writeSettings("user", {
      ...before,
      alwaysThinkingEnabled: true,
      env: { ...before.env, MY_VAR: "keep" },
    })

    const r = await sb.run(["disconnect", sb.project, "--usage", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /removed usage monitoring from/)

    const after = sb.readSettings("user")
    assert.equal(hasTelemetry(after), false)
    assert.deepEqual(Object.keys(after.env), ["MY_VAR"], "unrelated env vars survive")
    assert.equal(after.alwaysThinkingEnabled, true, "unrelated settings survive")
  })

  it("clears both scopes, regardless of -g", async () => {
    // The one component whose leftovers keep *doing* something, so scope
    // selection must not be able to leave half of it exporting.
    sb.seedTelemetry("user", otk("usage-user"))
    sb.seedTelemetry("project", otk("usage-project"))
    const r = await sb.run(["disconnect", sb.project, "--usage", "-y"])
    assert.equal(r.code, 0)
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
    assert.equal(hasTelemetry(sb.readSettings("project")), false)
  })

  it("leaves a block pointing at someone else's collector alone", async () => {
    sb.writeSettings("user", {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.corp.internal:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer corp-token",
      },
    })
    const r = await sb.run(["disconnect", sb.project, "--usage", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.output, /does not point at OpenTrace/)
    assert.equal(hasTelemetry(sb.readSettings("user")), true)
  })

  it("says so when there is nothing configured", async () => {
    const r = await sb.run(["disconnect", sb.project, "--usage", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /No usage monitoring configured/)
  })

  it("does not touch MCP entries or the plugin", async () => {
    // -g so the plugin declaration lands at user scope, where this asserts.
    await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    sb.seedTelemetry("user", otk("usage"))
    await sb.run(["disconnect", sb.project, "--usage", "-y"])
    const user = sb.readSettings("user")
    assert.equal(user.enabledPlugins?.["opentrace@opentrace"], true, "plugin left declared")
    assert.equal(fs.existsSync(sb.pluginTokenPath()), true, "key file left in place")
  })
})

describe("disconnect --plugin and Claude Code's plugin list", () => {
  /**
   * What `/plugin` reads. Removing the settings declaration takes the MCP server
   * away but leaves these, which is why the plugin went on being listed as
   * installed after a disconnect that reported success.
   */
  function seedInstalled(): { installDir: string; marketplaceDir: string } {
    const plugins = path.join(sb.home, ".claude", "plugins")
    const installDir = path.join(plugins, "cache", "opentrace", "opentrace", "0.6.0")
    const marketplaceDir = path.join(plugins, "marketplaces", "opentrace")
    fs.mkdirSync(installDir, { recursive: true })
    fs.mkdirSync(marketplaceDir, { recursive: true })
    fs.writeFileSync(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "other@somewhere": [{ scope: "user", installPath: path.join(plugins, "cache", "other") }],
          "opentrace@opentrace": [{ scope: "user", installPath: installDir, version: "0.6.0" }],
        },
      }),
    )
    fs.writeFileSync(
      path.join(plugins, "known_marketplaces.json"),
      JSON.stringify({
        somewhere: { source: { source: "github", repo: "a/b" } },
        opentrace: { source: { source: "github", repo: "opentrace/opentrace-cli" }, installLocation: marketplaceDir },
      }),
    )
    return { installDir, marketplaceDir }
  }

  const installedPlugins = (): any =>
    JSON.parse(fs.readFileSync(path.join(sb.home, ".claude", "plugins", "installed_plugins.json"), "utf8"))

  it("stops listing the plugin, and says a restart is needed for /plugin to catch up", async () => {
    await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    const { installDir, marketplaceDir } = seedInstalled()

    const r = await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /removed OpenTrace from Claude Code's plugin list/)
    assert.match(r.stdout, /Restart Claude Code/)

    assert.equal("opentrace@opentrace" in installedPlugins().plugins, false)
    assert.equal(fs.existsSync(installDir), false)
    assert.equal(fs.existsSync(marketplaceDir), false)
  })

  it("leaves other plugins and marketplaces alone", async () => {
    seedInstalled()
    await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.ok(installedPlugins().plugins["other@somewhere"], "another plugin survives")
    const known = JSON.parse(
      fs.readFileSync(path.join(sb.home, ".claude", "plugins", "known_marketplaces.json"), "utf8"),
    ) as Record<string, unknown>
    assert.ok(known.somewhere, "another marketplace survives")
    assert.equal("opentrace" in known, false)
  })

  it("cleans the list even when the declaration is already gone", async () => {
    // The state that used to be unreachable: settings cleaned by an earlier
    // disconnect, plugin still installed.
    seedInstalled()
    const r = await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /No OpenTrace plugin declaration found/)
    assert.match(r.stdout, /removed OpenTrace from Claude Code's plugin list/)
    assert.equal("opentrace@opentrace" in installedPlugins().plugins, false)
  })

  it("no longer tells the user to run claude plugin uninstall", async () => {
    seedInstalled()
    const r = await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.doesNotMatch(r.output, /claude plugin uninstall/)
  })

  it("says nothing about the plugin list on a machine that never installed it", async () => {
    const r = await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.doesNotMatch(r.stdout, /Claude Code's plugin list/)
  })
})

describe("disconnect --all", () => {
  it("includes usage monitoring", async () => {
    sb.seedTelemetry("user", otk("usage"))
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["disconnect", sb.project, "--all", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /removed usage monitoring from/)
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
  })

  it("clears the plugin declaration and the key file too", async () => {
    await sb.run(["install", sb.project, "-y", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(fs.existsSync(sb.pluginTokenPath()), true)
    const r = await sb.run(["disconnect", sb.project, "--all", "-y"])
    assert.equal(r.code, 0)
    const user = sb.readSettings("user")
    assert.equal(user.enabledPlugins?.["opentrace@opentrace"], undefined)
    assert.equal(fs.existsSync(sb.pluginTokenPath()), false)
  })

  it("removes usage monitoring on a bare -y run too", async () => {
    // No component flags and no TTY: the default set is everything, which now
    // includes the block. Worth pinning — it is a scope change for scripts.
    sb.seedTelemetry("user", otk("usage"))
    const r = await sb.run(["disconnect", sb.project, "-y"])
    assert.equal(r.code, 0)
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
  })

  it("reports having done nothing when there is nothing to do", async () => {
    const r = await sb.run(["disconnect", sb.project, "--all", "-y"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Nothing to disconnect/)
  })
})
