// The Claude desktop application — one Electron app with three tabs (Chat,
// Cowork, Code). Its **Code** tab is Claude Code Desktop: the same engine as the
// terminal CLI, shipped as a build the app downloads into its own directory.
//
// What matters for onboarding is that the Code tab reads the SAME config the CLI
// does — `~/.claude/settings.json` (including its `env` block), `~/.claude.json`,
// project `.mcp.json`, plugins and marketplaces — so the writes otx already
// makes for Claude Code land in desktop sessions too. Nothing separate to write;
// what was missing was knowing the app is there at all, and two places where the
// desktop app behaves differently enough to be worth saying out loud:
//
//   1. The app ALSO injects the MCP servers from `claude_desktop_config.json`
//      into local Code-tab sessions — it spawns the engine with `--mcp-config`,
//      so the engine itself never reads that file (its only mention of it is the
//      explicit `claude mcp add-from-claude-desktop` import, Mac/WSL only).
//      Those injected servers do NOT displace a plugin's: a plugin registers its
//      server under the scoped name `plugin:<plugin>:<server>` — verified with
//      `claude mcp list`, which prints ours as `plugin:opentrace:opentrace` —
//      so an entry named `opentrace` in `claude_desktop_config.json` sits
//      ALONGSIDE it, and Code-tab sessions then list two OpenTrace servers.
//      (The docs' collision rule is about two entries sharing one bare name.)
//   2. Config is read at session start, so a running session never picks up a
//      change — a new session is required, not just a restart.
//
// Verified against https://code.claude.com/docs/en/desktop ("Shared
// configuration"), https://code.claude.com/docs/en/mcp ("MCP servers from the
// Claude Desktop chat app") and the engine build the app downloads.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The desktop application's config directory (shared by all three tabs). */
export function claudeAppDir(): string {
  const home = os.homedir()
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude")
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude")
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude")
  }
}

/** The chat surface's MCP config — also read by local Code-tab sessions. */
export function claudeDesktopConfigPath(): string {
  return path.join(claudeAppDir(), "claude_desktop_config.json")
}

/** True if the Claude desktop app is installed on this machine. */
export function isClaudeAppInstalled(): boolean {
  return fs.existsSync(claudeAppDir())
}

/**
 * True once the Code tab has actually run. It downloads its own versioned
 * Claude Code build into `<appDir>/claude-code/<version>/`, so the directory's
 * presence is proof the desktop surface is in use — a stronger signal than the
 * app merely being installed, and the one worth reporting on.
 */
export function hasClaudeCodeDesktop(): boolean {
  return fs.existsSync(path.join(claudeAppDir(), "claude-code"))
}

/**
 * Which Claude Code surfaces this machine has, for labelling. Both read the
 * same config, so this describes reach — it never changes what gets written.
 */
export function claudeCodeSurfaces(): string[] {
  const surfaces: string[] = []
  if (fs.existsSync(path.join(os.homedir(), ".claude"))) surfaces.push("CLI")
  if (hasClaudeCodeDesktop()) surfaces.push("Desktop")
  // The app is installed but its Code tab has never been opened. The engine is
  // downloaded on first use, so the surface is still there to configure for.
  else if (isClaudeAppInstalled()) surfaces.push("Desktop")
  return surfaces
}
