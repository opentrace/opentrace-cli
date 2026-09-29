// Claude Code usage monitoring: the OTEL exporter env block in a Claude Code
// settings.json. The credential inside is a claude_code_telemetry-scoped key —
// a write-only ingest credential by design (it cannot read the graph or the
// REST surface), which is why, unlike MCP keys, it is allowed to live in a
// project-scoped settings file when the user picks that scope.
//
// Wording here deliberately matches the dashboard's own setup flow ("Monitor
// your Claude Code usage", "counts, not content"). This is the reader watching
// their own usage on their own dashboard, and copy that reads like OpenTrace
// collecting telemetry for itself describes the wrong thing entirely.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { confirm, password, select } from "@inquirer/prompts"
import { readJsonConfig, writeJsonConfig } from "./json-config.js"
import { clearTelemetryToken, writeTelemetryToken } from "./plugin-token.js"
import { buildIngestUrl, buildTelemetryKeyUrl, toBaseUrl } from "./constants.js"
import { TOKEN_REGEX, maskToken, validateTokenShape } from "./token.js"
import { recordKeyVerdict, usageKeyId } from "./notice-state.js"

interface ClaudeSettings {
  env?: Record<string, string>
  [key: string]: unknown
}

/**
 * What the export actually carries, said before the question rather than after
 * the answer. Exported because every path that enables monitoring without asking
 * (`--track-usage`, Express) still owes the reader this sentence.
 */
export const USAGE_PRIVACY_NOTE =
  "Counts, not content: Claude Code exports token counts, cost, and model and tool names — " +
  "never your prompts, your code, or your file paths."

/** The settings file the env block lands in for the chosen scope. */
export function claudeSettingsPath(projectDir: string, opts: { global?: boolean }): string {
  return opts.global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(projectDir, ".claude", "settings.json")
}

/**
 * The full env block, endpoint derived from the active host.
 *
 * Two families of key, written together because a reader who enabled monitoring wants both
 * halves of it and neither is useful alone.
 *
 * The ``OTEL_*`` keys configure Claude Code's own exporter: what it sends and where.
 * ``OTEL_METRICS_INCLUDE_REPOSITORY`` is off by default upstream and is the single setting
 * per-repository cost rests on — without it no event carries a repository at all, and spend
 * reaches one only by being matched to commits in time.
 *
 * ``OPENTRACE_API_URL`` configures the OpenTrace plugin's hooks, which report the branch
 * each prompt worked on. **It duplicates the endpoint on purpose.** Claude Code strips
 * ``OTEL_*`` from hook subprocesses — put both in one ``env`` block and a hook sees
 * ``OPENTRACE_API_URL`` and not ``OTEL_EXPORTER_OTLP_ENDPOINT`` — so the plugin cannot read
 * the exporter's configuration however carefully it tries. Left unset it falls back to the
 * public host, which silently points a self-hosted install at the wrong place.
 *
 * **The key is deliberately not here.** That same stripping is what contains it: inside
 * ``OTEL_EXPORTER_OTLP_HEADERS`` it reaches Claude Code's exporter and nothing else, whereas
 * an ``OPENTRACE_*`` name is passed through to every hook, every Bash tool call, and every
 * MCP server the session starts — readable with a bare ``env``, and apt to land verbatim in
 * a transcript. The exposure is to the process environment, not to the file, so "it is the
 * same file, the same permissions" did not answer it. The hooks read the key from
 * ``~/.claude/opentrace-plugin.token`` at mode 0600 instead; see ``writeTelemetryEnv``.
 */
export function telemetryEnv(baseUrl: string, token: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: buildIngestUrl(baseUrl),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
    OTEL_METRICS_INCLUDE_REPOSITORY: "true",
    OPENTRACE_API_URL: toBaseUrl(baseUrl),
  }
}

