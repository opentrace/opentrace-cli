# OpenTrace plugin for Claude Code

A thin wrapper around the hosted OpenTrace **dynamic MCP server** (`https://api.opentrace.ai/mcp/v1/`), plus hooks that teach Claude when to reach for it.

## What's included

- **`.mcp.json`** — registers the dynamic MCP server (streamable HTTP, stateless). Authentication uses the standard MCP OAuth flow: Claude Code discovers the authorization server via RFC 9728 protected-resource metadata and prompts you to sign in on first use. Local dev servers running in auth-bypass mode need no credentials.
- **`hooks/session-start.sh`** — injects context at session start describing the MCP tools and the `workspaces_list` → `environment_slug`/`workspace_slug` → resolve `source_id` → graph/source workflow, so the model uses the server correctly without trial and error.
- **`hooks/user-prompt-submit.sh`** — when a prompt looks like an architecture, dependency, or impact question, adds a short reminder that the OpenTrace graph tools can help. Silent (`{}`) otherwise.

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

Pointing at a different API (dev/local): the plugin exposes an `mcp_url` config option (default `https://api.opentrace.ai/mcp/v1/`). Claude Code prompts for it when the plugin is enabled — set it to e.g. `https://api.dev.opentrace.ai/mcp/v1/` or `http://localhost:8000/mcp/v1/`. (It's a per-user setting, stored in user settings.)
