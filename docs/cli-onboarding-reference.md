# OpenTrace CLI — onboarding reference

**Audience:** an AI session that needs to tell users how to connect a tool to OpenTrace (MCP,
the Claude Code plugin, and usage telemetry), or that needs to script the CLI.

**Verified against:** `@opentrace/cli` **0.4.0** (npm `latest`) and `api.opentrace.ai`, on
2026-08-11. Every endpoint, path, and flag below was read from source or probed live, not
recalled.

---

## 1. The happy path (this is what you should show users)

Two lines, no arguments, no key to copy:

```bash
npm install -g @opentrace/cli
otx login
```

`otx login` opens the browser, the user signs in to OpenTrace, and the CLI does everything
else: mints a CLI key, wires up Claude Code (the default client), and offers usage tracking.
There is nothing to paste and no dashboard visit.

If you want a **single** no-install line, it must pin `@latest`:

```bash
npx -y @opentrace/cli@latest login
```

> ⚠️ **Do not tell users `npx @opentrace/cli login`.** Without the `@latest` pin, npx reuses
> whatever version it has cached. On a machine that ran an older CLI, that resolves to a
> pre-0.4.0 build with no `login` command, and the user just gets the generic help text with
> no error explaining why. This was reproduced on 2026-08-11 (cached 0.3.0 silently won).
> Either pin `@latest` or use the global install.

**Requirements:** Node.js ≥ 18, a browser on the same machine, and a terminal (a TTY).
`otx login` refuses to run non-interactively — see §7 for what automation uses instead.

**After it finishes:** the user restarts their tool. For Claude Code specifically, it will
prompt to install the OpenTrace plugin (accept it), then `/reload-plugins`.

---

## 2. What "connecting" actually means

Three separate things get set up. They are independent — a user can have any subset.

| Thing | What it is | Who gets it |
|---|---|---|
| **MCP server** | The `opentrace` HTTP MCP endpoint registered in the tool's config | Every supported tool |
| **Claude Code plugin** | Marketplace-installed plugin bundling the MCP + session hooks | Claude Code only |
| **Usage telemetry** | OTEL env block exporting Claude Code usage to OpenTrace | Claude Code only, opt-in |

And three ways to authenticate. **Prefer the first** for humans:

1. **Browser sign-in (`otx login`)** — OAuth in the browser, trades the sign-in for a
   long-lived CLI key that the CLI stores and attaches. Zero copy-paste. *Default; recommend
   this everywhere.*
2. **Pasted CLI key (`otx connect otk_…`)** — the user creates a key in the dashboard
   (API keys) and passes it. *For automation, CI, and headless/SSH machines.*
3. **In-tool OAuth (no CLI credential)** — the CLI registers the MCP endpoint with no
   credential and the tool does its own OAuth handshake (in Claude Code: `/mcp`). *Fallback
   when the user declines to provide a key at all.*

All OpenTrace keys look identical — `otk_` followed by 43 URL-safe characters (47 total). The
**scope** decides what a key can do, and it is invisible in the token:

- **`cli` scope** — authenticates the MCP mount and the key-provisioning endpoints. This is
  the key `otx login` mints and what lands in tool configs.
- **`claude_code_telemetry` scope** — write-only ingest credential for usage telemetry.
  Refused by MCP and REST, so a leak cannot read the graph.

---

## 3. Command reference

Both binaries — `opentrace` and `otx` — are the same program. Use `otx` in user-facing copy.

### `otx login`

Browser sign-in. Mints a `cli`-scoped key and hands it to the same machinery as
`connect otk_…` (validate → attach → optional usage tracking).

| Flag | Meaning |
|---|---|
| `--client <id>` | Where to attach the key: `claude-code` (default), `claude-desktop`, `cursor` |
| `--base-url <url>` | OpenTrace API base (default `https://api.opentrace.ai`) |
| `--url <url>` | MCP endpoint or host; overrides `--base-url` |
| `--no-browser` | Print the sign-in URL instead of launching a browser |
| `--track-usage` / `--no-track-usage` | Decide usage tracking without asking |
| `-g, --global` | User-level scope for the usage-tracking settings file |
| `-y, --yes` | Skip confirmations (still needs a TTY and a browser) |

Behaviour worth knowing:

- **Requires a TTY.** Non-interactive runs exit 1 with a pointer at the pasted-key path.
- **Won't mint duplicates silently.** If the machine already holds a valid key for the target
  host, it asks before signing in again (skipped under `-y`).
