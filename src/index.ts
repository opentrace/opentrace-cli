#!/usr/bin/env node
import { Command } from "commander"
import { addMcp } from "./commands/add-mcp.js"
import { install } from "./commands/install.js"
import { ALL_INTEGRATIONS } from "./util/detect.js"
import { DEFAULT_BASE_URL } from "./util/constants.js"

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

const installCmd = program
  .command("install [path]")
  .alias("connect")
  .description("Onboard OpenTrace: register the MCP server (and the Claude Code plugin where supported) for all detected AI tools (or specific ones)")
  .option("--base-url <url>", "OpenTrace API base URL", DEFAULT_BASE_URL)
  .option("-y, --yes", "Skip confirmation prompts")
  .option("-g, --global", "Install to user-level config instead of project-level")

ALL_INTEGRATIONS.forEach((i) => {
  installCmd.option(`--${i.id}`, `${i.label}: ${i.helpText}`)
})

installCmd.action(async (targetPath: string | undefined, opts) => {
  await install(targetPath ?? ".", {
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
