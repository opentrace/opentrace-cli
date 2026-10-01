import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  LEGACY_TELEMETRY_ENV_KEYS,
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
let home: string
let realHome: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "otx-telemetry-"))
  file = path.join(dir, "settings.json")
  // writeTelemetryEnv lands the key in ~/.claude/opentrace-plugin.token. Unsandboxed, that
  // is the developer's own credential file, and running the suite would overwrite it.
  home = path.join(dir, "home")
  fs.mkdirSync(home, { recursive: true })
  realHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (value: unknown): void =>
  fs.writeFileSync(file, JSON.stringify(value, null, 4), "utf8")
const read = (): Record<string, any> => JSON.parse(fs.readFileSync(file, "utf8"))

describe("telemetryEnv", () => {
  it("writes only keys disconnect is allowed to delete", () => {
    // Drift here is how a key gets written but never cleaned up. The removal list is the
    // wider of the two on purpose: it must still carry keys this CLI has stopped writing,
    // so that files earlier builds wrote are cleaned up too.
    const written = Object.keys(telemetryEnv("https://h.test", otk("k")))
    for (const key of written) assert.ok(TELEMETRY_ENV_KEYS.includes(key as never), key)
  })

  it("still removes the key earlier builds wrote into the env block", () => {
    // Dropped from telemetryEnv because every subprocess inherits env, but a settings file
    // written before that change still has one, and disconnect has to take it out.
    assert.ok(TELEMETRY_ENV_KEYS.includes("OPENTRACE_TELEMETRY_API_KEY"))
    assert.equal(telemetryEnv("https://h.test", otk("k")).OPENTRACE_TELEMETRY_API_KEY, undefined)
  })

  it("turns on the repository attribute, which per-repository cost depends on", () => {
    // Off by default upstream. Without it Claude Code sends no repository on its events at
    // all, and spend reaches a repository only by matching it to commits in time — the
    // guess the whole attribution rebuild exists to replace. A user who runs the CLI has
    // asked for this to work.
    assert.equal(telemetryEnv("https://h.test", otk("k")).OTEL_METRICS_INCLUDE_REPOSITORY, "true")
  })

  it("configures the plugin's own endpoint, which it cannot read from the OTLP block", () => {
    // **Claude Code strips OTEL_* from hook subprocesses.** Verified directly: put both in
    // one settings `env` block and a hook sees `OPENTRACE_API_URL` and not
    // `OTEL_EXPORTER_OTLP_ENDPOINT`. So the plugin cannot derive the destination from the
    // exporter, and without this it falls back to the public host — which means a
    // self-hosted install reports its repositories and branches to the wrong place.
    const env = telemetryEnv("https://h.test", otk("k"))
    assert.equal(env.OPENTRACE_API_URL, "https://h.test")
  })

  it("keeps the key out of the env block, which every subprocess inherits", () => {
    // The same stripping that forces OPENTRACE_API_URL to exist is what contains the key:
    // inside OTEL_EXPORTER_OTLP_HEADERS it reaches Claude Code's exporter and nothing else.
    // An OPENTRACE_* name is passed through instead — to every hook, every Bash tool call
    // and every MCP server the session starts, readable with a bare `env`. The hooks read
    // it from ~/.claude/opentrace-plugin.token at 0600 instead.
    const env = telemetryEnv("https://h.test", otk("k"))
    assert.equal(env.OPENTRACE_TELEMETRY_API_KEY, undefined)
    assert.ok(!Object.values(env).some((value) => value === otk("k")))
  })

  it("carries the key as a bearer header and the endpoint from the host", () => {
    const env = telemetryEnv("https://h.test", otk("k"))
    assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${otk("k")}`)
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://h.test/ingest/claude-code")
  })
})

describe("writeTelemetryEnv", () => {
  const tokenFile = (name: string): string => path.join(home, ".claude", name)

  it("writes the ingest key to its own file, never the MCP's", () => {
    // `attachPluginKey` owns opentrace-plugin.token and puts a graph-reading CLI key there.
    // This is a usage key that deliberately cannot read anything. Sharing one path made the
    // outcome depend on which command wrote last: `install` left the usage key where the
    // MCP looks and broke it outright, `connect` left the CLI key where the hooks look and
    // posted a graph-reading credential on every prompt.
    writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("k")), otk("k"))

    assert.equal(fs.readFileSync(tokenFile("opentrace-telemetry.token"), "utf8").trim(), otk("k"))
    assert.equal(fs.existsSync(tokenFile("opentrace-plugin.token")), false)
  })

  it("leaves the MCP's token file alone when one already exists", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(tokenFile("opentrace-plugin.token"), `${otk("mcp")}\n`)

    writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("usage")), otk("usage"))

    assert.equal(fs.readFileSync(tokenFile("opentrace-plugin.token"), "utf8").trim(), otk("mcp"))
  })

  it("creates the token file private, not world-readable then narrowed", () => {
    writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("k")), otk("k"))

    assert.equal(fs.statSync(tokenFile("opentrace-telemetry.token")).mode & 0o777, 0o600)
  })

  it("strips a key an earlier build left in the env block", () => {
    // Settings are MERGED, so omitting the key preserves whatever is already under it — the
    // credential this build moved out of `env` would sit in every existing file for ever,
    // and the move would only protect machines that had never been set up.
    write({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OPENTRACE_TELEMETRY_API_KEY: otk("old"), KEEP: "yes" } })

    writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("new")), otk("new"))

    const after = read()
    for (const key of LEGACY_TELEMETRY_ENV_KEYS) assert.equal(key in after.env, false, key)
    assert.equal(after.env.KEEP, "yes", "unrelated env vars still survive")
  })


  it("preserves unrelated settings and unrelated env vars", () => {
    write({ alwaysThinkingEnabled: true, env: { MY_VAR: "keep" } })
    const { existed } = writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("k")), otk("k"))
    assert.equal(existed, false)
    const after = read()
    assert.equal(after.alwaysThinkingEnabled, true)
    assert.equal(after.env.MY_VAR, "keep")
    assert.equal(after.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  })

  it("reports a replacement, so a summary can say updated rather than added", () => {
    write({ env: telemetryEnv("https://h.test", otk("old")) })
    const { existed } = writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("new")), otk("new"))
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
  it("clears the ingest key file, and leaves the MCP's", () => {
    // The key no longer lives in the block, so clearing the block alone would leave the
    // hooks authenticated and still reporting after monitoring was turned off.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "opentrace-plugin.token"), `${otk("mcp")}\n`)
    writeTelemetryEnv(file, telemetryEnv("https://h.test", otk("k")), otk("k"))

    removeTelemetryEnv(file)

    assert.equal(fs.existsSync(path.join(home, ".claude", "opentrace-telemetry.token")), false)
    assert.equal(
      fs.readFileSync(path.join(home, ".claude", "opentrace-plugin.token"), "utf8").trim(),
      otk("mcp"),
      "disconnecting monitoring must not log the MCP out",
    )
  })


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
