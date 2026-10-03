# dsh-native-codex-cli — drive Codex from DSH's chat interface

**English** · [简体中文](README.md)

DSH owns the chat interface; **the Codex CLI owns task execution and native thread history**. Whatever you type in DSH is handed to Codex's `turn/start` **verbatim** — no second AI paraphrases it, summarises it, or replays a chat archive to fake continuity. Every character rendered in the UI comes from Codex's own protocol frames.

```
DSH Web GUI (this plugin's client half)
   │  POST /dsh-native-codex-cli/rpc       ← request/response
   │  GET  /dsh-native-codex-cli/events    ← SSE: streaming output / approvals / notices
   ▼
this plugin's host half (inside the DSH host process)
   │  newline-delimited JSON-RPC over stdio
   ▼
codex app-server   ←→   native Codex CLI threads (the only source of history)
```

---

## 1. Where each requirement lives

| # | Requirement | Implementation | Code |
|---|-------------|----------------|------|
| 1 | Open an old conversation: list threads, read and restore the selected one | `thread/list` (search/paging) + `thread/resume` | `lib/bridge.js` `listThreads` / `attachThread` / `hydrateHistory` |
| 2 | New task: create a native thread with cwd / model / permission | `thread/start` (`cwd` / `model` / `approvalPolicy` / `sandbox`); the pickers are fed by `model/list` and `permissionProfile/list` | `createThread`, `listModels`, `listPermissionProfiles` |
| 3 | Send a message straight into Codex's turn | `turn/start`, text forwarded verbatim as `input:[{type:"text",text}]`; follow-ups during a run go through `turn/steer` | `startTurn`, `steerTurn` |
| 4 | Streaming output | `item/started` / `item/completed` build the skeleton; `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/plan/delta` accumulate frame by frame | `_onNotification`, `applyItemDelta` |
| 5 | Tool display | `commandExecution` (command / status / exit code / output / duration), `fileChange` (file list + unified diff), `mcpToolCall` / `dynamicToolCall` / `webSearch` / `functionCallOutput`, plus `error` / `warning` notices | the `*Item` components in `client/client.js` |
| 6 | Stop a task | `turn/interrupt` (a real interrupt, not a stopped animation); pending approval requests are refused first so the interrupt is not queued behind an unanswered prompt | `interruptTurn` |
| 7 | Approvals and questions | server requests → UI cards → the choice is sent back: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` | `_onServerRequest`, `buildApprovalResponse`, `ApprovalCard` / `QuestionCard` |
| 8 | Refresh and restart | the session⇄thread association is persisted to `~/.dsh/storages/dsh-native-codex-cli/bindings.json`; `clientMessageId` makes resends idempotent; SSE reconnects and re-reads a snapshot; a restarted app-server is handled by an automatic `thread/resume` retry | `lib/bindings.js`, the dedupe in `startTurn`, `connectEvents` |

---

## 2. Where it appears in the UI

Installing adds six seats, all through DSH's official Slot extension points — nothing in DSH's own UI is replaced:

| Slot | Purpose |
|------|---------|
| `main[codex]` + `sidebar.panellist[codex]` | A **Codex** icon in the sidebar opening a standalone workspace: thread list / search / new task (cwd, model, approval policy, sandbox) / transcript / composer / stop button / rename / restart Codex |
| `conversation.view[codex]` | A **Codex** view beside "Chat" and "Trajectory" in an ordinary DSH session |
| `conversation.composer` | Once a session is bound, **takes over that session's composer**: every later message goes straight to Codex |
| `conversation.input.right[codex]` | A **Codex** button in the native composer that hands the current draft to Codex (it highlights when the draft starts with `@codex`) |
| `conversation.input.dock[codex]` | The Codex transcript plus its context (directory / model / approval / sandbox) rendered directly **above the composer**, so the conversation is on the main page without clicking a tab |

### `@codex` semantics

Chosen deliberately as a **takeover**:

1. Type `@codex <task>` in a session (or press the Codex button next to the composer) — that session is bound to a Codex thread and the task is dispatched;
2. From then on **that session's composer is taken over by Codex**: later messages need no `@codex`, they all go straight to Codex;
3. To hand the session back, press **"交还 DSH" / Hand back to DSH** above the composer (the Codex thread is kept, and re-taking the session resumes it).

The mention is case-insensitive and also accepts the full-width `＠` a CJK IME produces. Other per-session controls: **New thread** (start a fresh Codex thread for this session), **Unbind** (forget the association entirely).

---

## 3. Configuration

Configuration is a JSON file (**not** a `config:` block in `cordis.patch.yml`):

```
~/.dsh/storages/dsh-native-codex-cli/config.json
```

```json
{
  "codexBin": "codex",              // Codex executable; `codex` resolves from PATH
  "codexArgs": [],                  // extra argv appended after `app-server`
  "transport": "stdio",             // stdio (implemented); daemon is a reserved adapter
  "experimentalApi": true,          // opt into experimental app-server methods and fields
  "approvalPolicy": "on-request",   // default approval policy for new threads
  "sandbox": "workspace-write",     // default sandbox for new threads
  "model": "",                      // default model; empty = Codex's own default
  "traceWire": false                // log every protocol frame to the plugin log
}
```

A missing or malformed file falls back to the in-code defaults and never blocks startup.

> **Why not a patch `config:`?** cordis' `resolveConfig` validates an entry's patch config against the plugin's exported `Config` **schema**:
> ```js
> function resolveConfig(runtime, config) {
>   if (!runtime.Config) return config
>   const result = runtime.Config["~standard"].validate(config)   // ←
>   ...
> }
> ```
> No schema library is resolvable from a pnpm-isolated profile package, and exporting a plain default-value object as `Config` (or supplying a patch config without a schema) fails activation with `TypeError: Cannot read properties of undefined (reading 'validate')` — `apply()` never runs. This plugin therefore exports no `Config` and its patch carries no config, exactly like the shipped third-party plugins.

Plugin log: `~/.dsh/logs/dsh-native-codex-cli.log`, or `GET /dsh-native-codex-cli/log` for the last 300 lines. The client half posts its own diagnostics (slot registrations, composer hook shapes) to `/dsh-native-codex-cli/diag`, which lands in the same file.

---

## 4. Install / uninstall

### From GitHub (recommended)

```bash
dsh plugin --profile desktop add git+https://github.com/447662/dsh-native-codex-cli.git
```

Then **restart DSH**. `dsh plugin add` writes the package into the profile's `dependencies` and `dsh.profile.bundles`, and the plugin's own `cordis.patch.yml` inserts itself into the loader tree.

> **A restart is required**: a profile's bundle list is not hot-reloaded, and `plugin-manager`'s enable/disable only flips an entry's `disabled` bit — it does not re-import the module.

### From a local clone (development)

```powershell
git clone https://github.com/447662/dsh-native-codex-cli.git <repo-path>

