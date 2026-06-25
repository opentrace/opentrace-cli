import path from "node:path"
import fs from "node:fs"
import { confirm } from "@inquirer/prompts"
import claudeCode from "../integrations/claude-code.js"
import { DEFAULT_BASE_URL } from "../util/constants.js"

interface AddMcpOptions {
  baseUrl?: string
  yes?: boolean
}

export async function addMcp(targetPath: string, opts: AddMcpOptions): Promise<void> {
  const dir = path.resolve(targetPath)

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`)
    process.exit(1)
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const alreadyPresent = claudeCode.hasEntry(dir, { global: false })

  if (alreadyPresent && !opts.yes) {
    const configPath = claudeCode.getConfigPath(dir, { global: false })
    const overwrite = await confirm({
      message: `An "opentrace" MCP server already exists in ${configPath}. Overwrite?`,
      default: false,
    })
    if (!overwrite) {
      console.log("Aborted.")
      return
    }
  }

  const result = claudeCode.install(dir, { baseUrl, global: false })

  const verb = result.existed ? "Updated" : "Added"
  console.log(`\n${verb} OpenTrace MCP server in ${result.configPath}`)
  console.log(`  URL: ${baseUrl.replace(/\/$/, "")}/mcp/v1/`)
  console.log()
  console.log("Restart Claude Code to activate the MCP server.")
}
