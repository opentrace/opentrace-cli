import path from "node:path"
import fs from "node:fs"
import { checkbox, confirm, password, select } from "@inquirer/prompts"
import { ALL_INTEGRATIONS, detectInstalled } from "../util/detect.js"
import { DEFAULT_BASE_URL, buildMcpUrl, buildIngestUrl } from "../util/constants.js"
import { isInteractive } from "../util/tty.js"
import { maskToken, validateTokenShape } from "../util/token.js"
import { probeMcp } from "../util/mcp-probe.js"
import { getToken, KeychainUnavailableError } from "../util/keychain.js"
import { readPluginToken } from "../util/plugin-token.js"
import { attachClientKey, attachPluginKey } from "../util/attach-key.js"
import { resolveTelemetryPlan, writeTelemetryEnv } from "../util/telemetry.js"
import { loginWithBrowser } from "../util/oauth/flow.js"
import { looksHeadless } from "../util/oauth/browser.js"
import { findKeyClient, hasKeyClientEntry } from "../key-clients/index.js"
import type { Integration } from "../integrations/types.js"

interface InstallCommandOptions {
  baseUrl?: string
  /** Full MCP URL to inject into the plugin's userConfig; set only when a URL was explicitly given. */
  pluginUrl?: string
  /** API key supplied on the command line — the non-interactive form of the key prompt. */
  apiKey?: string
  /** Explicit --track-usage / --no-track-usage; undefined = not stated (prompt or skip). */
  trackUsage?: boolean
  yes?: boolean
  global?: boolean
  toolOpts?: Record<string, unknown>
}

