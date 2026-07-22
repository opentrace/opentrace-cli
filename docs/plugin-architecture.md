# Plugin Architecture — Tool Reference

How first-party plugins work across AI coding tools, and how this repo should be structured to build and distribute them.

A "plugin" here means a packaged extension that enriches the tool itself — custom slash commands, agent definitions, tool integrations, hooks — not just pointing the tool at an MCP server.

---

## Claude Code

The richest plugin system of any AI coding tool. A plugin is a **directory** (publishable as an npm package or git repo) with a conventional folder layout.

### Plugin structure

```
my-plugin/
  .claude-plugin/
    plugin.json           ← manifest (only "name" is required)
  skills/
    search/
      SKILL.md            ← slash command: /opentrace:search
    explain/
      SKILL.md            ← slash command: /opentrace:explain
  agents/
    opentrace.md          ← custom subagent definition
  hooks/
    hooks.json            ← lifecycle automation
  .mcp.json               ← MCP server bundled with plugin
  bin/                    ← executables added to Claude's PATH
```

### Manifest (`plugin.json`)

```json
{
  "name": "opentrace",
  "version": "1.0.0",
  "description": "OpenTrace integration for Claude Code"
}
```

### Skills (slash commands)

`skills/<name>/SKILL.md` — defines a `/opentrace:<name>` slash command. The SKILL.md body is the model's instruction for that command. Frontmatter controls behavior:

```markdown
---
description: Search the OpenTrace knowledge graph
---

Search the indexed codebase using OpenTrace. Use the `opentrace` MCP tools to...
```

### Agent definitions

`agents/<name>.md` — custom subagent that can be invoked by Claude or by other skills. Supports frontmatter: `model`, `effort`, `maxTurns`, `disallowedTools`, `isolation`.

### Hooks

`hooks/hooks.json` — lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, …). Hook types: `command` (script reads payload JSON on stdin, prints result JSON to stdout) and `prompt`. Each event maps to an array of matcher groups, each with its own `hooks` array; `matcher` is a regex against the tool name (omit to match everything):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__.*opentrace.*",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.sh" }
        ]
      }
    ]
  }
}
```

### MCP bundling

`.mcp.json` inside the plugin directory — same format as a project `.mcp.json`. The MCP server is activated when the plugin is installed, so users don't need to run `add-mcp` separately.

The endpoint is not hardcoded: the plugin declares a `userConfig.mcp_url` option (default `https://api.opentrace.ai/mcp/v1/`) in `plugin.json`, and `.mcp.json` references it as `"url": "${user_config.mcp_url}"`. Claude Code prompts for the value at enable time and stores it per-user, so a user on a different OpenTrace host overrides it through the plugin config UI rather than editing files. (`${...}` substitution reads from user/managed settings, not project settings — it's a per-user setting.) `otx install --url <host>` pre-seeds this by writing `pluginConfigs["opentrace@opentrace"].options.mcp_url` into `~/.claude/settings.json`, so the plugin uses that endpoint without prompting.

### Distribution

The plugin ships through the OpenTrace **marketplace** — `.claude-plugin/marketplace.json` at this repo's root lists the `opentrace` plugin (`source: ./plugins/claude-code`). Claude Code resolves the marketplace from the GitHub repo `opentrace/opentrace-cli`.

**How `otx connect` installs it (the primary path):** the CLI writes the marketplace and plugin declaratively into Claude Code settings rather than shelling out — matching how it registers MCP. It adds an `extraKnownMarketplaces` entry and an `enabledPlugins` entry to `.claude/settings.json` (project) or `~/.claude/settings.json` (`--global`):

```json
{
  "extraKnownMarketplaces": {
    "opentrace": { "source": { "source": "github", "repo": "opentrace/opentrace-cli" } }
  },
  "enabledPlugins": { "opentrace@opentrace": true }
}
```

When the user next trusts the folder, Claude Code prompts to install the plugin. This needs no `claude` binary on `PATH` and merges into existing settings idempotently.

**Manual alternatives** (equivalent, for direct use):
- **Marketplace + install**: `claude plugin marketplace add opentrace/opentrace-cli` then `claude plugin install opentrace@opentrace`
- **Local path (dev)**: `claude --plugin-dir ./plugins/claude-code`

### Install CLI

```bash
claude plugin marketplace add opentrace/opentrace-cli  # register the marketplace from this repo
claude plugin install opentrace@opentrace              # install the plugin from it
claude plugin uninstall opentrace@opentrace
claude plugin enable opentrace@opentrace
claude plugin disable opentrace@opentrace
claude plugin validate ./plugins/claude-code           # lint before publishing
```

