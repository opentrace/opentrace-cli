# @opentrace/cli

CLI for setting up and managing OpenTrace integrations. Ships two binaries — `opentrace` and the short alias `otx`.

## Installation

```bash
# Install globally (adds both `opentrace` and `otx`)
npm install -g @opentrace/cli

# Or run once with npx — pin @latest, or npx may reuse an older cached build
npx -y @opentrace/cli@latest login
```

Requires Node.js 18 or newer.

## Quick start

```bash
# Sign in with your browser — no API key to copy
otx login
```

`otx login` opens your browser, signs you in to OpenTrace, and does the rest: it mints a **CLI key** for this machine, then runs the same setup as `otx install` with that key — **Express or Custom**, tool detection, scope, and usage monitoring. Nothing to paste, no dashboard visit. Then restart your tools — in Claude Code, accept the plugin prompt and run `/reload-plugins`.

Browser sign-in needs a local browser and a terminal. On a server, in CI, or over SSH, use a key instead:

```bash
otx connect otk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The key you paste is your **CLI key**, issued from the OpenTrace dashboard. It wires your client (Claude Code by default) to talk to OpenTrace with **tenant-global** reach — every environment and workspace the key's owner can see. The CLI then asks whether you want to **monitor your Claude Code usage** in OpenTrace; say yes and it uses the same CLI key to provision a **usage key** (`claude_code_telemetry` scope) and writes the OTEL telemetry env block into your Claude Code settings. Restart the client, and the model can discover workspaces and operate on any of them.

## Commands

### `otx login [--client <id>] [--url <host>]`

Signs in through your browser and connects this machine — the recommended path for people.

```bash
otx login                        # default client (Claude Code)
otx login --client cursor        # or claude-desktop
otx login --no-browser           # print the URL instead of launching a browser
otx login --url https://api.example.opentrace.ai
```

It runs an OAuth loopback flow (dynamic client registration + PKCE) against your OpenTrace host and exchanges the sign-in for a `cli`-scoped key. The sign-in token itself is discarded — the CLI keeps only the minted key.

What happens next depends on whether you named a client:

- **No `--client`** (the dashboard's one-liner): the key goes into the full [`otx install` flow](#otx-connect-path--otx-install-path) — Express or Custom, tool detection, scope, usage monitoring. Signing in decides *how* you authenticate, not how little gets set up. The scope question leans towards **All projects** here, since signing in onboards a machine rather than a project.
- **`--client <id>`**: an explicit narrow instruction, so it behaves exactly like `otx connect otk_…` and configures that one client. This is also the only way to reach **Claude Desktop**, which the key flow supports but `install` does not.

**Options:** `--client <id>`, `--base-url <url>`, `--url <url>`, `--no-browser`, `--express`, `--track-usage` / `--no-track-usage`, `-g, --global`, `-y, --yes`.

Notes:

- **Needs a TTY and a local browser.** In automation use `otx connect otk_…` — `otx login` refuses to run non-interactively rather than hanging.
- Over SSH or on a headless box the redirect can't reach you (it lands on `127.0.0.1` of the machine running otx); the CLI says so and points you at the key flow.
- If this machine already holds a valid key, it asks before signing in again rather than minting a duplicate; `-y` takes that question's default and keeps the existing key.
- Self-hosted deployments without OAuth dynamic registration enabled report that browser sign-in isn't available — paste a key instead.

### `otx connect otk_<key> [--url <host>] [--client <id>]`

Connects a client to the OpenTrace global MCP endpoint using a **CLI key** (format `otk_` + 43 characters), issued from the OpenTrace dashboard.

```bash
# Default client (Claude Code)
otx connect otk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# A specific client
otx connect otk_… --client claude-desktop
otx connect otk_… --client cursor

