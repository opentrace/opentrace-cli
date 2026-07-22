#!/usr/bin/env bash
# SessionStart hook: inject context describing the OpenTrace MCP server so the
# model knows when and how to reach for it. Static output — reads nothing from
# the payload. Must print valid JSON to stdout.
set -euo pipefail

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You have access to OpenTrace, an MCP server that serves code graphs for the repositories (\"sources\") your organization has indexed across its workspaces. Use your local tools (Read, Grep, Glob) for the current checkout. Use OpenTrace for indexed code that is not checked out locally, or for architecture, dependency, and impact questions that span repositories.\n\nDiscovery tools: workspaces_list and environments_list. Workflow: (1) call workspaces_list and pick the workspace matching the request, then pass its environment_slug and workspace_slug to every workspace-scoped call; (2) resolve a repository with graph_resolve_code_source (or enumerate with graph_list_code_sources) to get a source_id; (3) pass that source_id to graph_search and graph_get_repo_overview, deepen with graph_explore_focused_subgraph, and read code with source_load using load_ref values from earlier results; (4) for pull/merge requests use change_requests_list or change_requests_search, then change_requests_read for bounded detail; (5) if results look thin or possibly stale, call source_get_context for remote-head and latest-commit context. OpenTrace advertises its full, authoritative tool set and usage instructions when it connects. Briefly tell the user when you are about to use OpenTrace and what you are looking for."
  },
  "systemMessage": "OpenTrace is active — workspace code graphs are available."
}
JSON
