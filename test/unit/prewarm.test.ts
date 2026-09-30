// Where the SessionStart prewarm hook sends the user's API key.
//
// prewarm.cjs POSTs `Authorization: Bearer <key>` to the plugin's MCP endpoint, and
// its cwd is whatever repository the user opened. So the endpoint must be decided by
// the user (env var, home-directory settings) and never by a file the repo ships.
// These tests run the real script against two local listeners — one the user
// configured, one a hostile repo names — and assert on who actually received the key.

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

// Compiled to build-test/test/unit/, so the repo root is three levels up.
const PREWARM = new URL("../../../plugins/claude-code/bin/prewarm.cjs", import.meta.url).pathname
const PLUGIN_KEY = "opentrace@opentrace"
const TOKEN = "otk_prewarm-test-token"

interface Listener {
  url: string
  auths: Array<string | undefined>
  close(): Promise<void>
}

/** Records the Authorization header of every request; always answers 401. */
async function listen(): Promise<Listener> {
  const auths: Array<string | undefined> = []
  const server = http.createServer((req, res) => {
    auths.push(req.headers.authorization)
    req.resume()
    res.writeHead(401).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp/v1`,
    auths,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

let home: string
let repo: string
let listeners: Listener[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-prewarm-home-"))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "otx-prewarm-repo-"))
  listeners = []
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", "opentrace-plugin.token"), `${TOKEN}\n`)
  // prewarm only contacts the network for a checkout with a recognisable remote.
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: repo, stdio: "ignore" })
    assert.equal(r.status, 0, `git ${args.join(" ")}`)
  }
  git("init", "-q")
  git("remote", "add", "origin", "https://github.com/acme/widgets.git")
})
afterEach(async () => {
  await Promise.all(listeners.map((l) => l.close()))
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

async function start(): Promise<Listener> {
  const l = await listen()
  listeners.push(l)
  return l
}

function settings(root: string, file: string, mcpUrl: string): void {
  const dir = path.join(root, ".claude")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({ pluginConfigs: { [PLUGIN_KEY]: { options: { mcp_url: mcpUrl } } } }),
  )
}

/** Run the SessionStart hook as Claude Code would: payload on stdin, hermetic HOME. */
function runHook(env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // Never inherit the developer's own endpoint override; every test names its own.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
    delete childEnv.OPENTRACE_MCP_URL
    Object.assign(childEnv, env)
    const child = spawn(process.execPath, [PREWARM], { env: childEnv, stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", reject)
    child.on("close", () => resolve())
    child.stdin.end(JSON.stringify({ cwd: repo }))
  })
}

describe("prewarm hook: where the API key is sent", () => {
  it("ignores an mcp_url committed in the repo's .claude/settings.json", async () => {
    const attacker = await start()
    const trusted = await start()
    settings(repo, "settings.json", attacker.url)
    settings(home, "settings.json", trusted.url)
    await runHook()
    assert.deepEqual(attacker.auths, [], "the repo-chosen host never sees the key")
    assert.ok(trusted.auths.length > 0, "the user's configured host is contacted")
    assert.ok(trusted.auths.every((a) => a === `Bearer ${TOKEN}`))
  })

  it("ignores an mcp_url in the repo's .claude/settings.local.json", async () => {
    const attacker = await start()
    const trusted = await start()
    settings(repo, "settings.local.json", attacker.url)
    settings(home, "settings.json", trusted.url)
    await runHook()
    assert.deepEqual(attacker.auths, [])
    assert.ok(trusted.auths.length > 0)
  })

  it("lets OPENTRACE_MCP_URL win over home settings", async () => {
    const fromEnv = await start()
    const fromHome = await start()
    const attacker = await start()
    settings(home, "settings.json", fromHome.url)
    settings(repo, "settings.json", attacker.url)
    await runHook({ OPENTRACE_MCP_URL: fromEnv.url })
    assert.ok(fromEnv.auths.length > 0)
    assert.deepEqual(fromHome.auths, [])
    assert.deepEqual(attacker.auths, [])
  })

  it("honours the user's home-directory settings, local before shared", async () => {
    const local = await start()
    const shared = await start()
    settings(home, "settings.json", shared.url)
    settings(home, "settings.local.json", local.url)
    await runHook()
    assert.ok(local.auths.length > 0)
    assert.deepEqual(shared.auths, [])
  })
})
