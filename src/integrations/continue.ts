import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SERVER_KEY, buildMcpUrl } from "../util/constants.js"
import type { Integration, InstallOptions, InstallResult, RemoveResult } from "./types.js"

const GLOBAL_CONFIG = path.join(os.homedir(), ".continue", "config.yaml")

// Matches "- name: opentrace" as a list item, tolerant of leading whitespace
const ENTRY_PATTERN = /^[ \t]*-[ \t]*name:[ \t]*opentrace[ \t]*$/m

function yamlEntry(url: string): string {
  return `  - name: ${SERVER_KEY}\n    type: http\n    url: ${url}`
}

const continueDev: Integration = {
  id: "continue",
  label: "Continue",
  helpText: ".continue/mcpServers/opentrace.yaml  (--global: ~/.continue/config.yaml)",

  detect() {
    return fs.existsSync(path.join(os.homedir(), ".continue"))
  },

  getConfigPath(projectDir, { global: isGlobal }) {
    return isGlobal
      ? GLOBAL_CONFIG
      : path.join(projectDir, ".continue", "mcpServers", `${SERVER_KEY}.yaml`)
  },

  hasEntry(projectDir, opts) {
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return false
    if (!opts.global) return true // standalone file named after SERVER_KEY
    return ENTRY_PATTERN.test(fs.readFileSync(configPath, "utf8"))
  },

  install(projectDir, opts): InstallResult {
    const isGlobal = opts.global ?? false
    const configPath = this.getConfigPath(projectDir, opts)
    const existed = this.hasEntry(projectDir, opts)
    const url = buildMcpUrl(opts.baseUrl)

    if (isGlobal) {
      if (existed) {
        // Replace the existing entry's url line — avoids duplicating the block
        const raw = fs.readFileSync(configPath, "utf8")
        // Bounded match: stop at the next list item (line starting with optional
        // whitespace then "- ") so we never cross into adjacent entries.
        const updated = raw.replace(
          /(-[ \t]*name:[ \t]*opentrace\n(?:[ \t]+(?!-)[ \t]*\S[^\n]*\n)*?[ \t]+url:)[ \t]*.*/m,
          `$1 ${url}`
        )
        fs.writeFileSync(configPath, updated, "utf8")
      } else if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf8")
        // /^mcpServers:/m anchors to line start — skips commented lines like "# mcpServers:"
        const updated = /^mcpServers:/m.test(raw)
          ? raw.replace(/^mcpServers:/m, `mcpServers:\n${yamlEntry(url)}`)
          : `${raw.trimEnd()}\n\nmcpServers:\n${yamlEntry(url)}\n`
        fs.writeFileSync(configPath, updated, "utf8")
      } else {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, `mcpServers:\n${yamlEntry(url)}\n`, "utf8")
      }
    } else {
      // Standalone file — Continue auto-loads all files in .continue/mcpServers/
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(
        configPath,
        `name: ${SERVER_KEY}\ntype: http\nurl: ${url}\n`,
        "utf8"
      )
    }

    return { configPath, existed }
  },

  remove(projectDir, opts): RemoveResult {
    const isGlobal = opts.global ?? false
    const configPath = this.getConfigPath(projectDir, opts)
    if (!fs.existsSync(configPath)) return { configPath, removed: false }

    if (!isGlobal) {
      // Standalone file named after the server — just delete it.
      fs.rmSync(configPath)
      return { configPath, removed: true }
    }

    // Global config.yaml — strip the "- name: opentrace" list item and its body.
    const raw = fs.readFileSync(configPath, "utf8")
    const lines = raw.split(/\r?\n/)
    const start = lines.findIndex((l) => ENTRY_PATTERN.test(l))
    if (start === -1) return { configPath, removed: false }
    const dashIndent = lines[start].search(/\S/)
    let end = start + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === "") break // entries written without blank lines; stop at one
      if (line.search(/\S/) <= dashIndent) break // sibling item or shallower key
      end++
    }
    lines.splice(start, end - start)
    fs.writeFileSync(configPath, lines.join("\n"), "utf8")
    return { configPath, removed: true }
  },
}

export default continueDev
