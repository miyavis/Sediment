# Sediment

[English](README.md) | [Chinese](README.zh-CN.md)

> **Local, controllable AI write auditing for your knowledge vault.**
> Every write an agent makes into your notes can be approved, rolled back, and traced.

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.8.7%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v1.2.0-blue.svg)](https://github.com/miyavis/Sediment/releases)

Sediment is a local-first Obsidian plugin and MCP server for people who let AI agents write into their knowledge base — and want **evidence, not vibes**. Agent writes become pending proposals with a frozen preview; your approval is bound to the content by a hash; after acceptance the change stays in a persistent, searchable timeline with snapshots and decisions. Nothing is uploaded, and no shell command is ever executed.

![Agent workshop, pending writes and change timeline](assets/agent-workshop-timeline.png)

![Today view with local API and per-client call status](assets/today-connection-status.png)

![Pending write diff before approval](assets/pending-write-diff.png)

## Why another Obsidian plugin?

Most tools in this space solve a different problem:

| Tool | What it does | Write governance |
| --- | --- | --- |
| Copilot for Obsidian | Agent container, chat, autocomplete | Permission tiers and a session diff — its docs call it a *review aid, not a complete audit*: shell changes are not recorded, a revoke is not sent back to the agent, and the diff is lost on restart |
| MCP bridges (mcp-obsidian, local-rest-api) | Vault access over MCP/HTTP | Authentication and optimistic locking, but no approval queue, diff, rollback, or provenance |
| Smart Connections / Tracker / Heatmap Calendar | Semantic search and statistics | Read-only; no write path |
| Notion AI / Capacities | Cloud AI knowledge work | Approval previews exist, but no local model and no vault-level audit trail |

Sediment is built for the gap: **a durable, local, auditable write workflow**. If an agent writes into your vault, you can answer later *who wrote what, when, under which approval, and what the previous version was*.

## Core: the write audit loop

1. **Gate** — path denylist/allowlist, per-operation switches, four work modes (read-only / draft / confirm / auto).
2. **Hold** — in confirm mode the write is frozen: request, `before`/`after` preview, and a SHA-256 hash of `before`. Nothing lands yet.
3. **Verify** — at approval time the target is re-read; if it was modified or created in the meantime, approval is refused (`CONTENT_CHANGED`). This closes the "approve A, write B" race.
4. **Decide** — accept (replay through the same guarded write path) or reject (drop the pending call and its audit row).
5. **Record** — a snapshot, a review decision with timestamp, and a timeline event persist in `data.json`; bridge submissions also get a `decisions/<id>.json` the agent can poll.

The result is a chain: **MCP call → pending write → approval → snapshot → timeline**, all local.

## Change timeline

The workshop shows a searchable timeline of agent activity: agent name, timestamp, tool, target path, content hash, approval decision, and snapshot id. Events from tool calls, pending writes, review decisions, and bridge decisions are merged into one view.

- Filter by agent, operation, or time.
- Export an audit bundle (JSON/CSV) with redaction by default.
- Read it from an agent with the `get_change_timeline` MCP tool.

## Network and file access

- The optional local Agent API is off by default and listens on `127.0.0.1` only; requests require the token shown in settings.
- Optional semantic search targets an Ollama endpoint (local loopback by default) and falls back to TF-IDF when unavailable.
- "Configure agent clients" reads and writes MCP configuration files **outside the vault**, under your user home or `%APPDATA%` (for example `~/.claude.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.jsonc`). It only adds or removes the Sediment entry.
- Direct filesystem access uses Node's `fs` only for those MCP config files, the plugin's own `mcp-server/index.mjs`, and note snapshots under `.obsidian/plugins/sediment/backups/`. **The plugin never runs shell commands.**
- Dashboard statistics enumerate in-vault note paths and metadata locally; no note content or path list is uploaded.
- Agent call statistics are aggregated and stored locally in `data.json`; never uploaded.
- No telemetry, no cloud upload, no self-update, no advertising.

See `examples/SECURE-AGENT-SETUP.md` for the threat model and recommended settings.

## Supporting views

These exist to feed and explain the audit workflow, not to compete with dedicated single-purpose plugins:

- Writing statistics, heatmap, contribution trend, and knowledge strata — a local, explainable view of where time went.
- Quick memos with daily-note double write and source-line anchors.
- Weekly review generation, task scanning, and health checks.
- A pomodoro timer and monthly poster export (experimental, off by default).

Contribution score (weights and daily cap configurable):

```text
score = notes created × 2 + editing sessions + tasks completed
      + floor(words added / 100)
      + floor(focus minutes / 25)
```

It is a supporting metric, not a measure of knowledge quality.

## Install

### BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Choose **Add Beta plugin**.
3. Enter `miyavis/Sediment`.
4. Enable Sediment under **Community plugins**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/miyavis/Sediment/releases).
2. Copy them into `<vault>/.obsidian/plugins/sediment/`.
3. Enable Sediment under **Settings → Community plugins**.

