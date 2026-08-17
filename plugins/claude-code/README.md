# OpenTrace plugin for Claude Code

A thin wrapper around the hosted OpenTrace **dynamic MCP server** (`https://api.opentrace.ai/mcp/v1`), plus hooks that teach Claude when to reach for it.

## What's included

- **`.mcp.json`** — registers the dynamic MCP server (streamable HTTP, stateless). Authentication uses the standard MCP OAuth flow: Claude Code discovers the authorization server via RFC 9728 protected-resource metadata and prompts you to sign in on first use. Local dev servers running in auth-bypass mode need no credentials.
- **`bin/prewarm.cjs`** — resolves the current checkout against OpenTrace at session start (see "Context prewarm" below).
- **`hooks/session-start.sh`** — injects a ready-to-use binding for the current checkout (environment/workspace slugs, `source_id`, indexed commit, freshness vs. your HEAD) plus routing guidance, so the model's first OpenTrace call needs no discovery hops. Falls back to static workflow guidance when prewarm can't run.
- **`hooks/user-prompt-submit.sh`** — when a prompt looks like an architecture, dependency, existence, or structure question, reminds the model that the graph tools can answer it — including the exact prewarmed parameters for this checkout when available. Silent (`{}`) otherwise.

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
| `source_load` | Load bounded source text for a `load_ref` from graph results |
| `source_get_context` | Remote-head / latest-commit freshness context for a source |
| `change_requests_list` | List GitHub PRs / GitLab MRs |
| `change_requests_search` | Search GitHub PRs / GitLab MRs |
| `change_requests_read` | Bounded detail for one change request (files, commits, discussions, reviews, checks) |

The tool inventory lives server-side (`opentrace-api`) — the server advertises the authoritative set and usage instructions on connect, so new tools appear without a plugin update. This table is a convenience snapshot; treat the server as the source of truth.

## Install

```bash
# From this repo (local path)
claude plugin install ./plugins/claude-code

# From git
claude plugin install github:opentrace/opentrace-cli?path=plugins/claude-code

# From npm (once published)
claude plugin install @opentrace/claude-code-plugin
```

Pointing at a different API (dev/local): the plugin exposes an `mcp_url` config option (default `https://api.opentrace.ai/mcp/v1`). Claude Code prompts for it when the plugin is enabled — set it to e.g. `https://api.dev.opentrace.ai/mcp/v1` or `http://localhost:8000/mcp/v1`. (It's a per-user setting, stored in user settings.)

Leave the trailing slash off. The server advertises `…/mcp/v1` (no slash) as its OAuth resource identifier in its protected-resource metadata, and Claude Code derives the RFC 8707 `resource` parameter from whatever URL it is configured with — a slash produces a resource the authorization server does not recognize. `otx install` strips it for you.

## Privacy Policy

This plugin sends data to OpenTrace's hosted API (`api.opentrace.ai`), operated by OpenTrace. Nothing is sent to any third party.

**What is sent.** MCP tool calls carry the query arguments Claude constructs — search terms, symbol names, repository and workspace identifiers. The session-start prewarm additionally sends the current checkout's git remote URL and commit SHAs, so the server can resolve which indexed repository you are working in. Your source code is read from the graphs OpenTrace has already indexed under your account; the plugin does not upload working-tree file contents.

**What is stored locally.** An API key at `~/.claude/opentrace-plugin.token` (mode 0600) when you connect with one, and a resolved-binding cache at `~/.claude/opentrace-prewarm.json`. Delete either file to clear it.

**Data collection, retention, third-party sharing and contact details** are covered in full by the OpenTrace privacy policy: <https://docs.opentrace.com/privacy-policy/>. Terms of service: <https://docs.opentrace.com/terms-of-service/>.
