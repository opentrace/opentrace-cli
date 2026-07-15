# OpenTrace plugin for Claude Code

A thin wrapper around the hosted OpenTrace **dynamic MCP server** (`https://api.opentrace.ai/mcp/v1/`), plus hooks that teach Claude when to reach for it.

## What's included

- **`.mcp.json`** — registers the dynamic MCP server (streamable HTTP, stateless). Authentication uses the standard MCP OAuth flow: Claude Code discovers the authorization server via RFC 9728 protected-resource metadata and prompts you to sign in on first use. Local dev servers running in auth-bypass mode need no credentials.
- **`hooks/session-start.sh`** — injects context at session start describing the five MCP tools and the `workspaces.list` → `workspace_id` → graph/source workflow, so the model uses the server correctly without trial and error.
- **`hooks/user-prompt-submit.sh`** — when a prompt looks like an architecture, dependency, or impact question, adds a short reminder that the OpenTrace graph tools can help. Silent (`{}`) otherwise.

## MCP tools (served dynamically by opentrace-api)

| Tool | Purpose |
|---|---|
| `workspaces.list` | List workspaces you can access (start here) |
| `environments.list` | List environments |
| `graph.search` | Search a workspace graph for symbols, files, dependencies |
| `graph.explore_focused_subgraph` | Explore the graph neighborhood around one symbol |
| `source.load` | Load bounded source text for a `load_ref` from graph results |

The tool inventory lives server-side (`opentrace-api`), so new tools appear without a plugin update — the plugin is deliberately just configuration.

## Install

```bash
# From this repo (local path)
claude plugin install ./plugins/claude-code

# From git
claude plugin install github:opentrace/opentrace-cli?path=plugins/claude-code

# From npm (once published)
claude plugin install @opentrace/claude-code-plugin
```

Pointing at a different API (dev/local): edit `.mcp.json`'s `url` — e.g. `https://api.dev.opentrace.ai/mcp/v1/` or `http://localhost:8000/mcp/v1/`.

## Not included (yet)

- **Skills** — the MCP tools plus the session-start context cover the minimal use case; slash commands can come later.
- **Agents** — opentrace-api's chat agents (`workspace_chat`, `graph_explorer`) map structurally onto Claude Code subagent definitions (markdown prompt + tool allowlist + model tier), but their tools are server-side typed contracts dispatched through an internal registry, not MCP tools. A plugin agent could only approximate them over the five MCP tools rather than mirror the implementation, so we deferred this.
