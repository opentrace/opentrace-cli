import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createSandbox, hasTelemetry, telemetryToken, type Sandbox } from "../harness.js"
import { otk } from "../stub-server.js"

let sb: Sandbox
const CLI_KEY = otk("cli")

beforeEach(async () => {
  sb = await createSandbox()
})
afterEach(() => sb.cleanup())

/** `connect otk_…` targets a host with --url, not --base-url. */
const url = (): string[] => ["--url", sb.stub.url]

describe("connect otk_… (key flow)", () => {
  it("attaches the key to the Claude Code plugin, not to a bare MCP entry", async () => {
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--no-track-usage"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Connected Claude Code \(plugin\)/)

    const user = sb.readSettings("user")
    assert.equal(user.enabledPlugins?.["opentrace@opentrace"], true)
    assert.equal(
      user.pluginConfigs?.["opentrace@opentrace"]?.options?.mcp_url,
      `${sb.stub.url}/mcp/v1/`,
      "mcp_url seeded so the plugin never asks for an endpoint",
    )
    assert.equal(fs.readFileSync(sb.pluginTokenPath(), "utf8").trim(), CLI_KEY)
    // The plugin reads the token file; a header in ~/.claude.json would be a
    // second source of truth.
    assert.equal(fs.existsSync(path.join(sb.home, ".claude.json")), false)
  })

  it("never prints the key", async () => {
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--no-track-usage"])
    assert.ok(!r.output.includes(CLI_KEY), "full key leaked into output")
    assert.match(r.stdout, /otk_/) // masked form only
  })

  it("locks the key file down to the owner", async () => {
    await sb.run(["connect", CLI_KEY, ...url(), "--no-track-usage"])
    if (process.platform === "win32") return // chmod is a no-op there
    const mode = fs.statSync(sb.pluginTokenPath()).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it("refuses a rejected key and writes nothing", async () => {
    sb.stub.options.revoked.add(CLI_KEY)
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--no-track-usage"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Key rejected/)
    assert.equal(fs.existsSync(sb.pluginTokenPath()), false)
    assert.equal(sb.readSettings("user").enabledPlugins, undefined)
  })

  it("refuses a malformed key without a network call", async () => {
    const r = await sb.run(["connect", "otk_short", ...url()])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid CLI key/)
    assert.equal(sb.apiRequests().length, 0)
  })

  it("rejects an unknown --client before doing any work", async () => {
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--client", "emacs"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unknown --client/)
    assert.equal(sb.apiRequests().length, 0)
  })

  it("sets up usage monitoring with the same key", async () => {
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--track-usage", "-g"])
    assert.equal(r.code, 0)
    // "enabled", not "updated": nothing was configured before this run.
    assert.match(r.stdout, /Usage monitoring enabled/)
    const user = sb.readSettings("user")
    assert.ok(hasTelemetry(user))
    assert.equal(telemetryToken(user), sb.stub.options.mintedUsageKey)
    // Provisioned with the CLI key, which is the only credential that can.
    const provision = sb.stub.requests.find((q) => q.path === "/claude-code-usage/key")
    assert.equal(provision?.token, CLI_KEY)
  })

  it("always replaces an existing usage key, since connect brings its own CLI key", async () => {
    const previous = otk("previous-owner-usage")
    sb.seedTelemetry("user", previous)
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--track-usage", "-g"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /replacing the usage key/)
    assert.equal(telemetryToken(sb.readSettings("user")), sb.stub.options.mintedUsageKey)
  })

  it("degrades with a note when the server cannot provision usage keys", async () => {
    sb.stub.options.usageKeyUnsupported = true
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--track-usage", "-g"])
    assert.equal(r.code, 0, "the connection itself still succeeds")
    assert.match(r.output, /does not support usage-key provisioning yet/)
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
  })

  it("writes a header entry plus a bridge note for Claude Desktop", async () => {
    // Via the harness, because the app directory is platform-specific — a
    // hardcoded .config/Claude passes on Linux and tests nothing on macOS.
    sb.seedClaudeApp()
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--client", "claude-desktop", "--no-track-usage"])
    assert.equal(r.code, 0)
    const cfg = JSON.parse(fs.readFileSync(sb.claudeDesktopConfigPath(), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    assert.equal(cfg.mcpServers.opentrace.command, "npx")
    assert.ok(cfg.mcpServers.opentrace.args.includes("mcp-remote"))
    assert.match(r.output, /mcp-remote/)
  })

  it("warns that claude_desktop_config.json shadows the native mount in Code sessions", async () => {
    // Only when the Code tab is actually present on the machine.
    sb.seedClaudeCodeDesktop()
    const r = await sb.run(["connect", CLI_KEY, ...url(), "--client", "claude-desktop", "--no-track-usage"])
    assert.equal(r.code, 0)
    assert.match(r.output, /Code-tab sessions will use the npx bridge/)
  })
})

describe("connect <path> (editor onboarding)", () => {
  it("routes a path to the install flow rather than the key flow", async () => {
    const r = await sb.run(["connect", sb.project, "-y", "--cursor", ...sb.base])
    assert.equal(r.code, 0)
    assert.equal(fs.existsSync(path.join(sb.project, ".cursor", "mcp.json")), true)
  })
})
