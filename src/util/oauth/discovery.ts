// OAuth discovery for the browser sign-in: the server's RFC 8414
// authorization-server metadata, published for its /oauth shim.
// opentrace-api is a resource server only — the metadata's issuer and token
// endpoint belong to the upstream IdP (Clerk/Authentik), while the
// authorization endpoint points at the server's scope-rewriting
// /oauth/authorize proxy. The metadata route is mounted only when the
// deployment has DCR enabled (OT_API_OAUTH_DCR_PROVIDER != none), so a 404
// means "browser sign-in unsupported", not a server fault.

import { buildAuthServerMetadataUrl } from "../constants.js"

export interface AuthServerInfo {
  authorizationEndpoint: string
  tokenEndpoint: string
  /** RFC 7591 dynamic client registration — without it the loopback redirect has nowhere to register. */
  registrationEndpoint: string
  scopesSupported?: string[]
}

export type DiscoveryResult =
  | { ok: true; server: AuthServerInfo }
  | { ok: false; kind: "unsupported" | "network" | "protocol"; message: string }

/** Metadata documents are small; anything bigger than this is not one. */
const MAX_METADATA_BYTES = 16_384

const UNSUPPORTED_MESSAGE = "This OpenTrace server does not offer browser sign-in."

type FetchMetadataResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "unsupported" | "network" | "protocol"; message: string }

async function fetchMetadata(url: string): Promise<FetchMetadataResult> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (res.status === 404 || res.status === 405) {
    return { ok: false, kind: "unsupported", message: UNSUPPORTED_MESSAGE }
  }
  if (!res.ok) {
    return { ok: false, kind: "protocol", message: `Unexpected HTTP ${res.status} from ${url}.` }
  }
  try {
    const body = JSON.parse((await res.text()).slice(0, MAX_METADATA_BYTES)) as Record<string, unknown>
    return { ok: true, body }
  } catch {
    return { ok: false, kind: "protocol", message: `The metadata at ${url} was not valid JSON.` }
  }
}

/**
 * https is required on every advertised endpoint, except loopback hosts so a
 * locally-run server remains testable. Returns an error message, or null.
 */
function endpointError(name: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return `metadata is missing ${name}`
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `${name} is not a valid URL`
  }
  const host = parsed.hostname
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return `${name} must be https`
  }
  return null
}

/** Fetch the authorization-server metadata and validate what the sign-in flow needs. */
export async function discoverAuthServer(baseUrl: string): Promise<DiscoveryResult> {
  const as = await fetchMetadata(buildAuthServerMetadataUrl(baseUrl))
  if (!as.ok) return as

  const meta = as.body
  if (typeof meta.registration_endpoint !== "string" || meta.registration_endpoint.length === 0) {
    // No dynamic client registration means the loopback redirect cannot be
    // registered — the flow cannot run, same outcome as no metadata at all.
    return { ok: false, kind: "unsupported", message: UNSUPPORTED_MESSAGE }
  }

  const challengeMethods = meta.code_challenge_methods_supported
  if (Array.isArray(challengeMethods) && !challengeMethods.includes("S256")) {
    return { ok: false, kind: "protocol", message: "The authorization server does not support PKCE S256." }
  }

  const server: AuthServerInfo = {
    authorizationEndpoint: typeof meta.authorization_endpoint === "string" ? meta.authorization_endpoint : "",
    tokenEndpoint: typeof meta.token_endpoint === "string" ? meta.token_endpoint : "",
    registrationEndpoint: meta.registration_endpoint,
    scopesSupported: Array.isArray(meta.scopes_supported)
      ? meta.scopes_supported.filter((s): s is string => typeof s === "string")
      : undefined,
  }
  const endpoints: Array<[string, string]> = [
    ["authorization_endpoint", server.authorizationEndpoint],
    ["token_endpoint", server.tokenEndpoint],
    ["registration_endpoint", server.registrationEndpoint],
  ]
  for (const [name, value] of endpoints) {
    const problem = endpointError(name, value)
    if (problem) {
      return { ok: false, kind: "protocol", message: `Authorization-server ${problem}.` }
    }
  }
  return { ok: true, server }
}
