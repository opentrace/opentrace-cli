// The browser sign-in flow, end to end: discovery → loopback redirect →
// RFC 7591 client registration → authorization-code + PKCE in the browser →
// token exchange at the upstream IdP → trade the access token for a
// cli-scoped otk_ key. OAuth here is a means to that key, not a session: the
// IdP access token lives only inside this module and is discarded after the
// trade (no refresh token is requested, and one issued anyway is ignored).
// The otk_ key is the only secret returned, and the caller stores it through
// the same choke points as a pasted key.

import os from "node:os"
import { createHash, randomBytes } from "node:crypto"
import { maskToken } from "../token.js"
import { parseErrorDetail } from "../telemetry.js"
import { discoverAuthServer, type AuthServerInfo } from "./discovery.js"
import { formatTimeout, startLoopbackServer } from "./loopback.js"
import { looksHeadless, openBrowser } from "./browser.js"
import { provisionCliKey } from "./cli-key.js"

export interface OauthLoginOptions {
  baseUrl: string
  /** Names the minted key server-side; defaults to the hostname. */
  deviceName?: string
  /** false = never spawn a browser, only print the URL (--no-browser). */
  openBrowser?: boolean
  timeoutMs?: number
}

export type OauthLoginResult =
  | { ok: true; token: string }
  | {
      ok: false
      kind: "unsupported" | "network" | "protocol" | "auth" | "denied" | "timeout" | "limit"
      message: string
    }

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Identity-only scopes. offline_access is deliberately absent — a refresh
 * token would be discarded anyway — and the server's authorize proxy appends
 * any IdP-mandatory extras (e.g. Clerk's user:org:read) itself.
 */
const IDENTITY_SCOPES = ["openid", "email", "profile"]

type RegisterResult =
  | { ok: true; clientId: string }
  | { ok: false; kind: "unsupported" | "network" | "protocol"; message: string }

/**
 * RFC 7591 dynamic registration of this run's loopback redirect. Matches the
 * server's RFC 8252 policy: exactly one redirect_uri, explicit port, public
 * client (token_endpoint_auth_method "none").
 */
async function registerClient(server: AuthServerInfo, redirectUri: string): Promise<RegisterResult> {
  let res: Response
  try {
    res = await fetch(server.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "OpenTrace CLI",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${server.registrationEndpoint} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (res.status === 404 || res.status === 405) {
    return { ok: false, kind: "unsupported", message: "This OpenTrace server does not offer browser sign-in." }
  }
  const text = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      kind: "protocol",
      message: parseErrorDetail(text) ?? `Client registration failed (HTTP ${res.status}).`,
    }
  }
  try {
    const parsed = JSON.parse(text) as { client_id?: string }
    if (!parsed.client_id) {
      return { ok: false, kind: "protocol", message: "Client registration returned no client_id." }
    }
    return { ok: true, clientId: parsed.client_id }
  } catch {
    return { ok: false, kind: "protocol", message: "Client registration returned invalid JSON." }
  }
}

type ExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; kind: "auth" | "network" | "protocol"; message: string }

/** Authorization-code exchange at the upstream IdP's token endpoint (public client + PKCE verifier). */
async function exchangeCode(
  tokenEndpoint: string,
  args: { code: string; redirectUri: string; clientId: string; verifier: string },
): Promise<ExchangeResult> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  })
  let res: Response
  try {
    res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${tokenEndpoint} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const text = await res.text()
  if (!res.ok) {
    let error: string | undefined
    try {
      error = (JSON.parse(text.slice(0, 4096)) as { error?: string }).error
    } catch {
      /* not JSON */
    }
    if (error === "invalid_grant") {
      return { ok: false, kind: "auth", message: "The sign-in expired before it completed — run the command again." }
    }
    return {
      ok: false,
      kind: "protocol",
      message: parseErrorDetail(text) ?? `Token exchange failed (HTTP ${res.status}).`,
    }
  }
  try {
    // refresh_token / id_token, if present, are deliberately ignored.
    const parsed = JSON.parse(text) as { access_token?: string }
    if (!parsed.access_token) {
      return { ok: false, kind: "protocol", message: "The token response carried no access token." }
    }
    return { ok: true, accessToken: parsed.access_token }
  } catch {
    return { ok: false, kind: "protocol", message: "The token response was not valid JSON." }
  }
}

