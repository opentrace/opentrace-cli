import path from "node:path"
import { checkbox, confirm } from "@inquirer/prompts"
import { ALL_INTEGRATIONS } from "../util/detect.js"
import { KEY_CLIENTS } from "../key-clients/index.js"
import { SERVER_KEY, DEFAULT_BASE_URL, normalizeMcpUrl } from "../util/constants.js"
import { hasJsonEntry } from "../util/json-config.js"
import { deleteToken, getToken, KeychainUnavailableError } from "../util/keychain.js"
import claudeCode from "../integrations/claude-code.js"

interface DisconnectOptions {
  mcp?: boolean
  plugin?: boolean
  keychain?: boolean
  all?: boolean
  client?: string
  global?: boolean
  url?: string
  yes?: boolean
}

type Component = "mcp" | "plugin" | "keychain"

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
  if (explicit.length > 0) return explicit
  if (opts.all) return ["mcp", "plugin", "keychain"]

  if (!process.stdin.isTTY || opts.yes) return ["mcp", "plugin", "keychain"]

  const chosen = await checkbox<Component>({
    message: "What should otx disconnect?",
    choices: [
      { name: "MCP server entries", value: "mcp", checked: true },
      { name: "Claude Code plugin", value: "plugin", checked: true },
      { name: "API key in the OS keychain", value: "keychain", checked: true },
    ],
  })
  return chosen
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
    const scopes = isGlobal ? [false, true] : [false]
    let any = false
    for (const g of scopes) {
      const r = claudeCode.plugin.remove(dir, { global: g })
      if (r.removed) {
        any = true
        didSomething = true
        console.log(`  ✓ removed plugin declaration     ${r.configPath}`)
      }
    }
    if (!any) console.log("No OpenTrace plugin declaration found.")
    else console.log("    (also run `claude plugin uninstall opentrace@opentrace` to drop the installed plugin cache)")
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

  console.log()
  console.log(didSomething
    ? "Done. Restart your AI tools to drop the connection."
    : "Nothing to disconnect.")
}
