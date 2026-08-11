// The loopback redirect target for the browser sign-in (RFC 8252 §7.3): an
// ephemeral HTTP server bound to 127.0.0.1 on an OS-assigned port. The DCR
// registration carries the actual bound port, so there is no fixed port list
// to collide on. Every response body is a compile-time constant — nothing
// from the request is ever reflected, so a forged request cannot inject
// content into the page. A request with a wrong or missing `state` gets a 400
// AND the server keeps waiting: any local process can hit the port, and
// letting a stray request abort the sign-in would be a trivial local
// denial-of-service — fail-open on the wait, fail-closed on the code (a
// wrong-state code is never exchanged).

import http from "node:http"
import type { AddressInfo, Socket } from "node:net"

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; kind: "timeout" | "denied" | "server"; message: string }

export interface LoopbackServer {
  port: number
  redirectUri: string
  /** Resolves with the authorization code, or how the wait ended. Call once per server. */
  waitForCallback(expectedState: string, timeoutMs: number): Promise<CallbackResult>
  /** Idempotent; destroys open sockets so the process can exit immediately. */
  close(): void
}

export type LoopbackStart =
  | { ok: true; server: LoopbackServer }
  | { ok: false; message: string }

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center">` +
    `<h2>${title}</h2><p>${body}</p></body></html>`
  )
}

const SUCCESS_PAGE = page("Signed in to OpenTrace", "You can close this tab and return to the terminal.")
const CANCELLED_PAGE = page("Sign-in cancelled", "You can close this tab. Re-run the command to try again.")
const BAD_REQUEST_PAGE = page("Request rejected", "This request did not match the sign-in in progress.")
const NOT_FOUND_PAGE = page("Not found", "Nothing to see here.")

function respond(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
  res.end(html)
}

/** "5 minutes" / "90 seconds" — a timeout reads as minutes only when it is minutes. */
export function formatTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`
}

/** Callback params are untrusted input — bound and strip to printable ASCII before terminal display. */
function sanitizeMessage(input: string): string {
  const cleaned = input.slice(0, 300).replace(/[^\x20-\x7E]/g, "")
  return cleaned || "The sign-in was cancelled."
}

function listenOnce(server: http.Server): Promise<string | null> {
  return new Promise((resolve) => {
    const onError = (err: Error): void => resolve(err.message)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError)
      resolve(null)
    })
  })
}

export async function startLoopbackServer(): Promise<LoopbackStart> {
  const sockets = new Set<Socket>()
  // The real handler is installed by waitForCallback (it closes over the
  // expected state); anything arriving before that is not the redirect.
  let handle: http.RequestListener = (_req, res) => respond(res, 404, NOT_FOUND_PAGE)
  const server = http.createServer((req, res) => handle(req, res))
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  // listen(0) lets the OS pick a free port, so failure here means loopback
  // networking itself is broken — no retry (an http.Server that failed to
  // listen is not reliably re-listenable; recovering would need a fresh
  // instance, for a case that does not happen in practice).
  const error = await listenOnce(server)
  if (error !== null) {
    return { ok: false, message: `Could not open a local port for the sign-in redirect — ${error}` }
  }

  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/callback`

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // The noop callback swallows the already-closed error when finish()'s
    // graceful close ran first — without it that error is emitted as an
    // unhandled 'error' event.
    server.close(() => {})
    for (const socket of sockets) socket.destroy()
  }

  const waitForCallback = (expectedState: string, timeoutMs: number): Promise<CallbackResult> =>
    new Promise((resolve) => {
      let warnedMismatch = false
      let settled = false
      const finish = (result: CallbackResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Stop accepting new connections the moment the wait settles, rather
        // than relying on the caller's close(). A graceful close (no socket
        // destruction) lets the in-flight response to the browser flush —
        // Connection: close ends it right after. The caller's close() still
        // destroys any straggler.
        server.close(() => {})
        resolve(result)
      }
      // unref: the open server is what keeps the event loop alive, so once the
      // flow closes it, a pending timeout no longer pins the process.
      const timer = setTimeout(() => {
        close()
        finish({
          ok: false,
          kind: "timeout",
          message: `Timed out waiting for the browser sign-in (${formatTimeout(timeoutMs)}).`,
        })
      }, timeoutMs)
      timer.unref()

      handle = (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
        if (url.pathname !== "/callback") {
          respond(res, 404, NOT_FOUND_PAGE)
          return
        }
        if (url.searchParams.get("state") !== expectedState) {
          if (!warnedMismatch) {
            warnedMismatch = true
            console.warn("Note: ignored a request to the sign-in callback that did not match this sign-in attempt.")
          }
          respond(res, 400, BAD_REQUEST_PAGE)
          return
        }
        const errorParam = url.searchParams.get("error")
        if (errorParam) {
          respond(res, 200, CANCELLED_PAGE)
          const description = url.searchParams.get("error_description")
          finish({ ok: false, kind: "denied", message: sanitizeMessage(description ?? errorParam) })
          return
        }
        const code = url.searchParams.get("code")
        if (!code) {
          respond(res, 400, BAD_REQUEST_PAGE)
          finish({ ok: false, kind: "server", message: "The sign-in redirect carried no authorization code." })
          return
        }
        respond(res, 200, SUCCESS_PAGE)
        finish({ ok: true, code })
      }
    })

  return { ok: true, server: { port, redirectUri, waitForCallback, close } }
}
