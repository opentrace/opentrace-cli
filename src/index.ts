#!/usr/bin/env node
import { Command } from "commander"
import { addMcp } from "./commands/add-mcp.js"
import { install } from "./commands/install.js"
import { connectWithKey } from "./commands/connect.js"
import { ALL_INTEGRATIONS } from "./util/detect.js"
import { DEFAULT_BASE_URL } from "./util/constants.js"
import { looksLikeToken } from "./util/token.js"

const program = new Command()

program
  .name("opentrace")
  .description("CLI for setting up and managing OpenTrace integrations")
  .version("0.1.0")

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
    .option("-y, --yes", "Skip confirmation prompts")
    .option("-g, --global", "Install to user-level config instead of project-level")
  ALL_INTEGRATIONS.forEach((i) => {
    cmd.option(`--${i.id}`, `${i.label}: ${i.helpText}`)
  })
  return cmd
}

const installCmd = addInstallOptions(
  program
    .command("install [path]")
    .description("Onboard OpenTrace: register the MCP server (and the Claude Code plugin where supported) for all detected AI tools (or specific ones)"),
)

installCmd.action(async (targetPath: string | undefined, opts) => {
  await install(targetPath ?? ".", {
    baseUrl: opts.baseUrl,
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
  .option("--url <url>", "MCP endpoint host for the API-key flow (default: the OpenTrace production host)")
  .option("--client <id>", "Target client for the API-key flow: claude-code | claude-desktop | cursor")
  .action(async (tokenOrPath: string | undefined, opts) => {
    if (tokenOrPath && looksLikeToken(tokenOrPath)) {
      await connectWithKey(tokenOrPath, { url: opts.url, client: opts.client })
      return
    }
    await install(tokenOrPath ?? ".", {
      baseUrl: opts.baseUrl,
      yes: opts.yes,
      global: opts.global,
      toolOpts: opts as Record<string, unknown>,
    })
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof Error && err.message.includes("force closed")) {
    process.exit(0)
  }
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
