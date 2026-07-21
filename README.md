# @opentrace/cli

CLI for setting up and managing OpenTrace integrations. Ships two binaries — `opentrace` and the short alias `otx`.

## Installation

```bash
# Run once with npx (no install needed)
npx @opentrace/cli connect otk_your_api_key

# Or install globally (adds both `opentrace` and `otx`)
npm install -g @opentrace/cli
```

## Quick start

```bash
# Connect a client to OpenTrace with your API key
otx connect otk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

This validates the key against the OpenTrace MCP endpoint, then wires your client (Claude Code by default) to talk to OpenTrace with **tenant-global** reach — every environment and workspace the key's owner can see. Restart the client, and the model can discover workspaces and operate on any of them.

## Commands

### `otx connect otk_<key> [--url <host>] [--client <id>]`

Connects a client to the OpenTrace global MCP endpoint using an API key. The key (format `otk_` + 43 characters) is issued from the OpenTrace dashboard.

```bash
# Default client (Claude Code)
otx connect otk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# A specific client
otx connect otk_… --client claude-desktop
otx connect otk_… --client cursor

# A non-default API host
otx connect otk_… --url https://api.example.opentrace.ai
```

**Options:**

| Flag | Description |
|------|-------------|
| `--url <url>` | MCP endpoint host (default: the OpenTrace production host). Normalized to end in `/mcp/v1/`. |
| `--client <id>` | Target client: `claude-code` (default), `claude-desktop`, or `cursor` |

What it does: validates the key shape locally, confirms it with an MCP handshake against the endpoint (invalid/expired/revoked keys are rejected before anything is written), writes the client's MCP config with the `Authorization: Bearer` header, and stores the key in your OS keychain. The key is never printed.

### `otx connect [path]` / `otx install [path]`

When `connect` is given a path (or nothing) instead of a key, it runs editor onboarding: registers the MCP server for all detected AI tools and installs the Claude Code plugin where supported. `install` is the same flow.

```bash
otx connect                 # detect installed tools, onboard all
otx install --claude-code   # a specific tool
otx install /path/to/repo -y
otx install --global        # user-level instead of project-level
```

**Options:** `--base-url <url>`, `-y, --yes`, `-g, --global`, and per-tool flags (`--claude-code`, `--cursor`, `--windsurf`, `--vscode`, `--continue`, `--zed`, `--jetbrains`).

### `otx add-mcp [path]`

Adds only the OpenTrace MCP server to a Claude Code project's `.mcp.json` (no plugin, no key). Defaults to the current directory.

**Options:** `--base-url <url>`, `-y, --yes`.

## What it writes

### API-key flow (`connect otk_…`)

The bearer key goes into a **user-scoped** config file in your home directory (never a committed project file), locked to `0600`, plus your OS keychain.

- **Claude Code** — `~/.claude.json`, native HTTP transport with headers:
  ```json
  { "mcpServers": { "opentrace": {
    "type": "http",
    "url": "https://<host>/mcp/v1/",
    "headers": { "Authorization": "Bearer otk_…" }
  } } }
  ```
- **Cursor** — `~/.cursor/mcp.json`, same shape (no `type` needed).
- **Claude Desktop** — `claude_desktop_config.json`. Desktop has no native remote-HTTP-with-headers support, so otx wires it through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) stdio bridge (needs Node.js/npx):
  ```json
  { "mcpServers": { "opentrace": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<host>/mcp/v1/", "--header", "Authorization: Bearer otk_…"]
  } } }
  ```

### Editor onboarding (`connect <path>` / `install`)

- **MCP server** — merged into each tool's MCP config (no auth header; the plugin/editor handles OAuth). For Claude Code, `.mcp.json` (project) or `~/.claude/mcp.json` (`--global`).
- **Claude Code plugin** — declared idempotently in `.claude/settings.json` via `extraKnownMarketplaces` + `enabledPlugins`; Claude Code prompts to install when you trust the folder.

## Authentication

Two models, depending on how you connect:

- **API key** (`connect otk_…`) — a `otk_` bearer key sent on every request, granting tenant-global reach. The key works against the MCP endpoint only; the CLI validates it via an MCP handshake (not a REST call). Keys can expire or be revoked — if calls start returning `401`, reconnect with a fresh key.
- **OAuth** (editor onboarding / plugin) — the AI tool performs the OAuth handshake against the MCP endpoint itself; the CLI stores no token. Run `/mcp` in Claude Code and sign in.

## License

Apache-2.0
