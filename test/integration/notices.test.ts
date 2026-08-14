// The on-use banner. Its value is entirely in when it speaks and when it stays
// quiet, so that is what these pin down.

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createSandbox, type Sandbox } from "../harness.js"
import { otk } from "../stub-server.js"

let sb: Sandbox
const CLI_KEY = otk("cli")

beforeEach(async () => {
  sb = await createSandbox({ latestVersion: "99.0.0" })
})
afterEach(() => sb.cleanup())

const UPDATE = /Update available/
const CLI_REJECTED = /CLI key is no longer accepted/
const USAGE_REJECTED = /usage key in .* was rejected/

describe("update notice", () => {
  it("offers a genuinely newer release", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.match(r.stderr, UPDATE)
    assert.match(r.stderr, /npm install -g @opentrace\/cli@latest/)
  })

  it("writes to stderr, never into stdout", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.doesNotMatch(r.stdout, UPDATE)
  })

  it("stays quiet when the published version is not newer", async () => {
    sb.stub.options.latestVersion = "0.0.1"
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.doesNotMatch(r.stderr, UPDATE)
  })

  it("caches the lookup, so a second run makes no registry call", async () => {
    await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    const before = sb.stub.requests.filter((q) => q.path.endsWith("/latest")).length
    assert.equal(before, 1)
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.match(r.stderr, UPDATE, "still reported, from cache")
    assert.equal(sb.stub.requests.filter((q) => q.path.endsWith("/latest")).length, 1)
  })

  it("says nothing when the registry cannot be reached", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], {
      env: { OTX_REGISTRY_URL: "http://127.0.0.1:1" },
    })
    assert.equal(r.code, 0)
    assert.doesNotMatch(r.stderr, UPDATE)
  })
})

describe("key notices", () => {
  it("reports a rejected CLI key on a command that does not check one itself", async (t) => {
    // Must come from the keychain: it is endpoint-scoped, so it is the only
    // store that can describe a non-default endpoint (see the test below).
    //
    // Which makes this one unrunnable on macOS: a generic-password item's ACL is
    // scoped to the process that created it, so the CLI child cannot read what
    // this test wrote — the notice would be absent for a reason that says nothing
    // about the code. On Linux CI there is no Secret Service at all and the seed
    // reports that itself.
    if (process.platform === "darwin") {
      return t.skip("macOS scopes keychain items to the creating process, so a child cannot read them")
    }
    if (!sb.seedKeychainKey(CLI_KEY)) return t.skip("no OS keychain backend on this machine")
    sb.stub.options.revoked.add(CLI_KEY)
    // The one child that must consult the real keychain, so it opts back in.
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], { env: { OTX_NO_KEYCHAIN: "" } })
    assert.match(r.stderr, CLI_REJECTED)
    assert.match(r.stderr, /otx login/)
  })

  it("does not judge a non-default endpoint by the plugin's token file", async () => {
    // The token file holds whatever key was attached last, with no record of
    // which deployment it belongs to. Probing it against another host would
    // report "your key was rejected" about a key that was never for this host.
    sb.stub.options.revoked.add(CLI_KEY)
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.doesNotMatch(r.stderr, CLI_REJECTED)
  })

  it("stays quiet about the CLI key on install, which reports it inline instead", async () => {
    sb.stub.options.revoked.add(CLI_KEY)
    sb.seedPluginToken(CLI_KEY)
    const r = await sb.run(["install", sb.project, "-y", "--claude-code", ...sb.base])
    assert.doesNotMatch(r.stderr, CLI_REJECTED)
    // Not silence — the command says it, with a better next step.
    assert.match(r.output, /was rejected/)
  })

  it("reports a rejected usage key", async () => {
    const usage = otk("dead-usage")
    sb.stub.options.revoked.add(usage)
    sb.seedTelemetry("user", usage)
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.match(r.stderr, USAGE_REJECTED)
  })

  it("prefers the project block over the user one, since the project copy wins", async () => {
    // A valid user key must not mask a rejected project key: the project copy is
    // the one Claude Code actually sends.
    const projectKey = otk("project-usage")
    sb.stub.options.revoked.add(projectKey)
    sb.seedTelemetry("user", otk("user-usage"))
    sb.seedTelemetry("project", projectKey)
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], { cwd: sb.project })
    assert.match(r.stderr, USAGE_REJECTED)
    assert.match(r.stderr, /project/)
  })

  it("ignores a shadowed user key that is rejected", async () => {
    const userKey = otk("user-usage")
    sb.stub.options.revoked.add(userKey)
    sb.seedTelemetry("user", userKey)
    sb.seedTelemetry("project", otk("project-usage")) // valid, and takes precedence
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], { cwd: sb.project })
    assert.doesNotMatch(r.stderr, USAGE_REJECTED)
  })

  it("says nothing about keys that are not there", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.doesNotMatch(r.stderr, CLI_REJECTED)
    assert.doesNotMatch(r.stderr, USAGE_REJECTED)
  })

  it("does not condemn a key just because the host is unreachable", async () => {
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", otk("usage"), { endpointHost: "http://127.0.0.1:1" })
    const r = await sb.run(["add-mcp", sb.project, "-y", "--base-url", "http://127.0.0.1:1"])
    assert.doesNotMatch(r.stderr, CLI_REJECTED)
    assert.doesNotMatch(r.stderr, USAGE_REJECTED)
  })

  it("drops a stale verdict once the key it described is replaced", async () => {
    const dead = otk("dead-usage")
    sb.stub.options.revoked.add(dead)
    sb.seedTelemetry("user", dead)
    const first = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.match(first.stderr, USAGE_REJECTED)

    // Same file, new key, unreachable host: the cached "rejected" verdict must
    // not be applied to a key it was never about.
    sb.seedTelemetry("user", otk("fresh-usage"), { endpointHost: "http://127.0.0.1:1" })
    const second = await sb.run(["add-mcp", sb.project, "-y", "--base-url", "http://127.0.0.1:1"])
    assert.doesNotMatch(second.stderr, USAGE_REJECTED)
  })

  it("stays quiet entirely on disconnect", async () => {
    sb.stub.options.revoked.add(CLI_KEY)
    sb.seedPluginToken(CLI_KEY)
    sb.seedTelemetry("user", CLI_KEY)
    const r = await sb.run(["disconnect", sb.project, "--plugin", "-y"])
    assert.doesNotMatch(r.stderr, CLI_REJECTED)
    assert.doesNotMatch(r.stderr, USAGE_REJECTED)
  })
})

describe("suppression", () => {
  for (const flag of ["OTX_NO_NOTICES", "NO_UPDATE_NOTIFIER", "CI"]) {
    it(`is silent when ${flag} is set, even forced`, async () => {
      const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], {
        env: { [flag]: "1", OTX_FORCE_NOTICES: "1" },
      })
      assert.doesNotMatch(r.stderr, UPDATE)
    })
  }

  it("is silent without a TTY when not forced", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base], { env: { OTX_FORCE_NOTICES: "" } })
    assert.doesNotMatch(r.stderr, UPDATE)
  })

  it("never runs for --version or --help, which perform no action", async () => {
    for (const args of [["--version"], ["--help"], ["help", "install"]]) {
      const r = await sb.run(args)
      assert.doesNotMatch(r.stderr, UPDATE, `${args.join(" ")} printed a banner`)
    }
    assert.equal(sb.stub.requests.length, 0, "not even a version lookup")
  })
})
