import { confirm } from "@inquirer/prompts"
import { DEFAULT_BASE_URL, normalizeMcpUrl, toBaseUrl } from "../util/constants.js"
import { findStoredKey } from "../util/stored-key.js"
import { probeMcp } from "../util/mcp-probe.js"
import { cliKeyId, recordKeyVerdict } from "../util/notice-state.js"
import { isInteractive } from "../util/tty.js"
import { maskToken } from "../util/token.js"
import { loginWithBrowser } from "../util/oauth/flow.js"
import { connectWithKey } from "./connect.js"
import { install } from "./install.js"

interface LoginOptions {
  url?: string
  baseUrl?: string
  client?: string
  /** commander --no-browser ⇒ false; absent = true. */
  browser?: boolean
  /** Skip the Express/Custom question and take Express. Ignored alongside --client. */
  express?: boolean
  /** Explicit --track-usage / --no-track-usage; undefined = not stated (prompt or skip). */
  trackUsage?: boolean
  global?: boolean
  /** Skip confirmations by taking their defaults — which includes keeping a still-valid CLI key. */
  yes?: boolean
}

/**
 * `otx login` — sign in with the browser, trade the sign-in for a cli-scoped
 * otk_ key, then onboard with it: the full `otx install` flow (Express or Custom,
 * tool detection, scope, usage monitoring), or the single-client key flow when
 * `--client` names one. Interactive by design — automation passes a key instead,
 * and that path is untouched.
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

  /**
   * Set up this machine with `token`, however we came by it — freshly minted, or
   * already on file. Shared so that keeping an existing key is not a reason to
   * stop short of the setup the command exists to perform.
   *
   * Where a client was named, that is an explicit narrow instruction — honour it
   * exactly, via the single-client key flow. It is also the only route to Claude
   * Desktop, which is a key client but not an installable integration, so this
   * branch cannot be folded into the one below.
   */
  const onboard = async (token: string): Promise<void> => {
    if (opts.client) {
      if (opts.express) {
        console.warn("--express has no effect with --client — that names a single client to attach.")
      }
      await connectWithKey(token, {
        url: opts.url ?? opts.baseUrl,
        client: opts.client,
        trackUsage: opts.trackUsage,
        global: opts.global,
        yes: opts.yes,
      })
      return
    }
    // Otherwise the same onboarding `otx install` runs, with the key in hand:
    // Express/Custom, tool detection, scope, usage monitoring. Signing in decides
    // *how* you authenticate; it should not also decide how little gets set up.
    await install(process.cwd(), {
      baseUrl,
      apiKey: token,
      express: opts.express,
      trackUsage: opts.trackUsage,
      global: opts.global,
      // `login` onboards a machine rather than a project, so the scope question
      // leans the other way from `install`'s own default.
      preferGlobal: true,
      yes: opts.yes,
    })
  }

  // Every sign-in mints a fresh server-side key, so a machine that already holds
  // a working one keeps it.
  //
  // This check runs under -y too. It used to be skipped there, which made -y the
  // one way to rotate a key that was perfectly good: the question below defaults
  // to "keep", and -y means take the default, so skipping the question inverted
  // the very answer it was meant to assume.
  //
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
      const again = opts.yes
        ? false // the default answer, taken rather than asked
        : await confirm({
            message: `This machine already has a valid CLI key for ${baseUrl}. Sign in and mint a new one anyway?`,
            default: false,
          })
      if (!again) {
        // Declining a *new* key is not declining setup. This is the command the
        // dashboard hands people, so a returning user who already has a working
        // key must still end up configured — rather than being told to go and run
        // a different command, which is what used to happen here.
        console.log("Keeping the existing key — setting up with it.")
        // Said only where it explains the absence of a question.
        if (opts.yes) {
          console.log("(-y keeps a valid key; re-run without -y to be asked about minting a fresh one.)")
        }
        console.log()
        await onboard(stored)
        return
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
  await onboard(result.token)
}
