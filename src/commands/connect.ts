import os from "node:os"
import { normalizeMcpUrl, toBaseUrl, buildIngestUrl, DEFAULT_BASE_URL } from "../util/constants.js"
import { validateTokenShape, maskToken } from "../util/token.js"
import { probeMcp } from "../util/mcp-probe.js"
import { isInteractive } from "../util/tty.js"
import { attachClientKey, attachPluginKey } from "../util/attach-key.js"
import { resolveTelemetryPlan, writeTelemetryEnv } from "../util/telemetry.js"
import { findKeyClient, detectKeyClients, KEY_CLIENTS, DEFAULT_KEY_CLIENT } from "../key-clients/index.js"
import claudeCode from "../integrations/claude-code.js"

interface ConnectKeyOptions {
  url?: string
  client?: string
  /** Explicit --track-usage / --no-track-usage; undefined = not stated (prompt or skip). */
  trackUsage?: boolean
  global?: boolean
  yes?: boolean
}

const DISCOVERY_TOOLS = ["workspaces_list", "environments_list"]

/**
 * `otx connect otk_<token>` — authenticate a client to the tenant-global
 * OpenTrace MCP endpoint with a CLI key. Validates the key by an MCP handshake,
 * then writes the client's MCP config with the bearer header. The same key
 * authenticates the usage-key endpoint for the optional usage-tracking step.
 * Never echoes the token.
 */