- **Headless/SSH aware.** It detects no-display environments, skips the browser launch, and
  explains that the loopback redirect lands on *this* machine so a remote browser can't
  complete it — pointing the user at the pasted-key flow instead.

### `otx connect <token-or-path>`

Overloaded on its argument:

- **`otx connect otk_…`** — attach a pasted CLI key. Same destinations as `login`.
- **`otx connect [path]`** — editor onboarding, identical to `install`.

Key-flow flags: `--client <id>`, `--url <url>`, `--track-usage`/`--no-track-usage`, `-g`, `-y`.

### `otx install [path]`

Editor onboarding for one or many tools. Interactive by default; asks four things, each
skippable by flag:

1. **Scope** — this project, or all projects (`-g`)
2. **Which tools** — detected ones pre-checked (per-tool flags below)
3. **How to authenticate** — a three-way choice: **Sign in with your browser** (default) /
   Paste a CLI key / Skip and sign in from the tool later (`--api-key` to preempt)
4. **Usage tracking** — Claude Code only (`--track-usage` / `--no-track-usage`)

Flags: `--base-url`, `--url`, `--api-key <key>`, `--track-usage`/`--no-track-usage`,
`-y, --yes`, `-g, --global`, plus one flag per tool: `--claude-code`, `--cursor`,
`--windsurf`, `--vscode`, `--continue`, `--zed`, `--jetbrains`.

### `otx add-mcp [path]`

Minimal path: writes only the OpenTrace MCP entry into a Claude Code project `.mcp.json`.
No plugin, no key, no telemetry. Flags: `--base-url`, `-y`.

### `otx disconnect [path]`

Reverses everything. With no component flags it prompts (or removes all three under `-y` or
non-TTY).

| Flag | Meaning |
|---|---|
| `--mcp` / `--plugin` / `--keychain` | Pick components, combine freely |
| `--all` | All three |
| `--client <id>` | Restrict MCP removal to one client |
| `--url <url>` | Keychain host whose key to delete (non-default hosts) |
| `-g, --global` | Also check user-level editor configs |
| `-y, --yes` | Skip prompts |

Note: it clears the plugin *declaration*; tell users to also run
`claude plugin uninstall opentrace@opentrace` to drop Claude Code's installed-plugin cache.

---

## 4. Supported tools and exact file paths

### MCP integrations (targets of `install` / `connect <path>`)

All write `mcpServers.opentrace = { type: "http", url: "<base>/mcp/v1/" }` unless noted.

| id | Label | Project scope | Global scope (`-g`) | Quirk |
|---|---|---|---|---|
| `claude-code` | Claude Code | `.mcp.json` | `~/.claude/mcp.json` | Plugin supersedes this — see below |
| `cursor` | Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` | — |
| `vscode` | VS Code / Copilot | `.vscode/mcp.json` | *(project only)* | Root key is **`servers`**, not `mcpServers` |
| `windsurf` | Windsurf | *(user-level only)* | `~/.codeium/windsurf/mcp_config.json` | Uses **`serverUrl`**, not `url` |
| `zed` | Zed | *(user-level only)* | `~/…/Zed/settings.json` | Key is **`context_servers`**, uses `transport` |
| `continue` | Continue | `.continue/mcpServers/opentrace.yaml` | `~/.continue/config.yaml` | YAML, not JSON |
| `jetbrains` | JetBrains AI | *(user-level only)* | `~/…/JetBrains/AIAssistant/mcp.json` | — |

Per-OS paths for Zed: `~/Library/Application Support/Zed/` (macOS), `%APPDATA%\Zed\`
(Windows), `~/.local/share/zed/` (Linux). JetBrains:
`~/Library/Application Support/JetBrains/AIAssistant/` (macOS),
`%APPDATA%\JetBrains\AIAssistant\` (Windows), `~/.config/JetBrains/AIAssistant/` (Linux).

**Important:** when a CLI key is in play, Claude Code gets the *plugin* instead of the bare
MCP entry, so **no `.mcp.json` is written for Claude Code** in that case.

### Key clients (targets of `login` / `connect otk_…`, via `--client`)

Only these three can carry a credential. Note **Claude Desktop is a key client only** — it is
not an `install` target.

| id | Label | Config file | Shape |
|---|---|---|---|
| `claude-code` *(default)* | Claude Code | plugin token file (below) | Plugin + `headersHelper` |
| `cursor` | Cursor | `~/.cursor/mcp.json` | `{url, headers: {Authorization}}` |
| `claude-desktop` | Claude Desktop | `claude_desktop_config.json` | `npx mcp-remote` stdio bridge |

Claude Desktop paths: `~/Library/Application Support/Claude/` (macOS),
`%APPDATA%\Claude\` (Windows), `$XDG_CONFIG_HOME/Claude` or `~/.config/Claude` (Linux).
It has no native remote-HTTP-with-headers support, so the CLI wires it through the
`mcp-remote` npx bridge — which needs Node/npx present and adds startup latency. Surface that
caveat if your UI offers Claude Desktop.

**Credential files are always user-scoped and `0600`**, even when the user picks project
scope — a bearer token must never land in a committable file.

---

## 5. The Claude Code plugin

Where a plugin is available it **supersedes** the bare MCP entry (it bundles its own MCP).

- **Declaration** — `extraKnownMarketplaces` + `enabledPlugins` written into
  `.claude/settings.json` (project) or `~/.claude/settings.json` (global). Marketplace
  `opentrace` → repo `opentrace/opentrace-cli`; plugin id `opentrace@opentrace`.
- **Endpoint** — seeded as the plugin's `mcp_url` userConfig in `pluginConfigs` in **user**
  settings (Claude Code reads plugin config from user settings only). If unset, the plugin
  prompts on enable, defaulting to `https://api.opentrace.ai/mcp/v1/`.
