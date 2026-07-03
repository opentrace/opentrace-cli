#!/usr/bin/env bash
# UserPromptSubmit hook: when the prompt looks like an architecture, dependency,
# or impact question, remind the model that the OpenTrace MCP tools can help.
# Prints {} for silent pass-through otherwise.
set -euo pipefail

payload=$(cat)

if command -v jq >/dev/null 2>&1; then
  text=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null || true)
else
  # Without jq, match against the raw payload; good enough for an advisory nudge.
  text=$payload
fi

if printf '%s' "$text" | grep -qiE 'architect|dependenc|upstream|downstream|impact|blast radius|call graph|who calls|cross-repo|other repo|outage|incident|root cause'; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "This prompt may concern architecture or dependencies. The OpenTrace MCP tools can help: graph.search finds the component in an indexed workspace graph, graph.explore_focused_subgraph shows its neighborhood, and source.load reads the underlying code. Call workspaces.list first if you do not yet have a workspace_id."
  }
}
JSON
else
  echo '{}'
fi
