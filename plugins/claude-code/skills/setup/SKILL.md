---
description: Connect this Claude Code session to OpenTrace, or diagnose why the OpenTrace tools are unavailable. Use when the OpenTrace tools are missing or erroring, when a tool call returns an authentication failure, when OpenTrace returns no workspaces or no indexed repositories, or when the user asks how to set up, connect, sign in to, or point OpenTrace at a different host.
---

# Connecting OpenTrace

The OpenTrace MCP server needs credentials before any of its tools work. A fresh install has none, so the first tool call fails until the user signs in. Walk them through it.

Work out which state they are in before suggesting a fix — the remedies are different and guessing wastes their time.

## Step 1 — check whether the server is connected

Ask the user to run `/mcp` and report what the `opentrace` entry says. The plugin registers its server under the scoped name `plugin:opentrace:opentrace`, so that is the row to look for.

| What they see | What it means | Go to |
|---|---|---|
| `connected` | Credentials are in place | Step 4 |
| `needs authentication` | Server reachable, not signed in | Step 2 |
| `failed` | Endpoint wrong, or the host is unreachable | Step 3 |
| No `opentrace` row at all | Plugin not enabled, or Claude Code has not reloaded | Step 5 |

## Step 2 — sign in

Two credentials work. Browser sign-in is the better default: nothing is written to disk.

**Browser sign-in (recommended).** In `/mcp`, select `opentrace` and choose to authenticate. This opens a browser for the OpenTrace sign-in and completes the standard MCP OAuth flow. Claude Code holds the resulting token itself.

**API key.** If the user already has an OpenTrace CLI key (`otk_…`), they can attach it instead from a terminal:

```bash
npx -y @opentrace/cli@latest connect otk_…
```

Pin `@latest` — without it npx may reuse an older cached build.

That writes the key to `~/.claude/opentrace-plugin.token`, which the plugin reads at connection time. It also enables the session-start prewarm described in Step 6, which browser sign-in cannot do because it leaves no key on disk.

Tell the user which one you are recommending and why, rather than listing both and leaving them to choose.

## Step 3 — check the endpoint

The plugin's `mcp_url` config option defaults to the hosted OpenTrace API and needs no change for normal use. It only matters if the user is pointing at a self-hosted, dev, or local OpenTrace.

Claude Code prompts for this value when the plugin is enabled and stores it per user, so it is changed through the plugin config UI (`/plugin`, select `opentrace`), not by editing files. `otx install --url <host>` also seeds it.

A `failed` status with a default endpoint usually means the network is blocking the API rather than that anything is misconfigured — check that before touching the config.

## Step 4 — verify it actually works

Do not tell the user setup is complete without a successful call. Run:

```
workspaces_list
```

- **Returns workspaces** — setup is done. Name one of them back to the user so they can see it found the right account.
- **Returns an empty list** — the credentials are valid but the account has no workspace the user can reach. This is an OpenTrace account or permissions question, not a Claude Code one. Point them at their OpenTrace administrator.
- **Authentication error** — the credential was rejected. If they attached a key, it may be revoked or belong to a different host; try browser sign-in instead.

Then confirm there is something indexed, since the graph tools have nothing to answer from otherwise. Pick a workspace and pass its `environment_slug` and `workspace_slug` to:

```
graph_list_code_sources
```

An empty result means no repository has been indexed yet. Say so plainly — this is the one failure that looks identical to a broken connector, and users reasonably assume the plugin is at fault.

## Step 5 — plugin not loaded

If `/mcp` shows no `opentrace` row, the plugin itself is not active. Check `/plugin` for the OpenTrace entry and whether it is enabled, and look at the **Errors** tab for a load failure. If it was just installed or enabled, the install summary may have asked for `/reload-plugins` — config is read at session start, so an enable mid-session does not take effect until then.

## Step 6 — what to expect afterwards

Once connected, the plugin resolves the current checkout against OpenTrace at session start and reports which indexed repository it maps to, along with how far the index sits behind the local `HEAD`. This needs the API key from Step 2; a browser-only install skips it and falls back to general guidance, which is expected and not a fault.

If the graph answers look thin or out of date, the index is behind the working tree rather than wrong. `source_get_context` reports freshness for a source, and that is the honest thing to show the user instead of retrying the same search.
