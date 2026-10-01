#!/usr/bin/env node
// Reports what this session is working on: repository, branch, head commit.
//
// This is the piece that turns per-pull-request cost from a guess into a fact. Claude
// Code's own OTLP export names a repository but never a branch, and it resolves that
// repository ONCE at process launch from the launch directory — it is never refreshed when
// the session moves. So a session started in an orchestrator root reports no repository at
// all for its whole life, and a session that moves between branches reports the first one
// for its whole life. Neither is a bug we can fix from the server; both are fixed by
// observing the work as it happens, which is what the hooks do.
//
// The join key is `prompt_id`. It appears both in the hook payload and in the telemetry
// events, so a prompt is priced against the branch it was actually on rather than against
// wherever the session happened to end up.
//
// Four rules, each of which the hook contract makes easy to break:
//
//   FAIL OPEN, ALWAYS. This runs in front of a person's prompt. Every path prints valid
//   JSON and exits 0 — a missing git binary, a detached HEAD, an expired token, a dead
//   network. Nothing here is worth costing somebody their prompt.
//
//   DEBOUNCE. The same (session, agent, repo, branch) is posted once per window, so the
//   overwhelming majority of invocations do no network work at all. Without this, a
//   PostToolUse hook on an editing run posts hundreds of identical rows a minute.
//
//   SEND THE REMOTE, NOT A KEY. The server derives the repository key from the remote URL.
//   The key's provider segment is an internal integration kind — GitHub's is `github_app`,
//   not `github` — and this plugin ships on its own cadence, so a key computed here would
//   keep being the old one after any server-side rename, with no symptom but a chart
//   quietly splitting in two.
//
//   NEVER NAME A PERSON. The payload carries no user or tenant. The server attributes every
//   observation to the member the API key belongs to, so there is nothing to spoof by
//   editing this file.
"use strict"

const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const STATE_FILE = path.join(os.homedir(), ".claude", "opentrace-session-context.json")
// How long one (session, agent, prompt, repo, branch) stays quiet after being posted. Long
// enough that an editing run posts once rather than per tool call; short enough that a
// prompt running for many minutes refreshes its row, so its window keeps up with the work.
const DEBOUNCE_MS = 60_000
// Entries older than this are dropped when the file is rewritten, so the state file cannot
// grow without bound across months of sessions.
const STATE_TTL_MS = 24 * 60 * 60 * 1000
// Bounded so a hook cannot hold up a prompt. A refused post is simply a missing
// observation, which shows up as unattributed spend rather than as an error.
const REQUEST_TIMEOUT_MS = 2_000
const GIT_TIMEOUT_MS = 1_000
// Where an unconfigured install posts. Named rather than inlined because it is also what
// marks a destination as OpenTrace when the operator named none.
const DEFAULT_API_URL = "https://api.opentrace.ai"

function main() {
  let payload = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
    // `JSON.parse` succeeds on `null`, on an array and on a bare number, none of which is a
    // hook payload. Only the object case is usable, and `null` in particular then threw a
    // TypeError out of `observe` past every guard here — the script exited non-zero having
    // printed nothing, which is the one thing it promises never to do.
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    payload = {}
  }

  try {
    exportSessionId(payload)
  } catch {
    // Best effort. The env file is a convenience for the user's own tooling; nothing the
    // server reads depends on it.
  }

  const entry = observe(payload)
  if (entry) {
    post(entry).catch(() => {})
  }
  process.stdout.write("{}")
}

// ---------------------------------------------------------------------------
// What to observe, per hook
// ---------------------------------------------------------------------------

function observe(payload) {
  const event = str(payload.hook_event_name)
  // The directory to resolve git facts against. Which field holds it differs per hook, and
  // getting this wrong is the orchestrator case: a session launched in a non-git root that
  // edits repositories in sub-directories reports nothing useful unless the FILE's
  // directory is what gets resolved, rather than the session's.
  let cwd = str(payload.cwd)
  let source = "session_start"

  if (event === "CwdChanged") {
    cwd = str(payload.new_cwd) || cwd
    source = "cwd_changed"
  } else if (event === "UserPromptSubmit") {
    source = "prompt"
  } else if (event === "PostToolUse") {
    source = "tool_use"
    const filePath = editedFilePath(payload)
    if (filePath) {
      cwd = path.dirname(filePath)
    }
  }

  const repo = gitFacts(cwd)
  if (!repo) {
    return null
  }
  return {
    session_id: str(payload.session_id),
    prompt_id: str(payload.prompt_id),
    agent_id: str(payload.agent_id),
    remote_url: repo.remote_url,
    branch: repo.branch,
    head_sha: repo.head_sha,
    source,
  }
}

// The file a tool actually touched, so an orchestrator's edits land on the sub-repository
// they were made in rather than on the root the session was launched from.
function editedFilePath(payload) {
  const input = payload.tool_input
  if (!input || typeof input !== "object") {
    return ""
  }
  const direct = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (direct) {
    return direct
  }
  // MultiEdit and similar batch shapes: the first entry is enough, because every edit in
  // one call is in one file.
  const edits = Array.isArray(input.edits) ? input.edits : []
  for (const edit of edits) {
    const candidate = edit && typeof edit === "object" ? str(edit.file_path) : ""
    if (candidate) {
      return candidate
    }
  }
  return ""
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim()
}

