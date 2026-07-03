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

### Distribution

Plugins can be installed from:
- **npm package**: `claude plugin install @opentrace/claude-code-plugin`
- **Git URL**: `claude plugin install github:opentrace/opentrace-cli?path=plugins/claude-code`
- **Local path**: `claude plugin install ./plugins/claude-code`

The git subdirectory form (sparse clone) is ideal for a monorepo — a single git URL with `?path=` points Claude at the right subdirectory.

### Install CLI

```bash
claude plugin install @opentrace/claude-code-plugin   # from npm
claude plugin install github:opentrace/opentrace-cli?path=plugins/claude-code  # from this repo
claude plugin uninstall opentrace
claude plugin enable opentrace
claude plugin disable opentrace
claude plugin update opentrace
claude plugin validate ./plugins/claude-code           # lint before publishing
```

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
  src/                              ← @opentrace/cli (this package)
    commands/
      add-mcp.ts
      install.ts                    ← future: opentrace install [--claude-code] [--opencode] ...
      install-plugin.ts             ← future: opentrace install-plugin claude-code [path]
    integrations/                   ← one module per tool for MCP installs
      claude-code.ts
      cursor.ts
      windsurf.ts
      vscode.ts
      continue.ts
      zed.ts
      jetbrains.ts
      cody.ts
    util/
      mcp-config.ts
      detect.ts                     ← future: detect which tools are installed
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

### Install flow (future)

```bash
# Auto-detect installed tools, install all relevant plugins + MCP configs
npx @opentrace/cli install

# Specific tools
npx @opentrace/cli install --claude-code    # runs: claude plugin install @opentrace/claude-code-plugin
npx @opentrace/cli install --opencode       # adds @opentrace/opencode-plugin to opencode.json
npx @opentrace/cli install --cursor         # copies plugin + MCP config
npx @opentrace/cli install --vscode         # writes .vscode/mcp.json
npx @opentrace/cli install --windsurf       # writes ~/.codeium/windsurf/mcp_config.json
```

For tools with a rich plugin system (Claude Code, OpenCode), the plugin is the primary install path — it bundles everything including the MCP config. For tools without a plugin system, `add-mcp` / MCP config write is the install.

---

## Publishing checklist (future)

- [ ] Set up npm workspaces in root `package.json`
- [ ] Add `prepublishOnly: "tsc"` build guard to each package
- [ ] Publish `@opentrace/claude-code-plugin` to npm (Claude Code's npm install support)
- [ ] Publish `@opentrace/opencode-plugin` to npm
- [ ] Submit `@opentrace/claude-code-plugin` to `anthropics/claude-plugins-community` marketplace
- [ ] Add GitHub Actions publish-on-tag workflow
