#!/usr/bin/env node
import { Command } from "commander"
import { addMcp } from "./commands/add-mcp.js"
import { install } from "./commands/install.js"
import { connectWithKey } from "./commands/connect.js"
import { login } from "./commands/login.js"
import { disconnect } from "./commands/disconnect.js"
import { ALL_INTEGRATIONS } from "./util/detect.js"
import { DEFAULT_BASE_URL, toBaseUrl, buildMcpUrl } from "./util/constants.js"
import { looksLikeToken } from "./util/token.js"
import { packageVersion } from "./util/version.js"
import { printNotices } from "./util/notices.js"

// Read at runtime so `--version` never drifts from the published package.
const version = packageVersion()

const program = new Command()

program
  .name("opentrace")
  .description("CLI for setting up and managing OpenTrace integrations")
  .version(version)

// Anything the user should know before the command they asked for speaks: a
// newer release, or a key that has stopped being accepted. A preAction hook is
// the right seam — it runs ahead of the action handler's own output, and never
// for `--help` or `--version`, which run no action at all. Bounded, cached, and
// silent outside an interactive terminal; see util/notices.ts.
program.hook("preAction", async (_program, actionCommand) => {
  const opts = actionCommand.opts() as { url?: string; baseUrl?: string }
  await printNotices({
    command: actionCommand.name(),
    endpoint: opts.url ?? opts.baseUrl,
  })
})

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
    .option("--api-key <key>", "CLI key (otk_…) to attach; skips the interactive key prompt")
    .option("--express", "Express setup, no questions: every detected tool, all projects, browser sign-in, usage monitoring on")
    .option("--track-usage", "Monitor your Claude Code usage in OpenTrace without asking; requires Claude Code among the targets. With -g the level is settled too (no prompts)")
    .option("--no-track-usage", "Skip Claude Code usage monitoring without asking")
    .option("-y, --yes", "Skip prompts: use detected tools, project scope, and any key already stored")
    .option("-g, --global", "Install to user-level config instead of project-level")
  ALL_INTEGRATIONS.forEach((i) => {
    cmd.option(`--${i.id}`, `${i.label}: ${i.helpText}`)
  })
  return cmd
}

/**
 * Tri-state for --track-usage: commander defaults a defined `--no-` pair to
 * true, but "not stated" must stay distinguishable so the interactive prompt
 * can run — only a value the user actually typed counts.
 */
function explicitTrackUsage(cmd: Command): boolean | undefined {
  return cmd.getOptionValueSource("trackUsage") === "cli" ? (cmd.opts().trackUsage as boolean) : undefined
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
    .description("Onboard OpenTrace: detect your AI tools, then register the MCP server (and the Claude Code plugin where supported) for the ones you pick"),
)

installCmd.action(async (targetPath: string | undefined, opts) => {
  const { baseUrl, pluginUrl } = resolveEndpoint(opts)
  await install(targetPath ?? ".", {
    baseUrl,
    pluginUrl,
    apiKey: opts.apiKey,
    express: opts.express,
    trackUsage: explicitTrackUsage(installCmd),
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
      // Both forms carry a key; the positional argument is the one this branch
      // exists for, so say which one wins rather than dropping the flag silently.
      if (opts.apiKey && opts.apiKey !== tokenOrPath) {
        console.warn("Both a key argument and --api-key were given — using the key argument, ignoring --api-key.")
      }
      await connectWithKey(tokenOrPath, {
        url: opts.url,
        client: opts.client,
        trackUsage: explicitTrackUsage(connectCmd),
        global: opts.global,
        yes: opts.yes,
      })
      return
    }
    const { baseUrl, pluginUrl } = resolveEndpoint(opts)
    await install(tokenOrPath ?? ".", {
      baseUrl,
      pluginUrl,
      apiKey: opts.apiKey,
      express: opts.express,
      trackUsage: explicitTrackUsage(connectCmd),
      yes: opts.yes,
      global: opts.global,
      toolOpts: opts as Record<string, unknown>,
    })
  })

// The browser front end to onboarding: OAuth sign-in mints the CLI key, then the
// `install` flow takes over with it — so the dashboard's recommended one-liner
// gets Express/Custom, tool detection and scope, not just one client. `--client`
// narrows it to the single-client key flow instead (the only route to Claude
// Desktop). Automation keeps using `connect otk_…` / `install --api-key` — login
// refuses non-TTY runs.
const loginCmd = program
  .command("login")
  .description("Sign in to OpenTrace in your browser, then set up your tools (mints a CLI key)")
  .option("--base-url <url>", "OpenTrace API base URL", DEFAULT_BASE_URL)
  .option("--url <url>", "OpenTrace MCP endpoint or host (overrides --base-url)")
  .option("--client <id>", "Target client for the minted key: claude-code | claude-desktop | cursor")
  .option("--no-browser", "Don't launch a browser — print the sign-in URL to open manually")
  .option("--track-usage", "Monitor your Claude Code usage in OpenTrace without asking")
  .option("--no-track-usage", "Skip Claude Code usage monitoring without asking")
  .option("-g, --global", "User-level scope for the usage-monitoring settings file")
  .option("-y, --yes", "Take the default answer to every prompt — including keeping a CLI key that is still valid (a TTY and browser are still required)")
loginCmd.action(async (opts) => {
  await login({
    url: opts.url,
    baseUrl: opts.baseUrl,
    client: opts.client,
    browser: opts.browser,
    trackUsage: explicitTrackUsage(loginCmd),
    global: opts.global,
    yes: opts.yes,
  })
})

program
  .command("disconnect [path]")
  .description("Remove OpenTrace from your clients: MCP entries, the Claude Code plugin, and/or the stored API key")
  .option("--mcp", "Remove OpenTrace MCP server entries")
  .option("--plugin", "Remove the Claude Code plugin declaration")
  .option("--keychain", "Delete the stored API key from the OS keychain")
  .option("--usage", "Stop usage monitoring: remove the OTEL env block from Claude Code settings (both scopes)")
  .option("--all", "Remove everything (MCP + plugin + keychain + usage monitoring)")
  .option("--client <id>", "Restrict MCP removal to one client (claude-code | claude-desktop | cursor | …)")
  .option("--url <url>", "Keychain endpoint whose key to delete (for a non-default host)")
  .option("-g, --global", "Also check user-level editor configs")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (targetPath: string | undefined, opts) => {
    await disconnect(targetPath ?? ".", {
      mcp: opts.mcp,
      plugin: opts.plugin,
      keychain: opts.keychain,
      usage: opts.usage,
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
