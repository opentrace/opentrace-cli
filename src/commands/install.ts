import path from "node:path"
import fs from "node:fs"
import { checkbox, confirm, password, select } from "@inquirer/prompts"
import { ALL_INTEGRATIONS, detectInstalled } from "../util/detect.js"
import { DEFAULT_BASE_URL, buildMcpUrl } from "../util/constants.js"
import { isInteractive } from "../util/tty.js"
import { maskToken, validateTokenShape } from "../util/token.js"
import { probeMcp } from "../util/mcp-probe.js"
import { getToken, KeychainUnavailableError } from "../util/keychain.js"
import { readPluginToken } from "../util/plugin-token.js"
import { attachClientKey, attachPluginKey } from "../util/attach-key.js"
import { findKeyClient } from "../key-clients/index.js"
import type { Integration } from "../integrations/types.js"

interface InstallCommandOptions {
  baseUrl?: string
  /** Full MCP URL to inject into the plugin's userConfig; set only when a URL was explicitly given. */
  pluginUrl?: string
  /** API key supplied on the command line — the non-interactive form of the key prompt. */
  apiKey?: string
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

/** True if OpenTrace is already wired into this integration at the given scope. */
function isConfigured(integration: Integration, dir: string, isGlobal: boolean): boolean {
  const opts = { global: isGlobal }
  return integration.plugin
    ? integration.plugin.isEnabled(dir, opts)
    : integration.hasEntry(dir, opts)
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
    const configured = isConfigured(integration, dir, isGlobal)
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

type KeySource = "flag" | "keychain" | "plugin" | "prompt"

interface ResolvedKey {
  token: string
  source: KeySource
}

interface KeyCheck {
  ok: boolean
  /** True when the key itself was rejected, as opposed to the check not completing. */
  rejected: boolean
  message?: string
  toolCount?: number
}

/**
 * Confirm a key with a real MCP handshake. Only a 401 tells us the key is bad —
 * a network or provisioning failure says nothing about the key, so those are
 * reported as "unverified" and the key is still used.
 */
async function checkKey(mcpUrl: string, token: string): Promise<KeyCheck> {
  const probe = await probeMcp(mcpUrl, token)
  if (probe.ok) return { ok: true, rejected: false, toolCount: probe.tools.length }
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
 * flag, a key this machine already holds, then (interactively) a prompt.
 * Returning undefined means "no key" — the tools fall back to signing in with
 * OAuth from inside the tool, which is a fully supported outcome, not an error.
 */
async function resolveApiKey(
  mcpUrl: string,
  opts: { apiKey?: string; interactive: boolean },
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
    const check = await checkKey(mcpUrl, existing.token)
    if (check.ok) {
      console.log(`Using the API key already stored in your ${where} (${maskToken(existing.token)}).`)
      return existing
    }
    if (check.rejected) {
      // Expired or revoked — say so and fall through, rather than silently
      // re-attaching a key that returns 401 on every call.
      console.warn(`The API key stored in your ${where} was rejected — ${check.message}`)
    } else {
      console.warn(`Could not verify the stored API key — ${check.message}`)
      return existing
    }
  }

  if (!opts.interactive) return undefined

  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const entered = (
      await password({
        message: "OpenTrace API key (otk_…) — leave blank to sign in from your tool instead:",
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
  let targets: Integration[]
  if (explicitTargets.length > 0) {
    targets = explicitTargets
  } else if (interactive) {
    targets = await promptTargets(dir, isGlobal)
    if (targets.length === 0) {
      console.log("No tools selected — nothing to do.")
      return
    }
  } else {
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
  const key = await resolveApiKey(mcpUrl, { apiKey: opts.apiKey, interactive })

  console.log()
  const results: Row[] = []
  let pluginInstalled = false
  let keyAttached = false
  const notes: string[] = []

  for (const integration of targets) {
    // Targets picked in the prompt were an explicit choice — re-asking
    // "overwrite?" for each one would just re-confirm what the user already
    // said. The flag path never showed a list, so it still confirms.
    const needsOverwriteConfirm = explicitTargets.length > 0 && !opts.yes && interactive
    if (needsOverwriteConfirm && isConfigured(integration, dir, isGlobal)) {
      const configPath = integration.plugin
        ? integration.plugin.getConfigPath(dir, { global: isGlobal })
        : integration.getConfigPath(dir, { global: isGlobal })
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
          // Seeding mcp_url alongside the key is what makes the plugin fully
          // non-interactive: with both present it never asks for an endpoint
          // and authenticates straight away.
          const attached = attachPluginKey(integration.plugin, mcpUrl, key.token)
          keyAttached = true
          results.push({
            label: `${integration.label} (API key)`,
            configPath: attached.tokenPath,
            status: "added",
          })
        } else if (opts.pluginUrl) {
          const ur = integration.plugin.setMcpUrl(opts.pluginUrl)
          console.log(`  ↳ plugin endpoint → ${opts.pluginUrl}  (${ur.configPath})`)
        }
        continue
      }

      // A key must never land in project-scoped config that could be committed,
      // so bearer-header clients are always written user-scoped (0600) — that
      // is what their writers do, independent of the scope chosen above.
      const keyClient = key ? findKeyClient(integration.id) : undefined
      if (key && keyClient) {
        const attached = attachClientKey(keyClient, mcpUrl, key.token)
        keyAttached = true
        results.push({
          label: `${integration.label} (API key)`,
          configPath: attached.configPath,
          status: "added",
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
      if (key) {
        // Selected, wired up, but this tool has no way to carry the key — say
        // so instead of letting the user assume the key applies everywhere.
        notes.push(`${integration.label}: no API-key support — sign in from the tool (OAuth) to authorize.`)
      }
    } catch (err) {
      console.error(`  ${integration.label}: failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (results.length === 0) return

  const colWidth = Math.max(...results.map((r) => r.label.length)) + 2
  for (const r of results) {
    const icon = r.status === "skipped" ? "-" : "✓"
    console.log(`  ${icon} ${r.label.padEnd(colWidth)} ${r.configPath}`)
  }

  console.log()
  console.log(`  Endpoint:  ${mcpUrl}`)
  if (keyAttached && key) console.log(`  API key:   ${maskToken(key.token)}`)

  for (const note of notes) {
    console.log()
    console.log(`  ${note}`)
  }

  const changed = results.some((r) => r.status !== "skipped")
  if (changed || pluginInstalled) {
    console.log()
    console.log("Next steps:")
    console.log("  1. Restart your AI tools to activate the OpenTrace MCP server.")
    if (pluginInstalled) {
      console.log("     Claude Code will prompt to install the OpenTrace plugin — accept it, then run /reload-plugins.")
      if (!key && !opts.pluginUrl) {
        console.log("     (it will also ask for the MCP endpoint — the default is production)")
      }
    }
    if (keyAttached) {
      console.log("  2. That's it — your API key is already attached.")
      console.log()
      console.log("Heads up: API keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")
    } else {
      console.log("  2. In Claude Code, run /mcp and sign in to OpenTrace to authorize the connection.")
    }
  }
}
