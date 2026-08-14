import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  hasTelemetryEnv,
  isOpenTraceTelemetryBlock,
  readTelemetryToken,
  removeTelemetryEnv,
  TELEMETRY_ENV_KEYS,
  telemetryEnv,
  writeTelemetryEnv,
} from "../../src/util/telemetry.js"
import { otk } from "../stub-server.js"

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "otx-telemetry-"))
  file = path.join(dir, "settings.json")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (value: unknown): void =>
  fs.writeFileSync(file, JSON.stringify(value, null, 4), "utf8")
const read = (): Record<string, any> => JSON.parse(fs.readFileSync(file, "utf8"))

describe("telemetryEnv", () => {
  it("writes exactly the keys disconnect is allowed to delete", () => {
    // Drift here is how a key gets written but never cleaned up.
    const written = Object.keys(telemetryEnv("https://h.test", otk("k"))).sort()
    assert.deepEqual(written, [...TELEMETRY_ENV_KEYS].sort())
  })

  it("carries the key as a bearer header and the endpoint from the host", () => {
    const env = telemetryEnv("https://h.test", otk("k"))
    assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${otk("k")}`)
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://h.test/ingest/claude-code")
  })
})

describe("writeTelemetryEnv", () => {
  it("preserves unrelated settings and unrelated env vars", () => {
    write({ alwaysThinkingEnabled: true, env: { MY_VAR: "keep" } })
    const { existed } = writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("k")))
    assert.equal(existed, false)
    const after = read()
    assert.equal(after.alwaysThinkingEnabled, true)
    assert.equal(after.env.MY_VAR, "keep")
    assert.equal(after.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  })

  it("reports a replacement, so a summary can say updated rather than added", () => {
    write({ env: telemetryEnv("https://h.test", otk("old")) })
    const { existed } = writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("new")))
    assert.equal(existed, true)
    assert.equal(readTelemetryToken(file), otk("new"))
  })
})

describe("readTelemetryToken", () => {
  it("finds the key in the bearer header", () => {
    write({ env: telemetryEnv("https://h.test", otk("usage")) })
    assert.equal(readTelemetryToken(file), otk("usage"))
  })

  it("ignores a header carrying something that is not an OpenTrace key", () => {
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer corp-token" } })
    assert.equal(readTelemetryToken(file), undefined)
    // Still "configured", just not with a key we can verify.
    assert.equal(hasTelemetryEnv(file), true)
  })

  it("returns undefined for an absent file", () => {
    assert.equal(readTelemetryToken(path.join(dir, "nope.json")), undefined)
  })
})

describe("isOpenTraceTelemetryBlock", () => {
  it("recognises ours by the ingest endpoint", () => {
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://h.test/ingest/claude-code" } })
    assert.equal(isOpenTraceTelemetryBlock(file), true)
  })

  it("recognises ours by the key, even pointed elsewhere", () => {
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${otk("k")}` } })
    assert.equal(isOpenTraceTelemetryBlock(file), true)
  })

  it("does not claim someone else's collector", () => {
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.corp.internal:4318" } })
    assert.equal(isOpenTraceTelemetryBlock(file), false)
  })
})

describe("removeTelemetryEnv", () => {
  it("deletes only our keys", () => {
    write({
      alwaysThinkingEnabled: true,
      env: { ...telemetryEnv("https://h.test", otk("k")), MY_VAR: "keep" },
    })
    assert.deepEqual(removeTelemetryEnv(file), { removed: true, foreign: false })
    const after = read()
    assert.deepEqual(Object.keys(after.env), ["MY_VAR"])
    assert.equal(after.alwaysThinkingEnabled, true)
  })

  it("drops env entirely when nothing else was in it", () => {
    write({ tui: { x: 1 }, env: telemetryEnv("https://h.test", otk("k")) })
    removeTelemetryEnv(file)
    const after = read()
    assert.equal("env" in after, false)
    assert.deepEqual(after.tui, { x: 1 })
  })

  it("refuses a foreign block and says so", () => {
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.corp.internal:4318" } })
    assert.deepEqual(removeTelemetryEnv(file), { removed: false, foreign: true })
    assert.equal(hasTelemetryEnv(file), true)
  })

  it("is a no-op on a file with no block, and on no file at all", () => {
    write({ tui: { x: 1 } })
    assert.deepEqual(removeTelemetryEnv(file), { removed: false, foreign: false })
    assert.deepEqual(removeTelemetryEnv(path.join(dir, "nope.json")), { removed: false, foreign: false })
  })

  it("is idempotent", () => {
    write({ env: telemetryEnv("https://h.test", otk("k")) })
    assert.equal(removeTelemetryEnv(file).removed, true)
    assert.equal(removeTelemetryEnv(file).removed, false)
  })
})
