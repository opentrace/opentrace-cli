// A hermetic place to run otx.
//
// Everything the CLI writes is derived from `os.homedir()` (34 call sites) or
// from the host it was given, so a temp HOME plus a stub server accounts for
// nearly all of it. Two things escape that and need naming explicitly:
//
//   • the OS keychain, which is machine-wide — namespaced per run via
//     OTX_KEYCHAIN_SERVICE so a test can never read, overwrite or delete the
//     real user's entries;
//   • the npm registry, redirected with OTX_REGISTRY_URL.
//
// The child also gets OTX_FORCE_NOTICES, because the banner is suppressed
// without a TTY and a piped child process has none; and CI / OTX_NO_NOTICES /
// NO_UPDATE_NOTIFIER are stripped, since a CI runner sets CI=true and would
// otherwise silence the very output some tests assert on.

import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { startStub, type Stub, type StubOptions, type StubRequest } from "./stub-server.js"

// The keyring binding is loaded lazily and defensively: a machine with no
// keychain backend must skip those tests, not fail to import.
const require = createRequire(import.meta.url)

/** The built CLI. Integration tests exercise the real entry point, not imports. */
const CLI_ENTRY = new URL("../../dist/index.js", import.meta.url).pathname

/** Everything the OpenTrace API serves — as opposed to the registry lookup. */
const API_PATH_PREFIXES = ["/mcp/v1", "/claude-code-usage/", "/ingest/", "/.well-known/", "/cli/"]

/**
 * Long enough for any real command against a local stub (the slowest legitimate
 * path is a probe with a 3s deadline), short enough that a hang is a failing test
 * rather than a stalled CI job.
 */
const CHILD_TIMEOUT_MS = 20_000

/** Where Windows keeps roaming app data inside a sandbox. */
const appDataFor = (home: string): string => path.join(home, "AppData", "Roaming")

/**
 * The Claude desktop app's config directory inside a sandbox home. Mirrors
 * claudeAppDir() in src/util/claude-app.ts, which cannot be reused directly: it
 * resolves against this process's own HOME, not the sandbox's. Tests must build
 * these paths through here rather than hardcoding `.config/Claude`, which is
 * Linux-only and silently tests nothing on macOS.
 */
function claudeAppDirFor(home: string): string {
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude")
    case "win32":
      return path.join(appDataFor(home), "Claude")
    default:
      return path.join(home, ".config", "Claude")
  }
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** Both streams interleaved by arrival — for assertions that don't care which. */
  output: string
}

export interface Sandbox {
  /** The temp HOME every config write lands under. */
  home: string
  /** A project directory to pass as the target path. */
  project: string
  stub: Stub
  /** `--base-url <stub>`, spread into args so tests stay readable. */
  base: string[]
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<RunResult>
  /**
   * Requests to the OpenTrace API only. The notice banner looks up the latest
   * version on virtually every command, so `stub.requests` is never empty and
   * "did this command talk to the API?" has to exclude that. Matched by what the
   * API *is* rather than by excluding what it isn't, so a route added to the stub
   * later cannot quietly start counting as an API call.
   */
  apiRequests(): StubRequest[]
  /** Path of the Claude settings file at the given scope. */
  settingsPath(scope: "user" | "project"): string
  readSettings(scope: "user" | "project"): Record<string, any>
  writeSettings(scope: "user" | "project", settings: Record<string, unknown>): void
  /** Put a telemetry env block on file, as a previous run would have left it. */
  seedTelemetry(scope: "user" | "project", token: string, opts?: { endpointHost?: string }): void
  /** Put a CLI key where the Claude Code plugin keeps it. */
  seedPluginToken(token: string): void
  pluginTokenPath(): string
  /**
   * Put a CLI key in the (namespaced) OS keychain for the stub endpoint. Unlike
   * the plugin token file, the keychain is endpoint-scoped, so this is the only
   * way to give a non-default endpoint a stored key. Returns false where the
   * machine has no keychain backend — a headless CI runner — so a test can skip
   * rather than fail for the wrong reason.
   */
  seedKeychainKey(token: string): boolean
  /** The Claude desktop app's config directory for this sandbox, per platform. */
  claudeAppDir(): string
  /** The chat surface's MCP config, which the Code tab also reads. */
  claudeDesktopConfigPath(): string
  /** Pretend the desktop app is installed but its Code tab has never been opened. */
  seedClaudeApp(): void
  /** Pretend the Code tab has run — it downloads its own engine build. */
  seedClaudeCodeDesktop(): void
  /** The notice-banner cache, so tests can seed or inspect verdicts. */
  statePath(): string
  readState(): Record<string, any>
  writeState(state: unknown): void
  cleanup(): Promise<void>
}

let counter = 0

