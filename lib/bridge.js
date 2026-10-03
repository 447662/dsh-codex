/**
 * CodexBridge — the state machine between DSH's chat surface and Codex.
 *
 * Responsibilities:
 *   - own the app-server process and the durable session⇄thread bindings,
 *   - mirror Codex's thread/turn/item state in memory and fold streaming deltas
 *     into it, so a DSH surface can render incrementally (requirement 4) and
 *     show command output, file changes and errors (requirement 5),
 *   - route approvals and user-questions to the UI and the answers back to
 *     Codex (requirement 7),
 *   - never send the same user message twice (requirement 8).
 *
 * Nothing here paraphrases or summarises a task: the text the user submits is
 * handed to `turn/start` verbatim, and Codex's own thread stays the single
 * source of history.
 */
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServer, defaultRefusal } from './app-server.js'
import { BindingStore } from './bindings.js'
import { SessionMirror } from './session-mirror.js'

/** Where pasted/uploaded images are staged for Codex to read from disk. */
export const UPLOAD_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-native-codex-cli', 'uploads')

const NOTICE_METHODS = {
  error: 'error',
  warning: 'warning',
  guardianWarning: 'warning',
  deprecationNotice: 'info',
  configWarning: 'warning',
}
const NOTICE_CAP = 200
const AGGREGATE_CAP = 2 * 1024 * 1024

function nowMs() {
  return Date.now()
}

function newThreadView(thread) {
  return {
    threadId: thread.id,
    sessionId: thread.sessionId ?? null,
    name: thread.name ?? null,
    preview: thread.preview ?? '',
    cwd: thread.cwd ?? null,
    model: thread.model ?? null,
    modelProvider: thread.modelProvider ?? null,
    status: thread.status ?? null,
    gitInfo: thread.gitInfo ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    turnOrder: [],
    turns: {},
    notices: [],
    tokenUsage: null,
    activeTurnId: null,
    lastError: null,
    hydrated: false,
    updatedAtMs: nowMs(),
  }
}

function newTurnView(turn) {
  return {
    turnId: turn.id,
    status: turn.status ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
    error: turn.error ?? null,
    diff: null,
    plan: null,
    planExplanation: null,
    itemOrder: [],
    items: {},
  }
}

/** Fold one delta into the item it names. */
function applyItemDelta(item, kind, params) {
  const delta = typeof params.delta === 'string' ? params.delta : ''
  if (!delta) return
  const append = (key) => {
    const next = `${item[key] ?? ''}${delta}`
    item[key] = next.length > AGGREGATE_CAP ? next.slice(-AGGREGATE_CAP) : next
  }
  switch (kind) {
    case 'agentMessage':
      append('text')
      break
    case 'plan':
      append('text')
      break
    case 'reasoningText':
      item.reasoningText = `${item.reasoningText ?? ''}${delta}`
      break
    case 'reasoningSummary':
      item.summaryText = `${item.summaryText ?? ''}${delta}`
      break
    case 'commandOutput':
      append('aggregatedOutput')
      break
    case 'fileChangeOutput':
      append('outputText')
      break
    default:
      break
  }
}

