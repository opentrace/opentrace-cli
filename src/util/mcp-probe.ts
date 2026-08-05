// Validates an OpenTrace API key by performing an MCP Streamable-HTTP handshake
// against the global mount. The key only works against the MCP endpoint (REST
// rejects it), so a real `initialize` + `tools/list` is the only way to confirm it.
//
// The server is stateless (stateless_http=True): every request carries the auth
// header and there is no session to reuse, so we do not track Mcp-Session-Id.

import { packageVersion } from "./version.js"

const PROTOCOL_VERSION = "2025-06-18"

export type ProbeResult =
  | { ok: true; tools: string[] }
  | { ok: false; kind: "auth" | "provisioning" | "network" | "protocol"; message: string }

interface JsonRpcResponse {
  result?: unknown
  error?: { code: number; message: string }
}

/** RFC 6750 flat error body returned by the MCP mount: {error, error_description}. */
function parseErrorBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string }
    if (parsed.error_description) return parsed.error_description
    if (parsed.error) return parsed.error
  } catch {
    /* not JSON */
  }
  return null
}

/**
 * The response to a POST may be a single JSON object (`application/json`) or an
 * SSE stream (`text/event-stream`). Extract the JSON-RPC message from either.
 */
async function readJsonRpc(res: Response): Promise<JsonRpcResponse | null> {
  const contentType = res.headers.get("content-type") ?? ""
  const text = await res.text()
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as JsonRpcResponse
  }
  if (contentType.includes("text/event-stream")) {
    // Take the last `data:` payload that parses as JSON.
    let last: JsonRpcResponse | null = null
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!trimmed) continue
      try {
        last = JSON.parse(trimmed) as JsonRpcResponse
      } catch {
        /* skip non-JSON data lines (e.g. keepalives) */
      }
    }
    return last
  }
  // Some servers return JSON without the header — try anyway.
  try {
    return JSON.parse(text) as JsonRpcResponse
  } catch {
    return null
  }
}

async function post(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  })
}

function mapHttpFailure(status: number, body: string): ProbeResult {
  const detail = parseErrorBody(body)
  if (status === 401) {
    return {
      ok: false,
      kind: "auth",
      message: detail ?? "The API key was rejected (invalid, expired, revoked, or wrong scope).",
    }
  }
  if (status === 503) {
    return {
      ok: false,
      kind: "provisioning",
      message: detail ?? "The tenant is still being provisioned.",
    }
  }
  return {
    ok: false,
    kind: "protocol",
    message: detail ?? `Unexpected HTTP ${status} from the MCP endpoint.`,
  }
}

/**
 * Probe the MCP endpoint at `mcpUrl` (already normalized to end in /mcp/v1/)
 * with `token`. Runs initialize, then tools/list, mapping failures per the
 * OpenTrace auth contract.
 */
export async function probeMcp(mcpUrl: string, token: string): Promise<ProbeResult> {
  let initRes: Response
  try {
    initRes = await post(mcpUrl, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "opentrace-cli", version: packageVersion() },
      },
    })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${mcpUrl} — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!initRes.ok) {
    return mapHttpFailure(initRes.status, await initRes.text())
  }

  // Consume/ignore the initialize result; a 200 already means auth passed.
  await readJsonRpc(initRes)

  // Best-effort initialized notification (stateless servers accept or ignore it).
  try {
    await post(mcpUrl, token, { jsonrpc: "2.0", method: "notifications/initialized" })
  } catch {
    /* non-fatal */
  }

  let listRes: Response
  try {
    listRes = await post(mcpUrl, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `tools/list failed — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!listRes.ok) {
    return mapHttpFailure(listRes.status, await listRes.text())
  }

  const rpc = await readJsonRpc(listRes)
  if (rpc?.error) {
    return { ok: false, kind: "protocol", message: rpc.error.message }
  }
  const result = rpc?.result as { tools?: Array<{ name?: string }> } | undefined
  const tools = (result?.tools ?? []).map((t) => t.name).filter((n): n is string => Boolean(n))
  return { ok: true, tools }
}
