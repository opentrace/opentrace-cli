// Trades a browser sign-in (the IdP OAuth access token) for a long-lived
// cli-scoped otk_ key at POST <base>/cli/key. The access token authenticates
// only this endpoint and the MCP mount; the minted key is what everything
// else stores and attaches. Mirrors provisionUsageKey — the sister endpoint
// that the CLI key itself authenticates.

import { buildCliKeyUrl } from "../constants.js"
import { TOKEN_REGEX } from "../token.js"
import { parseErrorDetail } from "../telemetry.js"

export type CliKeyResult =
  | { ok: true; token: string }
  | { ok: false; kind: "auth" | "unsupported" | "limit" | "network" | "protocol"; message: string }

/**
 * Mint a CLI key from an IdP access token. Every call mints a fresh key
 * (secrets are stored hashed server-side); the caller's reuse of a still-valid
 * stored key is what keeps repeat sign-ins from sprawling. A 404 means the
 * deployment predates the endpoint — its own kind, so callers can distinguish
 * "server too old" from "sign-in rejected".
 */
export async function provisionCliKey(
  baseUrl: string,
  accessToken: string,
  deviceName?: string,
): Promise<CliKeyResult> {
  const url = buildCliKeyUrl(baseUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(deviceName ? { "Content-Type": "application/json" } : {}),
      },
      body: deviceName ? JSON.stringify({ device_name: deviceName }) : undefined,
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!res.ok) {
    const detail = parseErrorDetail(await res.text())
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", message: detail ?? "The sign-in token was not accepted for CLI-key minting." }
    }
    if (res.status === 404 || res.status === 405) {
      return {
        ok: false,
        kind: "unsupported",
        message:
          "The sign-in worked, but this OpenTrace server cannot mint CLI keys from a browser sign-in yet — " +
          "update the server, or paste a key instead.",
      }
    }
    if (res.status === 409) {
      return {
        ok: false,
        kind: "limit",
        message:
          detail ?? "API key limit reached — remove unused keys in the OpenTrace dashboard (API keys), then retry.",
      }
    }
    return { ok: false, kind: "protocol", message: detail ?? `Unexpected HTTP ${res.status} from ${url}.` }
  }

  try {
    const parsed = JSON.parse(await res.text()) as { token?: string }
    if (!parsed.token || !TOKEN_REGEX.test(parsed.token)) {
      return { ok: false, kind: "protocol", message: "The CLI-key response carried no valid key." }
    }
    return { ok: true, token: parsed.token }
  } catch {
    return { ok: false, kind: "protocol", message: "The CLI-key response was not valid JSON." }
  }
}
