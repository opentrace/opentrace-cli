#!/usr/bin/env bash
# SessionStart hook: inject context describing the OpenTrace MCP server so the
# model knows when and how to reach for it. Static output — reads nothing from
# the payload. Must print valid JSON to stdout.
set -euo pipefail

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You have access to OpenTrace, an MCP server that serves code graphs for the workspaces your organization has indexed. Use your local tools (Read, Grep, Glob) for anything in the current checkout. Use OpenTrace when a question concerns an indexed workspace — especially code that is not checked out locally — or for architecture, dependency, and impact questions that span repositories.\n\nFive tools are available: workspaces.list and environments.list (discovery), graph.search (find symbols, files, and dependencies in a workspace graph), graph.explore_focused_subgraph (explore the graph neighborhood around one symbol), and source.load (load bounded source text for a load_ref returned by the graph tools).\n\nWorkflow: (1) call workspaces.list and pick the workspace matching the user's request; (2) remember its workspace_id and pass it to every graph and source call; (3) start with graph.search, deepen with graph.explore_focused_subgraph on promising symbols, and read the underlying code with source.load using load_ref values from earlier results. Briefly tell the user when you are about to use OpenTrace and what you are looking for."
  },
  "systemMessage": "OpenTrace is active — workspace code graphs are available."
}
JSON