`otx connect` does the first two steps for you declaratively (see [Distribution](#distribution)); these are the manual equivalents.

**Install scopes**: `user` (`~/.claude/settings.json`), `project` (`.claude/settings.json`), `local` (`.claude/settings.local.json`).

**Disk location after install**: `~/.claude/plugins/cache/<plugin-name>/`

---

## Cursor

Nearly identical format to Claude Code (launched April 2026, same conventions).

- Same `plugin.json` manifest
- Same `skills/<name>/SKILL.md` layout
- Cursor-unique addition: `.cursor/rules/*.mdc` files (persistent AI context with `alwaysApply`/`globs` frontmatter)
- Install: `/add-plugin` slash command in-editor or GUI — no documented `cursor plugin install` CLI yet
- Disk: `~/.cursor/plugins/local/<name>/`
- npm distribution not yet documented for Cursor

**Implication**: the Claude Code plugin directory can be reused almost entirely for Cursor. The main additions are `.mdc` rules files and potentially tweaking skill descriptions.

---

## OpenCode

Completely different model — plugins are **TypeScript/JavaScript modules**, not markdown directories.

### Plugin structure

```ts
// plugins/opencode/src/index.ts
import { Plugin } from "@opencode-ai/plugin"

export default Plugin(async (app) => {
  // Register a custom tool available to the LLM
  app.tool({
    name: "opentrace_search",
    description: "Search the OpenTrace knowledge graph",
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => { /* ... */ },
  })

  // Intercept tool calls
  app.on("tool:before", (event) => { /* ... */ })
  app.on("tool:after", (event) => { /* ... */ })
})
```

### Distribution and install

**npm package** (recommended): list in `opencode.json`, OpenCode runs `bun install` at startup:

```json
{
  "plugin": ["@opentrace/opencode-plugin"]
}
```

**Local**: drop `.ts` files into `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global). No config needed.

No CLI install command — configuration only through `opencode.json` and the filesystem.

### What plugins can do

- Define Zod-typed custom LLM tools
- Intercept every tool call (before/after)
- Modify model sampling parameters
- Custom auth flows
- Subscribe to a broad event bus (sessions, files, LSP, permissions, TUI)

---

## Others

### Zed

- WASM/Rust extension system (sandboxed)
- Created **Agent Client Protocol (ACP)** — an open cross-editor standard now supported by 12+ editors and 60+ agents
- ACP is becoming the interoperability layer that makes editor-specific plugin formats less relevant

### Windsurf / Devin Desktop

No proprietary plugin format. Uses OpenVSX extensions + MCP + ACP.

### VS Code extensions

Standard VS Code extension model (VSIX). Not a priority — the MCP config approach covers VS Code Copilot without needing a full extension.

---

## Recommended repo structure

All plugins live in this repo under `plugins/`. The CLI handles installation.

```
opentrace-cli/
  docs/
    mcp-installs.md
    plugin-architecture.md
  src/                              ← @opentrace/cli (this package; bins: opentrace, otx)
    commands/
      add-mcp.ts
      install.ts                    ← `otx connect` / `opentrace install`: MCP + plugin onboarding
    integrations/                   ← one module per tool; each declares MCP install + optional plugin capability
      claude-code.ts                ← MCP + plugin capability (marketplace/settings.json)
      cursor.ts
      windsurf.ts
      vscode.ts
      continue.ts
      zed.ts
      jetbrains.ts
    util/
      constants.ts
      json-config.ts
      detect.ts                     ← detects which tools are installed
  plugins/
    claude-code/                    ← @opentrace/claude-code-plugin
      .claude-plugin/
        plugin.json
      skills/
        search/SKILL.md
        explain/SKILL.md
        index/SKILL.md
      agents/
        opentrace.md
      hooks/
        hooks.json
      .mcp.json                     ← MCP config bundled — replaces need for add-mcp
      package.json                  ← published as @opentrace/claude-code-plugin
    opencode/                       ← @opentrace/opencode-plugin
      src/
        index.ts
      package.json                  ← published as @opentrace/opencode-plugin
```

### Why one repo

- Plugin source and CLI installer stay in sync — a MCP URL change updates both
- Claude Code supports `github:opentrace/opentrace-cli?path=plugins/claude-code` — no separate repo needed for git installs
- npm workspaces can publish `@opentrace/cli`, `@opentrace/claude-code-plugin`, and `@opentrace/opencode-plugin` independently from the same repo

### Install flow

The CLI is the control plane: it installs the MCP server for every detected tool, and installs a plugin only where the target declares that capability. Today Claude Code is the only tool with a plugin capability; every other tool gets MCP alone.

```bash
# Auto-detect installed tools and onboard all of them (MCP + plugin where supported)
npx @opentrace/cli connect

# Specific tools
otx connect --claude-code    # declares the plugin in .claude/settings.json (no .mcp.json — the plugin supersedes it)
otx connect --cursor         # writes .cursor/mcp.json (MCP only)
otx connect --vscode         # writes .vscode/mcp.json (MCP only)
otx connect --windsurf       # writes ~/.codeium/windsurf/mcp_config.json (MCP only)
```

Each integration in `src/integrations/` declares its MCP install and an optional `plugin` capability. Adding plugin support for a new tool (e.g. OpenCode) is a matter of populating that capability on its integration module — the onboarding loop picks it up automatically.

### Still future

- Bundled skills/agents/hooks (a shared skill area passed to whatever plugin a target supports)
- Plugin capabilities for tools beyond Claude Code (OpenCode, Cursor)
- npm publication of the plugin package(s)

---

## Publishing checklist (future)

- [ ] Set up npm workspaces in root `package.json`
- [ ] Add `prepublishOnly: "tsc"` build guard to each package
- [ ] Publish `@opentrace/claude-code-plugin` to npm (Claude Code's npm install support)
- [ ] Publish `@opentrace/opencode-plugin` to npm
- [ ] Submit `@opentrace/claude-code-plugin` to `anthropics/claude-plugins-community` marketplace
- [ ] Add GitHub Actions publish-on-tag workflow
