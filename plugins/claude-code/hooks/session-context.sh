#!/usr/bin/env bash
# Reports repository + branch for the current work (bin/session-context.cjs), so
# per-pull-request cost is a fact rather than a guess. Claude Code's OTLP export
# names a repository but never a branch, and resolves that repository once at
# launch — so a session that moves between branches, or an orchestrator run
# editing sub-directory repos, reports the wrong thing for its whole life.
#
# Fails open and silent: no node, no git, no network, no token — all print {}.
# Must print valid JSON to stdout, and must never delay the user's prompt.
set -uo pipefail

# Resolve our own directory rather than relying on ${CLAUDE_PLUGIN_ROOT}.
#
# That variable is only set for an INSTALLED plugin. Declared as a plain hook in a
# settings.json — which is how you test this without touching your real configuration,
# and how anyone wiring it by hand would do it — it is unset, and `set -u` aborted the
# script before it ever ran node. The failure is invisible by design: the hook is
# supposed to be silent, so it printed `{}` and reported nothing, for ever.
# Resolved through symlinks, because wiring this by hand usually means linking the wrapper
# somewhere convenient — and the link's own directory holds no ``bin/``, which put us back
# to failing open and reporting nothing.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")/.." && pwd)}"

payload=$(cat 2>/dev/null || true)

if command -v node >/dev/null 2>&1; then
  if out=$(printf '%s' "$payload" | node "${ROOT}/bin/session-context.cjs" 2>/dev/null) && [ -n "$out" ]; then
    printf '%s' "$out"
    exit 0
  fi
fi

echo '{}'
