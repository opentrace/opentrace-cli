// Claude Code's installed-plugin bookkeeping, which lives apart from settings.
//
// Enabling a plugin takes two records, and until now otx only wrote and removed
// one of them:
//
//   ~/.claude/settings.json           declares the marketplace and enables the
//                                     plugin — what otx writes, and removes
//   ~/.claude/plugins/*.json          what Claude Code installed as a result —
//                                     what `/plugin` actually lists
//
// So `otx disconnect --plugin` cleaned the declaration, the MCP server duly
// disappeared, and the plugin went on being listed in `/plugin` as installed.
// The old advice was to go and run `claude plugin uninstall` afterwards; doing it
// here means the user does not have to know these files exist.
//
// Everything below is surgical and refuses to guess. These are Claude Code's
// files, holding other people's plugins: an unexpected shape is left untouched
// and reported rather than rewritten, and a directory is only deleted when the
// record itself named it and it sits inside the plugins directory.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { claudeAppDir } from "./claude-app.js"

interface InstalledEntry {
  scope?: string
  installPath?: string
  projectPath?: string
}

interface InstalledPlugins {
  version?: number
  plugins?: Record<string, InstalledEntry[]>
}

interface MarketplaceRecord {
  installLocation?: string
}

/** The schema this code understands. A different one is skipped, not guessed at. */
const SUPPORTED_INSTALLED_VERSION = 2

export function claudePluginsDir(): string {
  return path.join(os.homedir(), ".claude", "plugins")
}

export function installedPluginsPath(): string {
  return path.join(claudePluginsDir(), "installed_plugins.json")
}

export function knownMarketplacesPath(): string {
  return path.join(claudePluginsDir(), "known_marketplaces.json")
}

/** Claude Code's per-plugin data directory, named `<plugin>-<marketplace>`. */
export function pluginDataDir(pluginName: string, marketplaceName: string): string {
  return path.join(claudePluginsDir(), "data", `${pluginName}-${marketplaceName}`)
}

export interface PluginCacheRemoval {
  /** The plugin no longer appears in installed_plugins.json. */
  uninstalled: boolean
  /** The marketplace no longer appears in known_marketplaces.json. */
  marketplaceForgotten: boolean
  /** Directories actually deleted, for reporting. */
  removedPaths: string[]
  /**
   * Files that were present but not in a shape this code recognises, so were left
   * exactly as they were. Reported so the user can finish by hand rather than
   * being told everything is clean when it is not.
   */
  skipped: string[]
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * Returns false rather than throwing, so a record that cannot be rewritten is
 * reported like any other skipped file instead of aborting a disconnect halfway
 * through its other components.
 */
function tryWriteJson(file: string, value: unknown): boolean {
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/**
 * Delete a directory, but only if the record named it and it lives inside the
 * plugins directory. A record is data, and data that has been hand-edited or
 * written by a future version must not be able to point a delete anywhere it
 * likes.
 */
function removeRecordedDir(target: string | undefined, removed: string[]): void {
  if (!target) return
  const root = path.resolve(claudePluginsDir())
  const resolved = path.resolve(target)
  // Strict children only. The root itself is never a legitimate target: a record
  // pointing there would take every other plugin on the machine with it.
  if (!resolved.startsWith(root + path.sep)) return
  if (!fs.existsSync(resolved)) return
  try {
    fs.rmSync(resolved, { recursive: true, force: true })
    removed.push(resolved)
    pruneEmptyAncestors(path.dirname(resolved), root)
  } catch {
    /* best-effort: the records are gone, which is what `/plugin` reads */
  }
}

/**
 * Walk up deleting directories that are now empty, stopping below `root`.
 *
 * An install path names a versioned directory — `cache/opentrace/opentrace/0.6.0`
 * — so removing it alone leaves two empty rungs behind. Only ever removes
 * directories that are already empty, and never `root` itself.
 */
function pruneEmptyAncestors(from: string, root: string): void {
  let current = path.resolve(from)
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) return
      fs.rmdirSync(current)
    } catch {
      return // not empty, gone already, or not ours to remove
    }
    current = path.dirname(current)
  }
}

/**
 * Undo what installing the plugin left on disk: its entry in
 * installed_plugins.json (every scope — disconnecting is not per-project), the
 * marketplace record, and the directories those two named.
 *
 * Idempotent, and a no-op on a machine where the plugin was never installed.
 */