/** Run the whole browser sign-in and return the minted cli-scoped otk_ key. */
export async function loginWithBrowser(opts: OauthLoginOptions): Promise<OauthLoginResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  console.log(`Checking sign-in support at ${opts.baseUrl} …`)
  const discovery = await discoverAuthServer(opts.baseUrl)
  if (!discovery.ok) return discovery
  const auth = discovery.server

  const started = await startLoopbackServer()
  if (!started.ok) return { ok: false, kind: "network", message: started.message }
  const server = started.server

  // Ctrl-C while parked on the wait should release the port and exit quietly.
  // Scoped to this flow: installed just before the wait, removed in finally.
  const onSigint = (): void => {
    server.close()
    console.log("\nSign-in cancelled.")
    process.exit(130)
  }

  try {
    // Installed as soon as the port is open — not just around the wait — so a
    // Ctrl-C during client registration or the browser hand-off also closes
    // the server and exits cleanly. Removed in the finally below.
    process.once("SIGINT", onSigint)

    const registered = await registerClient(auth, server.redirectUri)
    if (!registered.ok) return registered

    // PKCE S256 + state, fresh per run — both mandatory, no plain fallback.
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const state = randomBytes(16).toString("base64url")

    const authorizeUrl = new URL(auth.authorizationEndpoint)
    const supported = auth.scopesSupported?.filter((s) => IDENTITY_SCOPES.includes(s))
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", registered.clientId)
    authorizeUrl.searchParams.set("redirect_uri", server.redirectUri)
    authorizeUrl.searchParams.set("state", state)
    authorizeUrl.searchParams.set("code_challenge", challenge)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    authorizeUrl.searchParams.set("scope", (supported?.length ? supported : IDENTITY_SCOPES).join(" "))

    const headless = looksHeadless()
    if (opts.openBrowser === false || headless) {
      if (headless) {
        console.log("No local browser detected (SSH/headless). The sign-in redirects back to a port on THIS machine,")
        console.log("so a browser elsewhere cannot complete it — paste a key instead (`otx connect otk_…`), or:")
      } else {
        console.log("Open this URL in a browser to sign in:")
      }
      console.log(`  ${authorizeUrl}`)
    } else {
      console.log("Opening your browser to sign in …")
      const opened = await openBrowser(authorizeUrl.toString())
      console.log(opened ? "  If it didn't open, visit:" : "  Could not launch a browser — open this URL:")
      console.log(`  ${authorizeUrl}`)
    }

    console.log(`Waiting for sign-in (times out in ${formatTimeout(timeoutMs)}, Ctrl-C to cancel) …`)
    const callback = await server.waitForCallback(state, timeoutMs)
    if (!callback.ok) {
      const kind = callback.kind === "server" ? "protocol" : callback.kind
      return { ok: false, kind, message: callback.message }
    }

    const exchanged = await exchangeCode(auth.tokenEndpoint, {
      code: callback.code,
      redirectUri: server.redirectUri,
      clientId: registered.clientId,
      verifier,
    })
    if (!exchanged.ok) return exchanged

    const deviceName = opts.deviceName ?? os.hostname()
    console.log(`  ✓ signed in — creating a CLI key for this machine (${deviceName}) …`)
    const minted = await provisionCliKey(opts.baseUrl, exchanged.accessToken, deviceName)
    if (!minted.ok) return minted

    console.log(`  ✓ CLI key created (${maskToken(minted.token)})`)
    return { ok: true, token: minted.token }
  } finally {
    process.removeListener("SIGINT", onSigint)
    server.close()
  }
}
