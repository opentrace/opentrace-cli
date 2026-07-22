#!/usr/bin/env node
// headersHelper for the OpenTrace MCP server. Claude Code runs this at connection
// time and merges the JSON it prints into the request headers.
//
// If an OpenTrace API key has been written to ~/.claude/opentrace-plugin.token
// (by `otx connect otk_… --client claude-code`), emit an Authorization header so
// the MCP authenticates with that key. Otherwise emit nothing, leaving Claude Code
// to authenticate the server over OAuth. Never throws — always prints valid JSON.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

try {
  const tokenPath = path.join(os.homedir(), ".claude", "opentrace-plugin.token")
  const token = fs.readFileSync(tokenPath, "utf8").trim()
  process.stdout.write(token ? JSON.stringify({ Authorization: `Bearer ${token}` }) : "{}")
} catch {
  process.stdout.write("{}")
}
