// Key provisioning against the OpenTrace REST surface (POST /api-keys).
//
// The key a user pastes is an API-scoped key from the dashboard. It is never
// attached to a client itself: the CLI spends it on minting the narrower
// per-surface keys that actually get installed — an `mcp` key for MCP clients,
// and a `claude_code_telemetry` key for the usage-tracking env block. Minted
// secrets are returned by the API exactly once, so a key that isn't captured
// here is gone (only its prefix is listable afterwards).

import os from "node:os"
import { buildApiKeysUrl } from "./constants.js"
import { probeMcp } from "./mcp-probe.js"

/** Scopes the REST surface will mint (its OpenAPI advertises exactly these). */
export type ProvisionScope = "mcp" | "claude_code_telemetry"

export interface ProvisionedKey {
  id: string
  token: string
  name: string
}

export type ProvisionResult =
  | { ok: true; key: ProvisionedKey }
  | { ok: false; kind: "auth" | "forbidden" | "network" | "protocol"; message: string }

export type RestKeyCheck =
  | { ok: true }
  | { ok: false; kind: "auth" | "network" | "protocol"; message: string }

/**
 * Pull a human-readable reason out of a REST error body. FastAPI-style
 * `detail` is the norm; the RFC 6750 pair covers the auth middleware.
 */
function parseErrorDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown
      message?: string
      error?: string
      error_description?: string
    }
    if (typeof parsed.detail === "string") return parsed.detail
    if (parsed.detail && typeof parsed.detail === "object") {
      const message = (parsed.detail as { message?: string }).message
      if (message) return message
    }
    if (parsed.message) return parsed.message
    if (parsed.error_description) return parsed.error_description
    if (parsed.error) return parsed.error
  } catch {
    /* not JSON */
  }
  return null
}

/** Default display name for a minted key — identifies the mint site in the dashboard. */
export function defaultKeyName(scope: ProvisionScope): string {
  const surface = scope === "mcp" ? "MCP" : "Claude Code usage"
  return `otx ${surface} (${os.hostname()})`.slice(0, 100)
}

/**
 * Can this key talk to the provisioning surface? A GET of the caller's own
 * key list is the cheapest authenticated REST call there is, and unlike a
 * mint attempt it changes nothing.
 */
export async function checkProvisioningKey(baseUrl: string, token: string): Promise<RestKeyCheck> {
  const url = `${buildApiKeysUrl(baseUrl)}?limit=1`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (res.ok) return { ok: true }
  // Capped for the same reason as in provisionKey: error bodies are untrusted sizes.
  const detail = parseErrorDetail((await res.text()).slice(0, 4096))
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      kind: "auth",
      message: detail ?? "The key was rejected by the REST API (not an API-scoped key, expired, or revoked).",
    }
  }
  return { ok: false, kind: "protocol", message: detail ?? `Unexpected HTTP ${res.status} from ${url}.` }
}

/** Mint a key with one scope. The returned secret is shown by the API only this once. */
export async function provisionKey(
  baseUrl: string,
  provisioningToken: string,
  scope: ProvisionScope,
  name = defaultKeyName(scope),
): Promise<ProvisionResult> {
  const url = buildApiKeysUrl(baseUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provisioningToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ name, scope }),
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Error bodies are capped: a proxy in the way can answer with an arbitrarily
  // large HTML page, and only the first bytes can carry a useful detail anyway.
  if (!res.ok) {
    const detail = parseErrorDetail((await res.text()).slice(0, 4096))
    if (res.status === 401) {
      return { ok: false, kind: "auth", message: detail ?? "The provisioning key was rejected." }
    }
    if (res.status === 403) {
      return { ok: false, kind: "forbidden", message: detail ?? "This key is not allowed to mint API keys." }
    }
    return { ok: false, kind: "protocol", message: detail ?? `Unexpected HTTP ${res.status} minting a ${scope} key.` }
  }

  const body = await res.text()
  try {
    const parsed = JSON.parse(body) as { id?: string; token?: string; name?: string }
    if (!parsed.token) {
      return { ok: false, kind: "protocol", message: "The mint response carried no key secret." }
    }
    return { ok: true, key: { id: parsed.id ?? "", token: parsed.token, name: parsed.name ?? name } }
  } catch {
    return { ok: false, kind: "protocol", message: "The mint response was not valid JSON." }
  }
}

/**
 * Best-effort deletion of a key that was minted but never attached anywhere —
 * without this, a failure between mint and attach strands a live credential on
 * the server that the user does not know exists. Returns false rather than
 * throwing: cleanup runs on error paths, where a second failure must not mask
 * the first.
 */
export async function deleteProvisionedKey(
  baseUrl: string,
  provisioningToken: string,
  keyId: string,
): Promise<boolean> {
  if (!keyId) return false
  try {
    const res = await fetch(`${buildApiKeysUrl(baseUrl)}/${keyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${provisioningToken}` },
    })
    return res.status === 204
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

/**
 * What one pasted otk_ token turned out to be. Scopes are invisible in the
 * token itself, so the surfaces are asked: REST accepting it makes it an
 * API-scoped key (and an `mcp` key is minted on the spot); the MCP mount
 * accepting it makes it an MCP-scoped key attached directly (the pre-scopes
 * behavior, kept so existing keys keep working).
 */
export type KeyMaterial =
  | { kind: "provisioned"; provisioningKey: string; mcpToken: string }
  | { kind: "mcp"; mcpToken: string; note?: string }
  | { kind: "rejected"; message: string }
  | { kind: "unverified"; mcpToken: string; message: string }

export async function resolveKeyMaterial(
  baseUrl: string,
  mcpUrl: string,
  token: string,
): Promise<KeyMaterial> {
  const rest = await checkProvisioningKey(baseUrl, token)
  if (rest.ok) {
    const minted = await provisionKey(baseUrl, token, "mcp")
    if (!minted.ok) {
      // The key authenticated but the mint failed — surfacing why beats
      // falling back to attaching an API-scoped key that no client accepts.
      return { kind: "rejected", message: `key accepted, but minting an MCP key failed — ${minted.message}` }
    }
    return { kind: "provisioned", provisioningKey: token, mcpToken: minted.key.token }
  }

  // REST said no — see whether the MCP mount recognizes it as an mcp-scoped key.
  const probe = await probeMcp(mcpUrl, token)
  if (probe.ok) {
    return {
      kind: "mcp",
      mcpToken: token,
      note:
        rest.kind === "auth"
          ? "This is an MCP-scoped key — attached directly. Minting a usage key needs an API-scoped key."
          : undefined,
    }
  }
  if (rest.kind === "auth" && probe.kind === "auth") {
    return { kind: "rejected", message: probe.message }
  }
  // At least one surface was unreachable/broken, so nothing conclusive is
  // known about the key itself — same posture as before scopes existed: use
  // it, say it is unverified.
  return {
    kind: "unverified",
    mcpToken: token,
    message: rest.ok === false && rest.kind !== "auth" ? rest.message : probe.message,
  }
}
