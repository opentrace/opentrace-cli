#!/usr/bin/env bash
# SessionStart hook: prewarm OpenTrace for this checkout (bin/prewarm.cjs) —
# resolve the repo to a source_id, inject environment/workspace slugs, the
# indexed commit, and freshness vs. the local HEAD, so the model's first
# OpenTrace call needs no discovery hops. Falls back to static guidance when
# node is unavailable or prewarm cannot run. Must print valid JSON to stdout.
set -uo pipefail

payload=$(cat 2>/dev/null || true)

if command -v node >/dev/null 2>&1; then
  if out=$(printf '%s' "$payload" | node "${CLAUDE_PLUGIN_ROOT}/bin/prewarm.cjs" 2>/dev/null) && [ -n "$out" ]; then
    printf '%s' "$out"
    exit 0
  fi
fi

# Static fallback: same routing guidance prewarm emits, minus the binding.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You have access to OpenTrace, an MCP server that serves code graphs for the repositories (\"sources\") your organization has indexed across its workspaces.\n\nRouting: Read/Grep/Glob remain best for files you already have open or whose paths you know. Prefer OpenTrace for existence, structure, and architecture questions — including in this checkout when the index covers it: one graph_search covers the entire indexed snapshot and an empty result is a bounded negative (absent at the indexed commit), which repeated greps cannot establish; graph_get_repo_overview maps an unfamiliar subsystem in one call. If two greps in a row come back empty, switch to graph_search rather than trying a third pattern.\n\nWorkflow: (1) workspaces_list and pick the workspace matching the request, then pass its environment_slug and workspace_slug to every workspace-scoped call; (2) resolve a repository with graph_resolve_code_source (or enumerate with graph_list_code_sources) to get a source_id; (3) pass that source_id to graph_search and graph_get_repo_overview, deepen with graph_explore_focused_subgraph, and read code with source_load using load_ref values from earlier results; (4) for pull/merge requests use change_requests_list or change_requests_search, then change_requests_read for bounded detail; (5) if results look thin or possibly stale, call source_get_context for remote-head and latest-commit context. Briefly tell the user when you are about to use OpenTrace and what you are looking for."
  },
  "systemMessage": "OpenTrace is active — workspace code graphs are available."
}
JSON