export function removeInstalledPlugin(
  pluginId: string,
  marketplaceName: string,
  pluginName: string,
): PluginCacheRemoval {
  const result: PluginCacheRemoval = {
    uninstalled: false,
    marketplaceForgotten: false,
    removedPaths: [],
    skipped: [],
  }

  // 1. The installed-plugin record — the one `/plugin` reads.
  const installedFile = installedPluginsPath()
  if (fs.existsSync(installedFile)) {
    const installed = readJson<InstalledPlugins>(installedFile)
    if (!installed || typeof installed.plugins !== "object" || installed.plugins === null) {
      result.skipped.push(installedFile)
    } else if (installed.version !== undefined && installed.version !== SUPPORTED_INSTALLED_VERSION) {
      // A schema we have not seen. Rewriting it could break every other plugin
      // the user has installed, which is a far worse outcome than a leftover.
      result.skipped.push(installedFile)
    } else if (pluginId in installed.plugins) {
      // Record first, directories second. The other order leaves the record
      // pointing at directories that no longer exist if the write fails — and the
      // record is the half that matters, being what `/plugin` reads.
      const dirs = (installed.plugins[pluginId] ?? []).map((entry) => entry.installPath)
      delete installed.plugins[pluginId]
      if (tryWriteJson(installedFile, installed)) {
        result.uninstalled = true
        for (const dir of dirs) removeRecordedDir(dir, result.removedPaths)
      } else {
        result.skipped.push(installedFile)
      }
    }
  }

  // 2. The marketplace record, so the plugin is not offered straight back.
  const marketplacesFile = knownMarketplacesPath()
  if (fs.existsSync(marketplacesFile)) {
    const known = readJson<Record<string, MarketplaceRecord>>(marketplacesFile)
    if (!known || typeof known !== "object") {
      result.skipped.push(marketplacesFile)
    } else if (marketplaceName in known) {
      const location = known[marketplaceName]?.installLocation
      delete known[marketplaceName]
      if (tryWriteJson(marketplacesFile, known)) {
        result.marketplaceForgotten = true
        removeRecordedDir(location, result.removedPaths)
      } else {
        result.skipped.push(marketplacesFile)
      }
    }
  }

  // 3. The per-plugin data directory, but only while it is still the empty
  //    scaffold Claude Code creates. Anything in there is the plugin's own data,
  //    and a disconnect has no business deleting data.
  const dataDir = pluginDataDir(pluginName, marketplaceName)
  try {
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) {
      removeRecordedDir(dataDir, result.removedPaths)
    }
  } catch {
    /* unreadable — leave it alone */
  }

  return result
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/** Is the plugin in the records `/plugin` reads? */
export function isPluginInstalled(pluginId: string): boolean {
  const installed = readJson<InstalledPlugins>(installedPluginsPath())
  return Boolean(installed?.plugins && pluginId in installed.plugins)
}

/**
 * A `claude` executable, if this machine has one. PATH first, then the copy the
 * desktop app downloads for its own Code tab — which is the case that matters,
 * since a desktop-only user may have no CLI on PATH at all.
 */
export function findClaudeBinary(): string | undefined {
  const onPath = spawnSync("claude", ["--version"], { timeout: 15_000, stdio: "ignore" })
  if (!onPath.error && onPath.status === 0) return "claude"

  const engines = path.join(claudeAppDir(), "claude-code")
  try {
    // Newest first: the app keeps old versions around after an update.
    const versions = fs.readdirSync(engines).sort().reverse()
    for (const v of versions) {
      const candidate = path.join(engines, v, "claude")
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    /* no app directory */
  }
  return undefined
}

export interface PluginInstall {
  /** The plugin is in the install records now. */
  installed: boolean
  /** It already was, before this call. */
  alreadyInstalled: boolean
  /** The binary used, for reporting. */
  via?: string
  /** Why it could not be done, when it could not. */
  error?: string
}

/**
 * Make the declaration real.
 *
 * Writing `enabledPlugins` only *asks* for the plugin: Claude Code installs it
 * when it next prompts the user to accept. In a terminal that prompt arrives and
 * onboarding appears to work; in the desktop app nothing prompts, so the
 * declaration sat there and `/plugin` stayed empty while otx reported success.
 *
 * So finish the job when a `claude` binary can be found, and say what to run when
 * it cannot — rather than leaving the user in a state they have no way to see.
 */
export function ensurePluginInstalled(pluginId: string): PluginInstall {
  if (isPluginInstalled(pluginId)) return { installed: true, alreadyInstalled: true }

  const bin = findClaudeBinary()
  if (!bin) return { installed: false, alreadyInstalled: false, error: "no `claude` executable found" }

  const run = spawnSync(bin, ["plugin", "install", pluginId, "--scope", "user", "-y"], {
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  if (run.error) {
    return { installed: false, alreadyInstalled: false, via: bin, error: run.error.message }
  }
  // Trust the records, not the exit code: this is what `/plugin` reads.
  if (isPluginInstalled(pluginId)) return { installed: true, alreadyInstalled: false, via: bin }

  const detail = (run.stderr || run.stdout || "").trim().split("\n").pop() || `exit ${run.status}`
  return { installed: false, alreadyInstalled: false, via: bin, error: detail }
}
