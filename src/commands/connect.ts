import os from "node:os"
import { normalizeMcpUrl, DEFAULT_BASE_URL } from "../util/constants.js"
import { validateTokenShape, maskToken } from "../util/token.js"
import { probeMcp } from "../util/mcp-probe.js"
import { storeToken, KeychainUnavailableError } from "../util/keychain.js"
import { writePluginToken } from "../util/plugin-token.js"
import { findKeyClient, detectKeyClients, KEY_CLIENTS, DEFAULT_KEY_CLIENT } from "../key-clients/index.js"
import claudeCode from "../integrations/claude-code.js"

interface ConnectKeyOptions {
  url?: string
  client?: string
}

const DISCOVERY_TOOLS = ["workspaces_list", "environments_list"]

/**
 * `otx connect otk_<token>` — authenticate a client to the tenant-global
 * OpenTrace MCP endpoint with an API key. Validates the key by an MCP handshake,
 * then writes the client's MCP config with the bearer header. Never echoes the token.
 */
export async function connectWithKey(token: string, opts: ConnectKeyOptions): Promise<void> {
  // 1. Fail fast on shape — cheap and offline.
  const shapeError = validateTokenShape(token)
  if (shapeError) {
    console.error(`Invalid API key: ${shapeError}`)
    process.exit(1)
  }

  // 2. Resolve the endpoint.
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

  // 4. Validate the key with a real MCP handshake (REST would reject it).
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
      claudeCode.plugin.setMcpUrl(mcpUrl)
      tokenPath = writePluginToken(token)
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
    console.log()
    console.log("Restart Claude Code (or /reload-plugins) to activate — the plugin authenticates with your API key.")
    console.log("Heads up: API keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")
    return
  }

  // 5b. Cursor / Claude Desktop: write the MCP entry with the bearer header directly.
  let note: string | undefined
  let configPath: string
  try {
    const result = client.write(mcpUrl, token)
    configPath = result.configPath
    note = result.note
  } catch (err) {
    console.error(`\nFailed to write ${client.label} config: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // 6. Persist to the OS keychain (otx's own record). Best-effort: the client
  //    config already carries the token, so a keychain miss doesn't break the
  //    connection — just warn.
  let keychainStored = false
  try {
    storeToken(mcpUrl, token)
    keychainStored = true
  } catch (err) {
    if (err instanceof KeychainUnavailableError) {
      console.warn(`\nNote: ${err.message}\nThe key is still active in the ${client.label} config; it just wasn't saved to the keychain.`)
    } else {
      throw err
    }
  }

  // 7. Report success — tenant-global, token masked.
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
  console.log()
  console.log(`Restart ${client.label} to activate the connection.`)
  console.log("Heads up: API keys can expire or be revoked — if calls start returning 401, reconnect with a fresh key.")

  // Surface other installed clients the user might also want to connect.
  const others = detectKeyClients().filter((c) => c.id !== client.id)
  if (others.length > 0) {
    console.log()
    console.log(`Also detected: ${others.map((c) => c.label).join(", ")}. Connect with --client <${others.map((c) => c.id).join("|")}>.`)
  }
}