- **Credential** — `~/.claude/opentrace-plugin.token` (`0600`). The plugin's `.mcp.json`
  declares a `headersHelper` (`bin/auth-headers.cjs`) that emits
  `Authorization: Bearer <key>` when that file exists and **`{}` when it doesn't** — the empty
  object is exactly what makes Claude Code fall back to its own MCP OAuth. That is why the
  "skip the key" path still works.
- **Hooks** — `SessionStart` (15s timeout) and `UserPromptSubmit` (5s timeout) shell hooks
  that prewarm/inject repo context.
- **Plugin env overrides** (read by the plugin, not the CLI): `OPENTRACE_MCP_URL`,
  `OPENTRACE_ENVIRONMENT`, `OPENTRACE_WORKSPACE`, `OPENTRACE_PREWARM_DEBUG`.

Users must restart Claude Code (or `/reload-plugins`) and accept the install prompt.

---

## 6. Usage telemetry (Claude Code only)

Opt-in. Asked during `login`/`connect`/`install`, or forced with `--track-usage` /
suppressed with `--no-track-usage`. If Claude Code isn't among the targets, the question is
never asked and an explicit `--track-usage` is **refused with a note** rather than writing
Claude Code settings on an unrelated run.

The CLI calls `POST <base>/claude-code-usage/key` with the CLI key to provision a
`claude_code_telemetry` key, then merges this block into the chosen settings file
(`.claude/settings.json` or `~/.claude/settings.json`), preserving all other `env` entries:

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

Re-run behaviour: a usage key already in the target file is revalidated against the ingest
endpoint and **kept if still valid** — that check is what stops re-runs minting key after key
(the server mints a fresh one per provisioning call). A rejected key is replaced.

Scope guidance for your UI: project scope puts the key in `.claude/settings.json`, which is
often committed. It is write-only (it cannot read anything), but recommend "All projects" for
users who don't want it in the repo.

---

## 7. Automation contract

Humans get OAuth; scripts get keys. **Never** put `otx login` in CI — it requires a TTY and a
browser and will exit 1.

```bash
# CI / provisioning: pasted key, no prompts
otx connect otk_… --client cursor --no-track-usage
otx install --api-key otk_… -y -g --claude-code --cursor

# Non-default host (moves MCP, key-mint, and ingest endpoints together)
otx login --url https://api.staging.opentrace.ai
otx connect otk_… --url https://api.staging.opentrace.ai
```

Rules the CLI enforces:

- **`-y` or any non-TTY run** (CI, piped stdin) skips every prompt: detected tools, project
  scope, whatever key is already stored, and **no** usage tracking unless `--track-usage`.
- **`--api-key` that the server rejects is fatal** (exit 1) — wiring a known-bad key is worse
  than failing. A network/provisioning failure only warns and proceeds.
- **`--track-usage` is tri-state**: set, unset, and "not stated". Only a value the user
  actually typed suppresses the prompt.
- **`-g` settles telemetry scope outright**, so `--track-usage -g` runs with no prompts.
- **Exit codes:** `0` success (including clean no-op paths like declining a re-login), `1`
  failure, `130` Ctrl-C during sign-in.
- **No env-var credential override exists.** The CLI reads no `OPENTRACE_API_KEY`; pass keys
  as arguments. (The *plugin* reads env vars — §5 — but the CLI does not.)

