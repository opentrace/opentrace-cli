import path from "node:path"
import { select, checkbox, confirm } from "@inquirer/prompts"
import { ALL_INTEGRATIONS } from "../util/detect.js"
import { KEY_CLIENTS } from "../key-clients/index.js"
import { SERVER_KEY, DEFAULT_BASE_URL, MARKETPLACE_NAME, PLUGIN_NAME, normalizeMcpUrl, pluginId } from "../util/constants.js"
import { hasJsonEntry } from "../util/json-config.js"
import { deleteToken, getToken, KeychainUnavailableError } from "../util/keychain.js"
import { claudeSettingsPath, hasTelemetryEnv, removeTelemetryEnv } from "../util/telemetry.js"
import { removeInstalledPlugin } from "../util/claude-plugins.js"
import claudeCode from "../integrations/claude-code.js"

interface DisconnectOptions {
  mcp?: boolean
  plugin?: boolean
  keychain?: boolean
  usage?: boolean
  all?: boolean
  client?: string
  global?: boolean
  url?: string
  yes?: boolean
}

type Component = "mcp" | "plugin" | "keychain" | "usage"

/** Every component, for `--all` and for the non-interactive default. */
const ALL_COMPONENTS: Component[] = ["mcp", "plugin", "keychain", "usage"]

/** A single removable OpenTrace MCP server entry (from a key-client or an editor integration). */
interface McpTarget {
  id: string
  label: string
  configPath: string
  present: boolean
  remove: () => { removed: boolean; url?: string }
}