# A non-default API host
otx connect otk_… --url https://api.example.opentrace.ai
```

Run it in a terminal with no `--client` and it routes into the full [`otx install` flow](#otx-connect-path--otx-install-path) — Express or Custom, tool detection, scope — the same as `otx login`. `--express` takes that route too, terminal or not, since it asks for it outright. **Without a terminal (CI, a pipe), with `-y`, or with `--client`, it stays the narrow single-client attach described below**, so the server/CI usage the dashboard documents is unchanged.

On that narrow path only `--client` is understood. Per-tool flags and `--express` are reported as ignored rather than dropped in silence — `--cursor` used to leave you with Claude Code configured instead. To set up several tools with a pasted key, use `otx install --api-key otk_…` with per-tool flags.

**Options:**

| Flag | Description |
|------|-------------|
| `--url <url>` | OpenTrace host (default: production). Sets the MCP endpoint (normalized to end in `/mcp/v1/`), the usage-key endpoint, **and** the telemetry ingest endpoint together. |
| `--client <id>` | Target client: `claude-code` (default), `claude-desktop`, or `cursor` |
| `--track-usage` / `--no-track-usage` | Monitor/skip your Claude Code usage without asking |

What it does: validates the key shape locally, then confirms it with an MCP handshake against the endpoint (invalid/expired/revoked keys are rejected before anything is written). Then, per client:

- **Claude Code** → installs the **plugin** (which supersedes a bare MCP entry) and attaches the key to it: seeds the plugin's `mcp_url` and writes the key to `~/.claude/opentrace-plugin.token` (0600), which the plugin's `headersHelper` reads to send `Authorization: Bearer …`. No direct `~/.claude.json` entry.
- **Cursor / Claude Desktop** → writes the MCP entry with the `Authorization: Bearer` header directly, and stores the key in your OS keychain.

Finally (Claude Code only, interactive or `--track-usage`): asks whether to monitor your Claude Code usage in OpenTrace, and at which level — see [Usage monitoring](#usage-monitoring-claude-code-telemetry).

No key is ever printed. (Undo: `otx disconnect --plugin` for Claude Code, or `otx disconnect --mcp --keychain --client cursor` for the others.)

### `otx connect [path]` / `otx install [path]`

When `connect` is given a path (or nothing) instead of a key, it runs editor onboarding — the Claude Code plugin where supported (which supersedes the bare MCP), a plain MCP entry everywhere else. `install` is the same flow.

Interactive by default. The first question is how much you want to be asked:

| Mode | What it does |
|------|--------------|
| **Express** (recommended) | Signs you in with your browser, then sets up **every detected tool** for **all projects** with **usage monitoring on**. Nothing else is asked. |
| **Custom** | The full wizard below. |

Express prints exactly what it is about to do — the tools, the scope, the sign-in, and what the usage export carries — before it does any of it. `--express` states the choice up front (including for automation); per-tool flags are already a custom answer, so they skip the question. If nothing is detected there is nothing to be express about, and it falls back to Custom so you can pick.

Custom asks four things, each skippable with a flag:

1. **Scope** — just this project, or all projects (`-g, --global`)
2. **Which tools** — detected ones pre-checked; the rest are still listed, so you can configure a tool before installing it (per-tool flags)
3. **How to authenticate** — a three-way choice: sign in with your browser (the default; mints a CLI key for this machine), paste a CLI key from the dashboard, or skip and sign in from the tool later. Whichever key results is attached to the tools and reused for the usage-key step (`--api-key` preempts the question)
4. **Usage monitoring** — monitor your Claude Code usage in OpenTrace, and at which level (`--track-usage` / `--no-track-usage`); see [Usage monitoring](#usage-monitoring-claude-code-telemetry)

A pasted key is shape-checked, then confirmed with an MCP handshake before anything is written; a key this machine already holds (OS keychain, or the plugin token file) is revalidated and reused without asking. Keys are always written **user-scoped**, even when you pick project scope, so a bearer token never lands in a committable file. Tools with no API-key mechanism get the headerless MCP entry and are called out in the summary.

```bash
otx connect                    # prompt: Express or Custom
otx install --express          # Express with no questions at all
otx install --claude-code      # a specific tool (still asks scope + key)
otx install /path/to/repo -y   # no prompts: detected tools, project scope, stored key
otx install --global           # user-level instead of project-level
otx install --api-key otk_…    # attach a key non-interactively
```

`-y` and any non-interactive run (CI, piped stdin) skip every prompt and fall back to detected tools, project scope, whatever key is already stored, and no usage monitoring unless `--track-usage` says so. `--express -y` keeps Express's choices (all projects, every detected tool, monitoring on) but cannot open a browser, so it uses whatever key the machine already holds.

**Options:** `--base-url <url>`, `--url <url>`, `--api-key <key>`, `--express`, `--track-usage` / `--no-track-usage`, `-y, --yes`, `-g, --global`, and per-tool flags (`--claude-code`, `--cursor`, `--windsurf`, `--vscode`, `--continue`, `--zed`, `--jetbrains`).

### `otx add-mcp [path]`

Adds only the OpenTrace MCP server to a Claude Code project's `.mcp.json` (no plugin, no key). Defaults to the current directory.

**Options:** `--base-url <url>`, `-y, --yes`.

### `otx disconnect [path]`

Reverses what the CLI set up. Choose components; with none selected it prompts interactively (or removes everything under `-y`).

```bash
otx disconnect --all                      # MCP entries + plugin + keychain key + usage monitoring
otx disconnect --mcp                       # just the MCP server entries
otx disconnect --mcp --client cursor       # only Cursor's MCP entry
otx disconnect --plugin                    # just the Claude Code plugin declaration
otx disconnect --keychain --url https://…  # just the stored key for a host
otx disconnect --usage                     # just stop usage monitoring
```

**Options:**

| Flag | Description |
|------|-------------|
| `--mcp` / `--plugin` / `--keychain` / `--usage` | Pick components (combine freely) |
| `--all` | All four |
| `--client <id>` | Restrict MCP removal to one client (`claude-code`, `claude-desktop`, `cursor`, …) |
| `--url <url>` | Keychain endpoint whose key to delete (for a non-default host) |
| `-g, --global` | Also check user-level editor configs |
| `-y, --yes` | Skip prompts |

It removes the OpenTrace entry from each client config it finds, drops the plugin's `extraKnownMarketplaces`/`enabledPlugins` declaration (run `claude plugin uninstall opentrace@opentrace` to also clear the installed plugin cache), deletes the stored key from the OS keychain — for the API-key flow it auto-derives the keychain host from the config it removed, so `--all` needs no `--url` — and stops usage monitoring.

Two things worth knowing about `--usage`:

- **It always covers both scopes**, regardless of `-g`. This is the one component whose leftovers keep *doing* something: an MCP entry the tool can no longer authenticate is inert, but a live telemetry block goes on exporting after a disconnect you believed was total.
- **It only deletes the keys otx writes**, and only when the block is ours — identified by an OpenTrace ingest endpoint or an `otk_` credential. Your own env vars survive, `env` is dropped only if nothing is left in it, and a block pointing at your own collector is reported and left alone.

The usage key itself stays valid server-side; removing the block just stops anything using it. Revoke it in the dashboard if you want it gone.

## What it writes

### API-key flow (`connect otk_…`)

The CLI key goes into a **user-scoped** file in your home directory (never a committed project file), locked to `0600`.

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
- **With a CLI key** — the key goes to the same user-scoped destinations as the `connect otk_…` flow above (plugin token file for Claude Code; bearer-header entry + keychain for Cursor). The endpoint is always seeded as the plugin's `mcp_url` in that case, so the plugin never prompts for one.

## Usage monitoring (Claude Code telemetry)

This is **your** usage on **your** dashboard: cost, tokens and session activity, per person and per session. Counts, not content — Claude Code exports token counts, cost, and model and tool names, never your prompts, your code, or your file paths.

Opt-in, asked during `connect`/`install` (or forced with `--track-usage` / suppressed with `--no-track-usage`). It applies to **Claude Code only** — when Claude Code is not among the tools being set up, the question isn't asked and an explicit `--track-usage` is refused with a note rather than writing Claude Code settings on a run that isn't about Claude Code. When enabled, the CLI calls the usage-key endpoint with your CLI key to **provision a usage key** (`claude_code_telemetry` scope; the server names it for its owner and mint time — e.g. `Alice's Usage Key (Aug 11, 10:00AM)` — and flags it auto-created in your key list) and appends the OTLP exporter env block to the Claude Code settings file at the level you pick — `.claude/settings.json` in the project, or `~/.claude/settings.json` for all projects. An explicit `-g`/`--global` answers the level outright (so `--track-usage -g` runs with no telemetry prompts); otherwise it's asked interactively:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://<host>/ingest/claude-code",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer otk_…",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "true"
  }
}
```

Existing `env` entries are preserved. The ingest endpoint follows the same host as everything else — pass `--url`/`--base-url` and it moves too.

### When the existing key is checked, kept, or replaced

Whatever the run is doing, if monitoring is already configured it is **checked first**, before you are asked anything — so a revoked key is reported even on a run that goes on to decline monitoring, and even by `--no-track-usage`. That matters because the failure is otherwise silent: Claude Code has no way to tell you its exports are being turned away.

Given a key already on file, and having decided to proceed:

| Situation | What happens |
|---|---|
| Key still valid, and this run used a key already on the machine (keychain / plugin token) | **Kept.** This is what stops repeat `install` runs minting key after key, since the server provisions a fresh one per call. |
| Key still valid, but this run brought its own CLI key (`connect otk_…`, `login`, `--api-key`, a pasted key) | **Replaced.** A usage key reports to whichever CLI key provisioned it, so keeping the old one would go on attributing your usage to the previous owner. |
| Key rejected | **Replaced.** |
| Key unverifiable (endpoint unreachable) | **Kept**, with a note — a network failure says nothing about a key. |

Replacement is never destructive: if provisioning the new key fails, the existing block is left exactly as it was rather than removed. And the scope of an existing block wins over the run's default, so re-running against a global setup refreshes it in place instead of writing a second block at project level.

Since a replaced key is not deleted server-side, reconnecting repeatedly leaves auto-created keys behind — they're tagged as such in your key list, and safe to prune.

The usage key can only *write* telemetry (it is refused by the MCP and REST surfaces), so a leak from a committed `.claude/settings.json` cannot read your graph — but pick "All projects" if you'd rather keep it out of the repo entirely.

The env block is read by **both** Claude Code surfaces — the terminal CLI and the desktop app's Code tab — since both read `settings.json`.

## Claude Code: CLI and Desktop

The Claude desktop app's **Code** tab is Claude Code Desktop: the same engine as the terminal CLI, reading [the same configuration files](https://code.claude.com/docs/en/desktop#shared-configuration). So everything otx writes for Claude Code covers both surfaces, and there is nothing extra to install — `.mcp.json`, `~/.claude.json`, the plugin declaration (`extraKnownMarketplaces` / `enabledPlugins`), `pluginConfigs`, and the `env` block for usage monitoring all apply to desktop sessions.

otx detects the app, so a machine that has only the desktop app is set up rather than reported as "not found"; the tool list says which surfaces it found (`detected: CLI + Desktop`).

Two things behave differently enough to be worth knowing:

- **A running session won't pick up a change.** Config is read when a session starts, so restarting the app is not enough — start a **new** session. otx says so in the summary when it sees the desktop app.
- **`claude_desktop_config.json` wins in the Code tab.** The desktop app also loads MCP servers from the chat surface's `claude_desktop_config.json` into local Code-tab sessions, and on a name collision that definition takes precedence over `~/.claude.json` / `.mcp.json`. Since `otx connect --client claude-desktop` writes the `mcp-remote` stdio bridge there (Desktop chat accepts nothing else), setting up **both** clients leaves Code-tab sessions using the npx bridge instead of the native HTTP mount. otx warns when this applies; remove the `opentrace` entry from `claude_desktop_config.json` if you'd rather Code sessions used the direct endpoint.

Not covered: **Cowork** and **cloud** sessions source their skills, plugins and connectors from your claude.ai account rather than `~/.claude`, so a local otx run does not reach them.

## Notices

otx prints a banner above its own output when there is something you could not otherwise find out at that moment:

- **An update is available** — the latest published version, checked against the npm registry at most once a day. Shown on every command.
- **Your CLI key is no longer accepted** — expired or revoked; points you at `otx login`. Only on commands that don't check the key themselves: `install`, `connect` and `login` resolve it inline a moment later and tell you there, where they can offer to sign you in on the spot.
- **Your usage key was rejected** — worth surfacing because nothing else does: Claude Code has no way to tell you its exports are being turned away, so usage simply stops arriving.

The answers are cached in `~/.opentrace/state.json`, and the commands that already validate a key record their verdict there, so the banner is usually reading work that already happened rather than making a call of its own. Every check has a short deadline, an indefinite answer produces no notice at all (an unreachable host never gets reported as a bad key), and a verdict is tied to the key it was about — replace a rejected key and the warning goes with it.

It writes to stderr, and stays silent when there is no interactive terminal, in CI, or with `OTX_NO_NOTICES=1` (`NO_UPDATE_NOTIFIER=1` is honoured too).

## Authentication

There are three ways to authenticate, in order of preference:

1. **Browser sign-in** (`otx login`) — OAuth in your browser, no key to copy. The CLI mints a CLI key for this machine and attaches it for you. Best for people.
2. **Pasted CLI key** (`otx connect otk_…`, `install --api-key`) — from the dashboard. Best for automation, CI, and headless machines.
3. **In-tool OAuth** — skip the key entirely and let the tool sign in against the MCP endpoint itself (in Claude Code: `/mcp`). The CLI stores no credential.

All OpenTrace keys look the same (`otk_` + 43 chars); the **scope** chosen when a key is created decides which surface accepts it:

- **CLI key** — minted by `otx login`, or issued from the OpenTrace dashboard. It authenticates the MCP mount (bearer header on every request, tenant-global reach — this is what lands in your client config / plugin token file) and the usage-key endpoint. Validated via an MCP handshake.
- **Usage key** (`claude_code_telemetry` scope) — provisioned by the CLI (with your CLI key) when you enable usage monitoring; accepted only by the telemetry ingest endpoint, so a leak cannot read anything.
Note the two different OAuth flows, which are easy to confuse:

- **`otx login`** signs *the CLI* in and ends with a CLI key stored on your machine. The tool then authenticates by header, and never sees a sign-in prompt.
- **In-tool OAuth** (choosing "skip" at the key question) leaves the CLI with no credential, so *the tool itself* does the handshake against the MCP endpoint on first use. Run `/mcp` in Claude Code and sign in.

The **Claude Code plugin supports both** a key and OAuth, and `otx install` can set up either: choose browser sign-in or paste a key (or pass `--api-key`) for the key path — the same result as `otx connect otk_… --client claude-code` — or skip it for in-tool OAuth. With a key present the plugin authenticates by header; without one its headers helper returns nothing and Claude Code falls back to OAuth.

Keys can expire or be revoked — if calls start returning `401`, reconnect with a fresh key.

## Testing

```bash
npm test              # typecheck-free run: build, then unit + integration
npm run test:unit     # pure logic only — fast, no child processes
npm run lint          # typechecks src and test together
```

No test dependencies: `node:test` plus `tsc`. Tests compile alongside `src` into `build-test/`, so unit tests exercise the same TypeScript the package ships, while integration tests spawn the real `dist/index.js`.

**Everything is hermetic.** Integration tests run against a local stub (`test/stub-server.ts`) standing in for the MCP mount, the usage-key endpoint, the OTLP ingest mount, the OAuth metadata document and the npm registry — all five, because the CLI derives every one from a single host. That lets tests assert on states you cannot summon against production: a revoked key, a server too old to provision usage keys, a newer release on npm.

`HOME` accounts for nearly all isolation, since every config path derives from `os.homedir()`. Three things escape it and have env seams, set only by the harness:

| Variable | Why it exists |
|---|---|
| `OTX_KEYCHAIN_SERVICE` | The OS keychain is machine-wide. Without a namespace, a test run would read, overwrite and delete your real entries. |
| `OTX_REGISTRY_URL` | Redirects the update check off npm. |
| `OTX_FORCE_NOTICES` | The banner is suppressed without a TTY, and a piped child process has none. Only ever loosens — an explicit `OTX_NO_NOTICES` still wins. |

Two known gaps, stated rather than hidden: the **interactive prompts** need a pseudo-terminal, so prompt copy and defaults (including `otx login -y` keeping a valid key) are verified by hand rather than in CI; and the **browser sign-in** needs a real browser, so `otx login`'s OAuth round trip is never exercised automatically.

### Trying an unreleased build on any machine

`npm link` and `npm i -g` both overwrite the `otx` you actually use. This packs the candidate exactly as npm would publish it and installs *that* into a throwaway prefix instead:

```bash
eval "$(scripts/try-candidate.sh)"     # exports OTX and OTX_PREFIX
SANDBOX=$(mktemp -d)
HOME=$SANDBOX "$OTX" install --express # a real binary, none of your config
rm -rf "$SANDBOX" "$OTX_PREFIX"
```

Same packaging, same bin shims, same `files` list as a release — and your global install is untouched. Note the keychain caveat above: a temp `HOME` does not cover it, so set `OTX_KEYCHAIN_SERVICE` too if the run might store a key.

## License

Apache-2.0
