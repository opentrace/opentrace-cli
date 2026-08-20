import path from "node:path"
import fs from "node:fs"
import { checkbox, confirm, password, select } from "@inquirer/prompts"
import { ALL_INTEGRATIONS, detectInstalled, integrationsFromFlags } from "../util/detect.js"
import { DEFAULT_BASE_URL, MARKETPLACE_REPO, buildIngestUrl, buildMcpUrl, pluginId } from "../util/constants.js"
import { isInteractive } from "../util/tty.js"
import { maskToken, validateTokenShape } from "../util/token.js"
import { probeMcp } from "../util/mcp-probe.js"
import { findStoredKey, storedKeySourceLabel } from "../util/stored-key.js"
import { readPluginToken } from "../util/plugin-token.js"
import { attachClientKey, attachPluginKey } from "../util/attach-key.js"
import { resolveTelemetryPlan, writeTelemetryEnv, USAGE_PRIVACY_NOTE } from "../util/telemetry.js"
import { cliKeyId, recordKeyVerdict } from "../util/notice-state.js"
import { loginWithBrowser } from "../util/oauth/flow.js"
import { looksHeadless } from "../util/oauth/browser.js"
import { claudeCodeSurfaces, hasClaudeCodeDesktop } from "../util/claude-app.js"
import { ensurePluginInstalled } from "../util/claude-plugins.js"
import { findKeyClient, hasKeyClientEntry } from "../key-clients/index.js"
import type { Integration } from "../integrations/types.js"

interface InstallCommandOptions {
  baseUrl?: string
  /** Full MCP URL to inject into the plugin's userConfig; set only when a URL was explicitly given. */
  pluginUrl?: string
  /** API key supplied on the command line — the non-interactive form of the key prompt. */
  apiKey?: string
  /** Explicit --track-usage / --no-track-usage; undefined = not stated (prompt or skip). */
  trackUsage?: boolean
  /** Explicit --express; undefined = ask (interactively) or use the flag-driven path. */
  express?: boolean
  /**
   * Which way the scope question leans when it has not been answered outright.
   * `install` onboards a project, so it defaults project-side; `login` onboards a
   * machine, so it comes in here asking for the other default. Only moves the
   * default — an explicit -g/--global still settles it without asking.
   */
  preferGlobal?: boolean
  yes?: boolean
  global?: boolean
  toolOpts?: Record<string, unknown>
}

/** Integrations named explicitly with per-tool flags (`--cursor`, `--zed`, …). */
function flaggedTargets(opts: InstallCommandOptions): Integration[] {
  return integrationsFromFlags(opts.toolOpts ?? {})
}

/**
 * The file this run would write for a tool, and whether OpenTrace is already in
 * it. Mirrors the branching of the write loop — a plugin-hosted tool, a
 * key-carrying client, or a plain MCP entry all land in different files — so
 * "already configured" is answered about the file we are actually going to
 * touch rather than the scope-selected one.
 */
