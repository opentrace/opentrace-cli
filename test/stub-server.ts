// A stand-in for everything otx talks to over the network: the MCP mount, the
// usage-key endpoint, the OTLP ingest mount, the OAuth metadata document, and
// the npm registry. One server for all five, because the CLI derives every one
// of them from a single host — so pointing `--base-url` (and OTX_REGISTRY_URL)
// at this server redirects the entire surface at once.
//
// It exists so tests can assert on behaviour that otherwise needs a live tenant:
// a rejected key, a server too old to provision usage keys, a newer release on
// npm. Those are the cases that matter and the ones you cannot summon on demand
// against production.

import http from "node:http"
import type { AddressInfo } from "node:net"

export interface StubOptions {
  /** Tokens answered with 401 wherever they are presented. */
  revoked: Set<string>
  /** What the registry reports as the latest published version. */
  latestVersion: string
  /** Answer the usage-key endpoint with 404 — a deployment predating it. */
  usageKeyUnsupported: boolean
  /** The key the usage-key endpoint hands out. */
  mintedUsageKey: string
  /** Serve RFC 8414 metadata (i.e. claim browser sign-in is available). */
  oauthEnabled: boolean
}

export interface StubRequest {
  method: string
  path: string
  token?: string
}

export interface Stub {
  /** Host base, e.g. http://127.0.0.1:41183 — pass as --base-url. */
  url: string
  /** Live options: mutate between calls to change how the server answers. */
  options: StubOptions
  /** Every request received, for asserting what the CLI actually did. */
  requests: StubRequest[]
  close(): Promise<void>
}

/**
 * A token of the shape the CLI validates (`otk_` + 43 URL-safe chars), derived
 * from a readable seed so a failing assertion names which key it was about.
 */
export function otk(seed: string): string {
  const cleaned = seed.replace(/[^A-Za-z0-9_-]/g, "") || "x"
  return `otk_${cleaned.repeat(Math.ceil(43 / cleaned.length)).slice(0, 43)}`
}

function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== "string") return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1]
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(payload)
}

export async function startStub(overrides: Partial<StubOptions> = {}): Promise<Stub> {
  const options: StubOptions = {
    revoked: new Set(),
    latestVersion: "0.0.1",
    usageKeyUnsupported: false,
    mintedUsageKey: otk("minted"),
    oauthEnabled: false,
    ...overrides,
  }
  const requests: StubRequest[] = []

  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0]
      const token = bearer(req)
      requests.push({ method: req.method ?? "GET", path, token })

      const refused = (): boolean => !token || options.revoked.has(token)

      // --- MCP mount: initialize + tools/list ---
      if (path.startsWith("/mcp/v1")) {
        if (refused()) {
          return send(res, 401, {
            error: "invalid_token",
            error_description: "The API key was rejected (invalid, expired, revoked, or wrong scope).",
          })
        }
        const rpc = (() => {
          try {
            return JSON.parse(body) as { id?: number; method?: string }
          } catch {
            return {} as { id?: number; method?: string }
          }
        })()
        // A notification carries no id and expects no body.
        if (rpc.id === undefined) {
          res.writeHead(202).end()
          return
        }
        const result =
          rpc.method === "tools/list"
            ? { tools: [{ name: "workspaces_list" }, { name: "environments_list" }, { name: "graph_search" }] }
            : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } }
        return send(res, 200, { jsonrpc: "2.0", id: rpc.id, result })
      }

      // --- Usage-key provisioning ---
      if (path === "/claude-code-usage/key") {
        if (options.usageKeyUnsupported) return send(res, 404, { detail: "Not Found" })
        if (refused()) return send(res, 401, { detail: "The CLI key was not accepted for usage-key provisioning." })
        return send(res, 200, {
          token: options.mintedUsageKey,
          created: true,
          id: "usage-key-1",
          name: "Stub Usage Key",
        })
      }

      // --- OTLP ingest (Claude Code telemetry) ---
      if (path.startsWith("/ingest/claude-code")) {
        if (refused()) return send(res, 401, { detail: "usage key rejected" })
        return send(res, 200, {})
      }

      // --- OAuth authorization-server metadata ---
      // 404 by default: browser sign-in reports itself unavailable, which is the
      // deterministic outcome for a headless test. A real sign-in needs a browser.
      if (path.includes("/.well-known/oauth-authorization-server")) {
        if (!options.oauthEnabled) return send(res, 404, { detail: "Not Found" })
        return send(res, 200, {
          issuer: `${baseUrl()}/oauth`,
          authorization_endpoint: `${baseUrl()}/oauth/authorize`,
          token_endpoint: `${baseUrl()}/oauth/token`,
          registration_endpoint: `${baseUrl()}/oauth/register`,
          code_challenge_methods_supported: ["S256"],
        })
      }

      // --- npm registry: <pkg>/latest ---
      if (req.method === "GET" && path.endsWith("/latest")) {
        return send(res, 200, { name: "@opentrace/cli", version: options.latestVersion })
      }

      send(res, 404, { detail: `stub has no route for ${req.method} ${path}` })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = (): string => `http://127.0.0.1:${port}`

  return {
    url: baseUrl(),
    options,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}
