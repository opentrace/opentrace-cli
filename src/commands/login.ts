import { confirm } from "@inquirer/prompts"
import { DEFAULT_BASE_URL, normalizeMcpUrl, toBaseUrl } from "../util/constants.js"
import { findStoredKey } from "../util/stored-key.js"
import { probeMcp } from "../util/mcp-probe.js"
import { cliKeyId, recordKeyVerdict } from "../util/notice-state.js"
import { isInteractive } from "../util/tty.js"
import { maskToken } from "../util/token.js"
import { loginWithBrowser } from "../util/oauth/flow.js"
import { connectWithKey } from "./connect.js"

interface LoginOptions {
  url?: string
  baseUrl?: string
  client?: string
  /** commander --no-browser ⇒ false; absent = true. */
  browser?: boolean
  /** Explicit --track-usage / --no-track-usage; undefined = not stated (prompt or skip). */
  trackUsage?: boolean
  global?: boolean
  yes?: boolean
}

/**
 * `otx login` — sign in with the browser, trade the sign-in for a cli-scoped
 * otk_ key, then hand that key to the same machinery as `otx connect otk_…`
 * (probe, attach, usage-monitoring opt-in). Interactive by design — automation
 * passes a key instead, and that path is untouched.
 */
export async function login(opts: LoginOptions): Promise<void> {
  if (!isInteractive()) {
    console.error("otx login is interactive — it opens a browser and waits for the sign-in.")
    console.error("In automation, pass a key instead: otx connect otk_…  or  otx install --api-key otk_…")
    process.exit(1)
  }

  const endpoint = opts.url ?? opts.baseUrl ?? DEFAULT_BASE_URL
  const baseUrl = toBaseUrl(endpoint)
  const mcpUrl = normalizeMcpUrl(endpoint)

  // Every sign-in mints a fresh server-side key, so a machine that already
  // holds a working one is asked before another is minted.
  if (!opts.yes) {
    // The plugin token file is not endpoint-scoped, so it only describes this
    // endpoint when this endpoint is the default one — a run pointed at another
    // deployment must not probe (or offer to keep) a key minted elsewhere.
    const stored = findStoredKey(mcpUrl, { includePluginToken: baseUrl === DEFAULT_BASE_URL })?.token
    if (stored) {
      console.log(`Checking the CLI key already on this machine (${maskToken(stored)}) …`)
      const probe = await probeMcp(mcpUrl, stored)
      if (probe.ok || probe.kind === "auth") {
        recordKeyVerdict(cliKeyId(mcpUrl), stored, probe.ok ? "valid" : "rejected")
      }
      if (probe.ok) {
        const again = await confirm({
          message: `This machine already has a valid CLI key for ${baseUrl}. Sign in and mint a new one anyway?`,
          default: false,
        })
        if (!again) {
          console.log("Keeping the existing key — attach it to a client with `otx install` or `otx connect`.")
          return
        }
      }
    }
  }

  const result = await loginWithBrowser({ baseUrl, openBrowser: opts.browser !== false })
  if (!result.ok) {
    switch (result.kind) {
      case "unsupported":
        console.error(`\n${result.message}`)
        console.error("Create a key in the OpenTrace dashboard (API keys), then run: otx connect otk_…")
        break
      case "denied":
        console.error("\nSign-in was cancelled in the browser — nothing was written.")
        break
      case "timeout":
        console.error(`\n${result.message}`)
        console.error("Re-run `otx login`, or paste a key with `otx connect otk_…`.")
        break
      case "limit":
        // The message already points at the dashboard to prune keys.
        console.error(`\n${result.message}`)
        break
      default:
        console.error(`\n${result.message}`)
        console.error("You can paste a key instead: otx connect otk_… (OpenTrace dashboard → API keys).")
    }
    process.exit(1)
  }

  console.log()
  await connectWithKey(result.token, {
    url: opts.url ?? opts.baseUrl,
    client: opts.client,
    trackUsage: opts.trackUsage,
    global: opts.global,
    yes: opts.yes,
  })
}