/**
 * The set `disconnect` is allowed to delete. Spelled out rather than derived from a dummy
 * telemetryEnv() call so that adding a key to the block is a deliberate act in both
 * directions — and so that a key this CLI has *stopped* writing can still be cleaned up.
 * `OPENTRACE_TELEMETRY_API_KEY` is exactly that: earlier builds put it in the env block, so
 * it stays on this list to be removed from the files they wrote, and is absent from
 * `telemetryEnv` so no new file gets one.
 */
/**
 * Keys earlier builds wrote into the `env` block and this one no longer does.
 *
 * Stripped on every write, not merely left out. A settings file is *merged*, so omitting a
 * key preserves whatever is already under it — the credential this build moved out of `env`
 * would have stayed in every existing file for ever, and the move only protected machines
 * that had never been set up. Removing it here is what makes upgrading remediate rather
 * than just stop making it worse.
 */
export const LEGACY_TELEMETRY_ENV_KEYS = ["OPENTRACE_TELEMETRY_API_KEY"] as const

export const TELEMETRY_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_METRICS_INCLUDE_ENTRYPOINT",
  "OTEL_METRICS_INCLUDE_REPOSITORY",
  "OPENTRACE_API_URL",
  "OPENTRACE_TELEMETRY_API_KEY",
] as const