function gitFacts(cwd) {
  if (!cwd) {
    return null
  }
  let branch = ""
  let remote = ""
  let head = ""
  try {
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  } catch {
    // Not a repository, or git is unavailable. Either way there is nothing to report, and
    // an orchestrator root legitimately hits this on every session start.
    return null
  }
  // A detached HEAD reports the literal string "HEAD", which is not a branch and would
  // match no pull request. Reported as nothing rather than as a branch called HEAD, which
  // would collide across every repository.
  if (!branch || branch === "HEAD") {
    return null
  }
  try {
    remote = git(cwd, ["remote", "get-url", "origin"])
  } catch {
    try {
      // A checkout whose remote is not called "origin" is unusual but not wrong.
      const first = git(cwd, ["remote"]).split("\n")[0].trim()
      remote = first ? git(cwd, ["remote", "get-url", first]) : ""
    } catch {
      remote = ""
    }
  }
  if (!remote) {
    // With no remote there is no repository identity the server can join on. A local-only
    // checkout is real work, but it is work against a repository nobody connected.
    return null
  }
  // **Strip the credential a remote may carry.** `https://x-access-token:ghp_…@github.com/…`
  // is what a GitHub App checkout and most CI clones look like, and this field is sent
  // verbatim. The server derives the repository key without the userinfo, so nothing needs
  // it — but unstripped it travels in the request body, reaching request logs at whatever
  // host the post goes to. Removing OpenTrace's own credential from the wrong host is no
  // use while a third party's rides along in the payload.
  remote = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")
  try {
    head = git(cwd, ["rev-parse", "HEAD"])
  } catch {
    head = ""
  }
  return { branch, remote_url: remote, head_sha: head || null }
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function shouldPost(entry) {
  // `prompt_id` is IN THE KEY. Without it a 60-second window let one prompt a minute
  // through, and the server's branch rule requires a non-empty prompt id to join on — so
  // the measured path saw a small sample of prompts and quietly priced the rest as
  // unattributed. With it, the repeats a tool hook produces inside one prompt still
  // collapse to one post, which is what the debounce is actually for.
  const key = [entry.session_id, entry.agent_id, entry.prompt_id, entry.remote_url, entry.branch].join("\u001f")
  const now = Date.now()
  const state = readState()
  const last = state[key]
  // Clamped at `now`: a stamp in the future makes the elapsed time negative, which reads as
  // "debounced" for ever and silently stops the session reporting. A clock that jumped, or
  // a corrupt file, should cost one duplicate post rather than all of them.
  if (typeof last === "number" && last <= now && now - last < DEBOUNCE_MS) {
    return false
  }
  const next = { [key]: now }
  for (const [existing, stamp] of Object.entries(state)) {
    if (existing !== key && typeof stamp === "number" && now - stamp < STATE_TTL_MS) {
      next[existing] = stamp
    }
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    // Written before the post rather than after. Two hooks can run concurrently — a
    // PostToolUse and a UserPromptSubmit land together routinely — and marking afterwards
    // lets both see a clear state and both post. A post lost to a failure is simply a
    // missing observation; a debounce lost to a race is a burst on every edit.
    fs.writeFileSync(STATE_FILE, JSON.stringify(next), { mode: 0o600 })
  } catch {
    // An unwritable state file means no debounce, not no reporting.
  }
  return true
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Where to post, and what to authenticate with — resolved TOGETHER, deliberately.
//
// Two independent chains is the shape this started as and it leaks credentials. The
// endpoint could come from the OTLP exporter while the credential came from an OpenTrace
// key, which is an ordinary configuration: an organisation exporting OTLP to its own
// collector, with an OpenTrace key on the machine. Each service's bearer token then
// travelled to the other one's host. Neither side is misconfigured; the two chains simply
// had no idea the other existed.
//
// **A credential is only ever sent to the service it names.** The explicit key and the
// token file on disk name OpenTrace, so they go only to an OpenTrace destination — one the
// operator named outright, or the default. The OTLP header names whatever the exporter
// points at, so it goes only there. Nothing is inferred: a collector we were not told is
// OpenTrace is not treated as OpenTrace, and the result is a missing observation rather
// than a leaked key.
function resolveTarget() {
  const otlp = originOf(str(process.env.OTEL_EXPORTER_OTLP_ENDPOINT))
  const configured = originOf(str(process.env.OPENTRACE_API_URL))
  // The exporter endpoint points at this same API one path deeper, so a self-hosted
  // deployment that set one does not have to set two.
  const baseUrl = configured || otlp || DEFAULT_API_URL
  if (!isSafeDestination(baseUrl)) {
    // A plaintext destination is refused rather than downgraded. This request carries a
    // bearer token, and anything that can read it can then write telemetry as that member.
    return null
  }
  // Named as OpenTrace by the operator, or the default we ship. Only here may a credential
  // that names OpenTrace be used.
  const isOpenTrace = Boolean(configured) || baseUrl === DEFAULT_API_URL
  const token = resolveToken({ isOpenTrace, mayBorrowOtlpHeader: baseUrl === otlp })
  return token ? { baseUrl, token } : null
}

/** Contents of a token file, or "" if it is absent or unreadable. */
function readTokenFile(name) {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".claude", name), "utf8").trim()
  } catch {
    return ""
  }
}