---

## 8. Server endpoints the CLI touches

Useful if your UI supports self-hosted or non-production hosts. Everything derives from one
base URL, so `--url`/`--base-url` moves them together.

| Purpose | Endpoint |
|---|---|
| MCP mount | `<base>/mcp/v1/` *(trailing slash)* |
| OAuth AS metadata | `<base>/.well-known/oauth-authorization-server/oauth` |
| Dynamic client registration | `<base>/oauth/register` |
| Authorize proxy | `<base>/oauth/authorize` |
| CLI key exchange | `POST <base>/cli/key` |
| Usage key provisioning | `POST <base>/claude-code-usage/key` |
| Telemetry ingest | `<base>/ingest/claude-code` *(Claude Code appends `/v1/metrics`, `/v1/logs`)* |

How `otx login` works, for your own understanding: AS-metadata discovery → RFC 7591 dynamic
client registration of a `http://127.0.0.1:<random-port>/callback` redirect → authorization
code with PKCE S256 → token exchange at the upstream IdP (Clerk) → trade that access token at
`POST /cli/key` for the `otk_` key. The IdP token is discarded immediately; no refresh token
is requested. OAuth is a means to the key, not a session.

**Browser sign-in requires the deployment to have DCR enabled.** Production has it
(verified live 2026-08-11). Self-hosted deployments with `OT_API_OAUTH_DCR_PROVIDER=none`
serve no OAuth metadata; the CLI detects this and reports "this server does not offer browser
sign-in", then falls back to the paste prompt. Your UI should offer the pasted-key path for
self-hosted users.

**Key naming is server-owned.** The CLI sends the machine hostname as `device_name`, but the
server currently ignores it and names keys after the owner and mint time — e.g.
`Alice's CLI Key (Aug 11, 10:00AM)`. Don't promise users their machine name will appear in
the dashboard.

---

## 9. Failure modes → what to tell the user

| Situation | CLI behaviour | Suggested UI copy |
|---|---|---|
| Stale `npx` cache | Generic help, no `login` command, no error | Pin `@latest` or install globally (§1) |
| No TTY (CI, piped) | `login` exits 1 | "Use a CLI key in automation: `otx connect otk_…`" |
| Headless / SSH | Skips browser, prints URL + warning | "Browser sign-in needs a local browser — paste a key instead" |
| Server has no DCR (self-hosted) | "does not offer browser sign-in", falls back to paste | Offer the dashboard → API keys route |
| Server too old for `/cli/key` | "sign-in worked, but this server cannot mint CLI keys yet" | "Update your OpenTrace server, or paste a key" |
| 50-key cap hit | Exits 1 with the limit message | "Remove unused keys in the dashboard → API keys" |
| Sign-in cancelled / timed out (5 min) | Exits 1, nothing written | "Re-run `otx login`" |
| Key rejected (401) | Fatal for explicit keys; stored keys are re-prompted | "Keys can expire or be revoked — sign in again" |
| No OS keychain (headless Linux) | Warning only; connection still works | Mention it needs gnome-keyring/KWallet to remember keys |

---

## 10. Ready-to-use UI copy

**Primary (recommend this):**

> **Connect your tools to OpenTrace**
> ```bash
> npm install -g @opentrace/cli
> otx login
> ```
> Sign in through your browser — no API key needed. Then restart your editor.
> In Claude Code, accept the plugin prompt and run `/reload-plugins`.

**No-install alternative:**

> ```bash
> npx -y @opentrace/cli@latest login
> ```

**For servers, CI, or headless machines:**

> Create a CLI key in **Dashboard → API keys**, then:
> ```bash
> otx connect otk_your_key_here
> ```

**Targeting a specific tool:**

> ```bash
> otx login --client cursor          # or claude-desktop
> otx install --cursor --vscode      # register MCP in several editors
> ```

**Undo:**

> ```bash
> otx disconnect --all
> ```

---

## 11. Things not to say

- ❌ "Run `npx @opentrace/cli login`" — breaks on stale caches (§1).
- ❌ "Paste your API key to get started" — that is now the *fallback*, not the happy path.
- ❌ "The key will be named after your computer" — the server names keys (§8).
- ❌ "Works over SSH" — loopback OAuth needs a browser on the same machine (§9).
- ❌ "Run `otx login` in your pipeline" — it requires a TTY (§7).
- ❌ Don't tell Claude Code users to add an MCP entry manually; the plugin supersedes it (§5).
