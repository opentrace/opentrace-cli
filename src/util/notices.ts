// The banner otx prints above whatever you asked it to do: an update line when a
// newer release exists, and a warning when a key this machine holds has stopped
// being accepted. Both are things the user cannot otherwise find out at the
// moment it matters — a revoked usage key in particular fails silently, because
// Claude Code has no way to report that its exports are being turned away.
//
// Three rules keep it from becoming a tax on every command:
//
//   • It never blocks. Answers are cached (see notice-state.ts) and every
//     network call has a deadline; a timeout produces no notice at all.
//   • It never speaks unless spoken to interactively — no TTY, CI, or
//     OTX_NO_NOTICES / NO_UPDATE_NOTIFIER and it stays silent.
//   • It never fails a command. Anything thrown in here is swallowed.
//
// It writes to stderr so a banner can never end up inside piped output.

import os from "node:os"
import { DEFAULT_BASE_URL, normalizeMcpUrl, toBaseUrl } from "./constants.js"
import { isNewerVersion, packageName, packageVersion } from "./version.js"
import { findStoredKey } from "./stored-key.js"
import { probeMcp } from "./mcp-probe.js"
import { claudeSettingsPath, probeTelemetryKey, readTelemetryToken } from "./telemetry.js"
import {
  cliKeyId,
  readKeyVerdict,
  readNoticeState,
  recordKeyVerdict,
  updateNoticeState,
  usageKeyId,
} from "./notice-state.js"

const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
const KEY_TTL_MS = 12 * 60 * 60 * 1000
/** Short enough that a slow network costs less than a second of felt delay. */
const NETWORK_TIMEOUT_MS = 2_500

/**
 * Where each notice would be noise rather than news.
 *
 * Every command that authenticates — install, connect, login — resolves the CLI
 * key itself moments later, reports the same verdict with more context, and
 * offers a better next step than a banner can (browser sign-in right there,
 * rather than "run otx login"). Warning first would duplicate that and
 * recommend the worse option, so the CLI-key line is left to the commands that
 * never look: `add-mcp`. `disconnect` is on its way to removing the key.
 *
 * The usage key is the opposite case. Nothing checks it unless a run happens to
 * be setting up monitoring, and its failure is silent — so it is reported
 * everywhere except while it is being torn down.
 *
 * The update line always shows.
 */
const SKIPS_CLI_KEY_NOTICE = new Set(["install", "connect", "login", "disconnect"])
const SKIPS_USAGE_KEY_NOTICE = new Set(["disconnect"])

interface Notice {
  lines: string[]
}

/** An env var counts as set unless it is explicitly off. */
function envFlag(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value !== "" && value !== "0" && value !== "false"
}

function suppressed(): boolean {
  // An explicit opt-out always wins, including over the force below.
  if (envFlag("OTX_NO_NOTICES") || envFlag("NO_UPDATE_NOTIFIER") || envFlag("CI")) return true
  // The TTY rule is what makes the banner untestable without a pseudo-terminal,
  // so it alone can be forced off. Only ever loosens: it cannot make a banner
  // appear for someone who opted out above.
  if (envFlag("OTX_FORCE_NOTICES")) return false
  // Nobody is reading. Also keeps the banner out of captured output.
  return !process.stderr.isTTY
}

function tildify(filePath: string): string {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

/**
 * Overridable so tests can serve version metadata locally instead of reaching
 * npm. Read per call rather than once at module load: a top-level const freezes
 * whatever the environment held at first import, which is invisible in the CLI
 * (one process, one value) but silently defeats any in-process test that sets the
 * variable after importing this module.
 */
function registryUrl(): string {
  return (process.env.OTX_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/$/, "")
}

async function fetchLatestVersion(): Promise<string | undefined> {
  // A scoped name is one path segment to the registry, so it is encoded as one.
  const url = `${registryUrl()}/${encodeURIComponent(packageName())}/latest`
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const { version } = (await res.json()) as { version?: string }
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined // offline, throttled, private registry — all equally "don't know"
  }
}

async function updateNotice(): Promise<Notice | undefined> {
  // "0.0.0" is packageVersion()'s sentinel for an unreadable manifest, not a
  // release. Every published version looks newer than it, so comparing would
  // announce an update on every single command while knowing nothing.
  const current = packageVersion()
  if (current === "0.0.0") return undefined

  const state = readNoticeState()
  let latest = state.latestVersion
  const checkedAt = state.updateCheckedAt ?? 0
  if (Date.now() - checkedAt > UPDATE_TTL_MS) {
    const fetched = await fetchLatestVersion()
    // The timestamp advances either way, so an unreachable registry is retried
    // once a day rather than on every single command.
    updateNoticeState((s) => {
      s.updateCheckedAt = Date.now()
      if (fetched) s.latestVersion = fetched
    })
    latest = fetched ?? latest
  }

  if (!latest || !isNewerVersion(current, latest)) return undefined
  return {
    lines: [`Update available  ${current} → ${latest}`, `Run  npm install -g ${packageName()}@latest`],
  }
}

