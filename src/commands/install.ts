import path from "node:path"
import fs from "node:fs"
import { confirm } from "@inquirer/prompts"
import { ALL_INTEGRATIONS, detectInstalled } from "../util/detect.js"
import { DEFAULT_BASE_URL } from "../util/constants.js"
import type { Integration } from "../integrations/types.js"

interface InstallCommandOptions {
  baseUrl?: string
  yes?: boolean
  global?: boolean
  toolOpts?: Record<string, unknown>
}

function toCamelCase(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function resolveTargets(opts: InstallCommandOptions): Integration[] | null {
  const toolOpts = opts.toolOpts ?? {}
  const flagged = ALL_INTEGRATIONS.filter(i => Boolean(toolOpts[toCamelCase(i.id)]))
  return flagged.length > 0 ? flagged : null
}

export async function install(targetPath: string, opts: InstallCommandOptions): Promise<void> {
  const dir = path.resolve(targetPath)

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`)
    process.exit(1)
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const isGlobal = opts.global ?? false

  const explicit = resolveTargets(opts)
  let targets: Integration[]

  if (explicit) {
    targets = explicit
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

    const labels = targets.map((i) => i.label).join(", ")
    if (!opts.yes) {
      const go = await confirm({
        message: `Detected: ${labels}. Install OpenTrace MCP for all?`,
        default: true,
      })
      if (!go) {
        console.log("Aborted.")
        return
      }
    }
  }

  console.log()
  const results: Array<{ label: string; configPath: string; status: "added" | "updated" | "skipped" }> = []
  let pluginInstalled = false

  for (const integration of targets) {
    const alreadyPresent = integration.hasEntry(dir, { global: isGlobal })

    if (alreadyPresent && !opts.yes) {
      const configPath = integration.getConfigPath(dir, { global: isGlobal })
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
      const result = integration.install(dir, { baseUrl, global: isGlobal })
      results.push({
        label: integration.label,
        configPath: result.configPath,
        status: result.existed ? "updated" : "added",
      })

      // Control plane: install the plugin only where the target supports one.
      // Everything else gets MCP alone.
      if (integration.plugin) {
        try {
          const pluginResult = integration.plugin.install(dir, { global: isGlobal })
          pluginInstalled = true
          const verb = pluginResult.alreadyEnabled ? "-" : "✓"
          console.log(`  ${verb} ${integration.label} plugin  ${pluginResult.configPath}`)
        } catch (err) {
          console.error(`  ${integration.label} plugin: failed — ${err instanceof Error ? err.message : String(err)}`)
        }
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

  const changed = results.some((r) => r.status !== "skipped")
  if (changed || pluginInstalled) {
    console.log()
    console.log("Next steps:")
    console.log("  1. Restart your AI tools to activate the OpenTrace MCP server.")
    if (pluginInstalled) {
      console.log("     Claude Code will prompt to install the OpenTrace plugin — accept it, then run /reload-plugins.")
    }
    console.log("  2. In Claude Code, run /mcp and sign in to OpenTrace to authorize the connection.")
  }
}