function toCamelCase(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** Integrations named explicitly with per-tool flags (`--cursor`, `--zed`, …). */
function flaggedTargets(opts: InstallCommandOptions): Integration[] {
  const toolOpts = opts.toolOpts ?? {}
  return ALL_INTEGRATIONS.filter(i => Boolean(toolOpts[toCamelCase(i.id)]))
}

/**
 * The file this run would write for a tool, and whether OpenTrace is already in
 * it. Mirrors the branching of the write loop — a plugin-hosted tool, a
 * key-carrying client, or a plain MCP entry all land in different files — so
 * "already configured" is answered about the file we are actually going to
 * touch rather than the scope-selected one.
 */
function targetState(
  integration: Integration,
  dir: string,
  isGlobal: boolean,
  key?: ResolvedKey,
): { configPath: string; configured: boolean } {
  const opts = { global: isGlobal }
  if (integration.plugin) {
    return {
      configPath: integration.plugin.getConfigPath(dir, opts),
      configured: integration.plugin.isEnabled(dir, opts),
    }
  }
  // With a key in hand this tool's entry is written user-scoped by its key
  // client, so that is the file to inspect — not the project/global choice.
  const keyClient = key ? findKeyClient(integration.id) : undefined
  if (keyClient) {
    return { configPath: keyClient.configPath(), configured: hasKeyClientEntry(keyClient) }
  }
  return {
    configPath: integration.getConfigPath(dir, opts),
    configured: integration.hasEntry(dir, opts),
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Scope is asked BEFORE the tool list so the "already configured" labels in
 * that list are exact — whether an entry exists depends on which file we'd
 * write, and a label that contradicts what we do next is worse than no label.
 */
async function promptScope(): Promise<boolean> {
  return select({
    message: "Where should OpenTrace be configured?",
    choices: [
      {
        name: "Just this project",
        value: false,
        description: "Writes project-level config (.mcp.json, .cursor/mcp.json, …)",
      },
      {
        name: "All projects",
        value: true,
        description: "Writes user-level config (~/.claude, ~/.cursor, …)",
      },
    ],
    default: false,
  })
}

/**
 * The tool list, detected tools pre-checked. Undetected tools are still listed
 * (rather than hidden) so a tool whose config directory does not exist yet can
 * be set up ahead of installing it — detection is a hint, not a gate.
 */
async function promptTargets(dir: string, isGlobal: boolean): Promise<Integration[]> {
  const rows = ALL_INTEGRATIONS.map((integration) => {
    const detected = integration.detect()
    // No key resolved yet at this point, so this reads the scope-selected file.
    // It is a label, not a decision — the authoritative check runs after the
    // key prompt and prints what will actually be rewritten.
    const { configured } = targetState(integration, dir, isGlobal)
    const tags = [detected ? "detected" : "not found"]
    if (configured) tags.push("already configured")
    return {
      name: `${integration.label}  (${tags.join(" · ")})`,
      value: integration,
      checked: detected,
    }
  })

  return checkbox({
    message: "Which tools should OpenTrace be set up for?",
    choices: rows,
    pageSize: ALL_INTEGRATIONS.length,
    // Deliberately not `required` — deselecting everything is a valid way to
    // back out, and it exits cleanly without writing anything.
    required: false,
  })
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

type KeySource = "flag" | "keychain" | "plugin" | "prompt" | "oauth"

interface ResolvedKey {
  token: string
  source: KeySource
}

interface KeyCheck {
  ok: boolean
  /** True when the key itself was rejected, as opposed to the check not completing. */
  rejected: boolean
  message?: string
}

/**
 * Confirm a CLI key with a real MCP handshake. Only a 401 tells us the key is
 * bad — a network or provisioning failure says nothing about the key, so those
 * are reported as "unverified" and the key is still used.
 */
async function checkKey(mcpUrl: string, token: string): Promise<KeyCheck> {
  const probe = await probeMcp(mcpUrl, token)
  if (probe.ok) return { ok: true, rejected: false }
  return { ok: false, rejected: probe.kind === "auth", message: probe.message }
}

/** A key already on this machine from an earlier connect/install, if there is one. */
function storedKey(mcpUrl: string): ResolvedKey | undefined {
  try {
    const fromKeychain = getToken(mcpUrl)
    if (fromKeychain) return { token: fromKeychain, source: "keychain" }
  } catch (err) {
    // A missing Secret Service is not an onboarding failure — the plugin token
    // file below is checked next, and the prompt still works.
    if (!(err instanceof KeychainUnavailableError)) throw err
  }
  const fromPlugin = readPluginToken()
  return fromPlugin ? { token: fromPlugin, source: "plugin" } : undefined
}

const MAX_KEY_ATTEMPTS = 3

/**
 * Decide what these tools will authenticate with. In order: the `--api-key`
 * flag, a key this machine already holds, then (interactively) a choice of
 * browser sign-in (the default — mints a fresh CLI key), pasting a key, or
 * skipping. Every key is a CLI key — one credential authenticates the MCP
 * mount and the usage-key endpoint alike — validated with an MCP handshake.
 * Returning undefined means "no key" — the tools fall back to signing in with
 * OAuth from inside the tool, which is a fully supported outcome, not an error.
 */
async function resolveApiKey(
  mcpUrl: string,
  opts: { apiKey?: string; interactive: boolean; baseUrl: string },
): Promise<ResolvedKey | undefined> {
  if (opts.apiKey) {
    const check = await checkKey(mcpUrl, opts.apiKey)
    if (check.rejected) {
      // An explicitly supplied key that the server rejects is a hard failure —
      // proceeding would wire up a connection that cannot work.
      console.error(`\nKey rejected: ${check.message}`)
      console.error("Re-copy the key, or create a fresh one, then run install again.")
      process.exit(1)
    }
    if (!check.ok) console.warn(`Note: could not verify the key — ${check.message}`)
    return { token: opts.apiKey, source: "flag" }
  }

  const existing = storedKey(mcpUrl)
  if (existing) {
    const where = existing.source === "keychain" ? "OS keychain" : "Claude Code plugin"
    // Announced because it costs a network round-trip: without this the command
    // appears to stall before its first output. Worth the wait either way — a
    // revoked key that gets re-attached silently fails on every later call.
    console.log(`Checking the CLI key stored in your ${where} (${maskToken(existing.token)}) …`)
    const check = await checkKey(mcpUrl, existing.token)
    if (check.ok) {
      console.log(`  ✓ still valid — reusing it.`)
      return existing
    }
    if (check.rejected) {
      // Expired or revoked — say so and fall through, rather than silently
      // re-attaching a key that returns 401 on every call.
      console.warn(`The CLI key stored in your ${where} was rejected — ${check.message}`)
    } else {
      console.warn(`Could not verify the stored CLI key — ${check.message}`)
      return existing
    }
  }

  if (!opts.interactive) return undefined

  // Browser sign-in is the interactive default; pasting stays one keystroke
  // away, and automation (`--api-key`, `connect otk_…`, non-TTY) never lands here.
  const method = await select({
    message: "How should these tools authenticate to OpenTrace?",
    choices: [
      {
        name: "Sign in with your browser",
        value: "browser",
        description: looksHeadless()
          ? "Mints a CLI key for this machine (needs a browser on THIS machine — won't work over SSH)"
          : "Opens the OpenTrace sign-in and mints a CLI key for this machine",
      },
      {
        name: "Paste a CLI key (otk_…)",
        value: "paste",
        description: "From the OpenTrace dashboard → API keys",
      },
      {
        name: "Skip — sign in from each tool later",
        value: "skip",
        description: "Tools authenticate with OAuth from inside the tool (in Claude Code: /mcp)",
      },
    ],
  })
  if (method === "skip") return undefined

  if (method === "browser") {
    const result = await loginWithBrowser({ baseUrl: opts.baseUrl })
    if (result.ok) {
      // Same invariant as every other source: a returned key was confirmed
      // against the MCP mount. This key was minted moments ago, so a rejection
      // here is a server inconsistency, not a bad paste — warn, don't fail.
      const check = await checkKey(mcpUrl, result.token)
      if (!check.ok) {
        console.warn(
          check.rejected
            ? `Note: the freshly minted key was rejected by the MCP endpoint — ${check.message}`
            : `Note: could not verify the minted key — ${check.message}`,
        )
      }
      return { token: result.token, source: "oauth" }
    }
    console.error(result.message)
    console.log("Falling back to the key prompt — paste a key, or leave blank to skip.")
  }

  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const entered = (
      await password({
        message: "OpenTrace CLI key (otk_…) — leave blank to skip:",
        mask: "•",
        validate: (value: string) => {
          const trimmed = value.trim()
          if (!trimmed) return true // blank is the documented "skip" answer
          return validateTokenShape(trimmed) ?? true
        },
      })
    ).trim()

    if (!entered) return undefined

    const check = await checkKey(mcpUrl, entered)
    if (check.ok || !check.rejected) {
      if (!check.ok) console.warn(`Note: could not verify the key — ${check.message}`)
      return { token: entered, source: "prompt" }
    }
    console.error(`Key rejected: ${check.message}`)
    if (attempt === MAX_KEY_ATTEMPTS) {
      console.log("Continuing without a key — sign in from your tool with /mcp instead.")
      return undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type Status = "added" | "updated" | "skipped"

interface Row {
  label: string
  configPath: string
  status: Status
}

export async function install(targetPath: string, opts: InstallCommandOptions): Promise<void> {
  const dir = path.resolve(targetPath)

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`)
    process.exit(1)
  }

  // Shape-check a command-line key first: it's offline and free, so a typo
  // fails before we announce anything or touch a config file.
  if (opts.apiKey) {
    const shapeError = validateTokenShape(opts.apiKey)
    if (shapeError) {
      console.error(`Invalid --api-key: ${shapeError}`)
      process.exit(1)
    }
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const mcpUrl = opts.pluginUrl ?? buildMcpUrl(baseUrl)
  // `--yes` and any non-TTY run (CI, a pipe) take the flag-driven path so
  // nothing can block on a prompt that will never be answered.
  const interactive = !opts.yes && isInteractive()

  // 1. Scope. An explicit -g/--global answers this; otherwise ask, falling back
  //    to project-level (the historical default) when we cannot.
  const explicitTargets = flaggedTargets(opts)
  let isGlobal: boolean
  if (opts.global !== undefined) {
    isGlobal = opts.global
  } else if (interactive) {
    isGlobal = await promptScope()
  } else {
    isGlobal = false
  }

  // 2. Which tools. Per-tool flags win; then the prompt; then bare detection.
  //    How they were chosen decides whether an existing config is confirmed
  //    before it gets rewritten, so it is tracked rather than re-derived.
  let targets: Integration[]
  let targetSource: "flags" | "prompt" | "detected"
  if (explicitTargets.length > 0) {
    targets = explicitTargets
    targetSource = "flags"
  } else if (interactive) {
    targetSource = "prompt"
    targets = await promptTargets(dir, isGlobal)
    if (targets.length === 0) {
      console.log("No tools selected — nothing to do.")
      return
    }
  } else {
    targetSource = "detected"
    targets = detectInstalled()
    if (targets.length === 0) {
      console.log("No supported AI tools detected.")
      console.log()
      console.log("Specify tools explicitly with flags:")
      ALL_INTEGRATIONS.forEach((i) => {
        console.log(`  opentrace install --${i.id}`)
      })
      return
    }
    console.log(`Detected: ${targets.map((i) => i.label).join(", ")}`)
  }

  // 3. How they authenticate. Asked once and applied to every selected tool.
  //    The same CLI key later authenticates the usage-key endpoint.
  const key = await resolveApiKey(mcpUrl, { apiKey: opts.apiKey, interactive, baseUrl })

  // 4. Usage tracking. Decided and provisioned up front so every prompt and
  //    network round-trip happens before the first file is written.
  const telemetry = await resolveTelemetryPlan({
    dir,
    baseUrl,
    isGlobal,
    // Only the flag counts as explicit — an interactive scope answer above
    // becomes the default for telemetry's own scope question, not its answer.
    explicitGlobal: opts.global,
    interactive,
    trackUsage: opts.trackUsage,
    cliToken: key?.token,
    targetsClaudeCode: targets.some((i) => i.id === "claude-code"),
  })

  // Only the flag path asks "overwrite?" per tool. The checkbox already labels
  // which tools are configured and the user selected them anyway, so a confirm
  // there would re-ask a choice just made; the flag path never showed that
  // list. Either way a rewrite replaces OpenTrace's own entry only — the rest
  // of the file is preserved — so what's at stake is a hand-edited OpenTrace
  // entry, and the endpoint being written is printed in the summary.
  const confirmBeforeOverwrite = targetSource === "flags" && interactive

  // Say it up front when a run will rewrite existing config, so "already
  // configured" tools are never overwritten silently.
  if (!confirmBeforeOverwrite) {
    const rewriting = targets.filter((i) => targetState(i, dir, isGlobal, key).configured)
    if (rewriting.length > 0) {
      console.log(`Rewriting existing OpenTrace config for: ${rewriting.map((i) => i.label).join(", ")}`)
    }
  }

  console.log()
  const results: Row[] = []
  let pluginInstalled = false
  let attachedKey: ResolvedKey | undefined
  /** Tools left authenticating with OAuth — they still need a sign-in step. */
  const oauthTargets: string[] = []
  const notes: string[] = []

  for (const integration of targets) {
    const { configPath, configured } = targetState(integration, dir, isGlobal, key)
    if (confirmBeforeOverwrite && configured) {
      const overwrite = await confirm({
        message: `${integration.label}: OpenTrace already configured in ${configPath}. Overwrite?`,
        default: false,
      })
      if (!overwrite) {
        results.push({ label: integration.label, configPath, status: "skipped" })
        continue
      }
    }

    try {
      // Where a plugin is available (Claude Code) it supersedes the bare MCP
      // entry — the plugin bundles its own MCP, so writing .mcp.json too would
      // be redundant.
      if (integration.plugin) {
        const pr = integration.plugin.install(dir, { global: isGlobal })
        pluginInstalled = true
        results.push({
          label: `${integration.label} (plugin)`,
          configPath: pr.configPath,
          status: pr.alreadyEnabled ? "updated" : "added",
        })

        if (key) {
          // Replacing a key already on file is an update, not an add — a
          // summary that always says "added" would hide that a previous key
          // was just overwritten.
          const hadKey = readPluginToken() !== undefined
          // Seeding mcp_url alongside the key is what makes the plugin fully
          // non-interactive: with both present it never asks for an endpoint
          // and authenticates straight away.
          const attached = attachPluginKey(integration.plugin, mcpUrl, key.token)
          attachedKey = key
          results.push({
            label: `${integration.label} (API key)`,
            configPath: attached.tokenPath,
            status: hadKey ? "updated" : "added",
          })
        } else {
          oauthTargets.push(integration.label)
          if (opts.pluginUrl) {
            const ur = integration.plugin.setMcpUrl(opts.pluginUrl)
            console.log(`  ↳ plugin endpoint → ${opts.pluginUrl}  (${ur.configPath})`)
          }
        }
        continue
      }

      // A key must never land in project-scoped config that could be committed,
      // so bearer-header clients are always written user-scoped (0600) — that
      // is what their writers do, independent of the scope chosen above.
      const keyClient = key ? findKeyClient(integration.id) : undefined
      if (key && keyClient) {
        const hadEntry = hasKeyClientEntry(keyClient)
        const attached = attachClientKey(keyClient, mcpUrl, key.token)
        attachedKey = key
        results.push({
          label: `${integration.label} (API key)`,
          configPath: attached.configPath,
          status: hadEntry ? "updated" : "added",
        })
        if (attached.keychainError) {
          notes.push(
            `${integration.label}: ${attached.keychainError}\n` +
              "  The key is still active in the client config; it just wasn't saved to the keychain.",
          )
        }
        if (attached.note) notes.push(`${integration.label}: ${attached.note}`)
        continue
      }

      const r = integration.install(dir, { baseUrl, global: isGlobal })
      results.push({
        label: integration.label,
        configPath: r.configPath,
        status: r.existed ? "updated" : "added",
      })
      oauthTargets.push(integration.label)
      if (key) {
        // Selected, wired up, but this tool has no way to carry the key — say
        // so instead of letting the user assume the key applies everywhere.
        notes.push(`${integration.label}: no API-key support — sign in from the tool (OAuth) to authorize.`)
      }
    } catch (err) {
      console.error(`  ${integration.label}: failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Apply the usage-tracking plan (its prompts and minting already ran above).
  if (telemetry.note) notes.push(telemetry.note)
  if (telemetry.plan) {
    try {
      const { existed } = writeTelemetryEnv(telemetry.plan.configPath, telemetry.plan.env)
      results.push({
        label: "Claude Code (usage tracking)",
        configPath: telemetry.plan.configPath,
        status: existed ? "updated" : "added",
      })
      if (!telemetry.plan.isGlobalScope) {
        notes.push(
          "Usage tracking: the usage key lands in .claude/settings.json, which is often committed. " +
            'It is a write-only ingest credential (it cannot read anything), but pick "All projects" if you don\'t want it in the repo.',
        )
      }
    } catch (err) {
      console.error(`  Claude Code (usage tracking): failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (results.length === 0) return

  // The status column is what distinguishes a first write from one that
  // replaced something already there (a re-run, or a key swapped out).
  const colWidth = Math.max(...results.map((r) => r.label.length)) + 2
  const statusWidth = Math.max(...results.map((r) => r.status.length)) + 2
  for (const r of results) {
    const icon = r.status === "skipped" ? "-" : "✓"
    console.log(`  ${icon} ${r.label.padEnd(colWidth)}${r.status.padEnd(statusWidth)}${r.configPath}`)
  }

  console.log()
  console.log(`  Endpoint:  ${mcpUrl}`)
  if (attachedKey) console.log(`  CLI key:   ${maskToken(attachedKey.token)}`)
  if (telemetry.plan) console.log(`  Usage:     ${buildIngestUrl(baseUrl)}`)

  for (const note of notes) {
    console.log()
    console.log(`  ${note}`)
  }

  const changed = results.some((r) => r.status !== "skipped")
  if (!changed && !pluginInstalled) return

  console.log()
  console.log("Next steps:")
  console.log("  1. Restart your AI tools to activate the OpenTrace MCP server.")
  if (pluginInstalled) {
    console.log("     Claude Code will prompt to install the OpenTrace plugin — accept it, then run /reload-plugins.")
    if (!attachedKey && !opts.pluginUrl) {
      console.log("     (it will also ask for the MCP endpoint — the default is production)")
    }
  }

  // Only the tools that ended up without a key still need a sign-in, so name
  // them rather than pointing everyone at Claude Code's /mcp. Tools that were
  // skipped or failed to write never reach this list.
  if (oauthTargets.length > 0) {
    const suffix = oauthTargets.includes("Claude Code") ? " (in Claude Code: /mcp)" : ""
    console.log(`  2. Sign in to OpenTrace from ${oauthTargets.join(", ")} to authorize${suffix}.`)
  } else if (attachedKey) {
    console.log("  2. That's it — your API key is already attached.")
  }

  if (attachedKey) {
    console.log()
    console.log("Heads up: API keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")
  }
}
