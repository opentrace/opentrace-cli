import { confirm } from "@inquirer/prompts"
import { DEFAULT_BASE_URL, normalizeMcpUrl, toBaseUrl } from "../util/constants.js"
import { getToken, KeychainUnavailableError } from "../util/keychain.js"
import { readPluginToken } from "../util/plugin-token.js"
import { probeMcp } from "../util/mcp-probe.js"
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

/** A key this machine already holds for this endpoint (keychain, then the plugin token file). */
function storedCliKey(mcpUrl: string): string | undefined {
  try {
    const fromKeychain = getToken(mcpUrl)
    if (fromKeychain) return fromKeychain
  } catch (err) {
    // No Secret Service is no reason not to sign in — check the plugin file.
    if (!(err instanceof KeychainUnavailableError)) throw err
  }
  return readPluginToken()
}

/**
 * `otx login` — sign in with the browser, trade the sign-in for a cli-scoped
 * otk_ key, then hand that key to the same machinery as `otx connect otk_…`
 * (probe, attach, usage-tracking opt-in). Interactive by design — automation
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
    const stored = storedCliKey(mcpUrl)
    if (stored) {
      console.log(`Checking the CLI key already on this machine (${maskToken(stored)}) …`)
      const probe = await probeMcp(mcpUrl, stored)
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
