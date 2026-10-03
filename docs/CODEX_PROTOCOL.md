# Codex app-server protocol reference (CLI 0.153.4)

Implementation-ready wire contract for driving Codex over the `codex app-server` JSON-RPC transport.

**Sources.** Every statement below is grounded in one of:

- `.recon/codex-ts/**` —706 TypeScript bindings from `codex app-server generate-ts` (authoritative for field names and optionality).
- `.recon/codex-schema/**` —JSON Schema from `codex app-server generate-json-schema`, including top-level `ClientRequest.json`, `ServerRequest.json`, `ServerNotification.json`, `ClientNotification.json`, and one schema per method under `v2/`.
- `codex app-server --help` / `daemon --help` / `proxy --help` output from the installed 0.153.4 binary.
- **Live wire capture** from `codex app-server --stdio` on this machine (labelled "observed"). Where the server emits fields the bindings do not declare, that discrepancy is called out explicitly.

The `.recon/` tree is **not checked in** — regenerate it with `npm run recon:schema` (and `npm run recon:digest` / `npm run recon:methods`). Every path mentioned below is relative to that tree.

---

## 1. Transport & framing

### 1.1 Framing

**Newline-delimited JSON (NDJSON).** One complete JSON object per line, terminated by `\n`. There are **no `Content-Length` headers, no `\r\n`-delimited JSON-RPC 2.0 header block, and no length prefixing** —LSP-style framing is not used.

Evidence: a raw probe writing `{"jsonrpc":"2.0","id":1,"method":"initialize",...}\n` to the child's stdin read back exactly one JSON object per line on stdout, with no preamble (observed, `codex app-server --stdio`).

### 1.2 Requests, responses, notifications

Framing is standard JSON-RPC 2.0 *shape* but the server **omits the `"jsonrpc"` member on output** (observed). Send it if you like; the server accepts it. Do not require it when parsing.

Client —server request (expects a response):

```json
{"jsonrpc":"2.0","id":1,"method":"thread/start","params":{ ... }}
```

Success response (observed):

```json
{"id":2,"result":{ "thread": { ... }, "model": "...", ... }}
```

Error response (observed for `thread not found` on `turn/start`):

```json
{"error":{"code":-32600,"message":"thread not found: 01a0fe6c-..."},"id":3}
```

Server —client notification (no `id`, never answered):

```json
{"method":"item/agentMessage/delta","params":{"threadId":"...","turnId":"...","itemId":"msg_...","delta":"I"},"emittedAtMs":1790975286949}
```

Server —client request (has `id`, **must** be answered):

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"...","turnId":"...","itemId":"call_...","startedAtMs":1790975290848,...}}
```

**How to tell requests from notifications on the server→client direction:** the presence of an `id` member. `ServerNotification.json` entries have only `method` (+ `emittedAtMs` on the envelope); `ServerRequest.json` entries always carry `id` plus `params` (`codex-ts/ServerRequest.ts`).

- Request id type: `RequestId = string | number` (`codex-ts/RequestId.ts`, `codex-schema/RequestId.json`). Integer ids are what the server uses; **server-initiated request ids can be `0`** (observed: `"id":0` on `item/commandExecution/requestApproval`).
- Notification params envelope: `ServerNotificationEnvelope` adds an optional `emittedAtMs: number` alongside `method`/`params` (`codex-ts/ServerNotificationEnvelope.ts`). Current servers always populate it; treat as optional.
- Malformed JSON lines / unknown methods: no in-band error contract is documented in the bindings. Do not rely on receiving a reply for every malformed input.

### 1.3 Launching and transports

From `codex app-server --help`:

| Flag | Meaning |
|---|---|
| `--listen <URL>` | `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off` |
| `--stdio` | equivalent to `--listen stdio://` |
| `--ws-auth <MODE>` | `capability-token` \| `signed-bearer-token` (non-loopback websocket listeners) |
| `--ws-token-file`, `--ws-token-sha256`, `--ws-shared-secret-file`, `--ws-issuer`, `--ws-audience`, `--ws-max-clock-skew-seconds` | websocket auth material |
| `-c, --config key=value` | dotted-path config override, value parsed as TOML |
| `--enable/--disable <FEATURE>` | equivalent to `-c features.<name>=true|false` |
| `--code-mode-host <URL>` | connect to a remote code-mode host instead of starting a local one |
| `--strict-config` | error on unrecognized `config.toml` fields |

Subcommands: `daemon`, `proxy`, `generate-ts`, `generate-json-schema`.

- `codex app-server daemon` manages a local daemon: `bootstrap` (durable local management for SSH-driven use), `start`, `restart`, `stop`, `version` (prints CLI and running app-server versions as JSON), `enable-remote-control`, `disable-remote-control`.
- `codex app-server proxy --sock <SOCKET_PATH>` proxies **stdio bytes** to an already-running app-server unix control socket. So a client that speaks stdio to `codex app-server proxy` reaches the daemonized server; framing on your side is unchanged.

**Protocol-visible consequence:** `--listen off` and the `ws://`/`unix://` variants speak the same JSON-RPC message shapes; only the byte carrier differs. A stdio client is portable to `proxy` with no message changes.

---

## 2. Handshake

### 2.1 `initialize` (client —server request)

Params type `InitializeParams` (`codex-schema/v1/InitializeParams.json`, `codex-ts/InitializeParams.ts`):

| Field | Type | Req |
|---|---|---|
| `clientInfo` | `ClientInfo` | **REQ** |
| `capabilities` | `InitializeCapabilities \| null` | opt |

`ClientInfo` (`codex-ts/ClientInfo.ts`): `name: string` (REQ), `version: string` (REQ), `title: string | null` (opt, nullable).

`InitializeCapabilities` (`codex-ts/InitializeCapabilities.ts`):

| Field | Type | Req | Meaning |
|---|---|---|---|
| `experimentalApi` | `boolean` (default `false`) | **REQ** in the TS type | Opt into experimental API methods and fields |
| `requestAttestation` | `boolean` (default `false`) | **REQ** in the TS type | Opt into `attestation/generate` requests for upstream `x-oai-attestation` |
| `mcpServerOpenaiFormElicitation` | `boolean` | opt | Legacy opt-in for the `openai/form` MCP extension; new clients declare `openai/form` in `extensions` |
| `optOutNotificationMethods` | `string[] \| null` | opt | Exact notification method names to suppress on this connection (e.g. `thread/started`) |
| `extensions` | `map<string, JsonValue> \| null` | opt | MCP extension settings declared by the client |

Note the asymmetric optionality: `codex-schema/v1/InitializeParams.json` marks `capabilities` itself optional but, when present, requires both `experimentalApi` and `requestAttestation`. In the observed probe, **omitting `capabilities` entirely works** and the server still emits v2 notifications.

### 2.2 `initialize` result

Type `InitializeResponse` (`codex-schema/v1/InitializeResponse.json`, `codex-ts/InitializeResponse.ts`):

| Field | Type | Description |
|---|---|---|
| `userAgent` | `string` | e.g. `probe/0.153.4 (Windows 10.0.26200; x86_64) unknown (probe; 0.0.1)` (observed) |
| `codexHome` | `AbsolutePathBuf` | Absolute path to the server's `$CODEX_HOME` |
| `platformFamily` | `string` | `"unix"` or `"windows"` |
| `platformOs` | `string` | `"macos"`, `"linux"`, `"windows"` |

### 2.3 Follow-up notification

`ClientNotification` has exactly one member: `{ "method": "initialized" }` —**no params** (`codex-ts/ClientNotification.ts`, `codex-schema/ClientNotification.json`).

**Empirically:** the server accepts and serves `thread/start` **without** an `initialized` notification (observed). Sending `{"method":"initialized"}` immediately after the `initialize` result is nevertheless the contract-prescribed step and costs nothing; do it.

There is no `shutdown`/`exit` method in `ClientRequest.json` —terminate the child process (or close the socket) to end the session.

### 2.4 `experimentalApi` gating

Many method/notification schema descriptions carry an `EXPERIMENTAL` marker (`grep EXPERIMENTAL .recon/codex-schema/v2/*.json`). The set includes `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/turns/list`, `thread/items/list`, `turn/start`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `review/start`, `model/list`'s neighbours such as `apps/*`, `configRequirements/read`, and the `thread/realtime/*` family. `PlanDeltaNotification` is explicitly titled "EXPERIMENTAL - proposed plan streaming deltas".

The **only** opt-in switch is `capabilities.experimentalApi` at `initialize` —there is no per-call flag. Set it to `true` for any client that consumes the thread/turn/item surface.

---

## 3. Thread lifecycle

