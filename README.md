# @opentrace/cli

CLI for setting up and managing OpenTrace integrations.

## Installation

```bash
# Run once with npx (no install needed)
npx @opentrace/cli add-mcp

# Or install globally
npm install -g @opentrace/cli
```

## Commands

### `opentrace add-mcp [path]`

Adds the OpenTrace MCP server to a project's `.mcp.json`. Defaults to the current directory.

```bash
# Add to the current directory
opentrace add-mcp

# Target a specific repo
opentrace add-mcp /path/to/repo
```

**Options:**

| Flag | Description |
|------|-------------|
| `--base-url <url>` | API base URL (default: `https://api.opentrace.ai`) |
| `-y, --yes` | Skip confirmation prompts |

After running, restart Claude Code. The OpenTrace MCP server will be available in your project.

## What it adds

`add-mcp` merges a new entry into your project's `.mcp.json` (creating the file if it doesn't exist), leaving any existing MCP servers untouched:

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

## License

Apache-2.0
