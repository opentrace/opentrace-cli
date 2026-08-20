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

describe("install --express", () => {
  it("announces every decision before acting", async () => {
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "--express", "-y", ...sb.base])
    assert.equal(r.code, 0)
    // A mode that asks nothing must still say what it is about to do.
    assert.match(r.stdout, /Express setup:/)
    assert.match(r.stdout, /Tools:\s+Claude Code/)
    assert.match(r.stdout, /Scope:\s+all projects/)
    assert.match(r.stdout, /monitoring your Claude Code usage/)
    assert.match(r.stdout, /Counts, not content/)
  })

  it("sets up every detected surface at user scope with monitoring on", async () => {
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "--express", "-y", ...sb.base])
    assert.equal(r.code, 0)
    const user = sb.readSettings("user")
    assert.equal(user.enabledPlugins?.["opentrace@opentrace"], true)
    assert.ok(user.extraKnownMarketplaces?.opentrace, "marketplace declared")
    assert.ok(hasTelemetry(user), "telemetry block written at user scope")
    assert.equal(telemetryToken(user), sb.stub.options.mintedUsageKey)
    // Express means all projects: nothing project-scoped.
    assert.equal(fs.existsSync(path.join(sb.project, ".claude", "settings.json")), false)
  })

  it("announces the chat surface it is about to connect", async () => {
    // Express cannot add an account-level connector on the user's behalf, so it
    // announces the link it is going to print rather than promising a write.
    sb.seedClaudeApp()
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "--express", "-y", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Desktop:\s+a link to connect the Claude app's chat surface/)
    assert.match(r.output, /add-custom-connector/)
  })

  it("describes the flagged tools, not the detected ones", async () => {
    // `--express --cursor` sets up Cursor; the plan used to name every detected
    // tool, promise usage monitoring and announce the Claude app — none of which
    // that run goes on to do.
    sb.seedClaudeApp()
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "--express", "-y", "--cursor", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Tools:\s+Cursor$/m)
    assert.doesNotMatch(r.stdout, /Desktop:/)
    assert.doesNotMatch(r.stdout, /monitoring your Claude Code usage/)
    assert.equal(fs.existsSync(sb.claudeDesktopConfigPath()), false)
  })

  it("honours an explicit --no-track-usage instead of overriding it", async () => {
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "--express", "-y", "--no-track-usage", ...sb.base])
    assert.equal(r.code, 0)
    // Neither claimed in the plan…
    assert.doesNotMatch(r.stdout, /monitoring your Claude Code usage/)
    // …nor done.
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
    assert.equal(
      sb.stub.requests.some((q) => q.path === "/claude-code-usage/key"),
      false,
      "no usage key provisioned",
    )
  })

  it("promises only the sign-in it can perform", async () => {
    // No browser in a non-interactive run, so it must not claim one.
    const r = await sb.run(["install", sb.project, "--express", "-y", ...sb.base])
    assert.match(r.stdout, /Sign-in: a key already on this machine/)
    assert.doesNotMatch(r.stdout, /Sign-in: your browser/)
  })

  it("names the supplied key as the sign-in when one is given", async () => {
    const r = await sb.run(["install", sb.project, "--express", "-y", "--api-key", CLI_KEY, ...sb.base])
    assert.match(r.stdout, /Sign-in: the CLI key given on the command line/)
  })

  it("falls back to Custom when nothing is detected", async () => {
    // A home with no tool directories at all.
    fs.rmSync(path.join(sb.home, ".claude"), { recursive: true, force: true })
    const r = await sb.run(["install", sb.project, "--express", "-y", ...sb.base])
    assert.match(r.stdout, /No supported AI tools detected/)
  })
})

