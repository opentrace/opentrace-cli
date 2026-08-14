// Cache behind the on-use notice banner. Two things are remembered between runs:
// the latest published version, and whether a key this machine holds was last
// seen accepted or rejected.
//
// Verdicts are cached because the commands that already probe a key (install,
// connect, login, the usage-key step) record theirs here, so the banner is
// usually reading the result of real work rather than making a network call of
// its own. Every entry is fingerprinted with the key it describes: replace a
// rejected key and the old verdict no longer applies to anything, rather than
// warning about a key that is already gone.
//
// Every operation is best-effort. A cache that cannot be read or written must
// never be the reason a command fails, so failures degrade to "nothing known".

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type KeyVerdict = "valid" | "rejected"

interface CachedVerdict {
  /** Identifies the key the verdict is about, without storing the key. */
  fingerprint: string
  verdict: KeyVerdict
  /** epoch ms */
  at: number
}

export interface NoticeState {
  /** epoch ms of the last registry lookup, successful or not. */
  updateCheckedAt?: number
  latestVersion?: string
  /** Keyed by what the verdict is about — see cliKeyId / usageKeyId. */
  verdicts?: Record<string, CachedVerdict>
}

export function noticeStatePath(): string {
  return path.join(os.homedir(), ".opentrace", "state.json")
}

/**
 * How long a recorded verdict is trusted. Shared so the banner and the
 * onboarding path cannot drift apart about what "recently checked" means —
 * they read each other's answers.
 */
export const KEY_VERDICT_TTL_MS = 12 * 60 * 60 * 1000

/** The verdict key for a CLI key, scoped to the endpoint it was judged against. */
export function cliKeyId(mcpUrl: string): string {
  return `cli:${mcpUrl}`
}

/** The verdict key for a usage key, scoped to the settings file it lives in. */
export function usageKeyId(configPath: string): string {
  return `usage:${configPath}`
}

/** Identifies a key in the cache without persisting the secret itself. */
function fingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)
}

export function readNoticeState(): NoticeState {
  try {
    return JSON.parse(fs.readFileSync(noticeStatePath(), "utf8")) as NoticeState
  } catch {
    return {}
  }
}

/** Read-modify-write, so two fields written by different steps don't clobber. */
export function updateNoticeState(mutate: (state: NoticeState) => void): void {
  try {
    const state = readNoticeState()
    mutate(state)
    const target = noticeStatePath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  } catch {
    /* best-effort — the banner degrades to checking again next run */
  }
}

/**
 * Remember that `token` was accepted or rejected. Only definite answers belong
 * here: a timeout or an unreachable host says nothing about the key, and caching
 * it as anything would either nag or reassure on no evidence.
 */
export function recordKeyVerdict(id: string, token: string, verdict: KeyVerdict): void {
  updateNoticeState((state) => {
    state.verdicts = {
      ...(state.verdicts ?? {}),
      [id]: { fingerprint: fingerprint(token), verdict, at: Date.now() },
    }
  })
}

/** The cached verdict for `token`, or undefined if it is about a different key. */
export function readKeyVerdict(id: string, token: string): { verdict: KeyVerdict; at: number } | undefined {
  const cached = readNoticeState().verdicts?.[id]
  if (!cached || cached.fingerprint !== fingerprint(token)) return undefined
  return { verdict: cached.verdict, at: cached.at }
}

/**
 * The cached verdict for `token` if it is recent enough to act on. Lets a caller
 * skip a network round-trip entirely — notably the notice banner runs in the same
 * process, moments earlier, and has usually already asked this exact question.
 */
export function freshKeyVerdict(id: string, token: string): KeyVerdict | undefined {
  const cached = readKeyVerdict(id, token)
  if (!cached || Date.now() - cached.at >= KEY_VERDICT_TTL_MS) return undefined
  return cached.verdict
}
