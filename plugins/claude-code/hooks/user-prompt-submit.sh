#!/usr/bin/env bash
# UserPromptSubmit hook: when the prompt looks like an architecture, existence,
# or structure question, remind the model that the OpenTrace tools can answer
# it — with the exact parameters for this checkout when a prewarmed binding is
# cached (bin/prewarm.cjs --prompt-hint: cache-only, never touches the
# network). Prints {} for silent pass-through otherwise.
set -euo pipefail

payload=$(cat)

if command -v jq >/dev/null 2>&1; then
  text=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null || true)
else
  # Without jq, match against the raw payload; good enough for an advisory nudge.
  text=$payload
fi

# Two families of triggers: cross-repo/impact vocabulary (original) and
# in-checkout existence/orientation questions — the highest-value single-repo
# case, where a bounded graph answer beats a series of greps.
if printf '%s' "$text" | grep -qiE 'architect|dependenc|upstream|downstream|impact|blast radius|call graph|who calls|caller|callee|cross-repo|other repo|outage|incident|root cause|where (is|are|does|do|did)|does .* exist|is there (a|an|any)|do we have|how does .* work|entry ?point|subsystem|structure of|map (of|out)|overview of'; then
  if command -v node >/dev/null 2>&1; then
    if out=$(printf '%s' "$payload" | node "${CLAUDE_PLUGIN_ROOT}/bin/prewarm.cjs" --prompt-hint 2>/dev/null) && [ -n "$out" ]; then
      printf '%s' "$out"
      exit 0
    fi
  fi
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "This prompt may concern architecture, dependencies, or code structure. The OpenTrace MCP tools can help: graph_search finds symbols and files across an indexed snapshot (a bounded answer, including definitive negatives), graph_explore_focused_subgraph shows a symbol's neighborhood, and source_load reads the underlying code. Call workspaces_list first if you have not yet picked a workspace (then resolve a source_id with graph_resolve_code_source)."
  }
}
JSON
else
  echo '{}'
fi