function resolveToken({ isOpenTrace, mayBorrowOtlpHeader }) {
  if (isOpenTrace) {
    // **The managed file outranks the environment variable.** The CLI stopped writing
    // ``OPENTRACE_TELEMETRY_API_KEY`` into the settings ``env`` block — every subprocess a
    // session starts inherits that — but merging settings preserves whatever is already
    // there, so upgraded machines still carry an old copy. Reading the variable first meant
    // the stale value shadowed the fresh one, and re-running setup after a key rotation
    // fixed nothing: the file was rewritten and the hook went on sending the dead key.
    //
    // A file is only ever written by the CLI, so when both exist the file is the newer
    // fact. With no file the variable still wins, which keeps it usable as a deliberate
    // override for anything invoking this script outside Claude Code.
    const managed = readTokenFile("opentrace-telemetry.token")
    if (managed) {
      return managed
    }
    const direct = str(process.env.OPENTRACE_TELEMETRY_API_KEY)
    if (direct) {
      return direct
    }
  }
  // Wherever Claude Code telemetry already points at OpenTrace, that header holds a key
  // with exactly the right scope — so turning this on needs no second secret. Borrowed only
  // when the destination is that same host, because it is that host's credential.
  if (mayBorrowOtlpHeader) {
    const headers = str(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    for (const pair of headers.split(",")) {
      const index = pair.indexOf("=")
      if (index < 0) {
        continue
      }
      if (pair.slice(0, index).trim().toLowerCase() === "authorization") {
        return pair.slice(index + 1).trim().replace(/^Bearer\s+/i, "")
      }
    }
  }
  if (isOpenTrace) {
    // Last resort, and the reason upgrades work at all: a machine whose plugin predates the
    // telemetry token file has only the MCP's key on disk. Borrowing it keeps reporting
    // alive until the CLI writes the file this hook now prefers.
    return readTokenFile("opentrace-plugin.token")
  }
  return ""
}

/** `scheme://host[:port]`, or "" for anything unparseable. */
function originOf(value) {
  if (!value) {
    return ""
  }
  try {
    const parsed = new URL(value)
    // Userinfo is dropped from an origin by definition, so a URL carrying it would compare
    // equal to one that does not. Treated as unusable instead — `isSafeDestination` refuses
    // it too, and agreeing here keeps the two from disagreeing about the same string.
    if (parsed.username || parsed.password) {
      return ""
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ""
  }
}

// HTTPS, or plain HTTP only to the loopback address a developer runs the API on.
function isSafeDestination(baseUrl) {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.username || parsed.password) {
      // `https://api.opentrace.ai@evil.test` reads as OpenTrace to a human and resolves to
      // `evil.test`. Refused rather than normalised, because the two readings differ and a
      // configuration line is usually copied rather than parsed.
      return false
    }
    if (parsed.protocol === "https:") {
      return true
    }
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
  } catch {
    return false
  }
}

async function post(entry) {
  if (!entry.session_id || !shouldPost(entry)) {
    return
  }
  const target = resolveTarget()
  if (!target || typeof fetch !== "function") {
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    await fetch(`${target.baseUrl}/ingest/claude-code/v1/session-context`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({ entries: [entry], plugin_version: pluginVersion() }),
    })
  } catch {
    // Silent by design. A refused or unreachable ingest is a missing observation, which the
    // server reports as unattributed spend — visible in the right place, rather than as
    // noise in front of somebody's prompt.
  } finally {
    clearTimeout(timer)
  }
}

function pluginVersion() {
  try {
    const manifest = path.join(__dirname, "..", ".claude-plugin", "plugin.json")
    return str(JSON.parse(fs.readFileSync(manifest, "utf8")).version) || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session id for the user's own tooling
// ---------------------------------------------------------------------------

// Exported so anything the session shells out to can name the session it is running
// inside — a commit trailer, a build annotation, a local script. Nothing the server reads
// depends on it, which is why its failure is swallowed.
function exportSessionId(payload) {
  const envFile = str(process.env.CLAUDE_ENV_FILE)
  const sessionId = str(payload.session_id)
  if (!envFile || !sessionId || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) {
    return
  }
  // Appended once, not once per hook. This file is sourced ahead of the commands a session
  // runs, and writing on all four events added an identical line every time a tool ran — so
  // a long editing session left hundreds of duplicates to be re-read on each command. The
  // presence check also covers a resumed session, where SessionStart fires again.
  const line = `OT_CLAUDE_SESSION_ID=${sessionId}\n`
  try {
    if (fs.readFileSync(envFile, "utf8").includes(line)) {
      return
    }
  } catch {
    // No file yet, or unreadable: appending is still the right move.
  }
  fs.appendFileSync(envFile, line)
}

function str(value) {
  return typeof value === "string" ? value.trim() : ""
}

main()
