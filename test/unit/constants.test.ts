import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildAuthServerMetadataUrl,
  buildCliKeyUrl,
  buildIngestUrl,
  buildMcpUrl,
  buildTelemetryKeyUrl,
  normalizeMcpUrl,
  pluginId,
  toBaseUrl,
} from "../../src/util/constants.js"

describe("endpoint derivation", () => {
  const host = "https://api.example.test"

  it("derives every endpoint from one host", () => {
    // The point of a single --url: move the host and everything moves with it.
    assert.equal(buildMcpUrl(host), `${host}/mcp/v1/`)
    assert.equal(buildIngestUrl(host), `${host}/ingest/claude-code`)
    assert.equal(buildTelemetryKeyUrl(host), `${host}/claude-code-usage/key`)
    assert.equal(buildCliKeyUrl(host), `${host}/cli/key`)
  })

  it("stops the ingest URL at the mount, because the exporter appends the signal", () => {
    assert.ok(!buildIngestUrl(host).endsWith("/v1/logs"))
    assert.ok(!buildIngestUrl(host).endsWith("/"))
  })

  it("puts the well-known segment between host and issuer path", () => {
    assert.equal(
      buildAuthServerMetadataUrl(host),
      `${host}/.well-known/oauth-authorization-server/oauth`,
    )
  })
})

describe("normalizeMcpUrl", () => {
  it("accepts a bare host", () => {
    assert.equal(normalizeMcpUrl("https://api.example.test"), "https://api.example.test/mcp/v1/")
  })

  it("accepts a URL already pointing at the mount, without doubling it", () => {
    assert.equal(normalizeMcpUrl("https://api.example.test/mcp/v1"), "https://api.example.test/mcp/v1/")
    assert.equal(normalizeMcpUrl("https://api.example.test/mcp/v1/"), "https://api.example.test/mcp/v1/")
  })

  it("tolerates trailing slashes and surrounding whitespace", () => {
    assert.equal(normalizeMcpUrl("  https://api.example.test///  "), "https://api.example.test/mcp/v1/")
  })
})

describe("toBaseUrl", () => {
  it("reduces either form to the host base", () => {
    assert.equal(toBaseUrl("https://api.example.test/mcp/v1"), "https://api.example.test")
    assert.equal(toBaseUrl("https://api.example.test/"), "https://api.example.test")
    assert.equal(toBaseUrl("https://api.example.test"), "https://api.example.test")
  })

  it("round-trips with normalizeMcpUrl", () => {
    const host = "https://api.example.test"
    assert.equal(toBaseUrl(normalizeMcpUrl(host)), host)
  })
})

describe("pluginId", () => {
  it("is plugin@marketplace, the form Claude Code keys enabledPlugins by", () => {
    assert.equal(pluginId(), "opentrace@opentrace")
    assert.equal(pluginId("p", "m"), "p@m")
  })
})