# 1) let the profile resolve the package (a junction is equivalent to pnpm link)
New-Item -ItemType Junction -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-native-codex-cli" -Target "<repo-path>"

# 2) in the profile's package.json add:
#    dependencies."dsh-native-codex-cli" = "link:<repo-path>"
#    dsh.profile.bundles      += "dsh-native-codex-cli"
#    do NOT add a config for dsh-native-codex-cli in cordis.patch.yml (see section 3)
```

### Uninstall

```powershell
# remove dsh-native-codex-cli from the profile's dsh.profile.bundles and dependencies,
# drop the junction (or `dsh plugin --profile desktop remove dsh-native-codex-cli`), then restart DSH.
Remove-Item "$env:DSH_PROFILE_DIR\node_modules\dsh-native-codex-cli" -Force
```

Both halves are **failure-safe**: the host half hard-depends on nothing (if `ctx.inject` cannot reach `webServer` it only logs), the client half wraps every slot registration in its own try/catch, and **no Codex process is spawned at load time** (the first call starts it).

### Troubleshooting "the plugin did not load"

Work down this list; each step identifies exactly one layer:

1. `[boot] module imported` in `~/.dsh/logs/dsh-native-codex-cli.log` → the module resolved. Absent → package name / `exports` resolution failed.
2. `[boot]` present but no `[host] dsh-native-codex-cli host loaded` → the entry was created but **did not activate**; on this host that is almost always the `Config` schema issue from section 3.
3. `[host]` present but no `[routes] routes mounted` → the `webServer` service was not available.
4. All three present but `POST /dsh-native-codex-cli/rpc` still 404s → the routes registered on a different web-server instance.

### The panel says "Codex CLI not found"

**Since v0.2.1 this is only a message — it does not take DSH down** (older versions killed the host process; see the note below).

The plugin does **not** rely on `PATH` alone. It searches:

| Platform | Locations, in order |
|----------|--------------------|
| Windows | `PATH` → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (**the CLI bundled with the desktop app**) → `%LOCALAPPDATA%\OpenAI\Codex\bin` → `%ProgramFiles%\OpenAI\Codex\bin` → `%APPDATA%\npm` → `%LOCALAPPDATA%\pnpm` → `~/.codex/packages/standalone/current/bin`, `~/.codex/bin`, `~/.codex/plugins/.plugin-appserver` |
| macOS / Linux | `PATH` → `~/.codex/packages/standalone/current/bin` → `~/.codex/bin` → `~/.local/bin` → `/usr/local/bin` → `/opt/homebrew/bin` → `/usr/bin` |

> Why the search is necessary: **DSH is an Electron app**. The Codex desktop installer registers the CLI directory in the *user* environment, but a process that is already running — or one started by `explorer.exe`, which keeps the environment it had at logon — never sees it. So "Codex is installed" and "Codex is missing" looked identical.

If it still cannot find the CLI, the error lists **every directory that was searched**. Then:

1. Confirm `codex --version` works in a terminal;
2. Or hard-code the path: set `"codexBin": "C:\\Users\\<you>\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"` in `~/.dsh/storages/dsh-native-codex-cli/config.json`.

`codexBin` accepts either form: a **full path** is used verbatim (never silently swapped for a different binary), while a **bare name** (such as `codex`) is searched for in the locations above.

> Historical bug: in 0.2.0 and earlier a spawn failure called `emit('error')`, and `EventEmitter` **rethrows synchronously** when no `error` listener is attached — out of reach of the route's `try/catch`, so the whole DSH host exited and the app would not start. Fixed in v0.2.1 and guarded by `test/spawn-failure-check.mjs` in CI.

---

## 5. Self-checks

`npm run check` runs all four; none of them needs DSH or a browser (just Node 18+ and a logged-in Codex CLI):

```bash
npm run check          # everything
npm run check:utf8     # every tracked file is clean UTF-8
npm run check:load     # load-time self-check (seconds)
npm run check:smoke    # protocol-level end to end (spawns a real codex app-server, minutes)
npm run check:http     # HTTP boundary
```

| Script | Coverage |
|--------|----------|
| `tools/check-utf8.mjs` | no file is non-UTF-8 or BOM-prefixed — a Windows shell round-trip once read these UTF-8 sources as GBK and silently destroyed every Chinese character in the README |
| `test/load-check.mjs` | client bundle preamble, the six slot declarations, composer selector purity, host route mounting, `/codex` command shape, **session-mirror event shapes**, **the Markdown renderer** |
| `test/smoke-bridge.mjs` | spawns a real `codex app-server` and covers requirements 1–8: thread list / create (cwd + permissions) / submit turn / streaming deltas / command and file-change items / a real interrupt / **a real approval round-trip** / dedupe and history restore |
| `test/http-check.mjs` | the exact surface the browser uses: `POST /dsh-native-codex-cli/rpc` + `GET /dsh-native-codex-cli/events` (SSE) |

Current results: **load-check green / smoke-bridge 25/25 / http-check 22/22**.

### Maintenance tooling

- [`docs/CODEX_PROTOCOL.md`](docs/CODEX_PROTOCOL.md) — a field-by-field `codex app-server` protocol reference
- `tools/asar-extract.mjs` — extract a single file out of DSH's `app.asar` (this is how the loader's activation rules were diagnosed)
- `tools/session-shape.mjs` — decode DSH's `session.v4.jsonl.zstd` and inspect real session-event shapes
- `test/method-map.mjs` / `test/schema-digest.mjs` / `test/schema-def.mjs` — compress `codex app-server generate-json-schema` output into greppable summaries (run `npm run recon:schema` first)

---

## 6. Known limitations

1. **`transport: daemon` is not implemented** (`createDaemonTransport` in `lib/app-server.js` throws rather than silently starting a second Codex instance). Wiring up a shared daemon means implementing that function and reusing the same `LineRpc` — the frames are carrier-independent.
2. **Codex threads are process-scoped**: after an app-server restart an old thread id has to be `thread/resume`d. The plugin retries once automatically when `turn/start` answers `thread not found`.
3. **History comes from `thread/resume` only.** On Codex CLI 0.153.4 `thread/turns/list` answers `list_turns is not supported yet`, and `thread/read` with `includeTurns` fails the same way. The plugin detects this, stops paging, and uses the `resume` payload; the paging code is a dead path that will start working if Codex implements it.
4. **`assistant/message` cannot be written by a plugin.** A real one embeds the provider stream (`usage` / `stream`); without it DSH's session projection throws `Cannot read properties of undefined (reading 'length')` and that session's history stops loading. The session mirror therefore writes only `user/message` plus the turn lifecycle, and Codex's answers are rendered by the main-page dock.
5. **The generated protocol bindings lag the runtime**: 0.153.4 emits fields the bindings do not declare (`canAcceptDirectInput`, `availableDecisions`, …). The plugin reads only what it needs and ignores the rest.
6. **`conversation.input.right`'s `useInput` / `inputActions` shapes are probed at runtime**: after the first load in a real GUI, `~/.dsh/logs/dsh-native-codex-cli.log` contains a `composer-hooks` line with the field names the host actually passes. If they differ for you, adjust the `liveDraft` / clear-draft branches in `ComposerCodexAction` to match that line.
7. **Uploaded images are written to disk** under `~/.dsh/storages/dsh-native-codex-cli/uploads/` and served by `GET /dsh-native-codex-cli/image?p=<path>` (the path is confined to that directory). Files are not cleaned up automatically.
8. `turn/start` returns a **stub** (`itemsView:"notLoaded"`, empty timestamps) and `turn/completed` carries only an `itemsView:"summary"` slice. The mirror is built from `item/started` / `item/completed` / deltas instead.

---

## 7. Contributing

```bash
git clone https://github.com/447662/dsh-native-codex-cli.git
cd dsh-native-codex-cli
npm run check          # all four self-checks should be green
```

Conventions:

- The **host half** (`lib/`) does protocol and state only, and **never** hands task content to a model; user input goes to `turn/start` verbatim.
- The **client half** (`client/client.js`) is a hand-written, single-file module-loader bundle with **no build step**. That only works because the `window.__ModuleLoader__.load({ id, factory })` wrapper and the `module` / `exports` preamble inside the factory are kept — without them the whole bundle throws at load time.
- Every slot registration must go through `slots.inject(slot, …)` behind its own try/catch: DSH declares slots later than the plugin is applied.
- Add assertions to `test/load-check.mjs` for new behaviour (protocol shapes, pure functions, declarations) — it needs neither DSH nor a browser.
- Never edit tracked UTF-8 files with a Windows shell round-trip (`Get-Content` / `Set-Content` without an explicit encoding reads them as the ANSI code page). Use an editor, and `npm run check:utf8` will catch it if you slip.

---

## 8. License

[MIT](LICENSE) © dsh-native-codex-cli contributors

An independent community project, not affiliated with DeepSeek or OpenAI. Codex is an OpenAI product; this plugin merely drives the locally installed CLI through its public `codex app-server` protocol.