function buildMcpTargets(projectDir: string, includeGlobal: boolean): McpTarget[] {
  const targets: McpTarget[] = []

  // API-key clients (user-scoped, header-bearing configs).
  for (const c of KEY_CLIENTS) {
    const configPath = c.configPath()
    targets.push({
      id: c.id,
      label: `${c.label} (API key)`,
      configPath,
      present: hasJsonEntry(configPath, "mcpServers", SERVER_KEY),
      remove: () => {
        const r = c.remove()
        return { removed: r.removed, url: r.url }
      },
    })
  }

  // Editor-onboarding integrations at project scope, plus global when requested.
  const scopes: Array<{ global: boolean; suffix: string }> = [{ global: false, suffix: "" }]
  if (includeGlobal) scopes.push({ global: true, suffix: " (global)" })
  for (const i of ALL_INTEGRATIONS) {
    for (const s of scopes) {
      const configPath = i.getConfigPath(projectDir, { global: s.global })
      targets.push({
        id: i.id,
        label: `${i.label}${s.suffix}`,
        configPath,
        present: i.hasEntry(projectDir, { global: s.global }),
        remove: () => ({ removed: i.remove(projectDir, { global: s.global }).removed }),
      })
    }
  }

  // Dedupe by resolved path (a key-client and an integration global can share a file).
  const seen = new Set<string>()
  return targets.filter((t) => {
    const key = path.resolve(t.configPath)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function resolveComponents(opts: DisconnectOptions): Promise<Component[]> {
  const explicit: Component[] = []
  if (opts.mcp) explicit.push("mcp")
  if (opts.plugin) explicit.push("plugin")
  if (opts.keychain) explicit.push("keychain")
  if (opts.usage) explicit.push("usage")
  if (explicit.length > 0) return explicit
  if (opts.all) return ALL_COMPONENTS

  if (!process.stdin.isTTY || opts.yes) return ALL_COMPONENTS

  // Single-select with an explicit "everything" option — a pre-checked multi-select
  // reads as "highlight to pick", so users submit everything by accident.
  const choice = await select<Component | "all">({
    message: "What should otx disconnect?",
    choices: [
      { name: "Everything (MCP entries + plugin + keychain key + usage monitoring)", value: "all" },
      { name: "MCP server entries only", value: "mcp" },
      { name: "Claude Code plugin only", value: "plugin" },
      { name: "API key in the OS keychain only", value: "keychain" },
      { name: "Usage monitoring only (the OTEL env block)", value: "usage" },
    ],
  })
  return choice === "all" ? ALL_COMPONENTS : [choice]
}

export async function disconnect(targetPath: string, opts: DisconnectOptions): Promise<void> {
  const dir = path.resolve(targetPath)
  const isGlobal = opts.global ?? false
  const components = await resolveComponents(opts)
  if (components.length === 0) {
    console.log("Nothing selected. Aborted.")
    return
  }

  const removedUrls = new Set<string>()
  let didSomething = false

  // ---- MCP ----
  if (components.includes("mcp")) {
    let targets = buildMcpTargets(dir, isGlobal).filter((t) => t.present)
    if (opts.client) targets = targets.filter((t) => t.id === opts.client)

    if (targets.length === 0) {
      console.log(opts.client
        ? `No OpenTrace MCP entry found for "${opts.client}".`
        : "No OpenTrace MCP entries found.")
    } else {
      // Let the user pick which, when interactive and more than one and not pinned to --client.
      let selected = targets
      if (process.stdin.isTTY && !opts.yes && !opts.client && targets.length > 1) {
        const pick = await checkbox<string>({
          message: "Remove OpenTrace MCP from which clients?",
          choices: targets.map((t) => ({ name: `${t.label}  — ${t.configPath}`, value: t.configPath, checked: true })),
        })
        selected = targets.filter((t) => pick.includes(t.configPath))
      } else if (!opts.yes) {
        const go = await confirm({
          message: `Remove the OpenTrace MCP entry from ${targets.length} config file(s)?`,
          default: true,
        })
        if (!go) selected = []
      }

      for (const t of selected) {
        const r = t.remove()
        if (r.removed) {
          didSomething = true
          if (r.url) removedUrls.add(normalizeMcpUrl(r.url))
          console.log(`  ✓ removed MCP from ${t.label.padEnd(22)} ${t.configPath}`)
        }
      }
    }
  }

  // ---- Plugin ----
  if (components.includes("plugin") && claudeCode.plugin) {
    // remove() clears the declaration: project + user settings, pluginConfigs and
    // the key file.
    const r = claudeCode.plugin.remove(dir, { global: isGlobal })
    if (r.removed) {
      didSomething = true
      console.log("  ✓ removed OpenTrace plugin (declaration, mcp_url, API-key file)")
    } else {
      console.log("No OpenTrace plugin declaration found.")
    }

    // Removing the declaration takes the MCP server away but leaves the plugin
    // listed in `/plugin`, because that reads Claude Code's own install records.
    // Attempted whatever the declaration turned out to be — a machine can have
    // the plugin installed with the declaration already gone, and that is exactly
    // the state that used to be unreachable without `claude plugin uninstall`.
    const cache = removeInstalledPlugin(pluginId(), MARKETPLACE_NAME, PLUGIN_NAME)
    if (cache.uninstalled || cache.marketplaceForgotten) {
      didSomething = true
      const parts: string[] = []
      if (cache.uninstalled) parts.push("uninstalled")
      if (cache.marketplaceForgotten) parts.push("marketplace forgotten")
      console.log(`  ✓ removed OpenTrace from Claude Code's plugin list (${parts.join(", ")})`)
      for (const removed of cache.removedPaths) {
        console.log(`    deleted ${removed}`)
      }
      console.log("    Restart Claude Code (or /reload-plugins) for `/plugin` to catch up.")
    }
    for (const file of cache.skipped) {
      // Better to say so than to report a clean disconnect that is not one.
      console.warn(`  ! left ${file} alone — it is not in a format this version understands.`)
      console.warn("    Run `claude plugin uninstall opentrace@opentrace` to finish removing it.")
    }
  }

  // ---- Keychain ----
  if (components.includes("keychain")) {
    const urls = new Set<string>(removedUrls)
    if (opts.url) urls.add(normalizeMcpUrl(opts.url))
    urls.add(normalizeMcpUrl(DEFAULT_BASE_URL))
    let deleted = 0
    try {
      for (const u of urls) {
        if (getToken(u)) {
          deleteToken(u)
          deleted++
          didSomething = true
          console.log(`  ✓ deleted keychain key for       ${u}`)
        }
      }
      if (deleted === 0) {
        console.log(
          "No stored API key found in the keychain." +
            (opts.url ? "" : " (For a non-default host, pass --url.)"),
        )
      }
    } catch (err) {
      if (err instanceof KeychainUnavailableError) {
        console.warn(`Keychain unavailable: ${err.message}`)
      } else {
        throw err
      }
    }
  }

  // ---- Usage monitoring ----
  // Both scopes, unconditionally: this is the one component whose leftovers keep
  // *doing* something. An MCP entry the tool can no longer authenticate is
  // inert, but a live telemetry block goes on exporting to OpenTrace after a
  // disconnect the user believes was total — so `--global` does not gate it.
  if (components.includes("usage")) {
    const paths = [
      claudeSettingsPath(dir, { global: false }),
      claudeSettingsPath(dir, { global: true }),
    ].filter((p, i, all) => all.indexOf(p) === i)

    const present = paths.filter((p) => hasTelemetryEnv(p))
    if (present.length === 0) {
      console.log("No usage monitoring configured.")
    } else {
      let go = true
      if (!opts.yes && process.stdin.isTTY) {
        go = await confirm({
          message: `Stop usage monitoring and remove the OTEL env block from ${present.length} settings file(s)?`,
          default: true,
        })
      }
      if (go) {
        // Tracked separately from `didSomething`, which is shared with the MCP
        // and keychain components: gating the footer on that would announce an
        // orphaned usage key because an MCP entry was removed, on a run where
        // every telemetry block turned out to be someone else's.
        let usageRemoved = false
        for (const configPath of present) {
          const r = removeTelemetryEnv(configPath)
          if (r.removed) {
            didSomething = true
            usageRemoved = true
            console.log(`  ✓ removed usage monitoring from   ${configPath}`)
          } else if (r.foreign) {
            // Claude Code's OTEL settings are general-purpose. A block pointing
            // somewhere other than OpenTrace belongs to the user, not to us.
            console.warn(
              `  ! left the telemetry block in ${configPath} alone — it does not point at OpenTrace.`,
            )
          } else if (r.error) {
            // The block is ours and still there. Silence here would read as
            // "nothing to remove" while telemetry kept flowing.
            console.error(`  ✗ could not remove usage monitoring from ${configPath} — ${r.error}`)
          }
        }
        // The key stays valid server-side; it is simply no longer configured.
        if (usageRemoved) {
          console.log("    (the usage key itself still exists — revoke it in the OpenTrace dashboard if you want it gone)")
        }
      }
    }
  }

  console.log()
  console.log(didSomething
    ? "Done. Restart your AI tools to drop the connection."
    : "Nothing to disconnect.")
}