`ThreadRequest` methods are enumerated in `codex-schema/ClientRequest.json`; thread-lifecycle ones are:
`thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`, `thread/name/set`, `thread/metadata/update`, `thread/compact/start`, `thread/shellCommand`, `thread/approveGuardianDeniedAction`, `thread/rollback`, `thread/revert`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/inject_items`, plus `thread/goal/{set,get,clear}` and `threadSection/*`.

### 3.1 `thread/list`

Params `ThreadListParams` (`codex-schema/v2/ThreadListParams.json`, `codex-ts/v2/ThreadListParams.ts`) —**all optional**:

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string \| null` | opt | Opaque cursor from a previous call |
| `limit` | `uint32 \| null` | opt | Server picks a default |
| `sortKey` | `"created_at" \| "updated_at" \| "recency_at" \| "section_position" \| null` | opt | Defaults to `created_at` |
| `sortDirection` | `"asc" \| "desc" \| null` | opt | Defaults to descending (newest first) |
| `modelProviders` | `string[] \| null` | opt | Present-but-empty = all providers |
| `sourceKinds` | `ThreadSourceKind[] \| null` | opt | `cli`,`vscode`,`exec`,`appServer`,`subAgent`,`subAgentReview`,`subAgentCompact`,`subAgentThreadSpawn`,`subAgentOther`,`unknown`. Omitted/empty = interactive sources |
| `archived` | `boolean \| null` | opt | `true` = only archived; `false`/null = only non-archived |
| `sectionId` | `string \| null` | opt | Omit = every section; `null` = unsectioned only |
| `cwd` | `string \| string[] \| null` | opt | Exact-match filter (`ThreadListCwdFilter`) |
| `useStateDbOnly` | `boolean` | opt | Skip the JSONL scan-and-repair pass |
| `searchTerm` | `string \| null` | opt | Substring filter on the extracted thread title |

Result `ThreadListResponse`: `data: Thread[]` (**REQ**), `nextCursor: string \| null`, `backwardsCursor: string \| null`.

Each element is a full `Thread` (§3.10). For a history sidebar you need: `id`, `name`, `preview`, `cwd`, `createdAt`, `updatedAt`, `recencyAt`, `status`, `model`, `modelProvider`, `source`, `gitInfo`, `section`. `turns` is `[]` here.

### 3.2 `thread/start`

Params `ThreadStartParams` (`codex-ts/v2/ThreadStartParams.ts`) —**every field is optional**:

| Field | Type | Notes |
|---|---|---|
| `model` | `string \| null` | Model id |
| `modelProvider` | `string \| null` | e.g. `openai` |
| `serviceTier` | `string \| null \| null` | Note the doubled null in the binding |
| `cwd` | `string \| null` | Working directory for the thread |
| `approvalPolicy` | `AskForApproval \| null` | see below |
| `approvalsReviewer` | `ApprovalsReviewer \| null` | `user` \| `auto_review` \| `guardian_subagent` |
| `sandbox` | `SandboxMode \| null` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `config` | `map<string, JsonValue> \| null` | Per-thread config overrides |
| `serviceName` | `string \| null` | |
| `baseInstructions` | `string \| null` | Replaces base instructions |
| `developerInstructions` | `string \| null` | |
| `personality` | `"none" \| "friendly" \| "pragmatic" \| null` | |
| `ephemeral` | `boolean \| null` | Do not materialize on disk |
| `sessionStartSource` | `"startup" \| "clear" \| null` | `ThreadStartSource` |
| `threadSource` | `string \| null` | Analytics classification (`ThreadSource = string`) |

`AskForApproval` (`codex-ts/v2/AskForApproval.ts`) is `"untrusted" | "on-request" | "never" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean } }`. In the granular branch `sandbox_approval`, `rules` and `mcp_elicitations` are required; `skill_approval` and `request_permissions` default to `false`.

**Nothing is required.** In the observed probe, `{"cwd":"D:\\...","approvalPolicy":"untrusted","sandbox":"workspace-write"}` succeeded; the model, provider, cwd, and permission profile were all filled in from the server's own config.

Result `ThreadStartResponse` (`codex-ts/v2/ThreadStartResponse.ts`):

| Field | Type | Req |
|---|---|---|
| `thread` | `Thread` | **REQ** |
| `model` | `string` | **REQ** |
| `modelProvider` | `string` | **REQ** |
| `serviceTier` | `string \| null` | **REQ** (nullable) |
| `cwd` | `AbsolutePathBuf` | **REQ** |
| `instructionSources` | `LegacyAppPathString[]` | **REQ** |
| `approvalPolicy` | `AskForApproval` | **REQ** |
| `approvalsReviewer` | `ApprovalsReviewer` | **REQ** |
| `sandbox` | `SandboxPolicy` | **REQ** |
| `reasoningEffort` | `ReasoningEffort \| null` | **REQ** (nullable) |

`thread.turns` is `[]` on start. **Observed extra response fields not in the bindings:** `runtimeWorkspaceRoots: string[]`, `activePermissionProfile: {id, extends} | null`, `multiAgentMode`. Trust the documented fields; tolerate extras.

### 3.3 `thread/resume`

Params `ThreadResumeParams` (`codex-schema/v2/ThreadResumeParams.json`; schema description quoted verbatim in the file):

> There are three ways to resume a thread: 1. By thread_id: load from disk by thread_id and resume it. 2. By history: instantiate from memory and resume it. 3. By path: load from disk by path and resume it. For non-running threads the precedence is: history > non-empty path > thread_id. If using history or a non-empty path for a non-running thread, the thread_id param will be ignored. If thread_id identifies a running thread, app-server rejoins that thread and treats a non-empty path as a consistency check against the active rollout path. Empty string path values are treated as absent. Prefer using thread_id whenever possible.

| Field | Type | Req |
|---|---|---|
| `threadId` | `string` | **REQ** |
| `model` | `string \| null` | opt |
| `modelProvider` | `string \| null` | opt |
| `serviceTier` | `string \| null` | opt |
| `cwd` | `string \| null` | opt |
| `approvalPolicy` | `AskForApproval \| null` | opt |
| `approvalsReviewer` | `ApprovalsReviewer \| null` | opt |
| `sandbox` | `SandboxMode \| null` | opt |
| `config` | `map<string,JsonValue> \| null` | opt |
| `baseInstructions` | `string \| null` | opt |
| `developerInstructions` | `string \| null` | opt |
| `personality` | `Personality \| null` | opt |
| `excludeTurns` | `boolean` | opt |

Result `ThreadResumeResponse` —same shape as `ThreadStartResponse` plus pagination anchors:

`thread: Thread` (REQ, **`turns` populated**), `model`, `modelProvider`, `serviceTier`, `cwd`, `instructionSources`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `reasoningEffort`, and additionally `itemsBackwardsCursor: string | null` and `turnsBackwardsCursor: string | null`.

**Does it replay history?** Yes —`thread.resume` is one of the four responses in which `Thread.turns` is populated (the `Thread` doc comment in `codex-ts/v2/Thread.ts` lists `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` with `includeTurns: true`). The items are **lossy** relative to a live turn: `ThreadRollbackResponse`'s doc comment states "The ThreadItems stored in each Turn are lossy since we explicitly do not persist all agent interactions, such as command executions. This is the same behavior as `thread/resume`." For complete history use `thread/turns/list` + `thread/items/list`. Pass `excludeTurns: true` when you intend to paginate immediately.

### 3.4 `thread/read`

Params `ThreadReadParams`: `threadId: string` (**REQ**), `includeTurns: boolean` (opt, default false).

Result `ThreadReadResponse`: `thread: Thread` (**REQ**) —the only field. With `includeTurns: true`, `thread.turns` carries `Turn[]`; otherwise empty.

### 3.5 `thread/turns/list` (pagination)

Params `ThreadTurnsListParams`: `threadId: string` (**REQ**), `cursor?: string|null`, `limit?: number|null`, `sortDirection?: "asc"|"desc"|null` (default descending), `itemsView?: TurnItemsView|null` (default `summary`).

`TurnItemsView = "notLoaded" | "summary" | "full"` (`codex-ts/v2/TurnItemsView.ts`).

Result `ThreadTurnsListResponse`: `data: Turn[]` (REQ), `nextCursor: string|null`, `backwardsCursor: string|null`. Per the binding, `backwardsCursor` is populated only when the page has at least one turn; pass it as `cursor` with the opposite `sortDirection` to re-include the anchor turn and catch updates.

### 3.6 `thread/items/list` (pagination)

Params `ThreadItemsListParams`: `threadId: string` (**REQ**), `turnId?: string|null` (omit = across the thread), `cursor?: string|null`, `limit?: number|null`, `sortDirection?: "asc"|"desc"|null` (default **ascending**, unlike turns).

Result `ThreadItemsListResponse`: `data: ThreadItemEntry[]` (REQ), `nextCursor`, `backwardsCursor`. `ThreadItemEntry = { turnId: string, item: ThreadItem }` (`codex-ts/v2/ThreadItemEntry.ts`).

### 3.7 `thread/loaded/list`

Params: `cursor?: string|null`, `limit?: number|null` (default: no limit). Result: `data: string[]` (thread ids currently loaded in memory), `nextCursor`.

### 3.8 `thread/name/set`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`

| Method | Params | Result |
|---|---|---|
| `thread/name/set` | `{ threadId: string, name: string }` both REQ | `{}` (empty object) |
| `thread/archive` | `{ threadId: string }` | `{}` |
| `thread/unarchive` | `ThreadUnarchiveParams` (not separately dumped; same `threadId` shape) | `ThreadUnarchiveResponse` |
| `thread/delete` | `{ threadId: string }` | `{}` |
| `thread/unsubscribe` | `{ threadId: string }` | `{ status: "notLoaded" \| "notSubscribed" \| "unsubscribed" }` |

Enum `ThreadUnsubscribeStatus` = `notLoaded` | `notSubscribed` | `unsubscribed`.

### 3.9 `thread/fork`, `thread/compact/start`, `thread/rollback`, `thread/revert`, `thread/shellCommand`, `thread/inject_items`

- **`thread/fork`** —schema doc: fork by `thread_id` (preferred) or by non-empty `path`, which then overrides `threadId`. Params: `threadId: string` (**REQ**), `lastTurnId?: string|null` (fork through this turn, inclusive; the referenced turn must not be in progress), `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config`, `baseInstructions`, `developerInstructions`, `ephemeral?: boolean`, `threadSource`, `excludeTurns?: boolean` (metadata-only fork; pair with `thread/turns/list` + `thread/items/list`). Result `ThreadForkResponse` = the `ThreadStartResponse` field set with `thread.turns` populated.
- **`thread/compact/start`** —params `{ threadId: string }`; result `{}`. Compaction progress surfaces through the `contextCompaction` item and (deprecated) `thread/compacted` notification.
- **`thread/rollback`** —*deprecated* ("DEPRECATED: `thread/rollback` will be removed soon", `codex-ts/v2/ThreadRollbackParams.ts`). Params `{ threadId: string, numTurns: number }` (both REQ, `numTurns >= 1`). Result `{ thread: Thread }` with `turns` populated. It drops history only; it does **not** revert file changes. Prefer `thread/revert`.
- **`thread/revert`** —params `ThreadRevertParams`, result `ThreadRevertResponse` (present in bindings; not dumped here). Emits `thread/reverted`.
- **`thread/shellCommand`** —params `{ threadId: string (REQ), command: string (REQ), timeoutMs?: number|null }`. The command is evaluated by the thread's shell, preserves pipes/redirects/quoting, and **runs unsandboxed with full access**. Default timeout one hour; `0` means immediate timeout, not unlimited. Response is an immediate RPC acknowledgement, not the command result.
- **`thread/inject_items`** —params `{ threadId: string, items: JsonValue[] }`: raw Responses API items appended to the thread's model-visible history.

### 3.10 `Thread` (the shared summary/state object)

`codex-ts/v2/Thread.ts`:

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string` | **REQ** | UUIDv7 |
| `sessionId` | `string` | **REQ** | Shared across threads in one session tree |
| `forkedFromId` | `string \| null` | **REQ** | |
| `parentThreadId` | `string \| null` | **REQ** | Set only for subagent threads |
| `preview` | `string` | **REQ** | Usually the first user message |
| `ephemeral` | `boolean` | **REQ** | |
| `section` | `ThreadSection \| null` | **REQ** | `{id, name, appearance}` |
| `sectionEnteredAt` | `number \| null` | **REQ** | |
| `projectId` | `string \| null` | **REQ** | |
| `historyMode` | `"legacy" \| "paginated"` | **REQ** | |
| `modelProvider` | `string` | **REQ** | |
| `model` | `string \| null` | **REQ** | Configured model, not per-turn telemetry |
| `reasoningEffort` | `ReasoningEffort \| null` | **REQ** | |
| `createdAt` | `number` | **REQ** | Unix seconds |
| `updatedAt` | `number` | **REQ** | Unix seconds |
| `recencyAt` | `number \| null` | **REQ** | Unix seconds |
| `status` | `ThreadStatus` | **REQ** | see below |
| `path` | `string \| null` | **REQ** | `[UNSTABLE]` rollout path on disk |
| `cwd` | `AbsolutePathBuf` | **REQ** | |
| `cliVersion` | `string` | **REQ** | |
| `source` | `SessionSource` | **REQ** | |
| `threadSource` | `string \| null` | **REQ** | |
| `agentNickname`, `agentRole` | `string \| null` | **REQ** | Sub-agent metadata |
| `gitInfo` | `GitInfo \| null` | **REQ** | `{branch, originUrl, sha}` all nullable |
| `name` | `string \| null` | **REQ** | User-facing title |
| `turns` | `Turn[]` | **REQ** | Empty except in resume/rollback/fork/read-with-turns |

`ThreadStatus` (`codex-ts/v2/ThreadStatus.ts`) is a tagged union: `{"type":"notLoaded"} | {"type":"idle"} | {"type":"systemError"} | {"type":"active","activeFlags": ThreadActiveFlag[]}`. `ThreadActiveFlag` = `waitingOnApproval` | `waitingOnUserInput`.

`SessionSource` = `"cli" | "vscode" | "exec" | "mcp" | {"custom": string} | {"internal": InternalSessionSource} | {"subagent": SubAgentSource} | "unknown"`.

**Observed runtime-only Thread fields absent from the bindings:** `canAcceptDirectInput: boolean` and `extra: null` (see `codex-ts/v2/ThreadExtra.ts`, `Record<string, never>`). `grep canAcceptDirectInput` over the whole `.recon` tree returns nothing —**not present in bindings**, but present on the wire in 0.153.4.

---

## 4. Turn lifecycle

### 4.1 `turn/start`

Params `TurnStartParams` (`codex-ts/v2/TurnStartParams.ts`). Required and optional, exactly:

| Field | Type | Req | Notes |
|---|---|---|---|
| `threadId` | `string` | **REQ** | |
| `input` | `UserInput[]` | **REQ** | See §4.2 |
| `cwd` | `string \| null` | opt | Overrides working directory for this and subsequent turns |
| `model` | `string \| null` | opt | |
| `effort` | `ReasoningEffort \| null` | opt | Reasoning effort override (note the name: `effort`, not `reasoningEffort`) |
| `summary` | `ReasoningSummary \| null` | opt | `auto` \| `concise` \| `detailed` \| `none` |
| `approvalPolicy` | `AskForApproval \| null` | opt | |
| `approvalsReviewer` | `ApprovalsReviewer \| null` | opt | |
| `sandboxPolicy` | `SandboxPolicy \| null` | opt | Full policy object, not the `SandboxMode` string |
| `personality` | `Personality \| null` | opt | |
| `serviceTier` | `string \| null` | opt | Changes the thread's tier |
| `serviceTierForTurn` | `string \| null` | opt | One-turn-only tier; `"default"` for standard speed |
| `outputSchema` | JSON Schema | opt | Constrains the final assistant message |
| `clientUserMessageId` | `string \| null` | opt | Client correlation id |
| `toolOutput` | `TurnToolOutput \| null` | opt | |
| `turnTrigger` | `string \| null` | opt | Source classification; ignored when the request steers an active turn |

**`cwd` is required —no.** It is optional and inherits the thread's cwd. The binding is `cwd?: string | null`; the description says "Override the working directory for this turn and subsequent turns." Only `threadId` and `input` are required.

Result `TurnStartResponse`: `{ turn: Turn }` (**REQ**). The returned turn is a *stub*: observed `{"id":"01a0fe72-...","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}`. Take `turn.id` as the turn id and wait for `turn/started` for the populated form.

`SandboxPolicy` (`codex-ts/v2/SandboxPolicy.ts`):

```ts
{ "type": "dangerFullAccess" }
| { "type": "readOnly", networkAccess: boolean }
| { "type": "externalSandbox", networkAccess: NetworkAccess }   // NetworkAccess = "restricted" | "enabled"
| { "type": "workspaceWrite", writableRoots: AbsolutePathBuf[], networkAccess: boolean,
    excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean }
```

### 4.2 `UserInput` variants (`codex-ts/v2/UserInput.ts`)

| Variant `type` | Fields | Req |
|---|---|---|
| `text` | `text: string`; `text_elements?: TextElement[]` (default `[]`) | `text` REQ |
| `image` | `url: string`; `detail?: "auto"\|"low"\|"high"\|"original"\|null` | `url` REQ |
| `localImage` | `path: string`; `detail?: ImageDetail\|null` | `path` REQ |
| `audio` | `url: string` | REQ |
| `localAudio` | `path: string` | REQ |
| `skill` | `name: string`, `path: string` | both REQ |
| `mention` | `name: string`, `path: string` | both REQ |

`TextElement = { byteRange: {start: uint, end: uint}, placeholder?: string|null }`. Note the snake_case `text_elements` on `text` input —the schema's `title` is `TextUserInput` (`codex-schema/v2/...`, definition inside `ItemStartedNotification.json` and the v2 combined schema). **Observed wire form:** the user message item carries `content: [{"type":"text","text":"...","text_elements":[]}]`.

There is **no** `mention`/`skill` item name mismatch to worry about: the discriminator strings are lowercase `text`, `image`, `localImage`, `audio`, `localAudio`, `skill`, `mention`, while the corresponding ThreadItem view of the same data is `{"type":"userMessage","content":[...]}`.

### 4.3 `turn/interrupt`

Params `TurnInterruptParams`: `threadId: string` (**REQ**), `turnId: string` (**REQ**). Result `TurnInterruptResponse` = `{}` (empty). The interrupted turn completes with `status: "interrupted"` and a `turn/completed` notification.

### 4.4 `turn/steer`

Params `TurnSteerParams`: `threadId: string` (**REQ**), `input: UserInput[]` (**REQ**), `expectedTurnId: string` (**REQ**) —a hard precondition; the request fails if it does not match the currently active turn —`clientUserMessageId?: string|null`.

Result `TurnSteerResponse`: `{ turnId: string }` (**REQ**). Steering appends input to an already-running turn; it does not create a new turn, and `turnTrigger` on `turn/start` is ignored when the call steers.

### 4.5 `turn/completed` shape

Notification `turn/completed`, params `TurnCompletedNotification` = `{ threadId: string (REQ), turn: Turn (REQ) }`.

`Turn` (`codex-ts/v2/Turn.ts`): `id: string` (REQ), `items: ThreadItem[]` (REQ), `itemsView?: TurnItemsView` (opt), `status: TurnStatus` (REQ), `error?: TurnError|null`, `startedAt?: number|null`, `completedAt?: number|null`, `durationMs?: number|null`. `TurnStatus` = `completed` | `interrupted` | `failed` | `inProgress`. Timestamps are Unix seconds.

Observed completed turn: `{"id":"01a0fe72-...","items":[<final agentMessage>],"itemsView":"summary","status":"completed","error":null,"startedAt":1790975279,"completedAt":1790975302,"durationMs":23594}` —note `items` carries only the final-answer agent message at `itemsView: "summary"`, not every item produced during the turn.

### 4.6 `review/start`

Params `ReviewStartParams`: `threadId: string` (**REQ**), `target: ReviewTarget` (**REQ**), `delivery?: "inline" | "detached" | null`. `ReviewTarget` is `{"type":"uncommittedChanges"} | {"type":"baseBranch","branch":string} | {"type":"commit","sha":string,"title":string|null} | {"type":"custom","instructions":string}`. `delivery` defaults to `inline` (review runs on the current thread); `detached` runs it on a new thread. Result `ReviewStartResponse`: `{ turn: Turn, reviewThreadId: string }` —for inline reviews `reviewThreadId` equals the original thread id, for detached reviews it is the new review thread. Marked `EXPERIMENTAL` in `codex-schema/v2/ReviewStartResponse.json`.

---

## 5. Streaming notifications

Every delta notification carries the same correlation triple —**`threadId`, `turnId`, `itemId`** —except the thread/turn-scoped ones noted below. Correlation rules:

1. `threadId` identifies the thread; match it against the thread you started/resumed.
2. `turnId` matches `TurnStartResponse.turn.id` and the `turnId` in `turn/started` / `turn/completed`.
3. `itemId` matches `ThreadItem.id` in the corresponding `item/started` / `item/completed`, and equals the `itemId` a server-initiated approval request refers to.
4. Deltas **accumulate**: `item/started` for `agentMessage` arrives with `text: ""` and subsequent `item/agentMessage/delta` payloads concatenate to form `item/completed`'s `text`. Observed exactly this for two messages in one turn.
5. `startedAtMs` / `completedAtMs` are Unix **milliseconds**; `Thread.createdAt`/`updatedAt` and `Turn.startedAt`/`completedAt` are Unix **seconds**. Do not mix them.
6. Do not assume ordering between a delta and the `item/started` that precedes it across different items; only per-`itemId` ordering is meaningful.

### 5.1 `item/started` and `item/completed`

| Method | Params |
|---|---|
| `item/started` | `item: ThreadItem` (REQ), `threadId: string` (REQ), `turnId: string` (REQ), `startedAtMs: int64` (REQ) |
| `item/completed` | `item: ThreadItem` (REQ), `threadId: string` (REQ), `turnId: string` (REQ), `completedAtMs: int64` (REQ) |

Both are marked `EXPERIMENTAL` in `codex-schema/v2/ItemStartedNotification.json` / `ItemCompletedNotification.json`. The `item` object is fully populated at `item/completed`; at `item/started` it carries zeroed/empty values for anything still streaming.

### 5.2 The full `ThreadItem` discriminated union

From `codex-schema/codex_app_server_protocol.v2.schemas.json` —`definitions.ThreadItem` (21 variants). Field names are **camelCase on the wire**; the snake_case names below appear only inside nested payloads where the schema says so.

**`userMessage`** —REQ: `id: string`, `content: UserInput[]`; opt: `clientId: string|null`.

**`hookPrompt`** —REQ: `id: string`, `fragments: HookPromptFragment[]`.

**`agentMessage`** —REQ: `id: string`, `text: string`; opt: `phase: "commentary" | "final_answer" | null`, `memoryCitation: MemoryCitation|null`, `delivery: "async"|null`, `questions: AsyncUserInputQuestion[]|null`. `MemoryCitation = {entries: MemoryCitationEntry[], threadIds: string[]}`; `AsyncUserInputQuestion = {title: string, options?: string[]|null}`.

**`functionCallOutput`** —REQ: `id: string`, `name: string`, `output: FunctionCallOutputBody` (a string or an array of content items); opt: `namespace: string|null`.

**`plan`** —REQ: `id: string`, `text: string`. Streamed incrementally via `item/plan/delta` (experimental; the doc warns concatenated deltas may not match the completed plan text).

**`reasoning`** —REQ: `id: string`, `type`; opt: `content: string[]` (default `[]`), `summary: string[]` (default `[]`).

**`commandExecution`** —REQ: `id: string`, `command: string`, `cwd: LegacyAppPathString`, `status: CommandExecutionStatus`, `commandActions: CommandAction[]`; opt: `aggregatedOutput: string|null`, `exitCode: int32|null`, `durationMs: int64|null`, `processId: string|null`, `source: CommandExecutionSource` (default `"agent"`), `pluginId: string|null`, `scriptPath: string|null`.

**`fileChange`** —REQ: `id: string`, `changes: FileUpdateChange[]`, `status: PatchApplyStatus`.

**`mcpToolCall`** —REQ: `id: string`, `server: string`, `tool: string`, `status: McpToolCallStatus`, `arguments: JsonValue`; opt: `result: McpToolCallResult|null`, `error: McpToolCallError|null`, `durationMs: int64|null`, `appContext: McpToolCallAppContext|null`, `mcpAppResourceUri: string|null` (deprecated), `readOnlyHint: boolean|null`, `pluginId: string|null`.

**`dynamicToolCall`** —REQ: `id: string`, `tool: string`, `status: DynamicToolCallStatus`, `arguments: JsonValue`; opt: `contentItems: DynamicToolCallOutputContentItem[]|null`, `success: boolean|null`, `durationMs: int64|null`, `namespace: string|null`.

**`collabAgentToolCall`** —REQ: `id: string`, `tool: CollabAgentTool`, `status: CollabAgentToolCallStatus`, `senderThreadId: string`, `receiverThreadIds: string[]`, `agentsStates: map<string, CollabAgentState>`; opt: `prompt: string|null`, `model: string|null`, `reasoningEffort: ReasoningEffort|null`.

**`subAgentActivity`** —REQ: `id: string`, `agentPath: string`, `agentThreadId: string`, `kind: "started"|"interacted"|"interrupted"|"completed"`.

**`webSearch`** —REQ: `id: string`, `query: string`; opt: `action: WebSearchAction|null`, `results: unknown[]|null` (opaque JSON passthrough).

**`imageView`** —REQ: `id: string`, `path: LegacyAppPathString`.

**`sleep`** —REQ: `id: string`, `durationMs: uint64`. Emitted by the interruptible `clock.sleep` tool.

**`imageGeneration`** —REQ: `id: string`, `result: string`, `status: string`; opt: `revisedPrompt: string|null`, `savedPath: AbsolutePathBuf|null`, `failure: ImageGenerationFailure|null`, `transparentBackground: boolean|null`.

**`enteredReviewMode`** / **`exitedReviewMode`** —REQ: `id: string`, `review: string`.

**`contextCompaction`** —REQ: `id: string` only.

Supporting enums: `CommandExecutionStatus` = `inProgress|completed|failed|declined`; `PatchApplyStatus` = `inProgress|completed|failed|declined`; `McpToolCallStatus` = `DynamicToolCallStatus` = `inProgress|completed|failed`; `CollabAgentToolCallStatus` = `inProgress|completed|failed|interrupted`; `CollabAgentTool` = `spawnAgent|sendInput|resumeAgent|wait|closeAgent|sendMessage|followupTask|interruptAgent|listAgents`; `CollabAgentStatus` = `pendingInit|running|interrupted|completed|errored|shutdown|notFound`; `CommandExecutionSource` = `agent|userShell|unifiedExecStartup|unifiedExecInteraction`.

`CommandAction` union: `{"type":"read","command":string,"name":string,"path":LegacyAppPathString}` | `{"type":"listFiles","command":string,"path"?:string|null}` | `{"type":"search","command":string,"path"?:string|null,"query"?:string|null}` | `{"type":"unknown","command":string}`.

`FileUpdateChange` = `{path: string, kind: PatchChangeKind, diff: string}`; `PatchChangeKind` = `{"type":"add"}` | `{"type":"delete"}` | `{"type":"update","move_path"?: string|null}` —note the **snake_case `move_path`**.

Observed `commandExecution` item at start and completion (abridged):

```json
{"type":"commandExecution","id":"call_LNAf...","pluginId":null,"scriptPath":null,"command":"\"C:\\\\windows\\\\...powershell.exe\" -Command 'echo DSH_PROBE_OK'","cwd":"D:\\\\work\\\\my-project","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"echo DSH_PROBE_OK"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null}
```

```json
{...,"processId":"50107","source":"unifiedExecStartup","status":"completed","aggregatedOutput":"DSH_PROBE_OK\r\n","exitCode":0,"durationMs":428}
```

### 5.3 Agent message streaming —`item/agentMessage/delta`

Params: `threadId: string` (REQ), `turnId: string` (REQ), `itemId: string` (REQ), `delta: string` (REQ).

Append `delta` verbatim to the running `text` for `itemId`. Observed deltas were arbitrarily split, including mid-word (`"DS"`, `"H"`, `"BE"`, `"_PRO"`, `"_OK"`) and containing newlines and backticks. The final `item/completed` carries the authoritative concatenated `text`, so reconcile against it and treat deltas as a progressive approximation.

There is no separate "agent message completed delta" notification; `item/completed` is the terminal event.

### 5.4 Reasoning streaming

| Method | Params |
|---|---|
| `item/reasoning/textDelta` | `threadId`, `turnId`, `itemId` (all REQ), `contentIndex: int` (REQ), `delta: string` (REQ) |
| `item/reasoning/summaryTextDelta` | `threadId`, `turnId`, `itemId` (REQ), `summaryIndex: int` (REQ), `delta: string` (REQ) |
| `item/reasoning/summaryPartAdded` | `threadId`, `turnId`, `itemId` (REQ), `summaryIndex: int` (REQ) —**no delta** |

Meaning: `textDelta` appends to `ReasoningThreadItem.content[contentIndex]` (raw chain-of-thought text). `summaryTextDelta` appends to `ReasoningThreadItem.summary[summaryIndex]` (user-facing summary). `summaryPartAdded` signals that a **new** summary slot has begun at `summaryIndex`; create/reset that slot before applying subsequent `summaryTextDelta`s for the same index.

### 5.5 Command / file-change streaming

| Method | Params | Notes |
|---|---|---|
| `item/commandExecution/outputDelta` | `threadId`, `turnId`, `itemId` (REQ), `delta: string` (REQ) | Raw interleaved stdout/stderr text chunks |
| `item/commandExecution/terminalInteraction` | `threadId`, `turnId`, `itemId` (REQ), `processId: string` (REQ), `stdin: string` (REQ) | Shows what was written to a PTY |
| `item/fileChange/outputDelta` | same four fields as `commandExecution/outputDelta` | **Deprecated**: "The server no longer emits this notification" (`codex-schema/v2/FileChangeOutputDeltaNotification.json`) |
| `item/fileChange/patchUpdated` | `threadId`, `turnId`, `itemId` (REQ), `changes: FileUpdateChange[]` (REQ) | Full replacement of the item's `changes`; **not** a delta |
| `item/mcpToolCall/progress` | `threadId`, `turnId`, `itemId` (REQ), `message: string` (REQ) | Progress text for an MCP call |

Observed command output deltas split the same stream into multiple notifications, including a trailing `"\r\n"` chunk. `patchUpdated` semantics differ from every other `*Delta`: treat `changes` as the new whole value.

### 5.6 Turn- and thread-level notifications

| Method | Params (all REQ unless marked) |
|---|---|
| `turn/started` | `threadId`, `turn: Turn` |
| `turn/completed` | `threadId`, `turn: Turn` |
| `turn/diff/updated` | `threadId`, `turnId`, `diff: string` —latest aggregated unified diff across all file changes in the turn |
| `turn/plan/updated` | `threadId`, `turnId`, `plan: TurnPlanStep[]`; `explanation: string\|null` (opt). `TurnPlanStep = {step: string, status: "pending"\|"inProgress"\|"completed"}` |
| `thread/status/changed` | `threadId`, `status: ThreadStatus` |
| `thread/tokenUsage/updated` | `threadId`, `turnId`, `tokenUsage: ThreadTokenUsage` |
| `thread/name/updated` | `threadId`; `threadName: string\|null` (opt) |
| `thread/started` | `thread: Thread` |
| `thread/settings/updated` | `threadId`, `threadSettings: ThreadSettings` |
| `thread/closed` | `threadId` |
| `thread/archived` / `thread/unarchived` / `thread/deleted` | `threadId` (from the corresponding `v2/Thread*Notification.json`) |
| `thread/compacted` | `threadId`, `turnId` —deprecated in favour of the `contextCompaction` item |
| `serverRequest/resolved` | `threadId`, `requestId: RequestId` —closes out a server-initiated request (see §6) |

`ThreadTokenUsage` = `{total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow?: int|null}`.
`TokenUsageBreakdown` = `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` —all `number`, all required (`codex-ts/v2/TokenUsageBreakdown.ts`). The observed payload used exactly these six keys plus `modelContextWindow`.

`ThreadSettings` = `{cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, activePermissionProfile, model, modelProvider, serviceTier, effort, summary, collaborationMode, personality}` (`codex-ts/v2/ThreadSettings.ts`) —note it exposes `sandboxPolicy` and `effort`, whereas `ThreadStartResponse` exposes `sandbox` and `reasoningEffort`.

### 5.7 `command/exec/outputDelta`

`command/exec` runs a standalone argv vector in the server sandbox **without** a thread or turn (`codex-schema/v2/CommandExecParams.json`). It is unrelated to `item/commandExecution/outputDelta`.

`CommandExecParams`: `command: string[]` (**REQ**, empty arrays rejected); opt `cwd`, `env: map<string,string|null>|null`, `timeoutMs: int64|null`, `disableTimeout: boolean`, `outputBytesCap: uint|null`, `disableOutputCap: boolean`, `sandboxPolicy: SandboxPolicy|null` (cannot combine with `permissionProfile`), `processId: string|null`, `streamStdin: boolean`, `streamStdoutStderr: boolean`, `tty: boolean`, `size: CommandExecTerminalSize|null`.

`CommandExecOutputDeltaNotification` (connection-scoped): `processId: string` (REQ), `stream: "stdout" | "stderr"` (REQ), `deltaBase64: string` (REQ, base64 bytes), `capReached: boolean` (REQ —true on the final chunk of a stream whose later output was truncated).

Relationship to a running command: `processId` is **client-supplied** and connection-scoped. It is required to use `streamStdin`, `streamStdoutStderr`, `tty`, and the follow-up calls `command/exec/write` (`{processId, deltaBase64?, closeStdin?}`), `command/exec/resize` (`{processId, size:{cols,rows}}`), and `command/exec/terminate` (`{processId}`). The final `command/exec` response is deferred until the process exits and is sent only after all `command/exec/outputDelta` notifications for that connection. If the originating connection closes, the server terminates the process.

A parallel `process/spawn` family exists (`process/outputDelta`, `process/exited`, keyed by `processHandle`, `ProcessOutputStream`, plus buffered `stdout`/`stderr` and `*CapReached` flags on exit) —see `codex-schema/v2/ProcessOutputDeltaNotification.json` and `ProcessExitedNotification.json`.

### 5.8 `error`, `warning`, `deprecationNotice`, `configWarning`, `guardianWarning`

| Method | Params | When it fires |
|---|---|---|
| `error` | `error: TurnError` (REQ), `threadId: string` (REQ), `turnId: string` (REQ), `willRetry: boolean` (REQ) | A turn-scoped failure; `willRetry: true` means the server is retrying and the turn may still succeed |
| `warning` | `message: string` (REQ), `threadId?: string\|null` | Generic advisory; can be thread-scoped or connection-wide |
| `deprecationNotice` | `summary: string` (REQ), `details?: string\|null` | A feature/method used by this connection is deprecated |
| `configWarning` | `summary: string` (REQ), `details?: string\|null`, `path?: string`, `range?: TextRange` | A config file problem; `path`/`range` point at the offending location |
| `guardianWarning` | `message: string` (REQ), `threadId: string` (REQ) | Guardian/auto-review advisory tied to a specific thread |

`TurnError = {message: string (REQ), codexErrorInfo?: CodexErrorInfo|null, additionalDetails?: string|null, misalignment?: MisalignmentErrorDetails|null}`.

`CodexErrorInfo` (`codex-ts/v2/CodexErrorInfo.ts`) = `"contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "serverOverloaded" | "cyberPolicy" | "misalignmentPolicyViolation" | {"httpConnectionFailed":{"httpStatusCode":number|null}} | {"responseStreamConnectionFailed":{"httpStatusCode":number|null}} | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | {"responseStreamDisconnected":{"httpStatusCode":number|null}} | {"responseTooManyFailedAttempts":{"httpStatusCode":number|null}} | {"activeTurnNotSteerable":{"turnKind":NonSteerableTurnKind}} | "other"`.

Observed `warning` during a real turn: `{"threadId":"...","message":"Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}` —so a single `warning` must not be treated as fatal.

### 5.9 `rawResponseItem/completed`

Method `rawResponseItem/completed`, params `RawResponseItemCompletedNotification`: `item: ResponseItem` (REQ), `threadId: string` (REQ), `turnId: string` (REQ). This exposes the **undecoded upstream Responses API item** —low-level, pre-abstraction, and unstable across model/provider changes. Use it only for debugging or for fields the `ThreadItem` projection drops; never build UI state on it. A sibling `rawResponse/completed` (`RawResponseCompletedNotification`) also exists.

### 5.10 Other notifications worth knowing

`model/rerouted`, `model/verification`, `model/safetyBuffering/updated`, `turn/moderationMetadata`, `account/updated`, `account/rateLimits/updated`, `account/login/completed`, `app/list/updated`, `skills/changed`, `fs/changed`, `project/changed`, `thread/project/updated`, `thread/queue/changed`, `thread/goal/updated`, `thread/goal/cleared`, `thread/environment/connected|disconnected`, `hook/started`, `hook/completed`, `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed`, `mcpServer/event/stream/notification`, `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`, `fuzzyFileSearch/sessionUpdated|sessionCompleted`, the `thread/realtime/*` family, `item/autoApprovalReview/started|completed`, `autoApprovalReview/strictReviewRequired`, and `externalAgentConfig/import/progress|completed`. Full enumeration: `codex-schema/ServerNotification.json` (81 entries) and `codex-ts/ServerNotification.ts`.

---

## 6. Server-initiated requests (approvals and questions)

`ServerRequest.json` declares exactly ten methods. **The client must answer every one of them** with a JSON-RPC response carrying the same `id`; each answer resolves the pending request, and the server emits `serverRequest/resolved` (`{threadId, requestId}`) once the outstanding request is closed.

| # | Method | Status |
|---|---|---|
| 1 | `item/commandExecution/requestApproval` | **v2 —use this** |
| 2 | `item/fileChange/requestApproval` | **v2 —use this** |
| 3 | `item/permissions/requestApproval` | **v2 —use this** |
| 4 | `item/tool/requestUserInput` | **v2 —use this** (note the `item/tool/` prefix) |
| 5 | `mcpServer/elicitation/request` | v2 |
| 6 | `item/tool/call` | v2 (dynamic tool call, server-initiated) |
| 7 | `account/chatgptAuthTokens/refresh` | v2 |
| 8 | `attestation/generate` | v2, only if `capabilities.requestAttestation` |
| 9 | `applyPatchApproval` | **legacy v1** |
| 10 | `execCommandApproval` | **legacy v1** |

### 6.1 `item/commandExecution/requestApproval`

Params `CommandExecutionRequestApprovalParams`:

| Field | Type | Req | Notes |
|---|---|---|---|
| `threadId` | `string` | **REQ** | |
| `turnId` | `string` | **REQ** | |
| `itemId` | `string` | **REQ** | Correlates with the running `commandExecution` item |
| `startedAtMs` | `int64` | **REQ** | Unix ms |
| `kind` | `"command" \| "writeStdin"` | opt | Defaults to `command` on older servers; `writeStdin` distinguishes input sent to an existing terminal |
| `approvalId` | `string \| null` | opt | Non-null only for zsh-exec-bridge subcommand approvals and stdin approvals; a distinct opaque UUID to disambiguate multiple callbacks under one `itemId` |
| `environmentId` | `string \| null` | opt | Environment the command runs in (observed `"local"`) |
| `reason` | `string \| null` | opt | e.g. "request for network access" |
| `networkApprovalContext` | `{host: string, protocol: NetworkApprovalProtocol} \| null` | opt | Managed-network prompt |
| `command` | `string \| null` | opt | The command to be executed |
| `cwd` | `string \| null` | opt | |
| `commandActions` | `CommandAction[] \| null` | opt | Best-effort parse for friendly display |
| `proposedExecpolicyAmendment` | `string[] \| null` | opt | Proposal to allow similar commands without prompting (`ExecPolicyAmendment = string[]`) |
| `proposedNetworkPolicyAmendments` | `NetworkPolicyAmendment[] \| null` | opt | `{host, action: "allow"\|"deny"}` |

**Observed extras not in the bindings:** `availableDecisions` —e.g. `["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo","DSH_PROBE_OK"]}},"cancel"]`. Render only the decisions the server advertises, and fall back to the full set when the field is absent.

Response `CommandExecutionRequestApprovalResponse` —exactly one field: `decision: CommandExecutionApprovalDecision`.

`CommandExecutionApprovalDecision` (`codex-ts/v2/CommandExecutionApprovalDecision.ts`):

```ts
"accept" | "acceptForSession"
| { "acceptWithExecpolicyAmendment": { execpolicy_amendment: ExecPolicyAmendment } }   // ExecPolicyAmendment = string[]
| { "applyNetworkPolicyAmendment": { network_policy_amendment: NetworkPolicyAmendment } }
| "decline" | "cancel"
```

`accept` = allow this one execution. `acceptForSession` = remember the allowance for the rest of the session. `acceptWithExecpolicyAmendment` = allow and persist a rule that auto-approves matching commands. `applyNetworkPolicyAmendment` = allow and adjust the network policy for a host. `decline` = refuse this time. `cancel` = abort the request/turn path.

**Legacy vs v2:** `execCommandApproval` (params `ExecCommandApprovalParams`: `callId: string`, `conversationId: ThreadId`, `command: string[]`, `cwd: string`, `parsedCmd`, `reason?`, `approvalId?`; response `{decision: ReviewDecision}`) and `applyPatchApproval` (params `ApplyPatchApprovalParams`: `callId`, `conversationId`, `fileChanges: object`, `grantRoot?`, `reason?`; response `{decision: ReviewDecision}`) are the **v1** schemas. Their decision enum is the snake_case `ReviewDecision` = `"approved" | {"approved_execpolicy_amendment": {...}} | "approved_for_session" | "approved_mcp_policy_amendment" | {"network_policy_amendment": {...}} | {"denied": {...}} | "timed_out" | "abort"`. Do **not** mix the two families: the v1 methods carry `conversationId`/`callId` and the v1 decision strings, the v2 methods carry `threadId`/`turnId`/`itemId` and camelCase decisions. Implement v2, and only keep v1 handling if you must support older servers.

### 6.2 `item/fileChange/requestApproval`

Params `FileChangeRequestApprovalParams`: `threadId` (REQ), `turnId` (REQ), `itemId` (REQ), `startedAtMs: int64` (REQ), `reason?: string|null`, `grantRoot?: string|null` (`[UNSTABLE]`; "allow writes under this root for the remainder of the session (unclear if this is honored today)").

Response `FileChangeRequestApprovalResponse`: `{decision: FileChangeApprovalDecision}` where `FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"` —note there is **no** amendment variant here, unlike the command-execution decision.

### 6.3 `item/permissions/requestApproval`

Params `PermissionsRequestApprovalParams`: `threadId` (REQ), `turnId` (REQ), `itemId` (REQ), `startedAtMs: int64` (REQ), `cwd: AbsolutePathBuf` (REQ), `permissions: RequestPermissionProfile` (REQ), `environmentId: string|null` (opt), `reason: string|null` (opt).

`RequestPermissionProfile = {network: AdditionalNetworkPermissions|null, fileSystem: AdditionalFileSystemPermissions|null}` (both REQ, both nullable).
`AdditionalNetworkPermissions = {enabled: boolean|null}`.
`AdditionalFileSystemPermissions = {read: LegacyAppPathString[]|null (REQ), write: LegacyAppPathString[]|null (REQ), globScanMaxDepth?: number, entries?: FileSystemSandboxEntry[]}` —`read`/`write` are being replaced by `entries`, whose shape is `{path: FileSystemPath, access: "read"|"write"|"deny"}` with `FileSystemPath = {"type":"path","path":string} | {"type":"glob_pattern","pattern":string} | {"type":"special","value":FileSystemSpecialPath}`.

Response `PermissionsRequestApprovalResponse`: `permissions: GrantedPermissionProfile` (REQ), `scope?: "turn" | "session"` (opt), `strictAutoReview?: boolean|null` (opt —review every subsequent command in this turn before normal sandboxed execution).

`GrantedPermissionProfile = {network?: AdditionalNetworkPermissions, fileSystem?: AdditionalFileSystemPermissions}` —**both optional here**, unlike the request-side profile. Echo back only what you grant; an empty object grants nothing.

### 6.4 `item/tool/requestUserInput` —the "ask the user a question" flow

Params `ToolRequestUserInputParams` (titled "EXPERIMENTAL. Params sent with a request_user_input event"):

| Field | Type | Req |
|---|---|---|
| `threadId` | `string` | **REQ** |
| `turnId` | `string` | **REQ** |
| `itemId` | `string` | **REQ** |
| `questions` | `ToolRequestUserInputQuestion[]` | **REQ** |
| `isBlocking` | `boolean` | **REQ** |
| `autoResolutionMs` | `number \| null` | opt —`@deprecated Use isBlocking to decide whether the request should block` |

`ToolRequestUserInputQuestion` ("EXPERIMENTAL. Represents one request_user_input question and its required options"): `id: string` (REQ), `header: string` (REQ), `question: string` (REQ), `isOther: boolean` (REQ), `isSecret: boolean` (REQ), `options: ToolRequestUserInputOption[] | null` (REQ, nullable).

`ToolRequestUserInputOption` ("EXPERIMENTAL. Defines a single selectable option for request_user_input"): `label: string` (REQ), `description: string` (REQ).

`isSecret` should mask input; `isOther` permits a free-form answer beyond `options`; `options: null` means free-form only.

Response `ToolRequestUserInputResponse` ("EXPERIMENTAL. Response payload mapping question ids to answers"):

```json
{"answers": { "<question id>": { "answers": ["...", "..."] } }}
```

`answers` is `map<string, ToolRequestUserInputAnswer>` and `ToolRequestUserInputAnswer = {answers: string[]}` —the inner field is also named `answers` and is an **array** even for a single choice. Omit a question id to leave it unanswered.

### 6.5 `mcpServer/elicitation/request`

Params `McpServerElicitationRequestParams`: `serverName: string` (REQ), `threadId: string` (REQ), `turnId?: string|null` (opt —nullable because MCP models elicitation as a standalone server-to-client request identified by the MCP server request id; `turnId` is app-server correlation, not protocol identity), plus a `mode`-discriminated body:

| `mode` | Fields |
|---|---|
| `"form"` | `message: string` (REQ), `requestedSchema: McpElicitationSchema` (REQ), `_meta` (opt) |
| `"openai/form"` | `message: string` (REQ), `requestedSchema` (REQ), `_meta` (opt) |
| `"openaiForm"` | `message: string` (REQ), `requestedSchema` (REQ), `_meta` (opt) |
| `"url"` | `message: string` (REQ), `url: string` (REQ), `elicitationId: string` (REQ), `_meta` (opt) |

`openai/form` is the preferred form mode; `form` is the RMCP-standard mode; `openaiForm` also appears. A client declares support for the extension via `InitializeCapabilities.extensions` (or the legacy `mcpServerOpenaiFormElicitation`).

Response `McpServerElicitationRequestResponse`: `action: "accept" | "decline" | "cancel"` (REQ), `content: JsonValue | null` (opt —structured user input for accepted elicitations, mirroring RMCP `CreateElicitationResult`; null for decline/cancel), `_meta: JsonValue | null` (opt —client metadata for form-mode action handling).

### 6.6 `item/tool/call` (server-initiated dynamic tool call)

Params `DynamicToolCallParams`: `threadId: string` (REQ), `turnId: string` (REQ), `callId: string` (REQ), `tool: string` (REQ), `arguments: JsonValue` (REQ), `namespace?: string|null`.

Response `DynamicToolCallResponse`: `contentItems: DynamicToolCallOutputContentItem[]` (REQ), `success: boolean` (REQ), where `DynamicToolCallOutputContentItem = {"type":"inputText","text":string} | {"type":"inputImage","imageUrl":string} | {"type":"inputAudio","audioUrl":string}`.

Tools are declared to the server through `DynamicToolSpec`/`DynamicToolNamespaceTool` (from the `ClientRequest` definition set), which are configured rather than passed per request.

### 6.7 Remaining server requests

- `account/chatgptAuthTokens/refresh` —params `ChatgptAuthTokensRefreshParams` (`{reason: ChatgptAuthTokensRefreshReason, previousAccountId?: string|null}`), response `ChatgptAuthTokensRefreshResponse` (`{accessToken, chatgptAccountId, chatgptPlanType?}`). Used in external-auth mode.
- `attestation/generate` —params `AttestationGenerateParams`, response `AttestationGenerateResponse`. Only sent when `capabilities.requestAttestation` is true.

---

## 7. Metadata / settings reads

### 7.1 `model/list`

Params `ModelListParams`: `cursor?: string|null`, `limit?: number|null`, `includeHidden?: boolean|null`.

Result `ModelListResponse`: `data: Model[]`, `nextCursor: string|null`.

`Model` (`codex-ts/v2/Model.ts`), all required unless noted:

| Field | Type |
|---|---|
| `id` | `string` |
| `model` | `string` |
| `displayName` | `string` |
| `description` | `string` |
| `modelSpecialty` | `string \| null` |
| `hidden` | `boolean` |
| `supportedReasoningEfforts` | `ReasoningEffortOption[]` |
| `defaultReasoningEffort` | `ReasoningEffort` (string) |
| `inputModalities` | `InputModality[]` |
| `supportsPersonality` | `boolean` |
| `multiAgentVersion` | `MultiAgentVersion \| null` |
| `additionalSpeedTiers` | `string[]` (deprecated) |
| `serviceTiers` | `ModelServiceTier[]` |
| `defaultServiceTier` | `string \| null` |
| `isDefault` | `boolean` |
| `upgrade` | `string \| null` |
| `upgradeInfo` | `ModelUpgradeInfo \| null` |
| `availabilityNux` | `ModelAvailabilityNux \| null` |

`ReasoningEffort` is typed as a **non-empty string**, not an enum ("A non-empty reasoning effort value advertised by the model"). Populate your effort picker from `supportedReasoningEfforts`, defaulting to `defaultReasoningEffort`.

### 7.2 `permissionProfile/list`

Params `PermissionProfileListParams`: `cursor?: string|null`, `limit?: number|null` (defaults to the full result set), `cwd?: string|null` (resolve project config layers).

Result `PermissionProfileListResponse`: `data: PermissionProfileSummary[]`, `nextCursor: string|null`.

`PermissionProfileSummary = {id: string, description: string | null, allowed: boolean}`. `id` is the value you pass back as a permission profile (e.g. `:read-only`); `allowed` reflects whether effective requirements permit selecting it —disable non-allowed entries in the UI. The `ActivePermissionProfile` shape (`{id, extends}`, `codex-ts/v2/ActivePermissionProfile.ts`) is what threads/responses report.

### 7.3 Config

| Method | Params |
|---|---|
| `config/read` | `ConfigReadParams`: `includeLayers?: boolean`, `cwd?: string\|null` |
| `config/value/write` | `ConfigValueWriteParams`: `keyPath: string` (REQ), `value: JsonValue` (REQ), `mergeStrategy: "replace" \| "upsert"` (REQ), `filePath?: string\|null`, `expectedVersion?: string\|null` |
| `config/batchWrite` | `ConfigBatchWriteParams`: `edits: ConfigEdit[]` (REQ), `filePath?: string\|null`, `expectedVersion?: string\|null`, `reloadUserConfig?: boolean` |

`ConfigEdit = {keyPath: string, value: JsonValue, mergeStrategy: MergeStrategy}` (all REQ). `reloadUserConfig` hot-reloads updated runtime settings into loaded threads, but explicitly **not** session-static model, reasoning-effort, Plan-mode reasoning-effort, service-tier, and personality defaults.

`ConfigReadResponse = {config: Config, origins: map<string, ConfigLayerMetadata>, layers: ConfigLayer[] | null}`.
`ConfigWriteResponse = {status: WriteStatus, version: string, filePath: AbsolutePathBuf, overriddenMetadata: OverriddenMetadata | null}` —echo `version` back as `expectedVersion` for optimistic concurrency.

### 7.4 Account

| Method | Params | Result |
|---|---|---|
| `account/read` | `GetAccountParams`: `refreshToken?: boolean` | `GetAccountResponse` = `{account: Account \| null, requiresOpenaiAuth: boolean}` |
| `account/rateLimits/read` | (none) | `GetAccountRateLimitsResponse` |
| `account/usage/read` | `GetAccountTokenUsageParams`: `threadId?: string\|null` | `GetAccountTokenUsageResponse` |

`Account = {"type":"apiKey"} | {"type":"chatgpt","email":string|null,"planType":PlanType} | {"type":"amazonBedrock","usesCodexManagedCredentials":boolean}`.

`GetAccountRateLimitsResponse`: `rateLimits: RateLimitSnapshot` (backward-compatible single-bucket view), `rateLimitsByLimitId: map<string, RateLimitSnapshot> | null` (multi-bucket, keyed by metered `limit_id` such as `codex`), `rateLimitResetCredits: RateLimitResetCreditsSummary | null`, `accountId: string | null`, `rateLimitUpsell: JsonValue | null`.

`RateLimitSnapshot = {limitId, limitName, primary: RateLimitWindow|null, secondary: RateLimitWindow|null, credits, individualLimit, spendControlReached: boolean|null, planType: PlanType|null, rateLimitReachedType: RateLimitReachedType|null}`.
`RateLimitWindow = {usedPercent: number, windowDurationMins: number|null, resetsAt: number|null}`.

`account/rateLimits/updated` is described as a **sparse rolling update**: `{rateLimits: RateLimitSnapshot}`. Merge available values into your last `account/rateLimits/read` snapshot or refetch; nullable account metadata may be absent in a rolling update and must **not** clear a previously observed value. Related methods: `account/login/start`, `account/login/cancel`, `account/logout`, `account/rateLimitResetCredit/consume`, `account/workspaceMessages/read`, `account/sendAddCreditsNudgeEmail`.

### 7.5 Cheap inventory reads (one line each)

- `app/list` —params `{cursor?, limit?, threadId?, forceRefetch?}` —`{data: AppInfo[], nextCursor}`; `AppInfo` carries `id, name, description, logoUrl, branding, isAccessible, isEnabled, …`. EXPERIMENTAL.
- `skills/list` —params `{cwds?: string[], forceReload?: boolean}` (empty `cwds` = session cwd) —`{data: SkillsListEntry[]}` with `SkillsListEntry = {cwd, skills: SkillMetadata[], errors: SkillErrorInfo[]}`.
- `hooks/list` —params `{cwds?: string[]}` —`{data: HooksListEntry[]}` with `HooksListEntry = {cwd, hooks: HookMetadata[], warnings: string[], errors: HookErrorInfo[]}`.
- `mcpServerStatus/list` —params `{cursor?, limit?, detail?: McpServerStatusDetail|null, threadId?}` —`{data: McpServerStatus[], nextCursor}` with `McpServerStatus = {name, runtimeStatus, pluginId, serverInfo, tools, resources, resourceTemplates, authStatus}`.
- Also available, same style: `plugin/list`, `plugin/installed`, `plugin/read`, `marketplace/*`, `experimentalFeature/list`, `configRequirements/read`, `modelProvider/capabilities/read`, `skills/config/write`, `mcpServer/resource/read`, `mcpServer/tool/call`, `fs/*` (read/write/watch/copy/remove on absolute paths), and `fuzzyFileSearch`.

---

## 8. Versioning & pitfalls

### 8.1 v1 vs v2 naming

- The v2 names are the ones in `ClientRequest.json` / `ServerRequest.json` / `ServerNotification.json` and they are what 0.153.4 serves. **Prefer v2 everywhere.**
- Only four types remain under `codex-schema/v1/`: `InitializeParams`, `InitializeResponse` —i.e. `initialize` itself is a v1-named method, and that is correct and current.
- The genuinely legacy **server requests** to avoid are `execCommandApproval` and `applyPatchApproval` (§6.1). Their replacements are `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
- The user-input method is `item/tool/requestUserInput` —the `item/tool/` prefix is part of the v2 name; do not shorten it to `tool/requestUserInput`.
- `ThreadHistoryMode` is `legacy | paginated`; paginated threads are the current default (`historyMode: "paginated"` observed). Full-history hydration into `Thread.turns` is deprecated for paginated threads —prefer `thread/turns/list` + `thread/items/list`.
- `thread/rollback` is deprecated in favour of `thread/revert`.

### 8.2 Required vs optional fields that are easy to get wrong

| Question | Answer | Source |
|---|---|---|
| Does `thread/start` require `model`? | **No.** Every `ThreadStartParams` field is optional; the server falls back to its own config | `codex-ts/v2/ThreadStartParams.ts` |
| Must `turn/start` always include `cwd`? | **No.** Only `threadId` and `input` are required | `codex-ts/v2/TurnStartParams.ts` |
| Is `threadId` required on `turn/start`? | **Yes** | same |
| Is `input` required on `turn/start`? | **Yes** | same |
| Is `capabilities` required on `initialize`? | **No** —but if present, `experimentalApi` and `requestAttestation` are required members | `codex-schema/v1/InitializeParams.json` |
| Is `kind` required on the command approval request? | **No** —it is optional and "Defaults to `command` for older servers" | `codex-ts/v2/CommandExecutionRequestApprovalParams.ts` |
| Is `environmentId` required there? | **No**, it is `string \| null` and optional | same |
| Is `scope` required in the permissions approval response? | **No** —optional, defaults server-side | `codex-ts/v2/PermissionsRequestApprovalResponse.ts` |
| Does `initialize` send `clientInfo.title`? | Optional; `name` and `version` are required | `codex-ts/ClientInfo.ts` |
| `turn/start` effort field name? | `effort`, **not** `reasoningEffort` | `codex-ts/v2/TurnStartParams.ts` |
| `turn/start` sandbox field name? | `sandboxPolicy` (object), while `thread/start` uses `sandbox` (string enum) | `TurnStartParams.ts` / `ThreadStartParams.ts` |
| Snake_case leaks | `TextUserInput.text_elements`, `PatchChangeKind.update.move_path`, `ToolRequestUserInputQuestion` ids are user-defined, approval `acceptWithExecpolicyAmendment`'s inner key is `execpolicy_amendment` | schema union member names |
| Response envelopes | The server omits `jsonrpc` on output and uses bare `{"id", "result"}` / `{"id", "error"}` | observed |
| Result shapes for mutations | `thread/name/set`, `thread/archive`, `thread/delete`, `thread/compact/start` return `{}` (`Record<string, never>`), not `null` | `codex-ts/v2/Thread*Response.ts` |

### 8.3 Experimental gating

- Opt in once: `capabilities.experimentalApi = true`. There is no per-request flag.
- Schema-level `EXPERIMENTAL` markers cluster on the whole thread/turn/item family and on `apps/*`, `thread/realtime/*`, `PlanDeltaNotification`, `review/start`'s response, and the paginated-list responses. If you set `experimentalApi: false`, expect those methods/notifications to be withheld or rejected.
- `optOutNotificationMethods` lets you suppress specific notifications per connection (e.g. `thread/started` when you already have the thread from `thread/start`'s response). It takes **exact** method names.
- Marked `[UNSTABLE]` in the bindings: `Thread.path`, `FileChangeRequestApprovalParams.grantRoot`, and the `chatgptAuthTokens` login path ("FOR OPENAI INTERNAL USE ONLY - DO NOT USE").

### 8.4 Operational pitfalls observed or implied

1. **Threads are scoped to the app-server process.** A thread started under one `codex app-server` process is not resolvable from a new process that never resumed it: `turn/start` with a foreign id returned `{"error":{"code":-32600,"message":"thread not found: 01a0fe6c-..."}}`. Persist thread ids and always `thread/resume` (or `thread/read`) after a server restart.
2. The `Turn` returned by `turn/start` is a stub (`itemsView: "notLoaded"`, `items: []`, null timestamps). Do not render it as final state.
3. `turn/completed` carries a `summary` view of items, not the full turn. Merge deltas you already received, or refetch with `thread/items/list`.
4. Do not assume `item/fileChange/outputDelta` will ever arrive —it is documented as no longer emitted; use `item/fileChange/patchUpdated`.
5. `warning` notifications are routine and non-fatal (missing model metadata triggers one). Only `error`/`turn.status === "failed"` indicate turn failure.
6. `thread/status/changed` to `{"type":"active","activeFlags":["waitingOnApproval"]}` is the reliable signal that a human decision is pending; `activeFlags` clears once it is resolved. `waitingOnUserInput` accompanies `item/tool/requestUserInput`.
7. Every server request must be answered —including with `decline`/`cancel` —or the turn stays parked in `waitingOnApproval`/`waitingOnUserInput` indefinitely. `serverRequest/resolved` confirms closure.
8. Timestamp units differ (`*AtMs` vs `createdAt`/`updatedAt`/`startedAt` in seconds).

---

## 9. Worked end-to-end sequence

Literals below use the shapes verified against the bindings and the observed 0.153.4 wire. Line breaks are for readability; each message is **one line** on the wire.

**1. Client —server: initialize**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client","title":"My Client","version":"1.0.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":[]}}}
```

**2. Server —client: initialize result** (observed shape)

```json
{"id":1,"result":{"userAgent":"my-client/0.153.4 (Windows 10.0.26200; x86_64) unknown (my-client; 1.0.0)","codexHome":"C:\\\\Users\\\\you\\.codex","platformFamily":"windows","platformOs":"windows"}}
```

**3. Client —server: initialized notification** (no id, no params)

```json
{"jsonrpc":"2.0","method":"initialized"}
```

**4. Client —server: thread/start**

```json
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"D:\\\\work\\\\my-project","approvalPolicy":"on-request","sandbox":"workspace-write","personality":"pragmatic"}}
```

**5. Server —client: thread/start result** (truncated; note `turns: []`)

```json
{"id":2,"result":{"thread":{"id":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","sessionId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","preview":"","historyMode":"paginated","modelProvider":"openai","model":"gpt-6.1-sol","reasoningEffort":"medium","createdAt":1790975278,"updatedAt":1790975278,"status":{"type":"idle"},"cwd":"D:\\\\work\\\\my-project","cliVersion":"0.153.4","source":"vscode","name":null,"turns":[]},"model":"gpt-6.1-sol","modelProvider":"openai","serviceTier":null,"cwd":"D:\\\\work\\\\my-project","instructionSources":[],"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"reasoningEffort":"medium"}}
```

**6. Server —client: thread/started** (identical thread object; suppressible via `optOutNotificationMethods`)

```json
{"method":"thread/started","params":{"thread":{"id":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","sessionId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","preview":"","historyMode":"paginated","modelProvider":"openai","model":"gpt-6.1-sol","reasoningEffort":"medium","createdAt":1790975278,"updatedAt":1790975278,"status":{"type":"idle"},"cwd":"D:\\\\work\\\\my-project","cliVersion":"0.153.4","source":"vscode","name":null,"turns":[]}},"emittedAtMs":1790975278610}
```

**7. Client —server: turn/start**

```json
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","input":[{"type":"text","text":"Use your shell tool to run the command: echo DSH_PROBE_OK"}]}}
```

**8. Server —client: turn/start result** (stub turn —record `turn.id`)

```json
{"id":3,"result":{"turn":{"id":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
```

**9. Server —client: thread/status/changed —active**

```json
{"method":"thread/status/changed","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","status":{"type":"active","activeFlags":[]}},"emittedAtMs":1790975279262}
```

**10. Server —client: turn/started**

```json
{"method":"turn/started","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turn":{"id":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1790975279,"completedAt":null,"durationMs":null}},"emittedAtMs":1790975279262}
```

**11. Server —client: item/started (userMessage) then item/completed**

```json
{"method":"item/started","params":{"item":{"type":"userMessage","id":"01a0fe72-010d-7681-8103-0e13cc488397","clientId":null,"content":[{"type":"text","text":"Use your shell tool to run the command: echo DSH_PROBE_OK","text_elements":[]}]},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","startedAtMs":1790975279373},"emittedAtMs":1790975279375}
```

```json
{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0fe72-010d-7681-8103-0e13cc488397","clientId":null,"content":[{"type":"text","text":"Use your shell tool to run the command: echo DSH_PROBE_OK","text_elements":[]}]},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","completedAtMs":1790975279374},"emittedAtMs":1790975279384}
```

**12. Server —client: item/started (agentMessage, empty text) then a stream of deltas**

```json
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_083e248f2b7d6137016ac01d35b44487d28f539cfe922d45ec","text":"","phase":"commentary","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","startedAtMs":1790975286394},"emittedAtMs":1790975286395}
```

```json
{"method":"item/agentMessage/delta","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","itemId":"msg_083e248f2b7d6137016ac01d35b44487d28f539cfe922d45ec","delta":"I"},"emittedAtMs":1790975286949}
```

```json
{"method":"item/agentMessage/delta","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","itemId":"msg_083e248f2b7d6137016ac01d35b44487d28f539cfe922d45ec","delta":"’ll"},"emittedAtMs":1790975287618}
```

**13. Server —client: item/completed for the commentary message** (concatenated text; `phase: "commentary"`)

```json
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_083e248f2b7d6137016ac01d35b44487d28f539cfe922d45ec","text":"I’ll run the command in the shell now.\n","phase":"commentary","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","completedAtMs":1790975290435},"emittedAtMs":1790975290444}
```

**14. Server —client: thread/status/changed with the approval flag**

```json
{"method":"thread/status/changed","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","status":{"type":"active","activeFlags":["waitingOnApproval"]}},"emittedAtMs":1790975290853}
```

**15. Server —client: item/started (commandExecution)**

```json
{"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_LNAfRUrKKmZUnx87eVUKmChQ","pluginId":null,"scriptPath":null,"command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo DSH_PROBE_OK'","cwd":"D:\\\\work\\\\my-project","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"echo DSH_PROBE_OK"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","startedAtMs":1790975290864},"emittedAtMs":1790975290864}
```

**16. Server —client: REQUEST `item/commandExecution/requestApproval` (id `0`)**

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","itemId":"call_LNAfRUrKKmZUnx87eVUKmChQ","startedAtMs":1790975290848,"environmentId":"local","command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo DSH_PROBE_OK'","cwd":"D:\\\\work\\\\my-project","commandActions":[{"type":"unknown","command":"echo DSH_PROBE_OK"}],"proposedExecpolicyAmendment":["echo","DSH_PROBE_OK"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo","DSH_PROBE_OK"]}},"cancel"]}}
```

**17. Client —server: approval response** (`always allow` = `acceptForSession`; `accept` = once; `decline`/`cancel` = refuse)

```json
{"jsonrpc":"2.0","id":0,"result":{"decision":"acceptForSession"}}
```

**18. Server —client: serverRequest/resolved + status flag cleared**

```json
{"method":"serverRequest/resolved","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","requestId":0},"emittedAtMs":1790975290932}
```

```json
{"method":"thread/status/changed","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","status":{"type":"active","activeFlags":[]}},"emittedAtMs":1790975290938}
```

**19. Server —client: command output deltas, then item/completed for the command**

```json
{"method":"item/commandExecution/outputDelta","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","itemId":"call_LNAfRUrKKmZUnx87eVUKmChQ","delta":"DSH_PROBE_OK"},"emittedAtMs":1790975296824}
```

```json
{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_LNAfRUrKKmZUnx87eVUKmChQ","pluginId":null,"scriptPath":null,"command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo DSH_PROBE_OK'","cwd":"D:\\\\work\\\\my-project","processId":"50107","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"unknown","command":"echo DSH_PROBE_OK"}],"aggregatedOutput":"DSH_PROBE_OK\r\n","exitCode":0,"durationMs":428},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","completedAtMs":1790975296842},"emittedAtMs":1790975296963}
```

**20. Server —client: token usage update**

```json
{"method":"thread/tokenUsage/updated","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","tokenUsage":{"total":{"totalTokens":14253,"inputTokens":14191,"cachedInputTokens":3968,"cacheWriteInputTokens":0,"outputTokens":62,"reasoningOutputTokens":0},"last":{"totalTokens":14253,"inputTokens":14191,"cachedInputTokens":3968,"cacheWriteInputTokens":0,"outputTokens":62,"reasoningOutputTokens":0},"modelContextWindow":258400}},"emittedAtMs":1790975297144}
```

**21. Server —client: final-answer agentMessage start, deltas, completion** (`phase: "final_answer"`)

```json
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_08dcb523f1c2a729016ac01d4678a887d292403bd10b9725a5","text":"","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","startedAtMs":1790975302338},"emittedAtMs":1790975302338}
```

```json
{"method":"item/agentMessage/delta","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","itemId":"msg_08dcb523f1c2a729016ac01d4678a887d292403bd10b9725a5","delta":"```text\nDS"},"emittedAtMs":1790975302445}
```

```json
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_08dcb523f1c2a729016ac01d4678a887d292403bd10b9725a5","text":"```text\nDSH_PROBE_OK\n```","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","completedAtMs":1790975302663},"emittedAtMs":1790975302672}
```

**22. Server —client: thread idle, then turn/completed**

```json
{"method":"thread/status/changed","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","status":{"type":"idle"}},"emittedAtMs":1790975302776}
```

```json
{"method":"turn/completed","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turn":{"id":"01a0fe72-0004-70e2-abd7-1d2f3365eb30","items":[{"type":"agentMessage","id":"msg_08dcb523f1c2a729016ac01d4678a887d292403bd10b9725a5","text":"```text\nDSH_PROBE_OK\n```","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1790975279,"completedAt":1790975302,"durationMs":23594}},"emittedAtMs":1790975302776}
```

**23. Client —server: next message on the same thread**

```json
{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","input":[{"type":"text","text":"Now summarize what you did."}]}}
```

**24. To stop the in-flight turn instead:**

```json
{"jsonrpc":"2.0","id":4,"method":"turn/interrupt","params":{"threadId":"01a0fe71-fcd9-7c62-b050-07bcabc75c19","turnId":"01a0fe72-0004-70e2-abd7-1d2f3365eb30"}}
```

```json
{"id":4,"result":{}}
```

…followed by a `turn/completed` whose `turn.status` is `"interrupted"`.

---

## Appendix: complete client-request method list

From `codex-schema/ClientRequest.json` (99 methods, in schema order):
`initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/delete`, `thread/unsubscribe`, `thread/name/set`, `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, `thread/metadata/update`, `thread/section/move`, `thread/unarchive`, `thread/compact/start`, `thread/shellCommand`, `thread/approveGuardianDeniedAction`, `thread/rollback`, `thread/revert`, `thread/list`, `threadSection/list`, `threadSection/create`, `threadSection/update`, `threadSection/delete`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/inject_items`, `skills/list`, `skills/extraRoots/set`, `hooks/list`, `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `plugin/list`, `plugin/installed`, `plugin/reconcile`, `plugin/read`, `plugin/skill/read`, `plugin/share/save`, `plugin/share/updateTargets`, `plugin/share/list`, `plugin/share/checkout`, `plugin/share/delete`, `app/read`, `app/list`, `app/installed`, `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/remove`, `fs/copy`, `fs/watch`, `fs/unwatch`, `skills/config/write`, `plugin/install`, `plugin/uninstall`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `model/list`, `modelProvider/capabilities/read`, `experimentalFeature/list`, `permissionProfile/list`, `experimentalFeature/enablement/set`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServerStatus/list`, `mcpServer/resource/read`, `mcpServer/tool/call`, `windowsSandbox/setupStart`, `windowsSandbox/readiness`, `account/login/start`, `account/login/cancel`, `account/logout`, `account/rateLimits/read`, `account/rateLimitResetCredit/consume`, `account/usage/read`, `account/workspaceMessages/read`, `account/sendAddCreditsNudgeEmail`, `feedback/upload`, `command/exec`, `command/exec/write`, `command/exec/terminate`, `command/exec/resize`, `config/read`, `externalAgentConfig/detect`, `externalAgentConfig/import`, `externalAgentConfig/import/recordHistory`, `externalAgentConfig/import/readHistories`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `account/read`, `fuzzyFileSearch`.