Releases contain only the three files Obsidian installs, with GitHub build provenance attestations. The MCP bridge is written into the plugin folder's `mcp-server/` directory when you configure agent clients, so a BRAT install without that folder is expected.

`.obsidian` is a hidden folder at the vault root, not in this repository. On Windows, enable hidden items in Explorer or paste `<vault>\.obsidian\plugins\sediment` into the address bar. On macOS, press `Cmd + Shift + .` in Finder. On Linux, press `Ctrl + H`.

## Agent integration

```text
Claude Code / OpenCode / Qoder / Cursor / Claude Desktop
        │ MCP stdio
        ▼
mcp-server/index.mjs
        │ HTTP + Bearer token
        ▼
127.0.0.1:27123
```

Setup:

1. Enable the local Agent API in settings.
2. Keep the generated access token.
3. Use **Configure agent clients**, or copy a snippet from [`examples/`](./examples/).
4. Restart the client.
5. Set the work mode to **Confirm before write** to get the full audit loop.

The public MCP surface is **14 task-oriented tools** (read-only additions do not change `AGENT_API_VERSION = 1`):

- Context: `get_daily_context`, `get_active_context`
- Search and read: `search_notes`, `list_notes`, `read_note`
- Write: `write_note`, `patch_note`
- Deposition: `add_memo`, `add_knowledge`, `record_work_log`
- Tasks: `manage_tasks`
- Changes: `manage_changes`
- Audit: `get_change_timeline`
- Read-only workspace state: `get_workspace_state`

See [`examples/SECURE-AGENT-SETUP.md`](./examples/SECURE-AGENT-SETUP.md) and the per-client snippets in `examples/`.

### File bridge (non-MCP agents, experimental)

Off by default. When enabled, the plugin creates `proposals/` and `decisions/` under `.obsidian/plugins/sediment/bridge/`. Any agent that can write files may submit a proposal; proposals only enter the pending queue and are written after you accept them. Each file is limited to 256 KB; only `write_note`, `patch_note`, and `add_knowledge` are supported.

After a decision, `decisions/<id>.json` is written for the agent to poll:

```json
{
  "version": 1,
  "id": "demo-1",
  "pendingId": "bridge-demo-1",
  "decision": "approved",
  "reason": "user_approved",
  "time": "2026-11-21T10:00:00.000Z"
}
```

Existing decisions are never overwritten, so resend with a new id.

Security boundaries:

- The local server listens on `127.0.0.1` only; requests without a valid token are rejected.
- `.obsidian/` and `.git/` are always blocked.
- Blocked folders and tags cannot be read, written, or searched.
- High-risk operations can be reviewed with snapshots, diffs, and restore points.
- No shell execution, no cloud upload.

## Data and recovery

- Main data: `.obsidian/plugins/sediment/data.json`
- Default folders live under `Sediment/` in the vault: `daily`, `reviews`, `agent-logs`, `knowledge`, `backups`
- "Migrate legacy folders" in settings moves old defaults one file at a time, preserving Obsidian links.
- Unknown data versions or malformed data: writing pauses and a recovery copy is kept.
- Backups and the audit export are local; uninstalling the plugin does not delete normal folders, daily notes, or backups.

When reporting issues, do not include tokens, private note contents, or a full `data.json`.

## Development

```sh
npm install
npm run dev
npm run build
npm test
npm run test:typecheck
npm run lint:eslint
npm run lint:stylelint
npm run test:release
```

- `npm run build` — sync versions/changelog/MCP bridge, type-check, bundle `main.js`, and package `dist/sediment/`
- `npm test` — i18n lint, unit tests, MCP smoke test
- `npm run test:release` — verify version, changelog, and release artifacts

**One version source**: `version` in `package.json`. `scripts/version-bump.mjs` syncs it to `package-lock.json`, `manifest.json`, `versions.json`, the MCP `serverInfo`, and both README badges. Generated files are normalized to LF so builds are reproducible across Windows and Linux.

```text
src/                 plugin entry, data, agent, timeline, UI
tests/               unit suites (tests/suites/) + shared helpers
scripts/             build sync, tests, and release verification
examples/            agent client setup snippets and threat model
mcp-server/          MCP stdio bridge
.github/workflows/   CI and release
```

## Known limitations

- Desktop-only: client setup, snapshots, and uninstall use Node's filesystem (`isDesktopOnly` is set).
- Semantic search uses local TF-IDF by default; optional local Ollama embeddings are loopback-only with automatic fallback.
- The timeline is bounded by the retained tool-call log (500 entries) and snapshot index (200); export regularly if you need a permanent record.
- Agent approval is a workflow aid, not a cryptographic guarantee: an agent with direct filesystem access outside Sediment can still edit notes. Keep the vault in a trusted environment and review the threat model in `examples/SECURE-AGENT-SETUP.md`.

## Changelog and license

See [CHANGELOG.md](./CHANGELOG.md). Release and compatibility notes are on the [Releases](https://github.com/miyavis/Sediment/releases) page.

MIT © miyavis &lt;miyavis521@gmail.com&gt;