function targetState(
  integration: Integration,
  dir: string,
  isGlobal: boolean,
  key?: ResolvedKey,
): { configPath: string; configured: boolean } {
  const opts = { global: isGlobal }
  if (integration.plugin) {
    return {
      configPath: integration.plugin.getConfigPath(dir, opts),
      configured: integration.plugin.isEnabled(dir, opts),
    }
  }
  // With a key in hand this tool's entry is written user-scoped by its key
  // client, so that is the file to inspect — not the project/global choice.
  const keyClient = key ? findKeyClient(integration.id) : undefined
  if (keyClient) {
    return { configPath: keyClient.configPath(), configured: hasKeyClientEntry(keyClient) }
  }
  return {
    configPath: integration.getConfigPath(dir, opts),
    configured: integration.hasEntry(dir, opts),
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

type InstallMode = "express" | "custom"

/**
 * Asked before anything else, because Express is precisely an answer to every
 * question that would otherwise follow: all projects, every detected tool,
 * browser sign-in, usage monitoring on. Naming the detected tools in the
 * description matters — "every detected tool" is only reassuring once you can
 * see which ones those are.
 */
async function promptMode(detected: Integration[]): Promise<InstallMode> {
  const detectedList = detected.length > 0 ? detected.map((i) => i.label).join(", ") : "none found yet"
  return select({
    message: "How should OpenTrace be set up?",
    choices: [
      {
        name: "Express — recommended",
        value: "express" as const,
        description: `Sign in, then set up every detected tool (${detectedList}) for all projects, usage monitoring on`,
      },
      {
        name: "Custom",
        value: "custom" as const,
        description: "Pick the scope, the tools, how they authenticate, and whether to monitor usage",
      },
    ],
  })
}

/**
 * What the tool list says about a tool's presence. Claude Code is two surfaces
 * behind one entry — the terminal CLI and the desktop app's Code tab, which
 * share the same config files — so it names them rather than claiming a bare
 * "detected" that leaves a desktop-only user unsure they are covered.
 */
function detectionTag(integration: Integration): string {
  if (!integration.detect()) return "not found"
  if (integration.id === "claude-code") {
    const surfaces = claudeCodeSurfaces()
    if (surfaces.length > 0) return `detected: ${surfaces.join(" + ")}`
  }
  return "detected"
}

/**
 * Scope is asked BEFORE the tool list so the "already configured" labels in
 * that list are exact — whether an entry exists depends on which file we'd
 * write, and a label that contradicts what we do next is worse than no label.
 */
async function promptScope(defaultGlobal: boolean): Promise<boolean> {
  return select({
    message: "Where should OpenTrace be configured?",
    choices: [
      {
        name: "Just this project",
        value: false,
        description: "Writes project-level config (.mcp.json, .cursor/mcp.json, …)",
      },
      {
        name: "All projects",
        value: true,
        description: "Writes user-level config (~/.claude, ~/.cursor, …)",
      },
    ],
    default: defaultGlobal,
  })
}

/**
 * The tool list, detected tools pre-checked. Undetected tools are still listed
 * (rather than hidden) so a tool whose config directory does not exist yet can
 * be set up ahead of installing it — detection is a hint, not a gate.
 */
async function promptTargets(dir: string, isGlobal: boolean): Promise<Integration[]> {
  const rows = ALL_INTEGRATIONS.map((integration) => {
    const detected = integration.detect()
    // No key resolved yet at this point, so this reads the scope-selected file.
    // It is a label, not a decision — the authoritative check runs after the
    // key prompt and prints what will actually be rewritten.
    const { configured } = targetState(integration, dir, isGlobal)
    const tags = [detectionTag(integration)]
    if (configured) tags.push("already configured")
    return {
      name: `${integration.label}  (${tags.join(" · ")})`,
      value: integration,
      checked: detected,
    }
  })

  return checkbox({
    message: "Which tools should OpenTrace be set up for?",
    choices: rows,
    pageSize: ALL_INTEGRATIONS.length,
    // Deliberately not `required` — deselecting everything is a valid way to
    // back out, and it exits cleanly without writing anything.
    required: false,
  })
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

type KeySource = "flag" | "keychain" | "plugin" | "prompt" | "oauth"

interface ResolvedKey {
  token: string
  source: KeySource
}

interface KeyCheck {
  ok: boolean
  /** True when the key itself was rejected, as opposed to the check not completing. */
  rejected: boolean
  message?: string
}

/**
 * Confirm a CLI key with a real MCP handshake. Only a 401 tells us the key is
 * bad — a network or provisioning failure says nothing about the key, so those
 * are reported as "unverified" and the key is still used. Every definite answer
 * is handed to the notice banner, which then has no reason to ask again.
 */
async function checkKey(mcpUrl: string, token: string): Promise<KeyCheck> {
  const probe = await probeMcp(mcpUrl, token)
  if (probe.ok) {
    recordKeyVerdict(cliKeyId(mcpUrl), token, "valid")
    return { ok: true, rejected: false }
  }
  if (probe.kind === "auth") recordKeyVerdict(cliKeyId(mcpUrl), token, "rejected")
  return { ok: false, rejected: probe.kind === "auth", message: probe.message }
}

const MAX_KEY_ATTEMPTS = 3

/**
 * Decide what these tools will authenticate with. In order: the `--api-key`
 * flag, a key this machine already holds, then (interactively) a choice of
 * browser sign-in (the default — mints a fresh CLI key), pasting a key, or
 * skipping. Every key is a CLI key — one credential authenticates the MCP
 * mount and the usage-key endpoint alike — validated with an MCP handshake.
 * Returning undefined means "no key" — the tools fall back to signing in with
 * OAuth from inside the tool, which is a fully supported outcome, not an error.
 *
 * Express skips the "how?" question and signs in with the browser, which is what
 * the mode promised; the paste prompt is still there as the fallback if the
 * browser cannot be used.
 */
async function resolveApiKey(
  mcpUrl: string,
  opts: { apiKey?: string; interactive: boolean; baseUrl: string; express?: boolean },
): Promise<ResolvedKey | undefined> {
  if (opts.apiKey) {
    const check = await checkKey(mcpUrl, opts.apiKey)
    if (check.rejected) {
      // An explicitly supplied key that the server rejects is a hard failure —
      // proceeding would wire up a connection that cannot work.
      console.error(`\nKey rejected: ${check.message}`)
      console.error("Re-copy the key, or create a fresh one, then run install again.")
      process.exit(1)
    }
    if (!check.ok) console.warn(`Note: could not verify the key — ${check.message}`)
    return { token: opts.apiKey, source: "flag" }
  }

  const existing = findStoredKey(mcpUrl, { includePluginToken: true })
  if (existing) {
    const where = storedKeySourceLabel(existing.source)
    // Announced because it costs a network round-trip: without this the command
    // appears to stall before its first output. Worth the wait either way — a
    // revoked key that gets re-attached silently fails on every later call.
    console.log(`Checking the CLI key stored in your ${where} (${maskToken(existing.token)}) …`)
    const check = await checkKey(mcpUrl, existing.token)
    if (check.ok) {
      console.log(`  ✓ still valid — reusing it.`)
      return existing
    }
    if (check.rejected) {
      // Expired or revoked — say so and fall through, rather than silently
      // re-attaching a key that returns 401 on every call.
      console.warn(`The CLI key stored in your ${where} was rejected — ${check.message}`)
    } else {
      console.warn(`Could not verify the stored CLI key — ${check.message}`)
      return existing
    }
  }

  if (!opts.interactive) return undefined

  // Browser sign-in is the interactive default; pasting stays one keystroke
  // away, and automation (`--api-key`, `connect otk_…`, non-TTY) never lands here.
  const method = opts.express
    ? "browser"
    : await select({
        message: "How should these tools authenticate to OpenTrace?",
        choices: [
          {
            name: "Sign in with your browser",
            value: "browser",
            description: looksHeadless()
              ? "Mints a CLI key for this machine (needs a browser on THIS machine — won't work over SSH)"
              : "Opens the OpenTrace sign-in and mints a CLI key for this machine",
          },
          {
            name: "Paste a CLI key (otk_…)",
            value: "paste",
            description: "From the OpenTrace dashboard → API keys",
          },
          {
            name: "Skip — sign in from each tool later",
            value: "skip",
            description: "Tools authenticate with OAuth from inside the tool (in Claude Code: /mcp)",
          },
        ],
      })
  if (method === "skip") return undefined

  if (method === "browser") {
    const result = await loginWithBrowser({ baseUrl: opts.baseUrl })
    if (result.ok) {
      // Same invariant as every other source: a returned key was confirmed
      // against the MCP mount. This key was minted moments ago, so a rejection
      // here is a server inconsistency, not a bad paste — warn, don't fail.
      const check = await checkKey(mcpUrl, result.token)
      if (!check.ok) {
        console.warn(
          check.rejected
            ? `Note: the freshly minted key was rejected by the MCP endpoint — ${check.message}`
            : `Note: could not verify the minted key — ${check.message}`,
        )
      }
      return { token: result.token, source: "oauth" }
    }
    console.error(result.message)
    // Where retrying the browser could actually succeed (the user cancelled
    // or ran out of time), say so — otherwise pasting is the right path.
    console.log(
      result.kind === "timeout" || result.kind === "denied"
        ? "Re-run this command to try the browser again — or paste a key below (leave blank to skip)."
        : "Falling back to the key prompt — paste a key, or leave blank to skip.",
    )
  }

  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const entered = (
      await password({
        message: "OpenTrace CLI key (otk_…) — leave blank to skip:",
        mask: "•",
        validate: (value: string) => {
          const trimmed = value.trim()
          if (!trimmed) return true // blank is the documented "skip" answer
          return validateTokenShape(trimmed) ?? true
        },
      })
    ).trim()

    if (!entered) return undefined

    const check = await checkKey(mcpUrl, entered)
    if (check.ok || !check.rejected) {
      if (!check.ok) console.warn(`Note: could not verify the key — ${check.message}`)
      return { token: entered, source: "prompt" }
    }
    console.error(`Key rejected: ${check.message}`)
    if (attempt === MAX_KEY_ATTEMPTS) {
      console.log("Continuing without a key — sign in from your tool with /mcp instead.")
      return undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type Status = "added" | "updated" | "skipped"

interface Row {
  label: string
  configPath: string
  status: Status
}

export async function install(targetPath: string, opts: InstallCommandOptions): Promise<void> {
  const dir = path.resolve(targetPath)

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`)
    process.exit(1)
  }

  // Shape-check a command-line key first: it's offline and free, so a typo
  // fails before we announce anything or touch a config file.
  if (opts.apiKey) {
    const shapeError = validateTokenShape(opts.apiKey)
    if (shapeError) {
      console.error(`Invalid --api-key: ${shapeError}`)
      process.exit(1)
    }
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const mcpUrl = opts.pluginUrl ?? buildMcpUrl(baseUrl)
  // `--yes` and any non-TTY run (CI, a pipe) take the flag-driven path so
  // nothing can block on a prompt that will never be answered.
  const interactive = !opts.yes && isInteractive()

  // 1. Express or Custom. Per-tool flags are already a custom answer, so they
  //    skip the question; `--express` states it outright, including for
  //    automation. Everything Express decides is announced before it acts —
  //    a mode that asks nothing must not also do anything unannounced.
  const explicitTargets = flaggedTargets(opts)
  // Detected once and reused: the Express summary names the tools it is about to
  // set up, and `targets` must be that same list. Two calls could disagree —
  // and a summary that does not describe the work is worse than none.
  const detected = detectInstalled()
  let express = opts.express === true
  if (opts.express === undefined && interactive && explicitTargets.length === 0) {
    express = (await promptMode(detected)) === "express"
  }

  // What Express is about to set up. Per-tool flags win over detection further
  // down (`--express --cursor` is a coherent request), so the plan is written
  // from the same list the write loop will use — describing `detected` there
  // made every line of the summary wrong for exactly that combination.
  const planTargets = explicitTargets.length > 0 ? explicitTargets : detected

  if (express) {
    if (planTargets.length === 0) {
      // Express has nothing to be express about. Falling back to the tool list
      // beats silently doing nothing, or writing config for tools that are
      // nowhere on this machine.
      console.log("No supported AI tools detected — switching to Custom so you can pick which to set up.")
      console.log()
      express = false
    } else {
      console.log()
      console.log("Express setup:")
      console.log(`  • Tools:   ${planTargets.map((i) => i.label).join(", ")}`)
      console.log("  • Scope:   all projects (user-level config)")
      // `--express --no-track-usage` is a coherent request, and the flag wins —
      // so the summary must not claim monitoring the run then skips.
      if (planTargets.some((i) => i.id === "claude-code") && opts.trackUsage !== false) {
        console.log("  • Usage:   monitoring your Claude Code usage in OpenTrace")
        console.log(`             ${USAGE_PRIVACY_NOTE}`)
      }
      // Only promise the sign-in this run can actually perform: `--express -y`
      // and `--express` in CI have no browser to open, and the key step falls
      // back to whatever this machine already holds.
      if (opts.apiKey) {
        console.log("  • Sign-in: the CLI key given on the command line")
      } else if (interactive) {
        console.log("  • Sign-in: your browser, which mints a CLI key for this machine")
      } else {
        console.log("  • Sign-in: a key already on this machine (no browser without a terminal)")
      }
      console.log()
    }
  }

  // 2. Scope. Express is "all projects" by definition; otherwise an explicit
  //    -g/--global answers it, then the prompt, then project-level (the
  //    historical default) when we cannot ask.
  let isGlobal: boolean
  if (express) {
    isGlobal = true
  } else if (opts.global !== undefined) {
    isGlobal = opts.global
  } else if (interactive) {
    isGlobal = await promptScope(opts.preferGlobal ?? false)
  } else {
    isGlobal = opts.preferGlobal ?? false
  }

  // 3. Which tools. Per-tool flags win; then Express or bare detection; then the
  //    prompt. How they were chosen decides whether an existing config is
  //    confirmed before it gets rewritten, so it is tracked rather than
  //    re-derived.
  let targets: Integration[]
  let targetSource: "flags" | "prompt" | "detected"
  if (explicitTargets.length > 0) {
    targets = explicitTargets
    targetSource = "flags"
  } else if (express) {
    // The same list the Express summary named, so not printed twice.
    targetSource = "detected"
    targets = detected
  } else if (interactive) {
    targetSource = "prompt"
    targets = await promptTargets(dir, isGlobal)
    if (targets.length === 0) {
      console.log("No tools selected — nothing to do.")
      return
    }
  } else {
    targetSource = "detected"
    targets = detected
    if (targets.length === 0) {
      console.log("No supported AI tools detected.")
      console.log()
      console.log("Specify tools explicitly with flags:")
      ALL_INTEGRATIONS.forEach((i) => {
        console.log(`  opentrace install --${i.id}`)
      })
      return
    }
    console.log(`Detected: ${targets.map((i) => i.label).join(", ")}`)
  }

  // 4. How they authenticate. Asked once and applied to every selected tool.
  //    The same CLI key later authenticates the usage-key endpoint.
  const key = await resolveApiKey(mcpUrl, { apiKey: opts.apiKey, interactive, baseUrl, express })

  // 5. Usage monitoring. Decided and provisioned up front so every prompt and
  //    network round-trip happens before the first file is written.
  const telemetry = await resolveTelemetryPlan({
    dir,
    baseUrl,
    isGlobal,
    // Only the flag counts as explicit — an interactive scope answer above
    // becomes the default for the scope question, not its answer. Express is
    // the exception: it settled both the "whether" and the "where".
    explicitGlobal: express ? true : opts.global,
    interactive,
    // Express turns monitoring on, but only where the user did not say
    // otherwise: a `--no-track-usage` they typed is honoured rather than
    // silently overridden by the mode's default.
    trackUsage: opts.trackUsage ?? (express ? true : undefined),
    cliToken: key?.token,
    // A key from the keychain or the plugin token file is the one this machine
    // was already using, so the usage key on file belongs to it. A key that
    // arrived any other way may be a different account.
    explicitCliKey: key !== undefined && key.source !== "keychain" && key.source !== "plugin",
    targetsClaudeCode: targets.some((i) => i.id === "claude-code"),
  })

  // 6. The Claude desktop app. Nothing to write: its Code tab shares ~/.claude
  //    with the CLI, and its chat surface takes account-level connectors.
  //
  //    otx used to write an `mcp-remote` stdio bridge into
  //    claude_desktop_config.json here. That put the raw key in an npx process's
  //    argv, needed Node on PATH, and made local Code-tab sessions list OpenTrace
  //    twice. A custom connector reaches the same surface over OAuth with none of
  //    that, so we print the prefilled link and let the user confirm it — which is
  //    the only way an account-level connector can be added anyway.
  //
  //    The Code tab needs nothing either way: it shares ~/.claude, where the
  //    plugin is already installed — which is the whole of what onboarding owes the
  //    desktop app. So nothing here advertises the chat surface: it is reached only
  //    when asked for by name, with `otx connect --client claude-desktop`.

  // A bridge from an older otx is still a live stdio server holding a key, so
  // take it out rather than leaving it beside the connector we now recommend.
  let staleBridge: string | undefined
  {
    const legacy = findKeyClient("claude-desktop")
    if (legacy && hasKeyClientEntry(legacy)) {
      try {
        const removed = legacy.remove()
        if (removed.removed) staleBridge = removed.configPath
      } catch {
        /* leave it rather than fail onboarding over a cleanup */
      }
    }
  }

  // Only the flag path asks "overwrite?" per tool. The checkbox already labels
  // which tools are configured and the user selected them anyway, so a confirm
  // there would re-ask a choice just made; the flag path never showed that
  // list. Either way a rewrite replaces OpenTrace's own entry only — the rest
  // of the file is preserved — so what's at stake is a hand-edited OpenTrace
  // entry, and the endpoint being written is printed in the summary.
  const confirmBeforeOverwrite = targetSource === "flags" && interactive

  // Say it up front when a run will rewrite existing config, so "already
  // configured" tools are never overwritten silently.
  if (!confirmBeforeOverwrite) {
    const rewriting = targets.filter((i) => targetState(i, dir, isGlobal, key).configured)
    if (rewriting.length > 0) {
      console.log(`Rewriting existing OpenTrace config for: ${rewriting.map((i) => i.label).join(", ")}`)
    }
  }

  console.log()
  const results: Row[] = []
  let pluginInstalled = false
  /** Set when the declaration landed but the plugin could not be installed for the user. */
  let pluginNeedsInstall = false
  let pluginInstallError: string | undefined
  let attachedKey: ResolvedKey | undefined
  /** Tools left authenticating with OAuth — they still need a sign-in step. */
  const oauthTargets: string[] = []
  const notes: string[] = []

  for (const integration of targets) {
    const { configPath, configured } = targetState(integration, dir, isGlobal, key)
    if (confirmBeforeOverwrite && configured) {
      const overwrite = await confirm({
        message: `${integration.label}: OpenTrace already configured in ${configPath}. Overwrite?`,
        default: false,
      })
      if (!overwrite) {
        results.push({ label: integration.label, configPath, status: "skipped" })
        continue
      }
    }

    try {
      // Where a plugin is available (Claude Code) it supersedes the bare MCP
      // entry — the plugin bundles its own MCP, so writing .mcp.json too would
      // be redundant.
      if (integration.plugin) {
        const pr = integration.plugin.install(dir, { global: isGlobal })
        pluginInstalled = true
        results.push({
          label: `${integration.label} (plugin)`,
          configPath: pr.configPath,
          status: pr.alreadyEnabled ? "updated" : "added",
        })

        // The declaration only *asks* for the plugin; Claude Code installs it when
        // it next prompts. A terminal shows that prompt, the desktop app does not —
        // so onboarding used to finish with nothing in /plugin and no way to tell.
        const ensured = ensurePluginInstalled(pluginId())
        if (ensured.installed && !ensured.alreadyInstalled) {
          results.push({ label: `${integration.label} (plugin install)`, configPath: "Claude Code plugin list", status: "added" })
        } else if (!ensured.installed) {
          pluginNeedsInstall = true
          // Say why. Reporting only the command to run left the user to rediscover
          // the failure themselves — and when the cause was an unregistered
          // marketplace, that command failed the same way.
          pluginInstallError = ensured.error
        }

        if (key) {
          // Replacing a key already on file is an update, not an add — a
          // summary that always says "added" would hide that a previous key
          // was just overwritten.
          const hadKey = readPluginToken() !== undefined
          // Seeding mcp_url alongside the key is what makes the plugin fully
          // non-interactive: with both present it never asks for an endpoint
          // and authenticates straight away.
          const attached = attachPluginKey(integration.plugin, mcpUrl, key.token)
          attachedKey = key
          results.push({
            label: `${integration.label} (API key)`,
            configPath: attached.tokenPath,
            status: hadKey ? "updated" : "added",
          })
        } else {
          oauthTargets.push(integration.label)
          if (opts.pluginUrl) {
            const ur = integration.plugin.setMcpUrl(opts.pluginUrl)
            console.log(`  ↳ plugin endpoint → ${opts.pluginUrl}  (${ur.configPath})`)
          }
        }
        continue
      }

      // A key must never land in project-scoped config that could be committed,
      // so bearer-header clients are always written user-scoped (0600) — that
      // is what their writers do, independent of the scope chosen above.
      const keyClient = key ? findKeyClient(integration.id) : undefined
      if (key && keyClient) {
        const hadEntry = hasKeyClientEntry(keyClient)
        const attached = attachClientKey(keyClient, mcpUrl, key.token)
        attachedKey = key
        results.push({
          label: `${integration.label} (API key)`,
          configPath: attached.configPath,
          status: hadEntry ? "updated" : "added",
        })
        if (attached.keychainError) {
          notes.push(
            `${integration.label}: ${attached.keychainError}\n` +
              "  The key is still active in the client config; it just wasn't saved to the keychain.",
          )
        }
        if (attached.note) notes.push(`${integration.label}: ${attached.note}`)
        continue
      }

      const r = integration.install(dir, { baseUrl, global: isGlobal })
      results.push({
        label: integration.label,
        configPath: r.configPath,
        status: r.existed ? "updated" : "added",
      })
      oauthTargets.push(integration.label)
      if (key) {
        // Selected, wired up, but this tool has no way to carry the key — say
        // so instead of letting the user assume the key applies everywhere.
        notes.push(`${integration.label}: no API-key support — sign in from the tool to authorize.`)
      }
    } catch (err) {
      console.error(`  ${integration.label}: failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Apply the usage-monitoring plan (its prompts and minting already ran above).
  if (telemetry.note) notes.push(telemetry.note)
  if (telemetry.plan) {
    try {
      const { existed } = writeTelemetryEnv(telemetry.plan.configPath, telemetry.plan.env)
      results.push({
        label: "Claude Code (usage monitoring)",
        configPath: telemetry.plan.configPath,
        status: existed ? "updated" : "added",
      })
      if (!telemetry.plan.isGlobalScope) {
        notes.push(
          "The usage key is in .claude/settings.json, which is often committed. It can only send, never read.",
        )
      }
    } catch (err) {
      console.error(`  Claude Code (usage monitoring): failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Apply the chat-surface decision made above (see step 6).
  if (staleBridge) {
    notes.push(
      `Removed the old \`mcp-remote\` bridge from ${staleBridge} — it carried your key in a ` +
        "process argument. The plugin covers the app's Code tab; for its chat surface run " +
        "`otx connect --client claude-desktop`.",
    )
  }

  // Config is read when a session starts, so a running one never notices. This
  // used to claim the desktop app was "covered by the above" — the engine does
  // read these files, but the app's own plugin panel is a separate surface, so
  // that sentence told people they were done when they could see nothing.
  if (targets.some((i) => i.id === "claude-code") && hasClaudeCodeDesktop()) {
    notes.push("Claude Code Desktop: start a new session to pick this up.")
  }
  if (pluginNeedsInstall) {
    const why = pluginInstallError ? ` (${pluginInstallError})` : ""
    notes.push(
      `Could not finish installing the plugin${why}. Run: ` +
        `claude plugin marketplace add ${MARKETPLACE_REPO} && claude plugin install ${pluginId()}`,
    )
  }

  if (results.length === 0) return

  // The status column is what distinguishes a first write from one that
  // replaced something already there (a re-run, or a key swapped out).
  const colWidth = Math.max(...results.map((r) => r.label.length)) + 2
  const statusWidth = Math.max(...results.map((r) => r.status.length)) + 2
  for (const r of results) {
    const icon = r.status === "skipped" ? "-" : "✓"
    console.log(`  ${icon} ${r.label.padEnd(colWidth)}${r.status.padEnd(statusWidth)}${r.configPath}`)
  }

  console.log()
  console.log(`  Endpoint:  ${mcpUrl.replace(/\/+$/, "")}`)
  if (attachedKey) console.log(`  CLI key:   ${maskToken(attachedKey.token)}`)
  if (telemetry.plan) console.log(`  Usage:     ${buildIngestUrl(baseUrl)}`)

  for (const note of notes) {
    console.log()
    console.log(`  ${note}`)
  }

  const changed = results.some((r) => r.status !== "skipped")
  if (!changed && !pluginInstalled) return

  console.log()
  console.log("Next steps:")
  console.log("  1. Restart your AI tools to activate the OpenTrace MCP server.")
  if (pluginInstalled && pluginNeedsInstall) {
    console.log("     Claude Code will ask to install the plugin — accept it.")
  }
  if (pluginInstalled && !attachedKey && !opts.pluginUrl) {
    console.log("     It will ask for the MCP endpoint; the default is production.")
  }

  // Only the tools that ended up without a key still need a sign-in, so name
  // them rather than pointing everyone at Claude Code's /mcp. Tools that were
  // skipped or failed to write never reach this list.
  if (oauthTargets.length > 0) {
    const suffix = oauthTargets.includes("Claude Code") ? " (in Claude Code: /mcp)" : ""
    console.log(`  2. Sign in to OpenTrace from ${oauthTargets.join(", ")} to authorize${suffix}.`)
  } else if (attachedKey) {
    console.log("  2. That's it — your API key is already attached.")
  }
}
