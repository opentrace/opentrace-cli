import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createSandbox, type Sandbox } from "../harness.js"

let sb: Sandbox

beforeEach(async () => {
  sb = await createSandbox({ latestVersion: "0.0.1" })
})
afterEach(() => sb.cleanup())

const readMcp = (): { mcpServers: Record<string, { type: string; url: string }> } =>
  JSON.parse(fs.readFileSync(path.join(sb.project, ".mcp.json"), "utf8"))

describe("add-mcp", () => {
  it("writes just the MCP entry — no plugin, no key", async () => {
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.equal(r.code, 0)
    assert.equal(readMcp().mcpServers.opentrace.url, `${sb.stub.url}/mcp/v1/`)
    assert.equal(readMcp().mcpServers.opentrace.type, "http")
    assert.equal(sb.readSettings("user").enabledPlugins, undefined)
    assert.equal(fs.existsSync(sb.pluginTokenPath()), false)
  })

  it("preserves other servers in an existing .mcp.json", async () => {
    fs.writeFileSync(
      path.join(sb.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.test/" } } }, null, 2),
    )
    await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    const config = readMcp()
    assert.equal(config.mcpServers.other.url, "https://other.test/")
    assert.ok(config.mcpServers.opentrace)
  })

  it("is idempotent", async () => {
    await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    const first = fs.readFileSync(path.join(sb.project, ".mcp.json"), "utf8")
    await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.equal(fs.readFileSync(path.join(sb.project, ".mcp.json"), "utf8"), first)
  })

  it("reads a .mcp.json with comments and trailing commas", async () => {
    // Editor config files are routinely JSONC; failing on one would be a hard
    // stop on a file the user considers valid.
    fs.writeFileSync(
      path.join(sb.project, ".mcp.json"),
      '{\n  // kept\n  "mcpServers": {\n    "other": { "type": "http", "url": "https://other.test/" },\n  },\n}\n',
    )
    const r = await sb.run(["add-mcp", sb.project, "-y", ...sb.base])
    assert.equal(r.code, 0)
    assert.ok(readMcp().mcpServers.other)
    assert.ok(readMcp().mcpServers.opentrace)
  })
})
