# MCP Server Installation — Tool Reference

How to configure the OpenTrace MCP server across every major AI coding tool.
The HTTP endpoint is `https://api.opentrace.ai/mcp/v1/`.

---

## Summary table

| Tool | Config file | Root key | HTTP transport | Notes |
|---|---|---|---|---|
| Claude Code | `.mcp.json` (project) or `~/.claude/mcp.json` (user) | `mcpServers` | ✓ | Also has CLI: `claude mcp add` |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user) | `mcpServers` | ✓ | File-only, no CLI |
| Windsurf / Devin Desktop | `~/.codeium/windsurf/mcp_config.json` (user only) | `mcpServers` | `serverUrl` not `url` | User-level only |
| VS Code + Copilot | `.vscode/mcp.json` (workspace) or user settings | **`servers`** | ✓ | Key name differs from everyone else |
| Continue.dev | `~/.continue/config.yaml` or `.continue/mcpServers/opentrace.yaml` | YAML format | ✓ | Standalone file auto-loaded |
| Zed | OS-specific `settings.json` | `context_servers` | ✓ | No CLI |
| JetBrains AI | OS-specific `AIAssistant/mcp.json` | `mcpServers` | ✓ | |
| Cody (Sourcegraph) | `.vscode/settings.json` key `cody.mcpServers` | — | ✗ stdio only | Needs `mcp-remote` bridge |

---

## Claude Code

**Project-level** (committed to repo, shared with team):

```json
// .mcp.json
{
  "mcpServers": {
    "opentrace": {
      "type": "http",
      "url": "https://api.opentrace.ai/mcp/v1/"
    }
  }
}
```

**User-level** (global, all projects): `~/.claude/mcp.json` — same structure.

**Via CLI** (Claude Code ≥1.x):

```bash
# Project scope
claude mcp add --transport http opentrace https://api.opentrace.ai/mcp/v1/ --scope project

# User scope
claude mcp add --transport http opentrace https://api.opentrace.ai/mcp/v1/ --scope user
```

Restart Claude Code to activate.

---

## Cursor

**Project-level**: `.cursor/mcp.json`
**User-level**: `~/.cursor/mcp.json`

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

No CLI — file edit only. Cursor picks up changes without restart in most cases.

---

## Windsurf / Devin Desktop

**User-level only** (`~/.codeium/windsurf/mcp_config.json`). No project-level config.

> ⚠️ Field name is `serverUrl`, not `url`.

```json
{
  "mcpServers": {
    "opentrace": {
      "type": "http",
      "serverUrl": "https://api.opentrace.ai/mcp/v1/"
    }
  }
}
```

---

## VS Code + GitHub Copilot

> ⚠️ Root key is `"servers"`, not `"mcpServers"` — unique among all tools.

**Workspace-level**: `.vscode/mcp.json`

```json
{
  "servers": {
    "opentrace": {
      "type": "http",
      "url": "https://api.opentrace.ai/mcp/v1/"
    }
  }
}
```

**Via CLI** (VS Code ≥1.99):

```bash
code --add-mcp '{"name":"opentrace","type":"http","url":"https://api.opentrace.ai/mcp/v1/"}'
```

---

## Continue.dev

**Standalone project file** (auto-loaded, no merge required):
`.continue/mcpServers/opentrace.yaml`

```yaml
name: opentrace
type: http
url: https://api.opentrace.ai/mcp/v1/
```

**Global config** (`~/.continue/config.yaml`):

```yaml
mcpServers:
  - name: opentrace
    type: http
    url: https://api.opentrace.ai/mcp/v1/
```

The standalone file approach is preferred — drop and forget, no merge conflicts.

---

## Zed

Config location varies by OS:
- macOS: `~/Library/Application Support/Zed/settings.json`
- Linux: `~/.local/share/zed/settings.json`

```json
{
  "context_servers": {
    "opentrace": {
      "transport": "http",
      "url": "https://api.opentrace.ai/mcp/v1/"
    }
  }
}
```

No CLI — merge into existing settings.json.

---

## JetBrains AI Assistant

Config location varies by OS:
- macOS: `~/Library/Application Support/JetBrains/AIAssistant/mcp.json`
- Linux: `~/.config/JetBrains/AIAssistant/mcp.json`

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

---

## Cody (Sourcegraph)

> ⚠️ Cody supports **stdio transport only**. OpenTrace's MCP server is HTTP. A bridge is required.

Install `mcp-remote` as a bridge:

```bash
npm install -g mcp-remote
```

Then add to `.vscode/settings.json`:

```json
{
  "cody.mcpServers": {
    "opentrace": {
      "command": "mcp-remote",
      "args": ["https://api.opentrace.ai/mcp/v1/"]
    }
  }
}
```

---

## Implementation notes for the CLI installer

- **Detection**: most tools can be detected by checking if their config directory exists (`~/.cursor/`, `~/.codeium/windsurf/`, `~/.continue/`, etc.)
- **Merge strategy**: read existing config → insert/overwrite the `opentrace` key → write back. Never clobber other entries.
- **Continue.dev**: prefer the standalone file drop (`opentrace.yaml`) over merging into global config — no YAML parsing required.
- **Cody**: either skip (unsupported) or inject the `mcp-remote` bridge entry and document the npm install step.
- **Windsurf**: remember `serverUrl` not `url` or the server silently fails to connect.
- **VS Code**: remember `"servers"` not `"mcpServers"` — this is the most likely silent bug to ship.
