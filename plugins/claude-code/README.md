# OpenTrace plugin for Claude Code

A thin wrapper around the hosted OpenTrace **dynamic MCP server** (`https://api.opentrace.ai/mcp/v1`), plus hooks that teach Claude when to reach for it.

## What's included

- **`.mcp.json`** — registers the dynamic MCP server (streamable HTTP, stateless). Authentication uses the standard MCP OAuth flow: Claude Code discovers the authorization server via RFC 9728 protected-resource metadata and prompts you to sign in on first use. Local dev servers running in auth-bypass mode need no credentials.
- **`bin/prewarm.cjs`** — resolves the current checkout against OpenTrace at session start (see "Context prewarm" below).
- **`hooks/session-start.sh`** — injects a ready-to-use binding for the current checkout (environment/workspace slugs, `source_id`, indexed commit, freshness vs. your HEAD) plus routing guidance, so the model's first OpenTrace call needs no discovery hops. Falls back to static workflow guidance when prewarm can't run.
- **`hooks/user-prompt-submit.sh`** — when a prompt looks like an architecture, dependency, existence, or structure question, reminds the model that the graph tools can answer it — including the exact prewarmed parameters for this checkout when available. Silent (`{}`) otherwise.
- **`bin/session-context.cjs`** + **`hooks/session-context.sh`** — report which repository and branch each prompt is working on (see "Session context" below). Silent (`{}`) always.
- **`skills/setup/SKILL.md`** — `/opentrace:setup`, and model-invoked when the tools are missing or a call fails to authenticate. Walks the user from an unconnected server through sign-in to a verified tool call, and distinguishes the failure that looks like a broken plugin but isn't: valid credentials against an account with nothing indexed.

## Context prewarm

At session start, `prewarm.cjs` derives `owner/repo` from `git remote`, resolves it to an indexed source over the MCP endpoint (~1s first run, cached after), and computes freshness locally with git (`merge-base`/`rev-list` against the indexed commit — no provider account needed). The model then starts each session knowing, e.g.:

> This checkout (opentrace/opentrace-api) is indexed as "opentrace/opentrace-api" … indexed at 71e0cc3 on "dev" — an ancestor of your HEAD, 17 commit(s) behind it.

with copy-pasteable arguments for `graph_search`, `graph_get_repo_overview`, and `graph_search_source_regions`.

Details:

- **Auth**: prewarm reuses the API key written by `otx connect otk_… --client claude-code` (`~/.claude/opentrace-plugin.token`). OAuth-only installs have no key on disk, so prewarm degrades to static guidance — the MCP itself still works over OAuth in-session.
- **Cache**: bindings live in `~/.claude/opentrace-prewarm.json`, keyed by normalized remote. Positive entries refresh on every fresh session start; resumed/compacted sessions and prompt hints answer from cache instantly; "not indexed" results are re-checked after 24h. Delete the file to reset.
- **Overrides**: `OPENTRACE_MCP_URL` (endpoint), and `OPENTRACE_ENVIRONMENT` + `OPENTRACE_WORKSPACE` (slugs, set both) to pin the scope instead of scanning your workspaces.
- **Failure behavior**: a failed refresh serves the cached binding with a staleness note, or static guidance if nothing is cached. Unreachable endpoints and reachable-but-failing ones (auth rejected, tenant provisioning, malformed reply) are reported distinctly, so the note never blames the network for a server-side answer. The hook always answers within ~6s and never blocks the session.
- **Debugging**: the hook is silent by design; set `OPENTRACE_PREWARM_DEBUG=1` to print the reason a refresh failed to stderr.

## Session context

Claude Code's own telemetry export names a repository but never a branch, and it resolves
that repository **once at process launch** from the launch directory — it is never refreshed
when the session moves. So a session that switches branches reports the first one for its
whole life, and an orchestrator run launched in a non-git root reports nothing at all. Both
are why per-pull-request cost used to be an estimate.

These hooks fix it by observing the work as it happens. `session-context.cjs` runs on
`SessionStart`, `CwdChanged`, `UserPromptSubmit` and `PostToolUse`, reads the git remote,
branch and head commit for the directory the work is actually in, and posts them to
`POST /ingest/claude-code/v1/session-context`. The join key is `prompt_id`, which the
telemetry events already carry, so each prompt is priced against the branch it was on.

