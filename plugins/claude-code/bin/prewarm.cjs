#!/usr/bin/env node
// Context prewarm for the OpenTrace plugin hooks.
//
// Default mode (SessionStart): resolve the current checkout against OpenTrace
// and inject a ready-to-use binding — environment_slug, workspace_slug,
// source_id, indexed commit, and freshness vs. the local HEAD — so the model's
// first OpenTrace call needs no discovery hops (workspaces_list and
// graph_resolve_code_source are pre-answered here).
//
// --prompt-hint mode (UserPromptSubmit): emit the cached binding with the same
// ready-to-pass parameters. Cache-only — never touches the network, because it
// runs on every matching prompt.
//
// Authentication reuses the API key that `otx connect --client claude-code`
// writes for the headersHelper (bin/auth-headers.cjs). Without that file the
// MCP itself still works over OAuth in-session, but this script cannot
// pre-resolve, so it falls back to static guidance.
//
// Never throws; always prints exactly one valid JSON hook payload and exits 0.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const PROTOCOL_VERSION = "2025-06-18"
const DEFAULT_MCP_URL = "https://api.opentrace.ai/mcp/v1/"
const PLUGIN_CONFIG_KEY = "opentrace@opentrace"
const TOKEN_PATH = path.join(os.homedir(), ".claude", "opentrace-plugin.token")
const CACHE_PATH = path.join(os.homedir(), ".claude", "opentrace-prewarm.json")
const FETCH_TIMEOUT_MS = 2500
const WATCHDOG_MS = 6000
const MAX_WORKSPACES = 8
const UNINDEXED_TTL_MS = 24 * 60 * 60 * 1000

const PROMPT_HINT = process.argv.includes("--prompt-hint")

// ---------------------------------------------------------------------------
// Output. emit() is the only exit path: single write, single JSON object.

let emitted = false
function emit(payload) {
  if (!emitted) {
    emitted = true
    fs.writeSync(1, JSON.stringify(payload))
  }
  process.exit(0)
}

function output(context, systemMessage) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: PROMPT_HINT ? "UserPromptSubmit" : "SessionStart",
      additionalContext: context,
    },
  }
  if (systemMessage && !PROMPT_HINT) payload.systemMessage = systemMessage
  emit(payload)
}

// ---------------------------------------------------------------------------
// Injected text. HEADER/ROUTING/DISCOVERY are shared by every variant so the
// model gets one consistent story whether or not the binding resolved.

const HEADER =
  "You have access to OpenTrace, an MCP server that serves code graphs for the " +
  'repositories ("sources") your organization has indexed across its workspaces.'

const ROUTING =
  "Routing: Read/Grep/Glob remain best for files you already have open or whose paths you know. " +
  "Prefer OpenTrace for existence, structure, and architecture questions — including in this " +
  "checkout when the index covers it: one graph_search covers the entire indexed snapshot and an " +
  "empty result is a bounded negative (absent at the indexed commit), which repeated greps cannot " +
  "establish; graph_get_repo_overview maps an unfamiliar subsystem in one call. If two greps in a " +
  "row come back empty, switch to graph_search rather than trying a third pattern."

const DISCOVERY =
  "Workflow: (1) workspaces_list and pick the workspace matching the request, then pass its " +
  "environment_slug and workspace_slug to every workspace-scoped call; (2) resolve a repository " +
  "with graph_resolve_code_source (or enumerate with graph_list_code_sources) to get a source_id; " +
  "(3) pass that source_id to graph_search and graph_get_repo_overview, deepen with " +
  "graph_explore_focused_subgraph, and read code with source_load using load_ref values from " +
  "earlier results; (4) for pull/merge requests use change_requests_list or " +
  "change_requests_search, then change_requests_read for bounded detail; (5) if results look thin " +
  "or possibly stale, call source_get_context for remote-head and latest-commit context. Briefly " +
  "tell the user when you are about to use OpenTrace and what you are looking for."

