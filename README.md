# @opentrace/cli

CLI for setting up and managing OpenTrace integrations. Ships two binaries — `opentrace` and the short alias `otx`.

## Installation

```bash
# Run once with npx (no install needed)
npx @opentrace/cli connect

# Or install globally (adds both `opentrace` and `otx`)
npm install -g @opentrace/cli
```

## Quick start

```bash
# Onboard every AI tool detected on this machine
otx connect
```

`connect` auto-detects your installed AI tools, registers the OpenTrace MCP server for each, and — where the tool supports it (currently Claude Code) — enables the OpenTrace plugin. Afterwards, open Claude Code, run `/mcp`, and sign in to OpenTrace to authorize the connection.

## Commands

### `otx connect [path]` (alias: `opentrace install`)

Onboards OpenTrace for all detected AI tools (or specific ones). Registers the MCP server everywhere, and installs the Claude Code plugin where supported. Defaults to the current directory.

```bash
# Detect installed tools and onboard all of them
otx connect

# Onboard a specific tool only
otx connect --claude-code
otx connect --cursor

# Target a specific repo, no prompts
otx connect /path/to/repo -y

# User-level (all projects) instead of this project
otx connect --global
```

**Options:**

| Flag | Description |
|------|-------------|
| `--base-url <url>` | API base URL (default: `https://api.opentrace.ai`) |
| `-y, --yes` | Skip confirmation prompts |
| `-g, --global` | Install to user-level config instead of project-level |
| `--claude-code`, `--cursor`, `--windsurf`, `--vscode`, `--continue`, `--zed`, `--jetbrains` | Target specific tools instead of auto-detecting |

### `otx add-mcp [path]`

Adds only the OpenTrace MCP server to a Claude Code project's `.mcp.json`, without the plugin. Defaults to the current directory.

```bash
otx add-mcp
otx add-mcp /path/to/repo
```

**Options:**

| Flag | Description |
|------|-------------|
| `--base-url <url>` | API base URL (default: `https://api.opentrace.ai`) |
| `-y, --yes` | Skip confirmation prompts |

## What it writes

**MCP server** — merged into each tool's MCP config (creating the file if needed), leaving existing servers untouched. For Claude Code that's `.mcp.json` (project) or `~/.claude/mcp.json` (`--global`):

```json
{
  "mcpServers": {
    "opentrace": {
      "type": "http",
      "url": "https://api.opentrace.ai/mcp/v1/"
    }
  }
}
```

**Claude Code plugin** — declared in `.claude/settings.json` (project) or `~/.claude/settings.json` (`--global`) via the OpenTrace marketplace. Existing settings are preserved and the change is idempotent:

```json
{
  "extraKnownMarketplaces": {
    "opentrace": { "source": { "source": "github", "repo": "opentrace/opentrace-cli" } }
  },
  "enabledPlugins": ["opentrace@opentrace"]
}
```

When you next open (and trust) the folder, Claude Code prompts to install the plugin; accept it and run `/reload-plugins`.

## Authentication

OpenTrace authenticates over OAuth, handled by the AI tool itself — the CLI never stores tokens or API keys. After onboarding, run `/mcp` in Claude Code and sign in to OpenTrace to authorize the connection.

## License

Apache-2.0