export async function createSandbox(stubOptions: Partial<StubOptions> = {}): Promise<Sandbox> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-home-"))
  const project = path.join(home, "project")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const stub = await startStub(stubOptions)
  // Unique per sandbox, so parallel test files cannot collide in the keychain.
  const keychainService = `opentrace-cli-test-${process.pid}-${counter++}`
  // Only true once a test has deliberately stored something, so cleanup does not
  // reach for a backend that no test in this sandbox ever touched.
  let usedKeychain = false

  const settingsPath = (scope: "user" | "project"): string =>
    scope === "user"
      ? path.join(home, ".claude", "settings.json")
      : path.join(project, ".claude", "settings.json")

  const readJson = (file: string): Record<string, any> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>
    } catch {
      return {}
    }
  }
  const writeJson = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`, "utf8")
  }

  const statePath = (): string => path.join(home, ".opentrace", "state.json")

  return {
    home,
    project,
    stub,
    base: ["--base-url", stub.url],

    run(args, opts = {}) {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HOME: home,
        USERPROFILE: home, // os.homedir() reads this on Windows
        XDG_CONFIG_HOME: path.join(home, ".config"),
        // Without this the Windows app-dir lookup escapes the sandbox and reads
        // the real user's roaming profile.
        APPDATA: appDataFor(home),
        OTX_KEYCHAIN_SERVICE: keychainService,
        // Namespacing is not enough: the backend itself is machine-wide, and an
        // unattended or locked one can block in a native call instead of
        // failing — which is how a macOS run left two orphan node processes and
        // hung for 25 minutes. Tests that specifically need a stored key clear
        // this for their own child.
        OTX_NO_KEYCHAIN: "1",
        OTX_REGISTRY_URL: stub.url,
        OTX_FORCE_NOTICES: "1",
        ...opts.env,
      }
      // A CI runner sets CI=true, which silences the banner. Tests decide.
      for (const key of ["CI", "OTX_NO_NOTICES", "NO_UPDATE_NOTIFIER"]) {
        if (!(key in (opts.env ?? {}))) delete env[key]
      }

      return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
          cwd: opts.cwd ?? project,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let output = ""
        child.stdout.on("data", (d) => {
          stdout += d
          output += d
        })
        child.stderr.on("data", (d) => {
          stderr += d
          output += d
        })
        // A child that never exits used to hang the whole suite with no clue
        // which command was responsible. Killing it turns that into one failing
        // test that names itself and shows what the command had printed so far.
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(
            new Error(
              `otx ${args.join(" ")} did not exit within ${CHILD_TIMEOUT_MS}ms.\n` +
                `--- output so far ---\n${output || "(none)"}`,
            ),
          )
        }, CHILD_TIMEOUT_MS)
        child.on("error", (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr, output })
        })
      })
    },

    apiRequests: () =>
      stub.requests.filter((q) =>
        API_PATH_PREFIXES.some((prefix) => q.path.startsWith(prefix)),
      ),

    settingsPath,
    readSettings: (scope) => readJson(settingsPath(scope)),
    writeSettings: (scope, settings) => writeJson(settingsPath(scope), settings),

    seedTelemetry(scope, token, opts = {}) {
      const host = opts.endpointHost ?? stub.url
      const existing = readJson(settingsPath(scope))
      writeJson(settingsPath(scope), {
        ...existing,
        env: {
          ...(existing.env ?? {}),
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_ENDPOINT: `${host}/ingest/claude-code`,
          OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
          OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
        },
      })
    },

    pluginTokenPath: () => path.join(home, ".claude", "opentrace-plugin.token"),
    seedPluginToken(token) {
      fs.writeFileSync(path.join(home, ".claude", "opentrace-plugin.token"), `${token}\n`, "utf8")
    },

    seedKeychainKey(token) {
      try {
        // Constructed directly rather than through util/keychain: that module
        // reads OTX_KEYCHAIN_SERVICE from the environment, which is set for the
        // child process under test, not for this one.
        const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring")
        new Entry(keychainService, `${stub.url}/mcp/v1/`).setPassword(token)
        usedKeychain = true
        return true
      } catch {
        return false
      }
    },

    claudeAppDir: () => claudeAppDirFor(home),
    claudeDesktopConfigPath: () => path.join(claudeAppDirFor(home), "claude_desktop_config.json"),
    seedClaudeApp() {
      fs.mkdirSync(claudeAppDirFor(home), { recursive: true })
    },
    seedClaudeCodeDesktop() {
      fs.mkdirSync(path.join(claudeAppDirFor(home), "claude-code", "2.1.222"), { recursive: true })
    },

    statePath,
    readState: () => readJson(statePath()),
    writeState: (state) => writeJson(statePath(), state),

    async cleanup() {
      await stub.close()
      // Delete anything a test put in the real keychain under this sandbox's
      // service name. Skipped entirely unless one did, so the common case never
      // touches the backend at all.
      if (usedKeychain) try {
        const { Entry } = (await import("@napi-rs/keyring")) as typeof import("@napi-rs/keyring")
        for (const account of [`${stub.url}/mcp/v1/`, stub.url]) {
          try {
            new Entry(keychainService, account).deletePassword()
          } catch {
            /* nothing stored under that account */
          }
        }
      } catch {
        /* keyring unavailable — nothing to clean */
      }
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Does this settings file carry the OTEL block? */
export function hasTelemetry(settings: Record<string, any>): boolean {
  return Boolean(settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY)
}

/** The usage key configured in a settings object, if any. */
export function telemetryToken(settings: Record<string, any>): string | undefined {
  const header = settings.env?.OTEL_EXPORTER_OTLP_HEADERS
  if (typeof header !== "string") return undefined
  return /Authorization=Bearer\s+(\S+)/.exec(header)?.[1]
}
