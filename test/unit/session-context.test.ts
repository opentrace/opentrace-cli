// The hook that reports what a session is working on.
//
// Every test here is really about one of two things: the script must never cost somebody
// their prompt, and it must never report a repository or branch it did not observe. A
// missing observation is visible later as unattributed spend; a wrong one prices one
// repository's work into another and is visible nowhere.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

/** Resolved by walking up to the workspace root: this file runs compiled, from build-test. */
function repoRoot(): string {
  let dir = new URL(".", import.meta.url).pathname
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "plugins", "claude-code", "bin", "session-context.cjs"))) return dir
    dir = path.dirname(dir)
  }
  throw new Error("could not locate the plugin from " + new URL(".", import.meta.url).pathname)
}

const SCRIPT = path.join(repoRoot(), "plugins", "claude-code", "bin", "session-context.cjs")

let home: string
let savedHome: string | undefined
let posts: string[]
let server: any
let base: string

beforeEach(async () => {
  savedHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-ctx-"))
  process.env.HOME = home
  posts = []

  const http = await import("node:http")
  server = http.createServer((req: any, res: any) => {
    let body = ""
    req.on("data", (chunk: any) => {
      body += chunk
    })
    req.on("end", () => {
      posts.push(JSON.stringify({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }))
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"accepted":1,"stored":1}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A real git checkout, because the script reads real git output. */
function repo(remote: string, branch = "feat/thing"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otx-repo-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  git("init", "-q", "-b", branch)
  git("config", "user.email", "t@example.test")
  git("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "f.txt"), "x")
  git("add", ".")
  git("commit", "-qm", "c")
  if (remote) git("remote", "add", "origin", remote)
  return dir
}

function run(payload: Record<string, unknown>, env: Record<string, string> = {}): string {
  return execFileSync("node", [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, OPENTRACE_API_URL: base, OPENTRACE_TELEMETRY_API_KEY: "otk_test", ...env },
  })
}

/** The post is fired without being awaited, so give the loop a moment to flush it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

describe("session context", () => {
  it("reports the remote and branch, never a computed key", async () => {
    // The key's provider segment is an internal integration kind — GitHub's is
    // `github_app`, not `github`. Computed here it would keep being the old one after any
    // server-side rename, and the only symptom would be a chart splitting in two.
    const dir = repo("git@github.com:acme/widget-svc.git")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir })
    await settle()

    assert.equal(posts.length, 1)
    const sent = JSON.parse(posts[0])
    assert.equal(sent.url, "/ingest/claude-code/v1/session-context")
    assert.equal(sent.auth, "Bearer otk_test")
    const entry = sent.body.entries[0]
    assert.equal(entry.remote_url, "git@github.com:acme/widget-svc.git")
    assert.equal(entry.branch, "feat/thing")
    assert.equal(entry.prompt_id, "p1")
    assert.equal(entry.source, "prompt")
    assert.equal(entry.repo_key, undefined)
    assert.ok(sent.body.plugin_version)
  })

  it("prefers the managed token file over a key left in the environment", async () => {
    // The CLI stopped writing OPENTRACE_TELEMETRY_API_KEY into the settings `env` block,
    // but merging settings preserves whatever is already there — so an upgraded machine
    // still carries an old copy, and every subprocess inherits it. Reading the variable
    // first let that stale value shadow the fresh one: re-running setup after a rotation
    // rewrote the file and the hook went on sending the dead key, failing quietly.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "opentrace-telemetry.token"), "otk_managed\n")
    const dir = repo("git@github.com:acme/widget-svc.git")

    run(
      { hook_event_name: "UserPromptSubmit", session_id: "s-managed", prompt_id: "p1", cwd: dir },
      { OPENTRACE_TELEMETRY_API_KEY: "otk_stale" },
    )
    await settle()

    assert.equal(JSON.parse(posts[0]).auth, "Bearer otk_managed")
  })

  it("still falls back to the MCP token file, which is how upgrades keep reporting", async () => {
    // A machine whose plugin predates the telemetry token file has only the MCP's key on
    // disk. Borrowing it is what keeps reporting alive until the CLI writes the new file.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "opentrace-plugin.token"), "otk_legacy\n")
    const dir = repo("git@github.com:acme/widget-svc.git")

    run(
      { hook_event_name: "UserPromptSubmit", session_id: "s-legacy", prompt_id: "p1", cwd: dir },
      { OPENTRACE_TELEMETRY_API_KEY: "", OTEL_EXPORTER_OTLP_HEADERS: "" },
    )
    await settle()

    assert.equal(JSON.parse(posts[0]).auth, "Bearer otk_legacy")
  })

  it("names nobody", async () => {
    // The server attributes every observation to the member the API key belongs to, so
    // there is nothing to spoof by editing this file. Sending an identity anyway would
    // create a field somebody later trusts.
    const dir = repo("git@github.com:acme/widget-svc.git")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: dir })
    await settle()

    const entry = JSON.parse(posts[0]).body.entries[0]
    assert.equal(entry.user_id, undefined)
    assert.equal(entry.tenant_id, undefined)
    assert.equal(entry.email, undefined)
  })

  it("follows a cd rather than the launch directory", async () => {
    // The orchestrator case, and the one Claude Code's own export cannot answer: it
    // resolves the repository once at launch and never refreshes it.
    const dir = repo("git@github.com:acme/moved.git", "feat/moved")
    run({ hook_event_name: "CwdChanged", session_id: "s1", cwd: "/nonexistent", new_cwd: dir })
    await settle()

    const entry = JSON.parse(posts[0]).body.entries[0]
    assert.equal(entry.remote_url, "git@github.com:acme/moved.git")
    assert.equal(entry.branch, "feat/moved")
    assert.equal(entry.source, "cwd_changed")
  })

  it("resolves an edit against the file's repository, not the session's", async () => {
    // An orchestrator runs in a root that is not a repository and edits repositories in
    // sub-directories. Resolving the session's cwd there reports nothing at all.
    const dir = repo("git@github.com:acme/sub.git", "feat/sub")
    run({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "/nonexistent",
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "f.txt") },
    })
    await settle()

    const entry = JSON.parse(posts[0]).body.entries[0]
    assert.equal(entry.remote_url, "git@github.com:acme/sub.git")
    assert.equal(entry.source, "tool_use")
  })

  it("collapses one prompt's tool calls into a single post", async () => {
    // A PostToolUse hook on an editing run fires per tool call. Without the debounce that
    // is hundreds of identical rows a minute, for one fact.
    const dir = repo("git@github.com:acme/widget-svc.git")
    for (let i = 0; i < 5; i += 1) {
      run({ hook_event_name: "PostToolUse", session_id: "s1", prompt_id: "p1", cwd: dir })
    }
    await settle()

    assert.equal(posts.length, 1)
  })

  it("reports every prompt, not one a minute", async () => {
    // The debounce key must carry the prompt id. Keyed on the session and branch alone, a
    // 60-second window let roughly one prompt a minute through — and the server's branch
    // rule joins on a non-empty prompt id, so everything it dropped was priced as
    // unattributed. The feature appeared to work and reported a fraction of the spend.
    const dir = repo("git@github.com:acme/widget-svc.git")
    for (const prompt of ["p1", "p2", "p3"]) {
      run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: prompt, cwd: dir })
    }
    await settle()

    assert.deepEqual(
      posts.map((post) => JSON.parse(post).body.entries[0].prompt_id),
      ["p1", "p2", "p3"],
    )
  })

  it("posts again when the branch changes", async () => {
    // The debounce keys on the branch, so switching branches mid-session is reported
    // immediately — which is the case that makes per-pull-request cost correct at all.
    const first = repo("git@github.com:acme/widget-svc.git", "feat/one")
    const second = repo("git@github.com:acme/widget-svc.git", "feat/two")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: first })
    run({ hook_event_name: "PostToolUse", session_id: "s1", prompt_id: "p1", cwd: second })
    await settle()

    assert.deepEqual(
      posts.map((post) => JSON.parse(post).body.entries[0].branch),
      ["feat/one", "feat/two"],
    )
  })

  it("says nothing about a detached HEAD", async () => {
    // git reports the literal string "HEAD", which is not a branch and would collide
    // across every repository in the organisation.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    execFileSync("git", ["-C", dir, "checkout", "-q", sha], { stdio: "ignore" })

    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: dir })
    await settle()

    assert.equal(posts.length, 0)
  })

  it("says nothing about a checkout with no remote", async () => {
    // Real work, but against a repository nobody connected — there is no identity the
    // server could join it on.
    const dir = repo("")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: dir })
    await settle()

    assert.equal(posts.length, 0)
  })

  it("says nothing outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otx-plain-"))
    run({ hook_event_name: "SessionStart", session_id: "s1", cwd: dir })
    await settle()

    assert.equal(posts.length, 0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("prints valid JSON and succeeds with no credential", async () => {
    // This runs in front of a person's prompt. An unconfigured install must be silent, not
    // an error in their terminal.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const out = run(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: dir },
      { OPENTRACE_TELEMETRY_API_KEY: "", OTEL_EXPORTER_OTLP_HEADERS: "" },
    )
    await settle()

    assert.equal(out, "{}")
    assert.equal(posts.length, 0)
  })

  it("prints valid JSON on a malformed payload", () => {
    const out = execFileSync("node", [SCRIPT], {
      input: "not json at all",
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    assert.equal(out, "{}")
  })

  it("prints valid JSON when the ingest is unreachable", async () => {
    const dir = repo("git@github.com:acme/widget-svc.git")
    const out = run({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: dir }, {
      // A port nothing is listening on.
      OPENTRACE_API_URL: "http://127.0.0.1:1",
    })

    assert.equal(out, "{}")
  })

  it("borrows the telemetry credential the exporter already carries", async () => {
    // Wherever Claude Code telemetry already points at OpenTrace, that header holds a key
    // with exactly the right scope — so turning this on needs no second secret.
    const dir = repo("git@github.com:acme/widget-svc.git")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir }, {
      OPENTRACE_API_URL: "",
      OPENTRACE_TELEMETRY_API_KEY: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/v1/logs`,
      OTEL_EXPORTER_OTLP_HEADERS: "x-other=1,Authorization=Bearer otk_from_otel",
    })
    await settle()

    assert.equal(JSON.parse(posts[0]).auth, "Bearer otk_from_otel")
  })

  it("never sends the exporter's credential to a different host", async () => {
    // An ordinary configuration, not a misconfiguration: an organisation exporting OTLP to
    // its own collector while naming OpenTrace explicitly. Resolved as two independent
    // chains, each service's bearer token ended up posted to the other one's host.
    const dir = repo("git@github.com:acme/widget-svc.git")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir }, {
      OPENTRACE_API_URL: base,
      OPENTRACE_TELEMETRY_API_KEY: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.vendor.test/v1/logs",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer vendor_secret",
    })
    await settle()

    for (const post of posts) {
      assert.notEqual(JSON.parse(post).auth, "Bearer vendor_secret")
    }
  })

  it("never sends an OpenTrace credential to a collector that is not OpenTrace", async () => {
    // The destination and the credential were resolved by two chains that did not know
    // about each other. Binding only the borrowed OTLP header to the host left the two
    // credentials that actually name OpenTrace — the explicit key and the token file on
    // disk — free to travel anywhere the OTLP endpoint happened to point.
    //
    // This is an ordinary configuration, not a misconfiguration: an organisation exporting
    // OTLP to its own collector, with an OpenTrace key on the machine.
    const dir = repo("git@github.com:acme/widget-svc.git")
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "opentrace-plugin.token"), "otk_from_disk")

    for (const extra of [
      { OPENTRACE_TELEMETRY_API_KEY: "otk_explicit" },
      { OPENTRACE_TELEMETRY_API_KEY: "" },
    ]) {
      posts.length = 0
      fs.rmSync(path.join(home, "opentrace-session-context.json"), { force: true })
      fs.rmSync(path.join(home, ".claude", "opentrace-session-context.json"), { force: true })
      run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir }, {
        // The collector is our own test server, so anything sent to it is visible here.
        OPENTRACE_API_URL: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/v1/logs`,
        OTEL_EXPORTER_OTLP_HEADERS: "x-other=1",
        ...extra,
      })
      await settle()

      for (const post of posts) {
        const auth = JSON.parse(post).auth
        assert.notEqual(auth, "Bearer otk_explicit", "the explicit key names OpenTrace, not the collector")
        assert.notEqual(auth, "Bearer otk_from_disk", "the token file names OpenTrace, not the collector")
      }
    }
  })

  it("strips a credential embedded in the remote before sending it", async () => {
    // What a GitHub App checkout and most CI clones look like. This field is sent verbatim,
    // so an unstripped token travels in the request body and reaches request logs at
    // whatever host the post goes to. Removing our own credential from the wrong host is no
    // use while somebody else's rides along in the payload.
    const dir = repo("https://x-access-token:ghp_SECRET123@github.com/acme/widget-svc.git")
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir })
    await settle()

    const entry = JSON.parse(posts[0]).body.entries[0]
    assert.equal(entry.remote_url, "https://github.com/acme/widget-svc.git")
    assert.ok(!JSON.stringify(posts).includes("ghp_SECRET123"), "no part of the post may carry it")
  })

  it("refuses a destination whose URL carries userinfo", async () => {
    // `https://api.opentrace.ai@evil.test` reads as OpenTrace to a human and resolves to
    // `evil.test`. A configuration line is usually copied rather than parsed.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const out = run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir }, {
      OPENTRACE_API_URL: `https://api.opentrace.ai@127.0.0.1:${new URL(base).port}`,
    })
    await settle()

    assert.equal(out, "{}")
    assert.equal(posts.length, 0)
  })

  it("keeps reporting after a clock jump leaves a future timestamp behind", async () => {
    // A stamp in the future makes the elapsed time negative, which reads as "debounced" for
    // ever — the session silently stops reporting and nothing says why.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const statePath = path.join(home, ".claude", "opentrace-session-context.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({ anything: Date.now() + 86_400_000 }))

    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir })
    await settle()

    assert.equal(posts.length, 1)
  })

  it("runs when the wrapper is reached through a symlink", () => {
    // Wiring this by hand usually means linking the wrapper somewhere convenient, and the
    // link's own directory holds no bin/ — which put us back to failing open silently.
    const wrapper = path.join(repoRoot(), "plugins", "claude-code", "hooks", "session-context.sh")
    const link = path.join(home, "linked-hook.sh")
    fs.symlinkSync(wrapper, link)
    const dir = repo("git@github.com:acme/widget-svc.git")
    const env = { ...process.env, HOME: home, OPENTRACE_API_URL: base, OPENTRACE_TELEMETRY_API_KEY: "otk_test" }
    delete (env as Record<string, string | undefined>).CLAUDE_PLUGIN_ROOT

    const out = execFileSync(link, {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p1",
        cwd: dir,
      }),
      encoding: "utf8",
      env,
    })

    assert.equal(out, "{}")
  })

  it("refuses to carry a bearer token over plaintext", async () => {
    // Anything that can read this token can then write telemetry as that member, so a
    // plaintext destination is refused rather than downgraded. Loopback stays allowed,
    // which is what every other test here relies on.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const out = run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: dir }, {
      OPENTRACE_API_URL: "http://telemetry.internal.test",
    })
    await settle()

    assert.equal(out, "{}")
    assert.equal(posts.length, 0)
  })

  it("runs when it is wired by hand, not only as an installed plugin", async () => {
    // The wrapper resolves its own directory. Relying on ${CLAUDE_PLUGIN_ROOT} — which is
    // only set for an INSTALLED plugin — made `set -u` abort the script before it ever
    // reached node, and the failure was invisible by design: the hook is supposed to be
    // silent, so it printed `{}` and reported nothing at all. That is exactly how anyone
    // testing this from a settings.json would wire it.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const wrapper = path.join(repoRoot(), "plugins", "claude-code", "hooks", "session-context.sh")
    const env = { ...process.env, HOME: home, OPENTRACE_API_URL: base, OPENTRACE_TELEMETRY_API_KEY: "otk_test" }
    delete (env as Record<string, string | undefined>).CLAUDE_PLUGIN_ROOT

    const out = execFileSync(wrapper, {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p1",
        cwd: dir,
      }),
      encoding: "utf8",
      env,
    })
    await settle()

    assert.equal(out, "{}")
    assert.equal(posts.length, 1, "the wrapper must reach the script without CLAUDE_PLUGIN_ROOT")
  })

  it("writes the session id where the user's own tooling can read it", async () => {
    const dir = repo("git@github.com:acme/widget-svc.git")
    const envFile = path.join(home, "session.env")
    run({ hook_event_name: "SessionStart", session_id: "abc-123", cwd: dir }, { CLAUDE_ENV_FILE: envFile })
    await settle()

    assert.equal(fs.readFileSync(envFile, "utf8"), "OT_CLAUDE_SESSION_ID=abc-123\n")
  })

  it("writes the session id once however many hooks fire", async () => {
    // The env file is sourced ahead of the commands a session runs. Written on all four
    // hook events it gained an identical line every time a tool ran, so a long editing
    // session left hundreds of duplicates to be re-read on every command.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const envFile = path.join(home, "session.env")
    for (const prompt of ["p1", "p2", "p3"]) {
      run({ hook_event_name: "PostToolUse", session_id: "abc-123", prompt_id: prompt, cwd: dir }, {
        CLAUDE_ENV_FILE: envFile,
      })
    }
    await settle()

    assert.equal(fs.readFileSync(envFile, "utf8"), "OT_CLAUDE_SESSION_ID=abc-123\n")
  })

  for (const body of ["null", "[]", "42", "not json at all"]) {
    it(`prints valid JSON and exits 0 on a payload of ${body}`, () => {
      // `JSON.parse` succeeds on three of these, and none is a hook payload. `null` threw a
      // TypeError past every guard, so the script exited non-zero having printed nothing —
      // the one thing it promises never to do. The shell wrapper masked it.
      const out = execFileSync("node", [SCRIPT], {
        input: body,
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      })

      assert.equal(out, "{}")
    })
  }

  it("refuses to write a session id that could carry shell syntax", async () => {
    // The env file is sourced. A session id is an opaque identifier and has never contained
    // anything but hex and dashes, so anything else is refused rather than escaped.
    const dir = repo("git@github.com:acme/widget-svc.git")
    const envFile = path.join(home, "session.env")
    run({ hook_event_name: "SessionStart", session_id: "a\nexport EVIL=1", cwd: dir }, { CLAUDE_ENV_FILE: envFile })
    await settle()

    assert.equal(fs.existsSync(envFile), false)
  })
})
