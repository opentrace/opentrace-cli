// Claude Code usage tracking: the OTEL exporter env block in a Claude Code
// settings.json. The credential inside is a claude_code_telemetry-scoped key —
// a write-only ingest credential by design (it cannot read the graph or the
// REST surface), which is why, unlike MCP keys, it is allowed to live in a
// project-scoped settings file when the user picks that scope.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { confirm, password, select } from "@inquirer/prompts"
import { readJsonConfig, writeJsonConfig } from "./json-config.js"
import { buildIngestUrl } from "./constants.js"
import { TOKEN_REGEX, maskToken, validateTokenShape } from "./token.js"
import { checkProvisioningKey, provisionKey } from "./provision.js"

interface ClaudeSettings {
  env?: Record<string, string>
  [key: string]: unknown
}

/** The settings file the env block lands in for the chosen scope. */
export function claudeSettingsPath(projectDir: string, opts: { global?: boolean }): string {
  return opts.global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(projectDir, ".claude", "settings.json")
}

/** The full env block, endpoint derived from the active host. */
export function telemetryEnv(baseUrl: string, token: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: buildIngestUrl(baseUrl),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
  }
}

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
 * Merge the telemetry block into the file's `env`, preserving every other
 * setting and any unrelated env vars. Returns whether a block was replaced.
 */
export function writeTelemetryEnv(
  configPath: string,
  env: Record<string, string>,
): { existed: boolean } {
  const settings = readJsonConfig<ClaudeSettings>(configPath, {})
  const existed = settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined
  settings.env = { ...(settings.env ?? {}), ...env }
  writeJsonConfig(configPath, settings)
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
): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const res = await fetch(`${buildIngestUrl(baseUrl)}/v1/logs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resourceLogs: [] }),
    })
    if (res.ok) return "valid"
    if (res.status === 401 || res.status === 403) return "invalid"
    return "unknown"
  } catch {
    return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface TelemetryPlan {
  configPath: string
  env: Record<string, string>
  /** True when the file's existing usage key was still valid and kept. */
  reusedExisting: boolean
  isGlobalScope: boolean
}

/**
 * Decide whether — and into which settings file — the Claude Code OTEL env
 * block goes, and secure a usage key for it. All prompting and minting happens
 * here, before any file is written; the caller applies the returned plan.
 *
 * Key acquisition order: a valid usage key already in the target file is kept
 * (minting on every re-run would sprawl keys); otherwise one is minted with
 * the API-scoped key from the key step, or with one prompted for here — a
 * usage key's secret is only ever readable from the settings file itself, so
 * there is nowhere else to recover one from.
 */
export async function resolveTelemetryPlan(args: {
  dir: string
  baseUrl: string
  /** Default scope for the env block (the caller's own scope choice). */
  isGlobal: boolean
  /** Scope stated explicitly on the CLI (-g/--global); set = never prompt for scope. */
  explicitGlobal?: boolean
  interactive: boolean
  /** Explicit --track-usage / --no-track-usage; undefined = not stated. */
  trackUsage?: boolean
  /** API-scoped key already validated by the key step, if it produced one. */
  provisioningKey?: string
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

  let want: boolean
  if (args.trackUsage !== undefined) {
    want = args.trackUsage
  } else if (args.interactive) {
    want = await confirm({
      message: "Track Claude Code usage in OpenTrace? (writes OTEL telemetry env into Claude Code settings)",
      default: true,
    })
  } else {
    // Not stated and nothing to ask — never write telemetry config silently.
    want = false
  }
  if (!want) return {}

  // An explicitly stated scope is final; the prompt only exists for the case
  // where "at which level?" was genuinely never answered. Interactive answers
  // from the caller's own scope question arrive as the select's default.
  const isGlobalScope =
    args.explicitGlobal ??
    (args.interactive
      ? await select({
          message: "Where should usage tracking be configured?",
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
          default: args.isGlobal,
        })
      : args.isGlobal)
  const configPath = claudeSettingsPath(args.dir, { global: isGlobalScope })

  // 1. A usage key already in the target file, if it still authenticates.
  const existingToken = readTelemetryToken(configPath)
  if (existingToken) {
    const state = await probeTelemetryKey(args.baseUrl, existingToken)
    if (state !== "invalid") {
      if (state === "unknown") {
        console.warn(`Note: could not verify the usage key already in ${configPath} — keeping it.`)
      } else {
        console.log(`  ✓ usage key already in ${configPath} is still valid — keeping it.`)
      }
      return {
        plan: { configPath, env: telemetryEnv(args.baseUrl, existingToken), reusedExisting: true, isGlobalScope },
      }
    }
    console.warn("The usage key already configured was rejected at the ingest endpoint — minting a fresh one.")
  }

  // 2. Mint one. Needs an API-scoped key; the key step may not have produced
  //    one (stored-key reuse, an mcp-scoped key, or no key at all).
  let provisioningKey = args.provisioningKey
  if (!provisioningKey && args.interactive) {
    const entered = (
      await password({
        message: "API-scoped key (otk_…) to mint the usage key — leave blank to skip usage tracking:",
        mask: "•",
        validate: (value: string) => {
          const trimmed = value.trim()
          if (!trimmed) return true
          return validateTokenShape(trimmed) ?? true
        },
      })
    ).trim()
    if (!entered) return { note: "Usage tracking skipped — no API-scoped key to mint a usage key with." }
    const check = await checkProvisioningKey(args.baseUrl, entered)
    if (!check.ok) {
      return { note: `Usage tracking skipped — the key was not accepted by the REST API: ${check.message}` }
    }
    provisioningKey = entered
  }
  if (!provisioningKey) {
    return {
      note:
        "Usage tracking requested, but there is no API-scoped key to mint a usage key with — " +
        "re-run with an API-scoped key (OpenTrace dashboard → API keys).",
    }
  }

  const minted = await provisionKey(args.baseUrl, provisioningKey, "claude_code_telemetry")
  if (!minted.ok) {
    return { note: `Usage tracking skipped — minting the usage key failed: ${minted.message}` }
  }
  console.log(`  ✓ minted a usage key (${maskToken(minted.key.token)}) for Claude Code telemetry.`)
  return {
    plan: { configPath, env: telemetryEnv(args.baseUrl, minted.key.token), reusedExisting: false, isGlobalScope },
  }
}