/** The usage key already configured in a settings file, if any. */
export function readTelemetryToken(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) return undefined
  try {
    const settings = readJsonConfig<ClaudeSettings>(configPath, {})
    const headers = settings.env?.OTEL_EXPORTER_OTLP_HEADERS
    if (typeof headers !== "string") return undefined
    const match = /Authorization=Bearer\s+(\S+)/.exec(headers)
    const token = match?.[1]
    return token && TOKEN_REGEX.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

/** True if the file already carries the telemetry block (any endpoint/key). */
export function hasTelemetryEnv(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false
  try {
    const settings = readJsonConfig<ClaudeSettings>(configPath, {})
    return settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined
  } catch {
    return false
  }
}

/**
 * Is the block in this file one WE wrote? Claude Code's OTEL settings are
 * general-purpose — a user may well be exporting to their own collector — and
 * `disconnect` must not delete that. Ours is identifiable two ways, either of
 * which is conclusive: the endpoint is an OpenTrace ingest mount, or the
 * credential is an OpenTrace key.
 */
export function isOpenTraceTelemetryBlock(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false
  try {
    const settings = readJsonConfig<ClaudeSettings>(configPath, {})
    const env = settings.env ?? {}
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
    if (typeof endpoint === "string" && endpoint.includes("/ingest/claude-code")) return true
    return readTelemetryToken(configPath) !== undefined
  } catch {
    return false
  }
}

export interface TelemetryRemoval {
  removed: boolean
  /** A telemetry block is present but points somewhere else — left untouched. */
  foreign: boolean
  /**
   * Set when our own block was found but could not be removed — an unreadable or
   * unwritable settings file. Distinguishes "failed" from "nothing to do", which
   * otherwise look identical to the caller and leave telemetry running under a
   * report of success.
   */
  error?: string
}

/**
 * Delete the OTEL block from a settings file, and only the keys this CLI writes:
 * unrelated env vars, and every other setting, survive. `env` itself is dropped
 * when nothing is left in it, so disconnecting leaves no empty scaffolding
 * behind. Refuses to touch a block aimed at someone else's collector.
 */
export function removeTelemetryEnv(configPath: string): TelemetryRemoval {
  if (!fs.existsSync(configPath) || !hasTelemetryEnv(configPath)) {
    return { removed: false, foreign: false }
  }
  if (!isOpenTraceTelemetryBlock(configPath)) {
    return { removed: false, foreign: true }
  }
  try {
    const settings = readJsonConfig<ClaudeSettings>(configPath, {})
    const env = { ...(settings.env ?? {}) }
    for (const key of TELEMETRY_ENV_KEYS) delete env[key]
    if (Object.keys(env).length === 0) {
      delete settings.env
    } else {
      settings.env = env
    }
    writeJsonConfig(configPath, settings)
    // The key no longer lives in the block, so clearing the block alone would leave the
    // hooks authenticated and still reporting after the user turned monitoring off. The
    // MCP's own token file is deliberately untouched — that is `disconnect --plugin`.
    clearTelemetryToken()
    return { removed: true, foreign: false }
  } catch (err) {
    return { removed: false, foreign: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Merge the telemetry block into the file's `env`, preserving every other
 * setting and any unrelated env vars. Returns whether a block was replaced.
 *
 * Also lands the key in `~/.claude/opentrace-telemetry.token` at mode 0600, which is how
 * the plugin's hooks get it. They cannot read it from `env`: it is deliberately not written
 * there, because Claude Code passes `env` down to every subprocess a session starts.
 * Writing the file here keeps the two halves of enabling monitoring in one step — a block
 * written without it leaves the hooks silently unauthenticated.
 *
 * **Its own file, not the MCP's.** `attachPluginKey` owns `opentrace-plugin.token` and puts
 * a graph-reading CLI key there; this is a usage key that deliberately cannot read anything.
 * Sharing one path made the outcome depend on which command wrote last.
 *
 * Any copy of the key an earlier build left in `env` is removed here — see
 * `LEGACY_TELEMETRY_ENV_KEYS`. It has to go rather than merely be superseded, because the
 * hooks would otherwise keep reading the stale value and a rotated key would fail quietly.
 */
export function writeTelemetryEnv(
  configPath: string,
  env: Record<string, string>,
  token: string,
): { existed: boolean } {
  const settings = readJsonConfig<ClaudeSettings>(configPath, {})
  const existed = settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined
  const merged: Record<string, string> = { ...(settings.env ?? {}), ...env }
  for (const key of LEGACY_TELEMETRY_ENV_KEYS) delete merged[key]
  settings.env = merged
  writeJsonConfig(configPath, settings)
  if (token) writeTelemetryToken(token)
  return { existed }
}

/**
 * Is a usage key still accepted at the ingest endpoint? Posts an empty OTLP
 * logs export — a no-op batch — because ingest is the only surface that
 * accepts this scope, so there is nothing cheaper to ask. The server
 * authenticates at the dependency layer before the body is read, so an empty
 * batch exercises auth exactly like a real one (verified against a live
 * instance: valid key → 200, absent key → 401). Only an explicit 401/403
 * condemns the key; anything else says nothing about it.
 */
export async function probeTelemetryKey(
  baseUrl: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const res = await fetch(`${buildIngestUrl(baseUrl)}/v1/logs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resourceLogs: [] }),
      // A deadline only for callers that have one; a timeout lands in "unknown",
      // which never condemns the key.
      signal: opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs),
    })
    if (res.ok) return "valid"
    if (res.status === 401 || res.status === 403) return "invalid"
    return "unknown"
  } catch {
    return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Usage-key provisioning (authenticated by the CLI key)
// ---------------------------------------------------------------------------

export type UsageKeyResult =
  | { ok: true; token: string; created?: boolean }
  | { ok: false; kind: "auth" | "unsupported" | "network" | "protocol"; message: string }

/** Pull a human-readable reason out of a REST error body (bounded — untrusted size). */
export function parseErrorDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body.slice(0, 4096)) as {
      detail?: unknown
      message?: string
      error?: string
      error_description?: string
    }
    if (typeof parsed.detail === "string") return parsed.detail
    if (parsed.detail && typeof parsed.detail === "object") {
      const message = (parsed.detail as { message?: string }).message
      if (message) return message
    }
    if (parsed.message) return parsed.message
    if (parsed.error_description) return parsed.error_description
    if (parsed.error) return parsed.error
  } catch {
    /* not JSON */
  }
  return null
}

/**
 * Provision the Claude Code usage key, authenticated by the CLI key. The
 * server owns naming and flags the key auto-created; secrets are stored
 * hashed, so every call mints a fresh key (`created` is always true today —
 * false is reserved should reuse semantics ever become possible). Re-runs
 * converge because the CALLER keeps a still-valid key from the settings file
 * instead of calling this again.
 *
 * A 404 means the server predates this endpoint — reported as its own kind
 * so callers can say "server doesn't support this yet" instead of implying
 * the key was rejected.
 */
export async function provisionUsageKey(baseUrl: string, cliToken: string): Promise<UsageKeyResult> {
  const url = buildTelemetryKeyUrl(baseUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cliToken}`, Accept: "application/json" },
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!res.ok) {
    const detail = parseErrorDetail(await res.text())
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", message: detail ?? "The CLI key was not accepted for usage-key provisioning." }
    }
    if (res.status === 404 || res.status === 405) {
      return {
        ok: false,
        kind: "unsupported",
        message: "This OpenTrace server does not support usage-key provisioning yet.",
      }
    }
    return { ok: false, kind: "protocol", message: detail ?? `Unexpected HTTP ${res.status} from ${url}.` }
  }

  try {
    const parsed = JSON.parse(await res.text()) as { token?: string; created?: boolean }
    if (!parsed.token) {
      return { ok: false, kind: "protocol", message: "The usage-key response carried no key secret." }
    }
    return { ok: true, token: parsed.token, created: parsed.created }
  } catch {
    return { ok: false, kind: "protocol", message: "The usage-key response was not valid JSON." }
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface TelemetryPlan {
  configPath: string
  env: Record<string, string>
  /**
   * The ingest key. Carried beside `env` rather than inside it because it is written to a
   * 0600 file, not to the settings block — see `telemetryEnv`.
   */
  token: string
  /** True when the file's existing usage key was still valid and kept. */
  reusedExisting: boolean
  isGlobalScope: boolean
}

export interface ConfiguredTelemetry {
  configPath: string
  /** Absent when a block is present but carries no readable OpenTrace key. */
  token?: string
  state: "valid" | "invalid" | "unknown"
}

/**
 * Monitoring already set up on this machine, and whether its key still works.
 *
 * Checked BEFORE anything is asked, because "is what you already have still
 * working?" is worth answering on a run that is not about setting monitoring up
 * — that used to be reachable only by opting in again, so a revoked key stayed
 * silently revoked.
 *
 * Project settings override user settings key-for-key and the exporter
 * credential is one key, so the project file is checked first: its copy is the
 * one Claude Code actually sends. Stops at the first file carrying a block,
 * which bounds this to a single request.
 */
export async function findConfiguredTelemetry(
  dir: string,
  baseUrl: string,
): Promise<ConfiguredTelemetry | undefined> {
  for (const configPath of [
    claudeSettingsPath(dir, { global: false }),
    claudeSettingsPath(dir, { global: true }),
  ]) {
    const token = readTelemetryToken(configPath)
    if (!token) {
      // A block with no readable key — hand-edited, or written by something
      // else. Still "configured", just not something we can verify.
      if (hasTelemetryEnv(configPath)) return { configPath, state: "unknown" }
      continue
    }
    const state = await probeTelemetryKey(baseUrl, token)
    if (state !== "unknown") {
      recordKeyVerdict(usageKeyId(configPath), token, state === "valid" ? "valid" : "rejected")
    }
    return { configPath, token, state }
  }
  return undefined
}

/**
 * Decide whether — and into which settings file — the Claude Code OTEL env
 * block goes, and secure a usage key for it. All prompting and provisioning
 * happens here, before any file is written; the caller applies the plan.
 *
 * Key acquisition order: a usage key already in the target file is kept when it
 * still authenticates AND this run did not arrive with a CLI key of its own —
 * that reuse is what keeps repeat `install` runs from minting key after key,
 * since the server provisions a fresh one per call. A key supplied or minted
 * this run (`connect otk_…`, `login`, `--api-key`, a pasted key) replaces it
 * instead: the usage key belongs to whichever CLI key provisioned it, so keeping
 * the old one would go on reporting to the previous owner.
 */
export async function resolveTelemetryPlan(args: {
  dir: string
  baseUrl: string
  /** Default scope for the env block (the caller's own scope choice). */
  isGlobal: boolean
  /** Scope already settled — an explicit -g/--global, or Express; set = never prompt for scope. */
  explicitGlobal?: boolean
  interactive: boolean
  /** Explicit --track-usage / --no-track-usage; undefined = not stated. */
  trackUsage?: boolean
  /** The CLI key the key step resolved (the same key that authenticates MCP), if any. */
  cliToken?: string
  /**
   * True when `cliToken` was supplied or minted on this run rather than read
   * from local storage. Such a run may be a different account than the one that
   * provisioned the usage key on file, so the key is re-provisioned rather than
   * reused — there is no way to ask a key who owns it.
   */
  explicitCliKey?: boolean
  /** The env block only means anything to Claude Code — nothing is written (or asked) without it. */
  targetsClaudeCode: boolean
}): Promise<{ plan?: TelemetryPlan; note?: string }> {
  // Writing Claude Code settings on a run that is not setting up Claude Code
  // would be surprising even when asked for explicitly — the flag is refused
  // loudly rather than honored quietly.
  if (!args.targetsClaudeCode) {
    return args.trackUsage
      ? { note: "--track-usage has no effect here — Claude Code is not among the tools being set up." }
      : {}
  }

  // What is already set up, checked before anything is asked. A rejected key
  // means nothing is reaching OpenTrace, and that is true whether or not this
  // run was going to touch monitoring — so it is reported either way.
  const existing = await findConfiguredTelemetry(args.dir, args.baseUrl)
  if (existing?.state === "invalid") {
    console.warn(`\nThe usage key in ${existing.configPath} was rejected — nothing is reaching OpenTrace.`)
  }

  let want: boolean
  if (args.trackUsage !== undefined) {
    want = args.trackUsage
  } else if (args.interactive) {
    console.log()
    if (existing?.state === "invalid") {
      want = await confirm({ message: "Provision a fresh usage key and start monitoring again?", default: true })
    } else if (existing?.state === "unknown") {
      // A block is there but carries no key we can verify — hand-edited, or
      // written by something else. Saying so beats the first-run question, which
      // would imply nothing is configured and then quietly overwrite it.
      console.log(`Already configured in ${existing.configPath}, but the key could not be verified.`)
      want = await confirm({ message: "Set it up again with a fresh usage key?", default: true })
    } else if (existing?.state === "valid") {
      // Already working. Offered rather than assumed, because saying yes here
      // may replace the key (see explicitCliKey) rather than being a no-op.
      console.log(`Already monitoring (key in ${existing.configPath}).`)
      want = await confirm({ message: "Check and refresh usage monitoring?", default: true })
    } else {
      console.log("Your Claude Code cost, tokens and session activity, on your own OpenTrace dashboard.")
      console.log(`  ${USAGE_PRIVACY_NOTE}`)
      want = await confirm({ message: "Monitor your Claude Code usage in OpenTrace?", default: true })
    }
  } else {
    // Not stated and nothing to ask — never write telemetry config silently.
    want = false
  }
  if (!want) {
    // Declining leaves a dead block in place, which will go on failing quietly.
    // Say where the off switch is rather than let it rot unmentioned.
    return existing?.state === "invalid"
      ? { note: `The rejected usage key is still in ${existing.configPath} — clear it with \`otx disconnect --usage\`.` }
      : {}
  }

  // An explicitly stated scope is final; the prompt only exists for the case
  // where "at which level?" was genuinely never answered. Interactive answers
  // from the caller's own scope question arrive as the select's default.
  //
  // Where monitoring is already configured, that file's scope outranks the
  // caller's default: re-running against an existing setup should refresh it in
  // place, not write a second block at the other level and leave two.
  const existingScope = existing
    ? existing.configPath === claudeSettingsPath(args.dir, { global: true })
    : undefined
  const isGlobalScope =
    args.explicitGlobal ??
    (args.interactive
      ? await select({
          message: "Where should usage monitoring be configured?",
          choices: [
            {
              name: "Just this project",
              value: false,
              description: claudeSettingsPath(args.dir, { global: false }),
            },
            {
              name: "All projects",
              value: true,
              description: claudeSettingsPath(args.dir, { global: true }),
            },
          ],
          // Default to where monitoring already lives, so answering the scope
          // question the other way is a deliberate move rather than the way to
          // end up with two blocks in two files.
          default: existingScope ?? args.isGlobal,
        })
      : (existingScope ?? args.isGlobal))
  const configPath = claudeSettingsPath(args.dir, { global: isGlobalScope })

  // 1. The usage key already in the target file. Reused only when it still
  //    authenticates AND this run brought no CLI key of its own — see
  //    `explicitCliKey`. `existing` above may describe a different file (the
  //    user picked the other scope), so this reads the chosen one.
  const existingToken = readTelemetryToken(configPath)
  if (existingToken) {
    const state =
      existing?.configPath === configPath && existing.token === existingToken
        ? existing.state // already probed before the questions — don't ask twice
        : await probeTelemetryKey(args.baseUrl, existingToken)
    // Hand the verdict to the notice banner, which would otherwise have to ask
    // the ingest endpoint the same question again on the next run.
    if (state !== "unknown") {
      recordKeyVerdict(usageKeyId(configPath), existingToken, state === "valid" ? "valid" : "rejected")
    }
    if (state !== "invalid" && args.explicitCliKey) {
      console.log(`  ↻ replacing the usage key in ${configPath} — this run brought its own CLI key.`)
    } else if (state !== "invalid") {
      if (state === "unknown") {
        console.warn(`Note: could not verify the usage key already in ${configPath} — keeping it.`)
      } else {
        console.log(`  ✓ usage key already in ${configPath} is still valid — keeping it.`)
      }
      return {
        plan: {
          configPath,
          env: telemetryEnv(args.baseUrl, existingToken),
          token: existingToken,
          reusedExisting: true,
          isGlobalScope,
        },
      }
    } else {
      console.warn("The usage key already configured was rejected at the ingest endpoint — minting a fresh one.")
    }
  }

  // 2. Get-or-create one with the CLI key. The key step may not have produced
  //    a key (the OAuth path) — offer to take one here, since the usage key
  //    cannot be provisioned any other way.
  let cliToken = args.cliToken
  if (!cliToken && args.interactive) {
    const entered = (
      await password({
        message: "OpenTrace CLI key (otk_…) to set up usage monitoring — leave blank to skip:",
        mask: "•",
        validate: (value: string) => {
          const trimmed = value.trim()
          if (!trimmed) return true
          return validateTokenShape(trimmed) ?? true
        },
      })
    ).trim()
    if (!entered) return { note: "Usage monitoring skipped — it needs a CLI key to provision the usage key." }
    cliToken = entered
  }
  if (!cliToken) {
    return {
      note:
        "Usage monitoring requested, but there is no CLI key to provision the usage key with — " +
        "re-run with a key (OpenTrace dashboard → API keys).",
    }
  }

  const usage = await provisionUsageKey(args.baseUrl, cliToken)
  if (!usage.ok) {
    return { note: `Usage monitoring skipped — ${usage.message}` }
  }
  console.log(
    usage.created === false
      ? `  ✓ reusing this CLI key's existing usage key (${maskToken(usage.token)}).`
      : `  ✓ provisioned a usage key (${maskToken(usage.token)}) for Claude Code telemetry.`,
  )
  // A key the server just issued is known-good; recording it spares the banner a
  // round-trip and stops any verdict about the key it replaces from lingering.
  recordKeyVerdict(usageKeyId(configPath), usage.token, "valid")
  return {
    plan: {
      configPath,
      env: telemetryEnv(args.baseUrl, usage.token),
      token: usage.token,
      reusedExisting: false,
      isGlobalScope,
    },
  }
}