describe("install (flag-driven)", () => {
  it("writes a project .mcp.json for a non-plugin tool", async () => {
    const r = await sb.run(["install", sb.project, "-y", "--cursor", ...sb.base])
    assert.equal(r.code, 0)
    const cursor = JSON.parse(
      fs.readFileSync(path.join(sb.project, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { url: string }> }
    assert.equal(cursor.mcpServers.opentrace.url, `${sb.stub.url}/mcp/v1/`)
  })

  it("refuses --track-usage when Claude Code is not a target, with a note", async () => {
    const r = await sb.run(["install", sb.project, "-y", "--cursor", "--track-usage", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /--track-usage has no effect here/)
    assert.equal(hasTelemetry(sb.readSettings("user")), false)
  })

  it("rejects a malformed --api-key before touching anything", async () => {
    const r = await sb.run(["install", sb.project, "-y", "--api-key", "otk_short", ...sb.base])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid --api-key/)
    assert.equal(sb.apiRequests().length, 0, "no API call made")
  })

  it("fails loudly when the supplied key is rejected, writing nothing", async () => {
    const bad = otk("revoked")
    sb.stub.options.revoked.add(bad)
    const r = await sb.run(["install", sb.project, "-y", "--api-key", bad, ...sb.base])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Key rejected/)
    assert.equal(fs.existsSync(path.join(sb.project, ".mcp.json")), false)
  })

  it("exits cleanly when the directory does not exist", async () => {
    const r = await sb.run(["install", path.join(sb.home, "nope"), "-y", ...sb.base])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Directory not found/)
  })
})

