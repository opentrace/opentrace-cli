// Best-effort browser launch. Always spawn with array args and shell:false —
// the URL carries `&`-joined query params that a shell would re-parse; on
// Windows that rules out `cmd /c start`, so rundll32's FileProtocolHandler
// takes the URL as a plain argument instead. Failure is never fatal: the
// caller always prints the URL, so the worst case is the user clicking it.

import fs from "node:fs"
import { spawn } from "node:child_process"

let wslCached: boolean | undefined

function isWsl(): boolean {
  if (process.platform !== "linux") return false
  if (wslCached === undefined) {
    try {
      wslCached = /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"))
    } catch {
      wslCached = false
    }
  }
  return wslCached
}

/**
 * No display to open a browser on: over SSH, or on a Linux box with neither X
 * nor Wayland (WSL excepted — it opens the Windows browser). Callers skip the
 * spawn and warn that a loopback redirect cannot complete from a remote
 * browser.
 */
export function looksHeadless(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true
  if (process.platform === "linux" && !isWsl() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true
  }
  return false
}

function launchers(): Array<[string, string[]]> {
  switch (process.platform) {
    case "darwin":
      return [["open", []]]
    case "win32":
      return [["rundll32", ["url.dll,FileProtocolHandler"]]]
    default:
      return isWsl()
        ? [
            ["wslview", []],
            ["xdg-open", []],
          ]
        : [["xdg-open", []]]
  }
}

function trySpawn(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}

/** True if a launcher started. Best-effort — the caller prints the URL regardless. */
export async function openBrowser(url: string): Promise<boolean> {
  for (const [command, args] of launchers()) {
    if (await trySpawn(command, [...args, url])) return true
  }
  return false
}
