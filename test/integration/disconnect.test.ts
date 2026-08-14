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