// ---------------------------------------------------------------------------
// Key checks
// ---------------------------------------------------------------------------

/**
 * Resolve a verdict for `token`, preferring one already cached within its TTL.
 * `probe` is only called when there is nothing fresh to go on, and an
 * indefinite answer is neither cached nor reported.
 */
async function verdictFor(
  id: string,
  token: string,
  probe: () => Promise<"valid" | "rejected" | "unknown">,
): Promise<"valid" | "rejected" | "unknown"> {
  const cached = readKeyVerdict(id, token)
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.verdict
  const verdict = await probe()
  if (verdict !== "unknown") recordKeyVerdict(id, token, verdict)
  return verdict
}

async function cliKeyNotice(baseUrl: string): Promise<Notice | undefined> {
  const mcpUrl = normalizeMcpUrl(baseUrl)
  const stored = findStoredKey(mcpUrl, {
    // The plugin token file is not endpoint-scoped, so it only describes this
    // endpoint when this endpoint is the default one.
    includePluginToken: baseUrl === DEFAULT_BASE_URL,
  })
  if (!stored) return undefined

  const verdict = await verdictFor(cliKeyId(mcpUrl), stored.token, async () => {
    const probe = await probeMcp(mcpUrl, stored.token, { timeoutMs: NETWORK_TIMEOUT_MS })
    if (probe.ok) return "valid"
    // Only a 401 condemns a key. A 503 mid-provisioning or an unreachable host
    // would otherwise send the user off to re-authenticate for no reason.
    return probe.kind === "auth" ? "rejected" : "unknown"
  })
  if (verdict !== "rejected") return undefined

  return {
    lines: [
      "Your OpenTrace CLI key is no longer accepted — expired or revoked.",
      "Sign in again with  otx login",
    ],
  }
}

/**
 * The usage key, checked in the file whose copy is actually in force. Project
 * settings override user settings key-for-key, and the exporter's credential is
 * one key — so where this project defines a usage key, that is the one Claude
 * Code sends and the only one whose rejection stops anything arriving. Hence
 * project first, and stopping at the first file that carries one: a key the
 * project's copy shadows is not in use, and skipping it keeps this to a single
 * request.
 */
async function usageKeyNotice(baseUrl: string): Promise<Notice | undefined> {
  const candidates = [
    claudeSettingsPath(process.cwd(), { global: false }),
    claudeSettingsPath(process.cwd(), { global: true }),
  ]
  for (const configPath of candidates) {
    const token = readTelemetryToken(configPath)
    if (!token) continue
    const verdict = await verdictFor(usageKeyId(configPath), token, () =>
      probeTelemetryKey(baseUrl, token, { timeoutMs: NETWORK_TIMEOUT_MS }).then((state) =>
        state === "invalid" ? "rejected" : state === "valid" ? "valid" : "unknown",
      ),
    )
    if (verdict !== "rejected") return undefined
    return {
      lines: [
        `The Claude Code usage key in ${tildify(configPath)} was rejected —`,
        "your usage has stopped reaching OpenTrace.",
        "Re-provision it with  otx install --track-usage",
      ],
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(notices: Notice[]): string {
  const lines: string[] = []
  notices.forEach((notice, i) => {
    if (i > 0) lines.push("")
    lines.push(...notice.lines)
  })
  const width = Math.max(...lines.map((l) => l.length))
  // A box whose borders wrap is worse than no box at all.
  if (width + 8 > (process.stderr.columns ?? 80)) {
    return lines.map((l) => (l ? `  ! ${l}` : "")).join("\n")
  }
  return [
    `┌${"─".repeat(width + 4)}┐`,
    ...lines.map((l) => `│  ${l}${" ".repeat(width - l.length)}  │`),
    `└${"─".repeat(width + 4)}┘`,
  ]
    .map((l) => `  ${l}`)
    .join("\n")
}

/**
 * Print whatever the user ought to know before this command's own output. Runs
 * the update and key checks together, so the worst case is one timeout rather
 * than a queue of them.
 */
export async function printNotices(args: { command: string; endpoint?: string }): Promise<void> {
  try {
    if (suppressed()) return
    const baseUrl = toBaseUrl(args.endpoint ?? DEFAULT_BASE_URL)
    const pending = [updateNotice()]
    if (!SKIPS_CLI_KEY_NOTICE.has(args.command)) pending.push(cliKeyNotice(baseUrl))
    if (!SKIPS_USAGE_KEY_NOTICE.has(args.command)) pending.push(usageKeyNotice(baseUrl))
    const results = await Promise.all(pending)
    // Empty-lined notices are dropped here so render() always has a line to
    // measure — a zero-width box would throw rather than print.
    const notices = results.filter((n): n is Notice => n !== undefined && n.lines.length > 0)
    if (notices.length === 0) return
    process.stderr.write(`\n${render(notices)}\n`)
  } catch {
    /* a banner is never worth failing a command over */
  }
}