export class CodexBridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.bin
   * @param {string[]} [options.args]
   * @param {'stdio'|'daemon'} [options.transport]
   * @param {boolean} [options.experimentalApi]
   * @param {string} [options.defaultApprovalPolicy]
   * @param {string} [options.defaultSandbox]
   * @param {string} [options.defaultModel]
   * @param {object} options.log
   */
  constructor(options) {
    super()
    this.setMaxListeners(0)
    this.log = options.log
    this.defaults = {
      approvalPolicy: options.defaultApprovalPolicy ?? 'on-request',
      sandbox: options.defaultSandbox ?? 'workspace-write',
      model: options.defaultModel || null,
    }
    this.server = new CodexAppServer({
      bin: options.bin,
      args: options.args,
      transport: options.transport,
      experimentalApi: options.experimentalApi,
      log: this.log,
    })
    this.store = new BindingStore(this.log)
    /**
     * Set by the host entry: `(sessionId) => Session | undefined`. Without it
     * mirroring stays inert and the plugin still works — the browser dock
     * renders the Codex conversation instead of the DSH chat view.
     */
    this.sessionResolver = null
    this.mirror = new SessionMirror({ resolveSession: (id) => this.sessionResolver?.(id), log: this.log })
    /** `${threadId}:${codexTurnId}` -> mirror key, so completion can close it. */
    this.mirrorKeys = new Map()
    /**
     * Set once the server rejects `thread/turns/list` ("list_turns is not
     * supported yet" on the shipping Codex build), so history paging stops being
     * attempted and `thread/resume` stays the sole history source.
     */
    this.historyPagingUnsupported = false
    /** @type {Map<string, ReturnType<typeof newThreadView>>} */
    this.threads = new Map()
    /** Touched thread ids awaiting a flush to subscribers. */
    this._dirty = new Set()
    this._flushTimer = null

    this.server.on('notification', (msg) => this._onNotification(msg))
    this.server.on('server-request', (entry) => this._onServerRequest(entry))
    this.server.on('server-request-resolved', (payload) => this._publish({ type: 'approval-resolved', ...payload }))
    this.server.on('exit', (info) => {
      // The child owns every live turn; mark the mirror as stale rather than
      // pretending the turns are still running.
      for (const view of this.threads.values()) {
        if (view.activeTurnId) {
          const turn = view.turns[view.activeTurnId]
          if (turn && turn.status === 'inProgress') turn.status = 'interrupted'
          view.activeTurnId = null
        }
      }
      this._publish({ type: 'app-server-exit', info })
      this._markDirty([...this.threads.keys()])
    })
  }

  // ---------------------------------------------------------------- lifecycle

  async status() {
    await this.server.start()
    return {
      appServer: this.server.info,
      pendingApprovals: this.server.pendingServerRequests(),
      bindings: this.store.list(),
      panel: this.store.getPanelState(),
      defaults: this.defaults,
      threads: [...this.threads.values()].map((view) => ({
        threadId: view.threadId,
        name: view.name,
        cwd: view.cwd,
        turns: view.turnOrder.length,
      })),
    }
  }

  async restart() {
    await this.server.stop('restart requested')
    this.threads.clear()
    this.store.flush()
    await this.server.start()
    return this.status()
  }

  dispose() {
    this.store.dispose()
  }

  // ------------------------------------------------------------ subscriptions

  /** Subscribe to bridge events. Returns an unsubscribe function. */
  subscribe(listener) {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  _publish(payload) {
    this.emit('event', payload)
  }

  _markDirty(threadIds) {
    for (const threadId of threadIds) if (threadId) this._dirty.add(threadId)
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      const ids = [...this._dirty]
      this._dirty.clear()
      for (const threadId of ids) {
        const view = this.threads.get(threadId)
        if (view) this._publish({ type: 'thread', thread: serialiseThread(view) })
      }
    }, 60)
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref()
  }

  _threadFor(threadId) {
    return this.threads.get(threadId) ?? null
  }

  _ensureThread(thread) {
    let view = this.threads.get(thread.id)
    if (!view) {
      view = newThreadView(thread)
      this.threads.set(thread.id, view)
    } else {
      // Refresh mutable metadata without dropping mirrored turns/items.
      view.sessionId = thread.sessionId ?? view.sessionId
      view.name = thread.name ?? view.name
      view.preview = thread.preview ?? view.preview
      view.cwd = thread.cwd ?? view.cwd
      view.model = thread.model ?? view.model
      view.modelProvider = thread.modelProvider ?? view.modelProvider
      view.status = thread.status ?? view.status
      view.gitInfo = thread.gitInfo ?? view.gitInfo
      view.updatedAt = thread.updatedAt ?? view.updatedAt
    }
    return view
  }

  _ensureTurn(view, turn) {
    let turnView = view.turns[turn.id]
    if (!turnView) {
      turnView = newTurnView(turn)
      view.turns[turn.id] = turnView
      view.turnOrder.push(turn.id)
    } else {
      turnView.status = turn.status ?? turnView.status
      turnView.startedAt = turn.startedAt ?? turnView.startedAt
      turnView.completedAt = turn.completedAt ?? turnView.completedAt
      turnView.durationMs = turn.durationMs ?? turnView.durationMs
      if (turn.error !== undefined) turnView.error = turn.error
    }
    for (const item of turn.items ?? []) this._upsertItem(turnView, item)
    return turnView
  }

  _upsertItem(turnView, item) {
    if (!item?.id) return
    const existing = turnView.items[item.id]
    if (existing) {
      // Keep any text this side accumulated before the authoritative item
      // arrived, but let Codex's fields win for everything else.
      turnView.items[item.id] = { ...existing, ...item }
    } else {
      turnView.items[item.id] = { ...item }
      turnView.itemOrder.push(item.id)
    }
  }

  // ---------------------------------------------------------- notification fan

  _onNotification(msg) {
    const { method, params } = msg
    this._publish({ type: 'wire', method, params })

    switch (method) {
      case 'thread/started':
        if (params?.thread) {
          this._ensureThread(params.thread)
          this._markDirty([params.thread.id])
        }
        return
      case 'thread/status/changed': {
        const view = this._threadFor(params?.threadId)
        if (view) {
          view.status = params.status ?? view.status
          this._markDirty([view.threadId])
        }
        return
      }
      case 'thread/name/updated': {
        const view = this._threadFor(params?.threadId)
        if (view) {
          view.name = params.threadName ?? null
          const binding = this.store.findByThreadId(view.threadId)
          if (binding) this.store.put(binding.dshSessionId, { threadName: view.name })
          this._markDirty([view.threadId])
        }
        return
      }
      case 'thread/tokenUsage/updated': {
        const view = this._threadFor(params?.threadId)
        if (view) {
          view.tokenUsage = params.tokenUsage ?? null
          this._markDirty([view.threadId])
        }
        return
      }
      case 'thread/compacted':
      case 'thread/queue/changed':
      case 'thread/closed':
        this._markDirty([params?.threadId])
        return
      case 'turn/started': {
        const view = this._ensureThread({ id: params.threadId })
        const turnView = this._ensureTurn(view, params.turn)
        view.activeTurnId = turnView.turnId
        this._markDirty([view.threadId])
        return
      }
      case 'turn/completed': {
        const view = this._ensureThread({ id: params.threadId })
        this._ensureTurn(view, params.turn)
        if (view.activeTurnId === params.turn?.id) view.activeTurnId = null
        const binding = this.store.findByThreadId(view.threadId)
        if (binding) this.store.put(binding.dshSessionId, { lastTurnId: params.turn?.id ?? null, lastTurnStatus: params.turn?.status ?? null })

        // Close the mirrored DSH turn with whatever Codex said.
        const mirrorKey = this.mirrorKeys.get(`${view.threadId}:${params.turn?.id}`)
        if (mirrorKey) {
          this.mirrorKeys.delete(`${view.threadId}:${params.turn?.id}`)
          const mirrorTurn = view.turns[params.turn?.id]
          const texts = mirrorTurn
            ? mirrorTurn.itemOrder.map((id) => mirrorTurn.items[id]).filter((item) => item?.type === 'agentMessage' && item.text).map((item) => item.text)
            : []
          const status = String(params.turn?.status ?? '')
          const reason = status.includes('interrupt') ? 'interrupted' : status.includes('fail') ? 'failed' : 'completed'
          try {
            this.mirror.finishTurn(mirrorKey, texts, reason)
          } catch (error) {
            this.log.warn('session mirror finishTurn failed', error)
          }
        }

        this._markDirty([view.threadId])
        return
      }
      case 'turn/diff/updated': {
        const view = this._threadFor(params?.threadId)
        const turnView = view?.turns[params.turnId]
        if (turnView) {
          turnView.diff = params.diff ?? null
          this._markDirty([view.threadId])
        }
        return
      }
      case 'turn/plan/updated': {
        const view = this._threadFor(params?.threadId)
        const turnView = view?.turns[params.turnId]
        if (turnView) {
          turnView.plan = params.plan ?? null
          turnView.planExplanation = params.explanation ?? null
          this._markDirty([view.threadId])
        }
        return
      }
      case 'item/started': {
        const view = this._threadFor(params?.threadId)
        if (!view) return
        const turnView = view.turns[params.turnId]
        if (!turnView) return
        this._upsertItem(turnView, params.item)
        this._markDirty([view.threadId])
        return
      }
      case 'item/completed': {
        const view = this._threadFor(params?.threadId)
        if (!view) return
        const turnView = view.turns[params.turnId]
        if (!turnView) return
        this._upsertItem(turnView, params.item)
        this._markDirty([view.threadId])
        return
      }
      case 'item/agentMessage/delta':
        this._delta(params, 'agentMessage')
        return
      case 'item/plan/delta':
        this._delta(params, 'plan')
        return
      case 'item/reasoning/textDelta':
        this._delta(params, 'reasoningText')
        return
      case 'item/reasoning/summaryTextDelta':
        this._delta(params, 'reasoningSummary')
        return
      case 'item/commandExecution/outputDelta':
        this._delta(params, 'commandOutput')
        return
      case 'item/fileChange/outputDelta':
        this._delta(params, 'fileChangeOutput')
        return
      case 'item/fileChange/patchUpdated': {
        const view = this._threadFor(params?.threadId)
        const turnView = view?.turns[params.turnId]
        const item = turnView?.items[params.itemId]
        if (item && params.changes) item.changes = params.changes
        else if (item && params.patch) item.patch = params.patch
        this._markDirty([params?.threadId])
        return
      }
      case 'item/mcpToolCall/progress': {
        const view = this._threadFor(params?.threadId)
        const turnView = view?.turns[params.turnId]
        const item = turnView?.items[params.itemId]
        if (item) item.progress = params.message ?? params.progress ?? null
        this._markDirty([params?.threadId])
        return
      }
      case 'item/commandExecution/terminalInteraction': {
        const view = this._threadFor(params?.threadId)
        const turnView = view?.turns[params.turnId]
        const item = turnView?.items[params.itemId]
        if (item) {
          item.terminalInteraction = `${item.terminalInteraction ?? ''}${params.stdin ?? params.data ?? ''}`
        }
        this._markDirty([params?.threadId])
        return
      }
      case 'serverRequest/resolved': {
        const view = this._threadFor(params?.threadId)
        if (view) {
          view.pendingRequestIds = (view.pendingRequestIds ?? []).filter((id) => id !== params?.requestId)
          this._markDirty([view.threadId])
        }
        return
      }
      case 'error': {
        const threadId = params?.threadId
        const view = threadId ? this._threadFor(threadId) : null
        const notice = {
          id: `err-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`,
          level: 'error',
          at: nowMs(),
          turnId: params?.turnId ?? null,
          message: describeError(params?.error),
        }
        if (view) {
          view.lastError = notice
          view.notices.push(notice)
          this._trimNotices(view)
          this._markDirty([view.threadId])
        }
        this._publish({ type: 'notice', threadId: threadId ?? null, notice })
        return
      }
      default:
        break
    }

    const level = NOTICE_METHODS[method]
    if (level) {
      const threadId = params?.threadId ?? null
      const notice = {
        id: `n-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`,
        level,
        at: nowMs(),
        method,
        turnId: params?.turnId ?? null,
        message: params?.message ?? params?.summary ?? describeError(params) ?? method,
      }
      const view = threadId ? this._threadFor(threadId) : null
      if (view) {
        view.notices.push(notice)
        this._trimNotices(view)
        this._markDirty([view.threadId])
      }
      this._publish({ type: 'notice', threadId, notice })
    }
  }

  _trimNotices(view) {
    if (view.notices.length > NOTICE_CAP) view.notices.splice(0, view.notices.length - NOTICE_CAP)
  }

  _delta(params, kind) {
    const view = this._threadFor(params?.threadId)
    if (!view) return
    const turnView = view.turns[params.turnId]
    if (!turnView) return
    let item = turnView.items[params.itemId]
    if (!item) {
      // A delta can beat its `item/started` when the UI subscribes late; keep a
      // stub so no streamed text is lost.
      item = { id: params.itemId, type: kindToItemType(kind) }
      turnView.items[params.itemId] = item
      turnView.itemOrder.push(params.itemId)
    }
    applyItemDelta(item, kind, params)
    this._markDirty([view.threadId])
  }

  // -------------------------------------------------------- server-side asks

  _onServerRequest(entry) {
    // Record which thread the ask belongs to so a reopened UI can re-surface it.
    const threadId = entry.params?.threadId ?? entry.params?.conversationId ?? null
    const view = threadId ? this._threadFor(threadId) : null
    if (view) {
      view.pendingRequestIds = [...(view.pendingRequestIds ?? []), entry.requestId]
      this._markDirty([view.threadId])
    }
    this._publish({ type: 'approval', request: serialiseServerRequest(entry) })
  }

  /**
   * Answer an approval / question. `response` must already be in Codex's wire
   * shape; {@link buildApprovalResponse} turns a UI choice into one.
   */
  answerRequest(requestId, response) {
    const ok = this.server.answerServerRequest(requestId, response)
    if (ok) {
      for (const view of this.threads.values()) {
        if (view.pendingRequestIds?.includes(String(requestId))) {
          view.pendingRequestIds = view.pendingRequestIds.filter((id) => id !== String(requestId))
          this._markDirty([view.threadId])
        }
      }
    }
    return ok
  }

  refuseRequest(requestId) {
    const pending = this.server.pendingServerRequests().find((r) => r.requestId === String(requestId))
    if (!pending) return false
    return this.answerRequest(requestId, defaultRefusal(pending.method))
  }

  // --------------------------------------------------------------- thread ops

  /** Create a brand new Codex thread (requirement 2). */
  async createThread({ dshSessionId, cwd, model, approvalPolicy, sandbox, permissionProfile, ephemeral } = {}) {
    const params = {}
    if (cwd) params.cwd = cwd
    if (model) params.model = model
    params.approvalPolicy = normaliseApprovalPolicy(approvalPolicy ?? this.defaults.approvalPolicy)
    params.sandbox = normaliseSandbox(sandbox ?? this.defaults.sandbox)
    if (ephemeral !== undefined) params.ephemeral = Boolean(ephemeral)

    const result = await this.server.request('thread/start', params)
    const view = this._ensureThread(result.thread)
    view.hydrated = true

    let binding = null
    if (dshSessionId) {
      binding = this.store.put(dshSessionId, {
        // Creating/attaching always (re)activates the association: a binding
        // left suspended by "交还 DSH" must not stay invisible after a new
        // thread is created for the same session.
        active: true,
        threadId: result.thread.id,
        cwd: result.cwd ?? cwd ?? null,
        model: result.model ?? model ?? null,
        modelProvider: result.modelProvider ?? null,
        approvalPolicy: result.approvalPolicy ?? params.approvalPolicy,
        sandbox: result.sandbox ?? params.sandbox,
        permissionProfile: permissionProfile ?? null,
        reasoningEffort: result.reasoningEffort ?? null,
        threadName: result.thread.name ?? null,
        createdAt: nowMs(),
        lastTurnId: null,
        lastTurnStatus: null,
      })
    }
    this.store.setPanelState({ lastThreadId: result.thread.id })
    this._markDirty([result.thread.id])
    return { binding, thread: serialiseThread(view), raw: { cwd: result.cwd, model: result.model, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy } }
  }

  /**
   * Attach an existing Codex thread to a DSH session and restore its history
   * (requirement 1). Resumes first — that is what makes Codex treat the thread
   * as live for follow-up turns — then falls back to a plain read.
   */
  async attachThread({ dshSessionId, threadId, cwd, model, approvalPolicy, sandbox } = {}) {
    if (!threadId) throw new Error('attachThread requires threadId')
    const params = { threadId }
    if (cwd) params.cwd = cwd
    if (model) params.model = model

    let thread = null
    let raw = null
    try {
      raw = await this.server.request('thread/resume', {
        ...params,
        ...(approvalPolicy ? { approvalPolicy: normaliseApprovalPolicy(approvalPolicy) } : {}),
        ...(sandbox ? { sandbox: normaliseSandbox(sandbox) } : {}),
      })
      thread = raw?.thread ?? null
    } catch (error) {
      this.log.warn('thread/resume failed, falling back to thread/read', error?.message ?? error)
    }
    if (!thread) {
      const read = await this.server.request('thread/read', { threadId, includeTurns: false })
      thread = read?.thread
    }
    if (!thread) throw new Error(`Codex returned no thread for ${threadId}`)

    this._ensureThread(thread)
    // `thread/resume` no longer replays turns — history is paginated now — so
    // pull it explicitly. Without this a reopened conversation looks empty.
    let hydrated
    try {
      hydrated = await this.hydrateHistory(thread.id)
    } catch (error) {
      this.log.warn('history hydration failed', error?.message ?? error)
      hydrated = this._ensureThread(thread)
    }
    const view = hydrated ?? this.threads.get(thread.id)

    const lastTurnId = view.turnOrder.at(-1) ?? null
    let binding = null
    if (dshSessionId) {
      binding = this.store.put(dshSessionId, {
        // Attaching resumes the association, including a suspended one.
        active: true,
        threadId: thread.id,
        cwd: raw?.cwd ?? thread.cwd ?? cwd ?? null,
        model: raw?.model ?? thread.model ?? model ?? null,
        modelProvider: raw?.modelProvider ?? thread.modelProvider ?? null,
        approvalPolicy: raw?.approvalPolicy ?? this.defaults.approvalPolicy,
        sandbox: raw?.sandbox ?? this.defaults.sandbox,
        reasoningEffort: raw?.reasoningEffort ?? null,
        threadName: thread.name ?? null,
        lastTurnId,
        lastTurnStatus: lastTurnId ? view.turns[lastTurnId]?.status ?? null : null,
      })
    }
    this.store.setPanelState({ lastThreadId: thread.id })
    this._markDirty([thread.id])
    return { binding, thread: serialiseThread(this.threads.get(thread.id)) }
  }

  /**
   * Rebuild one thread's turns and items from Codex's own paginated history.
   *
   * IMPORTANT — this path is *optional*, and on the shipping Codex build it does
   * not work at all: `thread/turns/list` answers `list_turns is not supported
   * yet` (and `thread/read` with `includeTurns` errors out with the same
   * message). `thread/resume` is the API that actually returns a thread's turns,
   * which is why every caller feeds its result to {@link _ensureThread} first.
   *
   * Two consequences are encoded here:
   *   1. the existing view is NEVER cleared before a page succeeds — the earlier
   *      version emptied `turns` up front, so one rejected request wiped the very
   *      history `thread/resume` had just supplied and the UI showed
   *      "这个 Codex 线程还没有内容";
   *   2. once the server says the method is unsupported it is not tried again.
   *
   * @returns the rebuilt view, or null when paging is unavailable (the caller
   *   must then keep whatever `thread/resume` provided).
   */
  async hydrateHistory(threadId, { pageLimit = 50, maxPages = 20, backfillLimit = 20 } = {}) {
    const view = this.threads.get(threadId) ?? this._ensureThread({ id: threadId })
    if (this.historyPagingUnsupported) return null

    const collected = []
    try {
      let cursor = null
      let pages = 0
      do {
        const page = await this.server.request('thread/turns/list', {
          threadId,
          limit: pageLimit,
          itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        })
        for (const turn of page?.data ?? []) collected.push(turn)
        cursor = page?.nextCursor ?? null
        pages += 1
      } while (cursor && pages < maxPages)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/not supported|not implemented|unknown method/i.test(message)) {
        this.historyPagingUnsupported = true
        this.log.warn('thread/turns/list is unsupported by this Codex build; using the thread/resume payload for history')
      } else {
        this.log.warn('history paging failed', message)
      }
      // Leave the current view untouched: it holds the resume payload's turns.
      return null
    }

    if (collected.length === 0) return null

    // Backfill items for the newest turns that arrived empty.
    const emptyTurns = collected.filter((turn) => !(turn.items ?? []).length).slice(-backfillLimit)
    for (const turn of emptyTurns) {
      try {
        const items = await this.server.request('thread/items/list', { threadId, turnId: turn.id, limit: 500 })
        if (items?.data?.length) turn.items = items.data
      } catch (error) {
        this.log.debug('item backfill failed for turn', turn.id, error?.message ?? error)
      }
    }

    collected.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    // Only now is it safe to swap the view's contents.
    view.turnOrder = []
    view.turns = {}
    for (const turn of collected) this._ensureTurn(view, turn)
    view.hydrated = true
    view.activeTurnId = collected.find((turn) => turn.status === 'inProgress')?.id ?? null
    this._markDirty([threadId])
    return view
  }

  /**
   * Read a thread (history) without binding it to a DSH session.
   *
   * `thread/resume` is attempted first because it is the only call that returns
   * a thread's turns on this Codex build; `thread/read` with `includeTurns`
   * fails with `list_turns is not supported yet`.
   */
  async readThread({ threadId, includeTurns = true } = {}) {
    let thread = null
    try {
      const resumed = await this.server.request('thread/resume', { threadId })
      thread = resumed?.thread ?? null
    } catch (error) {
      this.log.warn('thread/resume failed during readThread', error?.message ?? error)
    }
    if (!thread) {
      const read = await this.server.request('thread/read', { threadId, includeTurns: false })
      thread = read?.thread
    }
    if (!thread) throw new Error(`Codex returned no thread for ${threadId}`)
    this._ensureThread(thread)
    const view = (await this.hydrateHistory(threadId)) ?? this._ensureThread(thread)
    return { thread: serialiseThread(view) }
  }

  async listThreads({ cwd, limit = 50, cursor, searchTerm, archived = false } = {}) {
    const params = { limit, archived: Boolean(archived), useStateDbOnly: false }
    if (cwd) params.cwd = cwd
    if (cursor) params.cursor = cursor
    if (searchTerm) params.searchTerm = searchTerm
    const result = await this.server.request('thread/list', params)
    return { threads: (result?.data ?? []).map(summariseThread), nextCursor: result?.nextCursor ?? null }
  }

  async listLoadedThreads() {
    const result = await this.server.request('thread/loaded/list', { limit: 200 })
    return { threadIds: result?.data ?? [] }
  }

  async listTurns({ threadId, limit = 50, cursor, sortDirection } = {}) {
    const result = await this.server.request('thread/turns/list', {
      threadId,
      limit,
      ...(cursor ? { cursor } : {}),
      ...(sortDirection ? { sortDirection } : {}),
    })
    const view = this.threads.get(threadId)
    if (view) {
      for (const turn of result?.data ?? []) this._ensureTurn(view, turn)
      this._markDirty([threadId])
    }
    return { turns: (result?.data ?? []).map((turn) => ({ ...turn, items: turn.items ?? [] })), nextCursor: result?.nextCursor ?? null }
  }

  async listItems({ threadId, limit = 200, cursor } = {}) {
    const result = await this.server.request('thread/items/list', { threadId, limit, ...(cursor ? { cursor } : {}) })
    return { items: result?.data ?? [], nextCursor: result?.nextCursor ?? null }
  }

  async renameThread({ threadId, name }) {
    await this.server.request('thread/name/set', { threadId, name })
    const view = this.threads.get(threadId)
    if (view) {
      view.name = name
      this._markDirty([threadId])
    }
    const binding = this.store.findByThreadId(threadId)
    if (binding) this.store.put(binding.dshSessionId, { threadName: name })
    return { ok: true }
  }

  async archiveThread({ threadId, archived = true }) {
    await this.server.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId })
    return { ok: true }
  }

  async deleteThread({ threadId }) {
    await this.server.request('thread/delete', { threadId })
    const binding = this.store.findByThreadId(threadId)
    if (binding) this.store.remove(binding.dshSessionId)
    this.threads.delete(threadId)
    return { ok: true }
  }

  async unsubscribeThread({ threadId }) {
    return this.server.request('thread/unsubscribe', { threadId })
  }

  async listModels({ cursor, limit = 100 } = {}) {
    const result = await this.server.request('model/list', { limit, ...(cursor ? { cursor } : {}) })
    return {
      models: (result?.data ?? []).map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: Boolean(model.isDefault),
        hidden: Boolean(model.hidden),
        defaultReasoningEffort: model.defaultReasoningEffort ?? null,
        supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
          value: option.reasoningEffort,
          description: option.description,
        })),
      })),
      nextCursor: result?.nextCursor ?? null,
    }
  }

  async listPermissionProfiles({ cwd, cursor, limit = 100 } = {}) {
    const result = await this.server.request('permissionProfile/list', { limit, ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) })
    return {
      profiles: (result?.data ?? []).map((profile) => ({ id: profile.id, description: profile.description ?? null, allowed: Boolean(profile.allowed) })),
      nextCursor: result?.nextCursor ?? null,
    }
  }

  // ------------------------------------------------------------------ turn ops

  /**
   * Stage pasted/uploaded images on disk so Codex can read them.
   *
   * `turn/start`'s `UserInput` union takes `{type:'localImage', path}`, so the
   * bytes have to exist as a real file; the browser half hands over data URLs.
   * @param {Array<{dataUrl?: string, data?: string, mediaType?: string}>} images
   * @returns {Promise<string[]>} absolute paths, in submission order
   */
  async saveImages(images) {
    if (!Array.isArray(images) || images.length === 0) return []
    await mkdir(UPLOAD_DIR, { recursive: true })
    const paths = []
    for (const image of images.slice(0, 8)) {
      const raw = String(image?.dataUrl ?? image?.data ?? '')
      const match = /^data:([^;,]+);base64,(.+)$/is.exec(raw)
      const mediaType = String(image?.mediaType ?? match?.[1] ?? 'image/png')
      const base64 = match ? match[2] : raw
      if (!base64) continue
      const ext = mediaType.includes('jpeg') || mediaType.includes('jpg')
        ? 'jpg'
        : (mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
      const file = join(UPLOAD_DIR, `${randomUUID()}.${ext}`)
      await writeFile(file, Buffer.from(base64, 'base64'))
      paths.push(file)
    }
    return paths
  }

  /**
   * Submit a user message straight to Codex (requirement 3).
   *
   * `clientMessageId` is the idempotency key: replaying the same id (a reloaded
   * page, a retried request) returns the already-issued turn instead of handing
   * Codex a duplicate message.
   */
  async startTurn({ dshSessionId, text, clientMessageId, cwd, model, approvalPolicy, sandbox, reasoningEffort, threadId, images } = {}) {
    const hasImages = Array.isArray(images) && images.length > 0
    if (typeof text !== 'string' || (text.length === 0 && !hasImages)) {
      // An image-only message is legitimate: pasting a screenshot and hitting
      // send is the same gesture as in the Codex CLI.
      throw new Error('startTurn requires non-empty text or at least one image')
    }

    let binding = dshSessionId ? this.store.get(dshSessionId) : null
    let targetThreadId = threadId ?? binding?.threadId ?? null

    if (!targetThreadId) {
      const created = await this.createThread({
        dshSessionId,
        cwd: cwd ?? binding?.cwd,
        model: model ?? binding?.model,
        approvalPolicy: approvalPolicy ?? binding?.approvalPolicy,
        sandbox: sandbox ?? binding?.sandbox,
      })
      targetThreadId = created.thread.threadId
      binding = created.binding
    } else if (dshSessionId && binding && binding.threadId !== targetThreadId) {
      binding = this.store.put(dshSessionId, { threadId: targetThreadId, active: true })
    }

    if (clientMessageId && dshSessionId && this.store.hasSentClientMessage(dshSessionId, clientMessageId)) {
      const view = this.threads.get(targetThreadId)
      this.log.info('duplicate turn suppressed', clientMessageId, targetThreadId)
      return {
        deduplicated: true,
        threadId: targetThreadId,
        turnId: binding?.lastTurnId ?? null,
        turn: binding?.lastTurnId ? serialiseTurn(view?.turns[binding.lastTurnId]) : null,
      }
    }

    // Images ride along as `localImage` inputs (the UserInput variant Codex
    // accepts for an on-disk file), so pasting a screenshot works exactly like
    // attaching one in the Codex CLI.
    let imagePaths = []
    if (Array.isArray(images) && images.length > 0) {
      try {
        imagePaths = await this.saveImages(images)
      } catch (error) {
        this.log.warn('saving pasted images failed', error)
      }
    }

    const params = {
      threadId: targetThreadId,
      input: [
        ...(text ? [{ type: 'text', text }] : []),
        ...imagePaths.map((path) => ({ type: 'localImage', path })),
      ],
    }
    if (clientMessageId) params.clientUserMessageId = clientMessageId
    if (cwd) params.cwd = cwd
    if (model) params.model = model
    if (approvalPolicy) params.approvalPolicy = normaliseApprovalPolicy(approvalPolicy)
    if (sandbox) params.sandboxPolicy = normaliseSandboxPolicy(sandbox)
    if (reasoningEffort) params.effort = reasoningEffort

    let result
    try {
      result = await this.server.request('turn/start', params)
    } catch (error) {
      // Thread ids are process-scoped: after an app-server restart, an id we
      // still hold from the binding store is not resolvable until it is
      // resumed. Resume once and retry before surfacing the failure.
      if (!/thread not found|not loaded|no rollout|unknown thread/i.test(String(error?.message ?? ''))) throw error
      this.log.warn('turn/start could not resolve thread; resuming and retrying', targetThreadId)
      await this.server.request('thread/resume', {
        threadId: targetThreadId,
        ...(binding?.cwd ? { cwd: binding.cwd } : {}),
        ...(binding?.model ? { model: binding.model } : {}),
      })
      result = await this.server.request('turn/start', params)
    }
    const turn = result?.turn
    const view = this._ensureThread({ id: targetThreadId })
    if (turn) {
      this._ensureTurn(view, turn)
      view.activeTurnId = turn.id
    }
    if (dshSessionId) {
      if (clientMessageId) this.store.noteSentClientMessage(dshSessionId, clientMessageId)
      this.store.put(dshSessionId, { lastTurnId: turn?.id ?? null, lastTurnStatus: turn?.status ?? null })
    }
    // Record the exchange in the DSH session log so the session stays durable
    // and DSH can render it natively. Purely additive: the task already went to
    // Codex and mirroring failures never affect it.
    if (dshSessionId && turn?.id) {
      try {
        const key = this.mirror.beginTurn({
          sessionId: dshSessionId,
          threadId: targetThreadId,
          codexTurnId: turn.id,
          text,
          clientMessageId,
        })
        if (key) this.mirrorKeys.set(`${targetThreadId}:${turn.id}`, key)
      } catch (error) {
        this.log.warn('session mirror beginTurn failed', error)
      }
    }
    this._markDirty([targetThreadId])
    return { deduplicated: false, threadId: targetThreadId, turnId: turn?.id ?? null, turn: serialiseTurn(view.turns[turn?.id]) }
  }

  /** Interrupt the running turn in Codex itself (requirement 6). */
  async interruptTurn({ dshSessionId, threadId, turnId } = {}) {
    const binding = dshSessionId ? this.store.get(dshSessionId) : null
    const targetThreadId = threadId ?? binding?.threadId
    if (!targetThreadId) return { interrupted: false, reason: 'no Codex thread bound' }
    const view = this.threads.get(targetThreadId)
    const targetTurnId = turnId ?? view?.activeTurnId ?? binding?.lastTurnId ?? null

    // Refuse anything Codex is waiting on first: otherwise the interrupt lands
    // behind an approval prompt the user never answered.
    this.server.refusePendingServerRequests('turn interrupted')

    if (!targetTurnId) return { interrupted: false, threadId: targetThreadId, reason: 'no active turn' }

    // A Stop pressed immediately after Send can beat Codex's own turn
    // registration: `turn/start` answers with a stub before the turn is live,
    // so the first `turn/interrupt` may be told there is no active turn. Retry
    // briefly while our mirror still believes the turn is running.
    const deadline = Date.now() + 6000
    let lastError = null
    for (;;) {
      try {
        await this.server.request('turn/interrupt', { threadId: targetThreadId, turnId: targetTurnId })
        lastError = null
        break
      } catch (error) {
        const message = String(error?.message ?? '')
        if (!/no active turn/i.test(message)) throw error
        lastError = error
        const stillRunning = view?.turns[targetTurnId]?.status === 'inProgress'
        if (!stillRunning || Date.now() > deadline) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }

    if (lastError) {
      // The turn finished between the click and the request: that is the
      // outcome the user asked for, not an error.
      if (view) {
        const turnView = view.turns[targetTurnId]
        if (turnView && turnView.status === 'inProgress' && Date.now() > deadline) turnView.status = 'interrupted'
        view.activeTurnId = null
        this._markDirty([targetThreadId])
      }
      return { interrupted: false, threadId: targetThreadId, turnId: targetTurnId, reason: 'already settled' }
    }
    if (view) {
      const turnView = view.turns[targetTurnId]
      if (turnView && turnView.status === 'inProgress') turnView.status = 'interrupted'
      view.activeTurnId = null
      this._markDirty([targetThreadId])
    }
    return { threadId: targetThreadId, turnId: targetTurnId, interrupted: true }
  }

  async steerTurn({ dshSessionId, text, expectedTurnId } = {}) {
    const binding = dshSessionId ? this.store.get(dshSessionId) : null
    if (!binding?.threadId) throw new Error('steerTurn: no bound Codex thread')
    const result = await this.server.request('turn/steer', {
      threadId: binding.threadId,
      expectedTurnId,
      input: [{ type: 'text', text }],
    })
    return { turnId: result?.turnId ?? null }
  }

  // --------------------------------------------------------------- diagnostics

  /** Everything a reloading surface needs, in one payload. */
  async snapshot({ dshSessionId, threadId } = {}) {
    const binding = dshSessionId ? this.store.get(dshSessionId) : null
    const targetThreadId = threadId ?? binding?.threadId ?? null
    const view = targetThreadId ? this.threads.get(targetThreadId) : null
    return {
      appServer: this.server.info,
      binding,
      panel: this.store.getPanelState(),
      defaults: this.defaults,
      thread: view ? serialiseThread(view) : null,
      pendingApprovals: this.server.pendingServerRequests().map(serialiseServerRequest),
      threads: [...this.threads.keys()],
    }
  }
}

// ----------------------------------------------------------------- helpers

function kindToItemType(kind) {
  switch (kind) {
    case 'agentMessage':
      return 'agentMessage'
    case 'plan':
      return 'plan'
    case 'reasoningText':
    case 'reasoningSummary':
      return 'reasoning'
    case 'commandOutput':
      return 'commandExecution'
    case 'fileChangeOutput':
      return 'fileChange'
    default:
      return 'unknown'
  }
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    if (typeof error.message === 'string') return error.message
    if (typeof error.error === 'string') return error.error
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/** Map the UI's coarse choice onto Codex's wire decision objects. */
export function normaliseApprovalPolicy(value) {
  if (!value || typeof value !== 'string') return 'on-request'
  if (value === 'read-only') return 'on-request'
  if (value === 'untrusted' || value === 'on-request' || value === 'never') return value
  return 'on-request'
}

export function normaliseSandbox(value) {
  if (value === 'read-only' || value === 'read-only') return 'read-only'
  if (value === 'danger-full-access') return 'danger-full-access'
  if (value === 'workspace-write') return 'workspace-write'
  return 'workspace-write'
}

/** `turn/start` wants a structured SandboxPolicy, not a SandboxMode string. */
export function normaliseSandboxPolicy(value) {
  const mode = normaliseSandbox(value)
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

export function summariseThread(thread) {
  return {
    threadId: thread.id,
    sessionId: thread.sessionId ?? null,
    name: thread.name ?? null,
    preview: thread.preview ?? '',
    cwd: thread.cwd ?? null,
    model: thread.model ?? null,
    modelProvider: thread.modelProvider ?? null,
    status: thread.status ?? null,
    gitInfo: thread.gitInfo ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    turnCount: thread.turns?.length ?? 0,
  }
}

function serialiseTurn(turnView) {
  if (!turnView) return null
  return {
    ...turnView,
    items: turnView.itemOrder.map((id) => turnView.items[id]).filter(Boolean),
    itemOrder: undefined,
    itemsById: undefined,
  }
}

export function serialiseThread(view) {
  if (!view) return null
  return {
    threadId: view.threadId,
    sessionId: view.sessionId,
    name: view.name,
    preview: view.preview,
    cwd: view.cwd,
    model: view.model,
    modelProvider: view.modelProvider,
    status: view.status,
    gitInfo: view.gitInfo,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    activeTurnId: view.activeTurnId,
    hydrated: view.hydrated,
    tokenUsage: view.tokenUsage,
    lastError: view.lastError,
    notices: view.notices,
    pendingRequestIds: view.pendingRequestIds ?? [],
    turns: view.turnOrder.map((id) => {
      const turn = view.turns[id]
      return {
        turnId: turn.turnId,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        error: turn.error,
        diff: turn.diff,
        plan: turn.plan,
        planExplanation: turn.planExplanation,
        items: turn.itemOrder.map((itemId) => turn.items[itemId]).filter(Boolean),
      }
    }),
  }
}

export function serialiseServerRequest(entry) {
  return {
    requestId: entry.requestId,
    method: entry.method,
    params: entry.params,
    receivedAt: entry.receivedAt,
    kind: classifyServerRequest(entry.method),
  }
}

/** Group the six approval-ish server requests into UI categories. */
export function classifyServerRequest(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'command'
    case 'item/fileChange/requestApproval':
      return 'fileChange'
    case 'item/permissions/requestApproval':
      return 'permissions'
    case 'item/tool/requestUserInput':
      return 'question'
    case 'mcpServer/elicitation/request':
      return 'elicitation'
    case 'item/tool/call':
      return 'dynamicTool'
    case 'applyPatchApproval':
      return 'fileChange'
    case 'execCommandApproval':
      return 'command'
    default:
      return 'other'
  }
}

/**
 * Build the wire response for a UI choice.
 * @param {string} method server request method
 * @param {object} choice `{decision}` for approvals, `{answers}` for questions,
 *   `{permissions,scope}` for permission grants.
 */
export function buildApprovalResponse(method, choice = {}) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: normaliseCommandDecision(choice) }
    case 'item/fileChange/requestApproval':
      return { decision: normaliseFileDecision(choice) }
    case 'item/permissions/requestApproval':
      return {
        permissions: choice.permissions ?? {},
        ...(choice.scope ? { scope: choice.scope } : {}),
      }
    case 'item/tool/requestUserInput':
      return { answers: choice.answers ?? {} }
    case 'mcpServer/elicitation/request':
      return choice.response ?? { action: 'decline' }
    case 'item/tool/call':
      return { contentItems: choice.contentItems ?? [], success: Boolean(choice.success) }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: legacyDecision(choice.decision) }
    default:
      return choice.response ?? {}
  }
}

function normaliseCommandDecision(choice) {
  const decision = choice.decision ?? 'decline'
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') return decision
  if (decision === 'acceptWithExecpolicyAmendment') {
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: choice.execpolicyAmendment ?? [] } }
  }
  if (decision === 'applyNetworkPolicyAmendment') {
    return { applyNetworkPolicyAmendment: { network_policy_amendment: choice.networkPolicyAmendment ?? {} } }
  }
  return 'decline'
}

function normaliseFileDecision(choice) {
  const decision = choice.decision ?? 'decline'
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') return decision
  return 'decline'
}

function legacyDecision(decision) {
  if (decision === 'accept' || decision === 'approved') return 'approved'
  if (decision === 'acceptForSession') return 'approved'
  return 'denied'
}
