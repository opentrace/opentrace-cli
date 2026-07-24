#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { Command } from "commander"
import { addMcp } from "./commands/add-mcp.js"
import { install } from "./commands/install.js"
import { connectWithKey } from "./commands/connect.js"
import { disconnect } from "./commands/disconnect.js"
import { ALL_INTEGRATIONS } from "./util/detect.js"
import { DEFAULT_BASE_URL, toBaseUrl, buildMcpUrl } from "./util/constants.js"
import { looksLikeToken } from "./util/token.js"

// Read the version from package.json at runtime so `--version` never drifts from
// the published package. dist/index.js → ../package.json resolves to the package
// root, which npm always ships.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }

const program = new Command()

program
  .name("opentrace")
  .description("CLI for setting up and managing OpenTrace integrations")
  .version(version)

program
  .command("add-mcp [path]")
  .description("Add the OpenTrace MCP server to a Claude Code project (.mcp.json)")
  .option("--base-url <url>", "OpenTrace API base URL", DEFAULT_BASE_URL)
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (targetPath: string | undefined, opts) => {
    await addMcp(targetPath ?? ".", { baseUrl: opts.baseUrl, yes: opts.yes })
  })

/** Options shared by the editor-config onboarding path (used by `install` and the path form of `connect`). */
function addInstallOptions(cmd: Command): Command {
  cmd
    .option("--base-url <url>", "OpenTrace API base URL", DEFAULT_BASE_URL)
    .option("--url <url>", "OpenTrace MCP endpoint (overrides --base-url; fed to the plugin's mcp_url)")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("-g, --global", "Install to user-level config instead of project-level")
  ALL_INTEGRATIONS.forEach((i) => {
    cmd.option(`--${i.id}`, `${i.label}: ${i.helpText}`)
  })
  return cmd
}

/**
 * Resolve the onboarding endpoint. Returns the host base (for direct MCP entries)
 * and, when a URL was explicitly given, the full MCP URL to inject into the plugin.
 */
function resolveEndpoint(opts: { url?: string; baseUrl?: string }): { baseUrl: string; pluginUrl?: string } {
  const explicit =
    opts.url ?? (opts.baseUrl && opts.baseUrl !== DEFAULT_BASE_URL ? opts.baseUrl : undefined)
  const base = toBaseUrl(explicit ?? opts.baseUrl ?? DEFAULT_BASE_URL)
  return { baseUrl: base, pluginUrl: explicit ? buildMcpUrl(base) : undefined }
}

const installCmd = addInstallOptions(
  program
    .command("install [path]")
    .description("Onboard OpenTrace: register the MCP server (and the Claude Code plugin where supported) for all detected AI tools (or specific ones)"),
)

installCmd.action(async (targetPath: string | undefined, opts) => {
  const { baseUrl, pluginUrl } = resolveEndpoint(opts)
  await install(targetPath ?? ".", {
    baseUrl,
    pluginUrl,
    yes: opts.yes,
    global: opts.global,
    toolOpts: opts as Record<string, unknown>,
  })
})

// `connect` is overloaded:
//   otx connect otk_<token> [--url <host>] [--client <id>]   → API-key onboarding
//   otx connect [path]                                        → editor MCP/plugin onboarding
const connectCmd = addInstallOptions(
  program
    .command("connect [token-or-path]")
    .description("Connect a client to OpenTrace with an API key (otk_…), or onboard editors when given a path"),
)
connectCmd
  .option("--client <id>", "Target client for the API-key flow: claude-code | claude-desktop | cursor")
  .action(async (tokenOrPath: string | undefined, opts) => {
    if (tokenOrPath && looksLikeToken(tokenOrPath)) {
      await connectWithKey(tokenOrPath, { url: opts.url, client: opts.client })
      return
    }
    const { baseUrl, pluginUrl } = resolveEndpoint(opts)
    await install(tokenOrPath ?? ".", {
      baseUrl,
      pluginUrl,
      yes: opts.yes,
      global: opts.global,
      toolOpts: opts as Record<string, unknown>,
    })
  })

program
  .command("disconnect [path]")
  .description("Remove OpenTrace from your clients: MCP entries, the Claude Code plugin, and/or the stored API key")
  .option("--mcp", "Remove OpenTrace MCP server entries")
  .option("--plugin", "Remove the Claude Code plugin declaration")
  .option("--keychain", "Delete the stored API key from the OS keychain")
  .option("--all", "Remove everything (MCP + plugin + keychain)")
  .option("--client <id>", "Restrict MCP removal to one client (claude-code | claude-desktop | cursor | …)")
  .option("--url <url>", "Keychain endpoint whose key to delete (for a non-default host)")
  .option("-g, --global", "Also check user-level editor configs")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (targetPath: string | undefined, opts) => {
    await disconnect(targetPath ?? ".", {
      mcp: opts.mcp,
      plugin: opts.plugin,
      keychain: opts.keychain,
      all: opts.all,
      client: opts.client,
      global: opts.global,
      url: opts.url,
      yes: opts.yes,
    })
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof Error && err.message.includes("force closed")) {
    process.exit(0)
  }
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