describe("install finishes the plugin install", () => {
  // Writing enabledPlugins only *asks* for the plugin — Claude Code installs it
  // when it next prompts. A terminal shows that prompt; the desktop app does not,
  // so onboarding used to end with nothing in /plugin and no way to tell.
  const installedPlugins = (): any =>
    JSON.parse(fs.readFileSync(path.join(sb.home, ".claude", "plugins", "installed_plugins.json"), "utf8"))

  it("installs the plugin, not just the declaration", async () => {
    const PATH = sb.seedClaudeBinary()
    const r = await sb.run(
      ["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base],
      { env: { PATH } },
    )
    assert.equal(r.code, 0)
    assert.equal(sb.readSettings("user").enabledPlugins?.["opentrace@opentrace"], true, "declared")
    assert.ok(installedPlugins().plugins["opentrace@opentrace"], "and actually installed")
    assert.match(r.stdout, /plugin install/)
  })

  it("says what to run when there is no claude executable to do it with", async () => {
    // An empty PATH: nothing to shell out to, and no bundled app engine either.
    const r = await sb.run(
      ["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base],
      { env: { PATH: path.join(sb.home, "nothing-here") } },
    )
    assert.equal(r.code, 0, "still succeeds — the declaration is written")
    assert.match(r.output, /claude plugin install opentrace@opentrace/)
  })

  it("does not re-install one that is already there", async () => {
    const PATH = sb.seedClaudeBinary()
    await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base], { env: { PATH } })
    const second = await sb.run(
      ["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base],
      { env: { PATH } },
    )
    assert.equal(second.code, 0)
    assert.doesNotMatch(second.stdout, /plugin install/)
  })
})

describe("install and the Claude desktop app", () => {
  // The Code tab needs nothing — it shares ~/.claude with the CLI, where the
  // plugin is already installed. The chat surface (and claude.ai, and mobile) takes
  // account-level connectors, which no local command can add on the user's behalf,
  // so otx hands over the prefilled link and writes nothing.
  it("prints the connector link when the app is installed, and writes nothing", async () => {
    sb.seedClaudeApp() // the Code tab has never run
    const r = await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /account-level connectors, not local config/)
    assert.match(r.output, /claude\.ai\/customize\/connectors\?modal=add-custom-connector/)
    assert.equal(
      fs.existsSync(sb.claudeDesktopConfigPath()),
      false,
      "the chat surface is not a file we write",
    )
  })

  it("never writes the key into an npx argument", async () => {
    // Why the bridge went: `npx -y mcp-remote <url> --header "Authorization:
    // Bearer otk_…"` exposed the key to any local process via ps or /proc.
    sb.seedClaudeApp()
    const r = await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(r.code, 0)
    assert.doesNotMatch(r.output, /mcp-remote/)
    assert.doesNotMatch(r.output, new RegExp(CLI_KEY))
  })

  it("removes a bridge left by an older otx, and says why", async () => {
    // Migration: that entry is a live stdio server still holding a key, so it goes
    // rather than sitting beside the connector we now recommend.
    sb.seedClaudeApp()
    fs.mkdirSync(sb.claudeAppDir(), { recursive: true })
    fs.writeFileSync(
      sb.claudeDesktopConfigPath(),
      JSON.stringify({
        coworkUserFilesPath: "/keep/me",
        mcpServers: {
          opentrace: { command: "npx", args: ["-y", "mcp-remote", "https://old.test/mcp/v1/", "--header", `Authorization: Bearer ${CLI_KEY}`] },
          somethingElse: { command: "node", args: ["other.js"] },
        },
      }),
    )
    const r = await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /Removed the old .?mcp-remote.? bridge/)
    const cfg = JSON.parse(fs.readFileSync(sb.claudeDesktopConfigPath(), "utf8")) as Record<string, any>
    assert.equal(cfg.mcpServers?.opentrace, undefined, "our entry is gone")
    // It doubles as the app's preferences store, so everything else stays put.
    assert.equal(cfg.coworkUserFilesPath, "/keep/me")
    assert.ok(cfg.mcpServers?.somethingElse, "another server's entry is not ours to remove")
  })

  it("writes nothing extra on a machine without the desktop app", async () => {
    const r = await sb.run(["install", sb.project, "-y", "-g", "--claude-code", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(r.code, 0)
    assert.doesNotMatch(r.output, /add-custom-connector/)
    assert.equal(fs.existsSync(sb.claudeDesktopConfigPath()), false)
  })

  it("does not mention the app when another tool was the one named", async () => {
    // `--cursor` on a machine that happens to have the Claude app is not a
    // request to configure the Claude app.
    sb.seedClaudeApp()
    const r = await sb.run(["install", sb.project, "-y", "-g", "--cursor", "--api-key", CLI_KEY, ...sb.base])
    assert.equal(r.code, 0)
    assert.doesNotMatch(r.output, /add-custom-connector/)
    assert.equal(fs.existsSync(sb.claudeDesktopConfigPath()), false)
  })
})

describe("install usage-key lifecycle", () => {
  it("keeps a valid usage key when the CLI key came from local storage", async () => {
    const usage = otk("existing-usage")
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", "--track-usage", "-g", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /is still valid — keeping it/)
    assert.equal(telemetryToken(sb.readSettings("user")), usage)
    assert.equal(sb.stub.requests.some((q) => q.path === "/claude-code-usage/key"), false)
  })

  it("replaces a valid usage key when the run brought its own CLI key", async () => {
    const usage = otk("existing-usage")
    sb.seedTelemetry("user", usage)
    const r = await sb.run([
      "install", sb.project, "-y", "--claude-code", "--track-usage", "-g",
      "--api-key", CLI_KEY, ...sb.base,
    ])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /replacing the usage key/)
    assert.equal(telemetryToken(sb.readSettings("user")), sb.stub.options.mintedUsageKey)
  })

  it("replaces a rejected usage key", async () => {
    const usage = otk("dead-usage")
    sb.stub.options.revoked.add(usage)
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", "--track-usage", "-g", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /rejected/)
    assert.equal(telemetryToken(sb.readSettings("user")), sb.stub.options.mintedUsageKey)
  })

  it("reports a rejected usage key even when the run declines monitoring", async () => {
    // The gap this closes: the check used to happen only when opting in, so a
    // revoked key stayed silently revoked.
    const usage = otk("dead-usage")
    sb.stub.options.revoked.add(usage)
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", "--no-track-usage", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /usage key in .* was rejected/)
    assert.match(r.output, /otx disconnect --usage/)
    // Declining means declining: the block is reported, not rewritten.
    assert.equal(telemetryToken(sb.readSettings("user")), usage)
  })

  it("refreshes an existing block in place instead of writing a second one", async () => {
    // Run defaults to project scope; the block lives at user scope. One block.
    const usage = otk("existing-usage")
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", "--track-usage", ...sb.base])
    assert.equal(r.code, 0)
    assert.equal(hasTelemetry(sb.readSettings("user")), true)
    assert.equal(hasTelemetry(sb.readSettings("project")), false, "no duplicate block")
  })

  it("leaves the existing block alone when provisioning fails", async () => {
    const usage = otk("existing-usage")
    sb.stub.options.revoked.add(usage)
    sb.stub.options.usageKeyUnsupported = true // server too old
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", "--track-usage", "-g", ...sb.base])
    assert.equal(r.code, 0)
    assert.match(r.output, /does not support usage-key provisioning yet/)
    // Never destroy what you cannot replace.
    assert.equal(telemetryToken(sb.readSettings("user")), usage)
  })
})
