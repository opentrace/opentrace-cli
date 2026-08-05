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

What it does: validates the key shape locally, then confirms it with an MCP handshake against the endpoint (invalid/expired/revoked keys are rejected before anything is written). Then, per client:

- **Claude Code** → installs the **plugin** (which supersedes a bare MCP entry) and attaches the key to it: seeds the plugin's `mcp_url` and writes the key to `~/.claude/opentrace-plugin.token` (0600), which the plugin's `headersHelper` reads to send `Authorization: Bearer …`. No direct `~/.claude.json` entry.
- **Cursor / Claude Desktop** → writes the MCP entry with the `Authorization: Bearer` header directly, and stores the key in your OS keychain.

The key is never printed. (Undo: `otx disconnect --plugin` for Claude Code, or `otx disconnect --mcp --keychain --client cursor` for the others.)

### `otx connect [path]` / `otx install [path]`

When `connect` is given a path (or nothing) instead of a key, it runs editor onboarding — the Claude Code plugin where supported (which supersedes the bare MCP), a plain MCP entry everywhere else. `install` is the same flow.

Interactive by default. It asks three things, each skippable with a flag:

1. **Scope** — just this project, or all projects (`-g, --global`)
2. **Which tools** — detected ones pre-checked; the rest are still listed, so you can configure a tool before installing it (per-tool flags)
3. **API key** — leave blank to sign in from the tool with OAuth instead (`--api-key`)

A pasted key is shape-checked, then confirmed with an MCP handshake before anything is written; a key this machine already holds (OS keychain, or the plugin token file) is reused without asking. Keys are always written **user-scoped**, even when you pick project scope, so a bearer token never lands in a committable file. Tools with no API-key mechanism get the headerless MCP entry and are called out in the summary.

```bash
otx connect                    # prompt: scope → tools → key
otx install --claude-code      # a specific tool (still asks scope + key)
otx install /path/to/repo -y   # no prompts: detected tools, project scope, stored key
otx install --global           # user-level instead of project-level
otx install --api-key otk_…    # attach a key non-interactively
```

`-y` and any non-interactive run (CI, piped stdin) skip every prompt and fall back to detected tools, project scope, and whatever key is already stored.

**Options:** `--base-url <url>`, `--url <url>`, `--api-key <key>`, `-y, --yes`, `-g, --global`, and per-tool flags (`--claude-code`, `--cursor`, `--windsurf`, `--vscode`, `--continue`, `--zed`, `--jetbrains`).

### `otx add-mcp [path]`

Adds only the OpenTrace MCP server to a Claude Code project's `.mcp.json` (no plugin, no key). Defaults to the current directory.

**Options:** `--base-url <url>`, `-y, --yes`.

### `otx disconnect [path]`

Reverses what the CLI set up. Choose components; with none selected it prompts interactively (or removes everything under `-y`).

```bash
otx disconnect --all                      # MCP entries + plugin + keychain key
otx disconnect --mcp                       # just the MCP server entries
otx disconnect --mcp --client cursor       # only Cursor's MCP entry
otx disconnect --plugin                    # just the Claude Code plugin declaration
otx disconnect --keychain --url https://…  # just the stored key for a host
```

**Options:**

| Flag | Description |
|------|-------------|
| `--mcp` / `--plugin` / `--keychain` | Pick components (combine freely) |
| `--all` | All three |
| `--client <id>` | Restrict MCP removal to one client (`claude-code`, `claude-desktop`, `cursor`, …) |
| `--url <url>` | Keychain endpoint whose key to delete (for a non-default host) |
| `-g, --global` | Also check user-level editor configs |
| `-y, --yes` | Skip prompts |

It removes the OpenTrace entry from each client config it finds, drops the plugin's `extraKnownMarketplaces`/`enabledPlugins` declaration (run `claude plugin uninstall opentrace@opentrace` to also clear the installed plugin cache), and deletes the stored key from the OS keychain — for the API-key flow it auto-derives the keychain host from the config it removed, so `--all` needs no `--url`.

## What it writes

### API-key flow (`connect otk_…`)

The bearer key goes into a **user-scoped** file in your home directory (never a committed project file), locked to `0600`.

- **Claude Code** — installs the plugin and attaches the key. The endpoint is seeded as the plugin's `mcp_url` (`pluginConfigs` in `~/.claude/settings.json`) and the key is written to `~/.claude/opentrace-plugin.token`. The plugin's `.mcp.json` carries a `headersHelper` (`bin/auth-headers.cjs`) that emits `Authorization: Bearer <key>` when that file exists, and nothing (→ OAuth) when it doesn't:
  ```json
  { "mcpServers": { "opentrace": {
    "type": "http",
    "url": "${user_config.mcp_url}",
    "headersHelper": "node \"${CLAUDE_PLUGIN_ROOT}/bin/auth-headers.cjs\""
  } } }
  ```
- **Cursor** — `~/.cursor/mcp.json`, direct header entry + OS keychain:
  ```json
  { "mcpServers": { "opentrace": { "url": "https://<host>/mcp/v1/", "headers": { "Authorization": "Bearer otk_…" } } } }
  ```
- **Claude Desktop** — `claude_desktop_config.json`. Desktop has no native remote-HTTP-with-headers support, so otx wires it through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) stdio bridge (needs Node.js/npx), + OS keychain:
  ```json
  { "mcpServers": { "opentrace": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<host>/mcp/v1/", "--header", "Authorization: Bearer otk_…"]
  } } }
  ```

### Editor onboarding (`connect <path>` / `install`)

- **Claude Code → plugin only.** Where a plugin is available it supersedes the bare MCP entry (the plugin bundles its own MCP), so **no `.mcp.json` is written for Claude Code** — just the plugin declaration (`extraKnownMarketplaces` + `enabledPlugins`) in `.claude/settings.json`. Claude Code prompts to install when you trust the folder. (Want the Claude Code MCP *without* the plugin? Use `add-mcp`.)
- **Other editors → MCP entry.** Cursor, Windsurf, VS Code, Zed, JetBrains, Continue get the headerless MCP config; auth is the editor's (OAuth).
- **Endpoint** — pass `--url` (or `--base-url`) to target a non-prod host. For Claude Code it's injected as the plugin's `mcp_url` (written to `pluginConfigs` in `~/.claude/settings.json`, since Claude Code reads plugin config from user settings only); for other editors it's written into the MCP entry. Omit it and the plugin falls back to prompting for `mcp_url` (default `https://api.opentrace.ai/mcp/v1/`) on enable.
- **With an API key** — the key goes to the same user-scoped destinations as the `connect otk_…` flow above (plugin token file for Claude Code; bearer-header entry + keychain for Cursor). The endpoint is always seeded as the plugin's `mcp_url` in that case, so the plugin never prompts for one.

## Authentication

Two models:

- **API key** (`connect otk_…`) — a `otk_` bearer key sent on every request, granting tenant-global reach. The key works against the MCP endpoint only; the CLI validates it via an MCP handshake (not a REST call). Keys can expire or be revoked — if calls start returning `401`, reconnect with a fresh key.
- **OAuth** (`install` / `connect <path>` when you leave the key prompt blank) — the AI tool performs the OAuth handshake against the MCP endpoint itself; the CLI stores no token. Run `/mcp` in Claude Code and sign in.

The **Claude Code plugin supports both**, and `otx install` can set up either: skip the key prompt for OAuth, or paste a key (or pass `--api-key`) to attach one — the same result as `otx connect otk_… --client claude-code`. With a key present the plugin authenticates by header; without one it uses OAuth.

## License

Apache-2.0