Details:

- **What it sends**: the git remote URL, branch, head commit, and the session/prompt/agent
  ids. It never sends a user, an organisation, a file path, a prompt or any code. The server
  attributes every observation to the member the API key belongs to, so there is nothing to
  spoof by editing the script.
- **Why the remote and not a repository key**: the key's provider segment is an internal
  integration kind (GitHub's is `github_app`). The server derives it, so a rename there
  cannot silently split one repository's charts in two across plugin versions.
- **Set `OPENTRACE_API_URL`. It is not optional.** Claude Code does not pass `OTEL_*`
  variables to hook subprocesses. Put both families in one settings `env` block and a hook
  sees `OPENTRACE_API_URL` and *not* `OTEL_EXPORTER_OTLP_ENDPOINT`, so these hooks cannot
  read the exporter's endpoint or borrow its `Authorization` header however they are
  configured.

  Without it the destination falls back to `https://api.opentrace.ai`. On a self-hosted or
  local install that means your repositories and branches are reported to the public host
  while the table you are watching stays empty.

- **Put the key in `~/.claude/opentrace-telemetry.token`, not in the `env` block.** That
  same stripping is what keeps the key contained: inside `OTEL_EXPORTER_OTLP_HEADERS` it
  reaches Claude Code's exporter and nothing else, while anything named `OPENTRACE_*` is
  inherited by every hook, every Bash tool call and every MCP server the session starts —
  readable with a bare `env`, and apt to end up in a transcript. The file is mode 0600 and
  is the first place these hooks look.

  **Its own file, not the MCP's.** `~/.claude/opentrace-plugin.token` holds the CLI key the
  MCP authenticates with, which can read your graphs; this is a usage key that deliberately
  cannot read anything. They are separate files so that setting one up never overwrites the
  other.

  `otx install` writes the URL and the token file for you; a manual setup must add both by
  hand.

- **Resolution order for the key**, first match wins: `~/.claude/opentrace-telemetry.token`,
  then `OPENTRACE_TELEMETRY_API_KEY`, then the `Authorization` entry in
  `OTEL_EXPORTER_OTLP_HEADERS` when the destination is that same host, then
  `~/.claude/opentrace-plugin.token`.

  The file outranks the variable because only the CLI writes the file, so when both exist
  the file is the newer fact — otherwise a copy of the variable left behind by an older
  setup would shadow a rotated key and reporting would fail silently. With no file the
  variable still wins, which keeps it usable as a deliberate override for anything invoking
  these scripts outside Claude Code. The last entry is the upgrade path: a machine whose
  plugin predates the telemetry file has only the MCP's key on disk, and borrowing it keeps
  reporting alive until the CLI writes the new one.

- **A credential only ever goes to the service it names.** Endpoint: `OPENTRACE_API_URL`,
  else the origin of `OTEL_EXPORTER_OTLP_ENDPOINT`, else `https://api.opentrace.ai`.
  Credentials that name OpenTrace — `~/.claude/opentrace-telemetry.token`,
  `OPENTRACE_TELEMETRY_API_KEY` and `~/.claude/opentrace-plugin.token` — are used only when
  the destination is one you named with `OPENTRACE_API_URL`, or the default. The `Authorization` entry in
  `OTEL_EXPORTER_OTLP_HEADERS` belongs to whatever the exporter points at, so it is borrowed
  only when that is the destination — a rule that matters for a process invoking this script
  directly, since a Claude Code hook never sees that variable at all.
  Nothing is inferred: a collector we were not told is OpenTrace is not treated as
  OpenTrace, and the result is a missing observation rather than a leaked key. An
  organisation exporting OTLP to its own collector while holding an OpenTrace key is a
  normal setup, and resolving the two independently sent each service's bearer token to the
  other one's host.
- **HTTPS only**, except to loopback for local development. The request carries a bearer
  token, so a plaintext destination is refused rather than downgraded.
- **Debounce**: one post per `(session, agent, prompt, repository, branch)` per minute,
  cached in `~/.claude/opentrace-session-context.json`. The repeats a tool hook produces
  inside one prompt collapse to a single post, while every prompt still gets reported —
  the server joins on the prompt id, so a debounce that dropped prompts would silently
  price them as unattributed.
- **Failure behavior**: silent and open in every case — no node, no git, a detached HEAD, a
  checkout with no remote, no credential, no network. Every path prints `{}` and exits 0, and
  the request is bounded at 2s. A missing observation shows up server-side as unattributed
  spend rather than as an error in front of your prompt.
- **`OT_CLAUDE_SESSION_ID`**: written to `$CLAUDE_ENV_FILE` at session start so your own
  tooling can name the session it is running inside.

## MCP tools (served dynamically by opentrace-api)

| Tool | Purpose |
|---|---|
| `workspaces_list` | List workspaces you can access (start here); use each workspace's `environment_slug` + `workspace_slug` for scoped calls |
| `environments_list` | List environments |
| `graph_list_code_sources` | Enumerate indexed repositories ("sources") in a workspace |
| `graph_resolve_code_source` | Resolve a repository to a `source_id` (resolve before graph/source calls) |
| `graph_get_repo_overview` | Repository overview for a `source_id` |
| `graph_search` | Search a workspace graph for symbols, files, dependencies |
| `graph_explore_focused_subgraph` | Explore the graph neighborhood around one symbol |
| `graph_search_source_files` | Find files by path or name within an indexed source |
| `graph_search_source_regions` | Search source text — string literals, error messages, config keys |
| `source_load` | Load bounded source text for a `load_ref` from graph results |
| `source_get_context` | Remote-head / latest-commit freshness context for a source |
| `source_history` | Recent commits for a source or path, each with the change request it landed through |
| `source_blame` | Who last touched given lines, and in which commit |
| `change_requests_list` | List GitHub PRs / GitLab MRs |
| `change_requests_search` | Search GitHub PRs / GitLab MRs |
| `change_requests_read` | Bounded detail for one change request (files, commits, discussions, reviews, checks) |
| `issues_list` | List GitHub / GitLab issues |
| `issues_search` | Search GitHub / GitLab issues |
| `issues_read` | Bounded detail for one issue |

The tool inventory lives server-side (`opentrace-api`) — the server advertises the authoritative set and usage instructions on connect, so new tools appear without a plugin update. This table is a convenience snapshot; treat the server as the source of truth.

## Install

Install the plugin and its marketplace in one line:

```bash
claude plugin marketplace add opentrace/opentrace-cli && claude plugin install opentrace@opentrace
```

Or let the OpenTrace CLI do the whole setup — plugin, MCP registration and sign-in together:

```bash
npx -y @opentrace/cli@latest login
```

For local development against a checkout of this repo, load the plugin without installing it:

```bash
claude --plugin-dir ./plugins/claude-code
```

Pointing at a different API (dev/local): the plugin exposes an `mcp_url` config option (default `https://api.opentrace.ai/mcp/v1`). Set it at install time:

```bash
claude plugin install opentrace@opentrace --config mcp_url=https://api.dev.opentrace.ai/mcp/v1
```

Otherwise Claude Code prompts for it, or you can set it later with `/plugin configure opentrace@opentrace`. It's a per-user setting, stored in user settings.

## Privacy Policy

This plugin sends data to OpenTrace's hosted API (`api.opentrace.ai`), operated by OpenTrace. Nothing is sent to any third party.

**What is sent.** MCP tool calls carry the query arguments Claude constructs — search terms, symbol names, repository and workspace identifiers. The session-start prewarm additionally sends the current checkout's git remote URL and commit SHAs, so the server can resolve which indexed repository you are working in. Your source code is read from the graphs OpenTrace has already indexed under your account; the plugin does not upload working-tree file contents.

**What is stored locally.** The MCP's API key at `~/.claude/opentrace-plugin.token` (mode 0600) when you connect with one, the usage key these hooks report with at `~/.claude/opentrace-telemetry.token` (mode 0600) when monitoring is set up, and a resolved-binding cache at `~/.claude/opentrace-prewarm.json`. Delete any of them to clear it; `otx disconnect --usage` removes the usage key, and `otx disconnect --plugin` the MCP's.

**Data collection, retention, third-party sharing and contact details** are covered in full by the OpenTrace privacy policy: <https://docs.opentrace.com/privacy-policy/>. Terms of service: <https://docs.opentrace.com/terms-of-service/>.
