# Sediment

[English](README.md) | [Chinese](README.zh-CN.md)

Sediment is a local-first Obsidian plugin that turns daily work into a personal knowledge stratum: writing statistics, heatmaps, quick memos, periodic reviews, and controlled agent collaboration in one workflow.

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.8.7%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v1.0.11-blue.svg)](https://github.com/miyavis/Sediment/releases)

## What it does

| Area | Highlights |
| --- | --- |
| **Today** | Daily goal, quick memos, pomodoro, local tasks, and agent activity |
| **Knowledge** | Heatmaps, writing trends, focus distribution, yearly profile, and periodic reviews |
| **Agent** | Draft review, task claiming, change review, snapshot restore, and work logs |

Three layout densities are available: compact, standard, and full. The plugin is desktop-only (`isDesktopOnly`), because agent client setup, snapshots, and uninstall rely on Node's filesystem access.

## Network and file access

- The optional local Agent API is off by default and listens on `127.0.0.1` only; requests require the token shown in settings.
- Optional semantic search targets an Ollama endpoint (local loopback by default) and falls back to TF-IDF when it is unavailable.
- "Configure agent clients" reads and writes MCP configuration files **outside the vault**, under your user home or `%APPDATA%` (for example `~/.claude.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.jsonc`). It only adds or removes the Sediment entry; "Uninstall MCP access" removes that entry again.
- Direct filesystem access uses Node's `fs` module only for those MCP configuration files, the plugin's own `mcp-server/index.mjs`, and note snapshots under `.obsidian/plugins/sediment/backups/`. The plugin does not run shell commands.
- Dashboard statistics enumerate in-vault note paths and metadata to build heatmaps, trends, and knowledge health. This is local only: no note content or path list is uploaded.
- Agent call statistics (client name, call counts, last-call time) are aggregated and stored locally in the plugin's `data.json`; they are never uploaded.
- Copy actions write the weekly review or poster text to the system clipboard only when you click the Copy button.
- No telemetry, no cloud upload, no self-update, and no advertising.

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

`.obsidian` is a hidden folder at the vault root, not in this repository. On Windows, enable hidden items in Explorer or paste `<vault>\.obsidian\plugins\sediment` into the address bar. On macOS, press `Cmd + Shift + .` in Finder. On Linux, press `Ctrl + H` or run `ls -a`.

## Features

- **Writing statistics** — words added, editing sessions, notes created, tasks completed, and focus minutes.
- **Quick memos** — Markdown callouts, image attachments, tag filtering, daily recall, similarity browsing, and knowledge deposition.
- **Tasks** — scans native checkboxes in daily notes and notes tagged `#task`/`#todo`; templates and acceptance checklists in knowledge notes are ignored. Tasks can be delegated to an agent and linked back to the source note and line.
- **Weekly review** — conclusions, unfinished items, knowledge output, next actions, and detailed charts.
- **Agent drafts** — keep source references; accept, merge, reject, or restore.
- **Local data** — core data lives in `.obsidian/plugins/sediment/data.json`; in-vault backup and redacted export are supported.
- **Interface** — Chinese and English, light and dark themes, narrow layouts, reduced motion, and layout density.

Contribution score:

```text
score = notes created × 2 + editing sessions + tasks completed
      + floor(words added / 100)
      + floor(focus minutes / 25)
```

Weights and the daily cap are configurable. The score is a supporting metric, not a measure of knowledge quality.

## Commands

- Open the knowledge dashboard
- Open the memo panel
- Add a memo
- Generate this week's review
- Record today's leftover tasks to the daily note
- Back up statistics into the vault
- Export today's report image
- View diagnostic logs
- Uninstall MCP access
- View changelog

## Settings

- Daily note folder, filename format, and memo section heading
- Review folder, work log folder, and knowledge folder
- Heatmap metric, editing-session tracking, writing goal, and contribution formula
- Agent blocked folders/tags, allowlist, and per-operation permissions
- Snapshot before modification, in-vault backup folder, and retention count
- Layout density, art style, language, and reduced motion
- Local Agent API port and token

Agent work modes:

| Mode | Effect |
| --- | --- |
| Read-only | Search and read within allowed paths |
| Draft | Create drafts without modifying existing notes |
| Confirm before write | Preview and confirm writes, with snapshots |
| Auto | Execute only within explicitly allowed operations |

Per-operation switches remain hard limits in every mode.

## Agent integration

Agents can connect through the in-plugin API, the local HTTP API, or the MCP stdio bridge.

```text
OpenCode / Qoder / Claude Code / Cursor
        │ MCP stdio
        ▼
mcp-server/index.mjs
        │ HTTP
        ▼
127.0.0.1:27123
```

Setup:

1. Enable the local Agent API in settings.
2. Keep the generated access token.
3. Use "Configure agent clients", or copy the JSON snippet.
4. Restart the client.

OpenCode example (replace `<vault>` with your vault root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sediment": {
      "type": "local",
      "command": ["node", "<vault>/.obsidian/plugins/sediment/mcp-server/index.mjs"],
      "environment": {
        "SEDIMENT_URL": "http://127.0.0.1:27123",
        "SEDIMENT_TOKEN": "token from settings",
        "AGENT_NAME": "opencode"
      },
      "enabled": true
    }
  }
}
```

The public MCP surface is 13 task-oriented tools covering context, search, notes, memos, knowledge deposition, tasks, change review, and read-only workspace state. Older fine-grained tool names were removed without compatibility aliases.

Main entry points:

- Context: `get_daily_context`, `get_active_context`
- Search and read: `search_notes`, `list_notes`, `read_note`
- Write: `write_note`, `patch_note`
- Deposition: `add_memo`, `add_knowledge`, `record_work_log`
- Tasks: `manage_tasks`
- Changes: `manage_changes`
- Read-only workspace state: `get_workspace_state` (statistics, graph, pomodoro, weekly review, tool activity, work logs, categories)

### File bridge (non-MCP agents, experimental)

Off by default. When enabled under **Settings → Agent access (local HTTP / MCP)**, the plugin creates `proposals/` and `decisions/` under `.obsidian/plugins/sediment/bridge/`. Any agent that can write files may submit a proposal; proposals only enter the workshop's pending queue and are written only after the user accepts them.

`proposals/<id>.json` (`<id>` is 1–64 characters from `[A-Za-z0-9._-]`, starting with a letter or digit):

```json
{
  "version": 1,
  "agent": "opencode",
  "tool": "write_note",
  "args": { "path": "Sediment/knowledge/example.md", "content": "# Example", "mode": "create" },
  "note": "why this note"
}
```

Only `write_note`, `patch_note`, and `add_knowledge` are supported; `args.input` for the latter two matches the MCP tool of the same name. Each file is limited to 256 KB.

After acceptance or rejection, the plugin writes `decisions/<id>.json`:

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

Agents can poll `decisions/<id>.json` for the result. Proposals are never applied automatically; imports still obey blocked folders/tags, the allowlist, and operation switches. Existing decisions are never overwritten, so resend with a new id.

Security boundaries:

- The local server listens on `127.0.0.1` only.
- Requests without a valid token are rejected.
- `.obsidian/` and `.git/` are always blocked.
- Blocked folders and tags cannot be read, written, or searched.
- High-risk operations can be reviewed with snapshots, diffs, and restore points.

The complete tool list is available through MCP `tools/list`.

**API version**: `AGENT_API_VERSION = 1` (`/health` returns `agentApiVersion`). The version increments when tool names or parameter shapes change; within one version, existing tools are not removed or renamed.

## Data and recovery

- Main data: `.obsidian/plugins/sediment/data.json`
- Daily notes: determined by the daily note folder and filename format
- Default folders live under `Sediment/` in the vault: `Sediment/daily`, `Sediment/reviews`, `Sediment/agent-logs`, `Sediment/knowledge`, `Sediment/backups`
- Upgrading from the old defaults (`daily` / `reviews` / `agent-logs` / `knowledge` / `sediment-backup`) can be done with "Migrate legacy folders" in settings; files are moved one by one with Obsidian links preserved
- Unknown data versions or malformed data: writing pauses and a recovery copy is kept
- Uninstalling the plugin does not delete normal folders, daily notes, or backups in the vault

Back up statistics into the vault before upgrading. When reporting issues, do not include tokens, private note contents, or a full `data.json`.

## Development

```sh
npm install
npm run dev
npm run build
npm test
npm run test:release
```

- `npm run build` — sync versions/docs/MCP bridge, type-check, and generate `main.js`
- `npm test` — unit tests and MCP smoke test
- `npm run test:release` — verify version, changelog, and release artifacts

**One version source**: `version` in `package.json`. During the build, `version-bump.mjs` syncs it to `package-lock.json`, `manifest.json`, `versions.json`, the MCP `serverInfo`, and the version badges in both READMEs. Release flow:

```sh
npm run release:prepare -- 1.0.5   # finalize [Unreleased] in CHANGELOG and bump package.json
npm run build                      # sync everything and generate dist/sediment
git add -A
git commit -m "release: 1.0.5"
git tag 1.0.5                      # must match manifest.version exactly, without "v"
git push origin main --tags
```

Community directory releases require a tag identical to `manifest.json`'s `version`, without a `v` prefix. Tags with `v` still trigger the release workflow but must not be used for community submissions.

Project layout:

```text
src/                 plugin entry, data, statistics, agent, UI
tests/               unit tests and Obsidian stubs
scripts/             build sync, tests, and release verification
mcp-server/          MCP stdio bridge
.github/workflows/   CI and release
```

## Known limitations

- No cloud authorization or cloud sync; core content is never uploaded.
- Semantic search uses local TF-IDF by default; optional local Ollama embeddings (loopback only, automatic TF-IDF fallback) are supported.
- Desktop-only: the plugin uses Node's filesystem for client setup, snapshots, and uninstall; `isDesktopOnly` is set.
- Migration and large-vault performance still need continuous benchmark validation.

## Changelog and license

See [CHANGELOG.md](./CHANGELOG.md). Release and compatibility notes are on the [Releases](https://github.com/miyavis/Sediment/releases) page.

MIT © miyavis &lt;miyavis521@gmail.com&gt;