function freshnessSentence(f, sha7, ref, date) {
  const base = `indexed at ${sha7} on "${ref}" (ingested ${date})`
  switch (f.kind) {
    case "identical":
      return `${base} — identical to your HEAD, so graph answers apply to your working tree.`
    case "ahead":
      return (
        `${base} — an ancestor of your HEAD, ${f.ahead} commit(s) behind it, so the graph ` +
        "covers everything except your most recent local changes."
      )
    case "diverged":
      return (
        `${base} — your branch has diverged from the indexed snapshot (${f.ahead} commit(s) on ` +
        `yours, ${f.behind} on the indexed side since the merge-base): trust the graph for ` +
        "unchanged areas and local tools for recently touched ones."
      )
    case "missing":
      return `${base} — that commit is not in your local history (run git fetch to compare).`
    default:
      return `${base}.`
  }
}

function freshnessShort(f, date) {
  switch (f.kind) {
    case "identical":
      return "matches your HEAD"
    case "ahead":
      return `${f.ahead} commit(s) behind your HEAD`
    case "diverged":
      return "diverged from your branch"
    default:
      return `ingested ${date}`
  }
}

function bindingContext(binding, f, opts = {}) {
  const sha7 = (binding.indexed_commit_sha || "").slice(0, 7) || "unknown"
  const date = (binding.last_ingested_at || "").slice(0, 10) || "an unknown date"
  const scope = {
    environment_slug: binding.environment_slug,
    workspace_slug: binding.workspace_slug,
  }
  const staleNote = opts.stale
    ? " (OpenTrace was unreachable just now; binding served from local cache.)"
    : ""
  return [
    HEADER,
    "",
    `This checkout (${binding.ownerRepo}) is indexed as "${binding.name}". Pass these parameters directly — no discovery calls needed:`,
    `  environment_slug: "${binding.environment_slug}"`,
    `  workspace_slug: "${binding.workspace_slug}"`,
    `  source_id: "${binding.source_id}"`,
    `Freshness: ${freshnessSentence(f, sha7, binding.ref, date)}${staleNote}`,
    "",
    "First-call examples:",
    `- Existence / definitions ("where is X?", "do we have Y?"): graph_search ${JSON.stringify({ query: "<name>", source_ids: [binding.source_id], ...scope })}`,
    `- Orientation / subsystem map: graph_get_repo_overview ${JSON.stringify({ source_id: binding.source_id, sections: ["top_level_layout", "entrypoints", "important_files"], ...scope })}`,
    `- String literals, error messages, config keys: graph_search_source_regions ${JSON.stringify({ source_id: binding.source_id, query: "<text>", ...scope })}`,
    `- Read any result: source_load ${JSON.stringify({ ref: "<load_ref from a result>", ...scope })}`,
    "",
    ROUTING,
    "",
    "Other indexed repositories and cross-repo questions: graph_resolve_code_source with the " +
      "same environment_slug and workspace_slug. Briefly tell the user when you are about to " +
      "use OpenTrace and what you are looking for.",
  ].join("\n")
}

function fallbackContext() {
  return [HEADER, "", ROUTING, "", DISCOVERY].join("\n")
}

function notIndexedContext(ownerRepo) {
  return [
    HEADER,
    "",
    `No indexed source matched this checkout's remote (${ownerRepo}), so the graph likely does ` +
      "not cover this repository — use local tools here. OpenTrace still covers the rest of the " +
      "organization's indexed repositories:",
    "",
    DISCOVERY,
  ].join("\n")
}