export async function connectWithKey(token: string, opts: ConnectKeyOptions): Promise<void> {
  // 1. Fail fast on shape — cheap and offline.
  const shapeError = validateTokenShape(token)
  if (shapeError) {
    console.error(`Invalid CLI key: ${shapeError}`)
    process.exit(1)
  }

  // 2. Resolve the endpoints.
  const baseUrl = toBaseUrl(opts.url ?? DEFAULT_BASE_URL)
  const mcpUrl = normalizeMcpUrl(opts.url ?? DEFAULT_BASE_URL)

  // 3. Resolve the target client before doing network work, so a bad --client
  //    fails before we touch anything.
  const clientId = opts.client ?? DEFAULT_KEY_CLIENT
  const client = findKeyClient(clientId)
  if (!client) {
    const ids = KEY_CLIENTS.map((c) => c.id).join(", ")
    console.error(`Unknown --client "${clientId}". Supported: ${ids}.`)
    process.exit(1)
  }

  // 4. Validate the key with a real MCP handshake (the CLI key's home surface).
  console.log(`Validating key against ${mcpUrl} …`)
  const probe = await probeMcp(mcpUrl, token)
  if (!probe.ok) {
    switch (probe.kind) {
      case "auth":
        console.error(`\nKey rejected: ${probe.message}`)
        console.error("Re-copy the key, or create a fresh one, then run connect again.")
        break
      case "provisioning":
        console.error(`\nTenant not ready: ${probe.message}`)
        console.error("This is usually temporary — retry shortly.")
        break
      case "network":
        console.error(`\nCould not reach the endpoint: ${probe.message}`)
        console.error(`Check the host and your connection (try --url if it is not ${DEFAULT_BASE_URL}).`)
        break
      default:
        console.error(`\nHandshake failed: ${probe.message}`)
    }
    process.exit(1) // nothing written
  }

  const hasDiscovery = DISCOVERY_TOOLS.some((t) => probe.tools.includes(t))
  const reachLine = `  Reach:     tenant-global — every environment and workspace this key can see (${probe.tools.length} MCP tools available).`

  // Usage tracking runs after the client attach succeeded, so a failed attach
  // never leaves a telemetry block behind. Defined here to share the closure.
  const maybeSetupUsageTracking = async (): Promise<void> => {
    const telemetry = await resolveTelemetryPlan({
      dir: process.cwd(),
      baseUrl,
      // Deliberately the OPPOSITE default from `install` (project-first):
      // connect onboards the machine (the plugin itself is written user-scoped
      // above), so its telemetry block defaults to user scope too. `install`
      // onboards a project, so it defaults project-side. Both are only the
      // select's default — an explicit -g wins outright, below.
      isGlobal: opts.global ?? true,
      explicitGlobal: opts.global,
      interactive: !opts.yes && isInteractive(),
      trackUsage: opts.trackUsage,
      cliToken: token,
      targetsClaudeCode: clientId === "claude-code",
    })
    if (telemetry.note) console.log(`\n${telemetry.note}`)
    if (!telemetry.plan) return
    try {
      const { existed } = writeTelemetryEnv(telemetry.plan.configPath, telemetry.plan.env)
      console.log()
      console.log(`✓ Usage tracking ${existed ? "updated" : "enabled"} for Claude Code`)
      console.log(`  Settings:  ${telemetry.plan.configPath}`)
      console.log(`  Ingest:    ${buildIngestUrl(baseUrl)}`)
      if (!telemetry.plan.isGlobalScope) {
        console.log('  Note: .claude/settings.json is often committed — the usage key is write-only (ingest only), but pick "All projects" if you don\'t want it in the repo.')
      }
    } catch (err) {
      console.error(`\nFailed to write usage tracking config: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 5a. Claude Code: the plugin supersedes a bare MCP entry, so attach the key to
  //     the plugin — seed its mcp_url and drop the key in the headersHelper token
  //     file. No direct ~/.claude.json header, no keychain (the token file is the
  //     plugin's source of truth; `disconnect --plugin` clears it).
  if (clientId === "claude-code") {
    if (!claudeCode.plugin) {
      console.error("\nClaude Code plugin capability is unavailable.")
      process.exit(1)
    }
    let settingsPath: string
    let tokenPath: string
    try {
      settingsPath = claudeCode.plugin.install(os.homedir(), { global: true }).configPath
      tokenPath = attachPluginKey(claudeCode.plugin, mcpUrl, token).tokenPath
    } catch (err) {
      console.error(`\nFailed to configure the Claude Code plugin: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    console.log()
    console.log(`✓ Connected Claude Code (plugin) to OpenTrace (${maskToken(token)})`)
    console.log(`  Endpoint:  ${mcpUrl}`)
    console.log(`  Plugin:    ${settingsPath}`)
    console.log(`  Key file:  ${tokenPath} (0600)`)
    console.log(reachLine)
    if (hasDiscovery) console.log(`  Start with ${DISCOVERY_TOOLS.join(" / ")} to discover, then target any workspace.`)

    await maybeSetupUsageTracking()

    console.log()
    console.log("Restart Claude Code (or /reload-plugins) to activate — the plugin authenticates with your CLI key.")
    console.log("Heads up: keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")
    return
  }

  // 5b. Cursor / Claude Desktop: write the MCP entry with the bearer header
  //     directly, then record the key in the OS keychain (otx's own record).
  //     The keychain write is best-effort — the client config already carries
  //     the token, so a miss doesn't break the connection; just warn.
  let note: string | undefined
  let configPath: string
  let keychainStored = false
  try {
    const attached = attachClientKey(client, mcpUrl, token)
    configPath = attached.configPath
    note = attached.note
    keychainStored = attached.keychainStored
    if (attached.keychainError) {
      console.warn(`\nNote: ${attached.keychainError}\nThe key is still active in the ${client.label} config; it just wasn't saved to the keychain.`)
    }
  } catch (err) {
    console.error(`\nFailed to write ${client.label} config: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // 6. Report success — tenant-global, token masked.
  console.log()
  console.log(`✓ Connected ${client.label} to OpenTrace (${maskToken(token)})`)
  console.log(`  Endpoint:  ${mcpUrl}`)
  console.log(`  Config:    ${configPath}`)
  if (keychainStored) console.log("  Key saved to the OS keychain.")
  console.log(reachLine)
  if (hasDiscovery) {
    console.log(`  Start with ${DISCOVERY_TOOLS.join(" / ")} to discover, then target any workspace.`)
  }
  if (note) console.log(`\n  ${note}`)

  // Honored for other clients only when asked for explicitly (--track-usage) —
  // the block lands in Claude Code settings, the one place it means anything.
  await maybeSetupUsageTracking()

  console.log()
  console.log(`Restart ${client.label} to activate the connection.`)
  console.log("Heads up: keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")

  // Surface other installed clients the user might also want to connect.
  const others = detectKeyClients().filter((c) => c.id !== client.id)
  if (others.length > 0) {
    console.log()
    console.log(`Also detected: ${others.map((c) => c.label).join(", ")}. Connect with --client <${others.map((c) => c.id).join("|")}>.`)
  }
}