function promptHintContext(binding) {
  if (!binding) {
    return (
      "This prompt may concern architecture, dependencies, or code structure. The OpenTrace MCP " +
      "tools can help: graph_search finds symbols and files across an indexed snapshot (a bounded " +
      "answer, including definitive negatives), graph_explore_focused_subgraph shows a symbol's " +
      "neighborhood, and source_load reads the underlying code. Call workspaces_list first if you " +
      "have not yet picked a workspace (then resolve a source_id with graph_resolve_code_source)."
    )
  }
  const sha7 = (binding.indexed_commit_sha || "").slice(0, 7) || "unknown"
  const scope = {
    environment_slug: binding.environment_slug,
    workspace_slug: binding.workspace_slug,
  }
  return (
    `This prompt may concern architecture or code structure. OpenTrace has this checkout indexed ` +
    `(${binding.name} at ${sha7}) — no discovery calls needed: graph_search ` +
    `${JSON.stringify({ query: "<name>", source_ids: [binding.source_id], ...scope })} answers ` +
    "existence and definition questions over the whole snapshot in one call (an empty result is " +
    "a bounded negative at that commit); graph_get_repo_overview " +
    `${JSON.stringify({ source_id: binding.source_id, ...scope })} maps a subsystem; ` +
    "graph_search_source_regions finds string literals and config text with the same parameters."
  )
}

// ---------------------------------------------------------------------------
// Local facts: git identity and freshness.

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

function gitOk(cwd, ...args) {
  try {
    execFileSync("git", args, { cwd, timeout: 1500, stdio: ["ignore", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

// git@host:owner/repo.git | ssh://git@host/owner/repo.git | https://host/owner/repo
// Nested GitLab groups (a/b/c) reduce to the last two segments — fine for a
// fuzzy resolve query, which ranks by name and external_ref anyway.
function normalizeRemote(url) {
  if (!url) return null
  const stripped = url.trim().replace(/\.git$/, "")
  const scp = stripped.match(/^[\w.+-]+@[^:/]+:(.+)$/)
  const proto = stripped.match(/^[a-z+]+:\/\/[^/]+\/(.+)$/i)
  const pathPart = scp ? scp[1] : proto ? proto[1] : null
  if (!pathPart) return null
  const segs = pathPart.split("/").filter(Boolean)
  if (segs.length < 2) return null
  return segs.slice(-2).join("/")
}

function repoIdentity(cwd) {
  const remotes = (git(cwd, "remote") || "").split("\n").filter(Boolean)
  const pick = remotes.includes("origin")
    ? "origin"
    : remotes.includes("upstream")
      ? "upstream"
      : remotes[0]
  if (!pick) return null
  const ownerRepo = normalizeRemote(git(cwd, "remote", "get-url", pick))
  return ownerRepo ? { ownerRepo } : null
}

// Freshness of the indexed snapshot relative to the local HEAD — answerable
// entirely from local git, no provider account needed (unlike source_get_context).
function freshness(cwd, sha) {
  if (!sha) return { kind: "unknown" }
  const head = git(cwd, "rev-parse", "HEAD")
  if (!head) return { kind: "unknown" }
  if (head === sha) return { kind: "identical" }
  if (!gitOk(cwd, "cat-file", "-e", `${sha}^{commit}`)) return { kind: "missing" }
  const ahead = parseInt(git(cwd, "rev-list", "--count", `${sha}..HEAD`) || "0", 10)
  if (gitOk(cwd, "merge-base", "--is-ancestor", sha, "HEAD")) return { kind: "ahead", ahead }
  const behind = parseInt(git(cwd, "rev-list", "--count", `HEAD..${sha}`) || "0", 10)
  return { kind: "diverged", ahead, behind }
}

// ---------------------------------------------------------------------------
// Config: token and MCP endpoint (mirrors the headersHelper / user_config).

function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || null
  } catch {
    return null
  }
}

function resolveMcpUrl(cwd) {
  const withSlash = (u) => (u.endsWith("/") ? u : `${u}/`)
  if (process.env.OPENTRACE_MCP_URL) return withSlash(process.env.OPENTRACE_MCP_URL.trim())
  // Hooks can't read ${user_config.*}, but Claude Code persists it in settings.
  const candidates = [
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ]
  for (const p of candidates) {
    try {
      const settings = JSON.parse(fs.readFileSync(p, "utf8"))
      const url = settings?.pluginConfigs?.[PLUGIN_CONFIG_KEY]?.options?.mcp_url
      if (typeof url === "string" && url.trim()) return withSlash(url.trim())
    } catch {
      /* missing or invalid settings file */
    }
  }
  return DEFAULT_MCP_URL
}

// ---------------------------------------------------------------------------
// Binding cache, keyed by normalized remote. Positive entries are refreshed on
// every real session start (network permitting) and reused by --prompt-hint;
// negative ("unindexed") entries expire so newly indexed repos get noticed.

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
    if (cache && cache.version === 1 && cache.bindings) return cache
  } catch {
    /* no cache yet */
  }
  return { version: 1, bindings: {} }
}

function writeCache(cache) {
  try {
    const tmp = `${CACHE_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, CACHE_PATH)
  } catch {
    /* cache is best-effort */
  }
}

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP. The server is stateless (see src/util/mcp-probe.ts):
// every request carries auth, no session id, no initialized notification needed.

let rpcId = 0

async function rpc(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  let msg = null
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      try {
        msg = JSON.parse(line.slice(5).trim())
      } catch {
        /* keepalive or partial line */
      }
    }
  } else {
    msg = JSON.parse(text)
  }
  if (!msg) throw new Error("no JSON-RPC message in response")
  if (msg.error) throw new Error(msg.error.message || "JSON-RPC error")
  return msg.result
}

async function initialize(url, token) {
  await rpc(url, token, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "opentrace-plugin-prewarm", version: "1" },
    },
  })
}

async function toolCall(url, token, name, args) {
  const result = await rpc(url, token, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  })
  if (result?.isError) throw new Error(`tool ${name} returned an error`)
  const text = (result?.content || []).find((c) => c.type === "text")?.text
  if (text) return JSON.parse(text)
  return result?.structuredContent?.result ?? result?.structuredContent ?? null
}

// Only accept a match whose name/external_ref equals the normalized remote —
// resolve scores are fuzzy, and a wrong binding is worse than none.
function exactMatch(source, ownerRepo) {
  const n = ownerRepo.toLowerCase()
  const name = (source.name || "").toLowerCase()
  const ext = (source.external_ref || "").toLowerCase()
  return name === n || ext === n || ext.endsWith(`/${n}`) || ext.endsWith(`:${n}`)
}

async function resolveInScopes(url, token, ownerRepo, scopes) {
  const attempts = await Promise.allSettled(
    scopes.map(async (scope) => {
      const res = await toolCall(url, token, "graph_resolve_code_source", {
        query: ownerRepo,
        limit: 5,
        ...scope,
      })
      const match = (res?.matches || []).find(
        (m) => exactMatch(m.source, ownerRepo) && m.source.availability_state === "available",
      )
      return match ? { scope, source: match.source } : null
    }),
  )
  const hits = attempts.filter((a) => a.status === "fulfilled" && a.value).map((a) => a.value)
  if (!hits.length) {
    // All rejected (network/auth) is a failure; all resolved-but-empty is a miss.
    if (attempts.every((a) => a.status === "rejected")) throw new Error("all resolves failed")
    return null
  }
  const best = hits[0]
  return {
    ownerRepo,
    environment_slug: best.scope.environment_slug,
    workspace_slug: best.scope.workspace_slug,
    source_id: best.source.source_id,
    name: best.source.name,
    ref: best.source.ref,
    indexed_commit_sha: best.source.indexed_commit_sha,
    last_ingested_at: best.source.last_ingested_at,
    resolved_at: new Date().toISOString(),
  }
}

// Returns a binding, null (definitively not indexed), or throws (unreachable).
async function resolveBinding(url, token, ownerRepo, cached) {
  await initialize(url, token)
  const envOverride = process.env.OPENTRACE_ENVIRONMENT
  const wsOverride = process.env.OPENTRACE_WORKSPACE
  if (envOverride && wsOverride) {
    return resolveInScopes(url, token, ownerRepo, [
      { environment_slug: envOverride, workspace_slug: wsOverride },
    ])
  }
  // Cached scope first (one call); rescan all workspaces if it comes up empty,
  // e.g. after the source moved workspaces.
  if (cached?.environment_slug && cached?.workspace_slug) {
    const refreshed = await resolveInScopes(url, token, ownerRepo, [
      { environment_slug: cached.environment_slug, workspace_slug: cached.workspace_slug },
    ])
    if (refreshed) return refreshed
  }
  const listed = await toolCall(url, token, "workspaces_list", { limit: 50 })
  const scopes = (listed?.workspaces || [])
    .slice(0, MAX_WORKSPACES)
    .map((w) => ({ environment_slug: w.environment_slug, workspace_slug: w.slug }))
  if (!scopes.length) return null
  return resolveInScopes(url, token, ownerRepo, scopes)
}

// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = ""
    const timer = setTimeout(() => resolve(data), 400)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => {
      clearTimeout(timer)
      resolve(data)
    })
    process.stdin.on("error", () => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

async function main() {
  // Watchdog: whatever happens, the hook answers within WATCHDOG_MS.
  setTimeout(() => {
    if (PROMPT_HINT) output(promptHintContext(null))
    output(fallbackContext(), "OpenTrace is active — workspace code graphs are available.")
  }, WATCHDOG_MS)

  let payload = {}
  try {
    payload = JSON.parse((await readStdin()) || "{}")
  } catch {
    /* run without payload */
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
  const identity = repoIdentity(cwd)
  const cache = readCache()
  const cached = identity ? cache.bindings[identity.ownerRepo] : null
  const cachedBinding = cached && !cached.unindexed ? cached : null

  if (PROMPT_HINT) output(promptHintContext(cachedBinding))

  const token = readToken()
  if (!identity || !token || typeof fetch !== "function") {
    output(fallbackContext(), "OpenTrace is active — workspace code graphs are available.")
  }

  const sysMsg = (binding, f) => {
    const sha7 = (binding.indexed_commit_sha || "").slice(0, 7)
    const date = (binding.last_ingested_at || "").slice(0, 10)
    return `OpenTrace: ${binding.name} indexed @ ${sha7} — ${freshnessShort(f, date)}.`
  }

  // Resumed/compacted sessions re-run SessionStart; answer from cache so they
  // stay instant. Fresh startups always re-resolve (the indexed sha moves).
  if ((payload.source === "resume" || payload.source === "compact") && cachedBinding) {
    const f = freshness(cwd, cachedBinding.indexed_commit_sha)
    output(bindingContext(cachedBinding, f), sysMsg(cachedBinding, f))
  }
  if (cached?.unindexed && Date.now() - Date.parse(cached.resolved_at || 0) < UNINDEXED_TTL_MS) {
    output(
      notIndexedContext(identity.ownerRepo),
      "OpenTrace is active — this checkout does not appear to be indexed.",
    )
  }

  let binding = null
  let unreachable = false
  try {
    binding = await resolveBinding(resolveMcpUrl(cwd), token, identity.ownerRepo, cachedBinding)
  } catch {
    unreachable = true
  }

  if (binding) {
    cache.bindings[identity.ownerRepo] = binding
    writeCache(cache)
    const f = freshness(cwd, binding.indexed_commit_sha)
    output(bindingContext(binding, f), sysMsg(binding, f))
  }
  if (unreachable && cachedBinding) {
    const f = freshness(cwd, cachedBinding.indexed_commit_sha)
    output(bindingContext(cachedBinding, f, { stale: true }), sysMsg(cachedBinding, f))
  }
  if (unreachable) {
    output(fallbackContext(), "OpenTrace is active — workspace code graphs are available.")
  }
  cache.bindings[identity.ownerRepo] = { unindexed: true, resolved_at: new Date().toISOString() }
  writeCache(cache)
  output(
    notIndexedContext(identity.ownerRepo),
    "OpenTrace is active — this checkout does not appear to be indexed.",
  )
}

main().catch(() => {
  if (PROMPT_HINT) output(promptHintContext(null))
  output(fallbackContext(), "OpenTrace is active — workspace code graphs are available.")
})
