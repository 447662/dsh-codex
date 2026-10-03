/**
 * dsh-native-codex-cli — Client half.
 *
 * Loaded by the DSH web module loader as a package client bundle. DSH owns the
 * shell (sidebar, panels, session nav, theme); this module supplies the Codex
 * surface on top of it:
 *
 *   main[codex]              a standalone Codex workspace: thread list, new
 *                            thread (cwd/model/permission), transcript, composer
 *   sidebar.panellist[codex] its sidebar entry
 *   conversation.view[codex] the same transcript inside a DSH session
 *   conversation.composer    once a session is bound to Codex, takes the
 *                            session's composer over so every later message goes
 *                            straight to Codex (no second AI in the path)
 *   conversation.input.right a "@Codex" affordance in the native composer that
 *                            hands the current draft to Codex
 *
 * Everything rendered here comes from Codex's own protocol frames relayed by
 * the Host half over POST /dsh-native-codex-cli/rpc and GET /dsh-native-codex-cli/events.
 */
window.__ModuleLoader__.load({
  id: 'dsh-native-codex-cli',
  factory: (require) => {
    // The DSH web module loader hands the factory only `require`; the bundle is
    // responsible for its own CommonJS-ish preamble, exactly like the shipped
    // bundles do. Without this, `exports.x = ...` throws at load time.
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    // ---------------------------------------------------------------- constants

    const NS = 'dsh-native-codex-cli'
    const RPC_URL = '/dsh-native-codex-cli/rpc'
    const EVENTS_URL = '/dsh-native-codex-cli/events'
    const DIAG_URL = '/dsh-native-codex-cli/diag'

    const APPROVAL_LABELS = {
      accept: '允许一次',
      acceptForSession: '本次会话总是允许',
      decline: '拒绝',
      cancel: '拒绝并中断',
    }

    // -------------------------------------------------------------------- store

    /** Module-level store: components subscribe; no context plumbing needed. */
    const store = {
      state: {
        connection: 'closed',
        appServer: null,
        snapshotLoaded: false,
        error: null,
        defaults: {},
        panel: { lastThreadId: null },
        threads: {},
        bindings: [],
        approvals: {},
        notices: [],
        models: [],
        profiles: [],
        threadList: [],
        threadListCursor: null,
        loadingList: false,
        sessionBinding: null,
        busy: {},
        diagnostics: [],
        /** Data URL / route URL of the image shown full-screen, or null. */
        lightbox: null,
        /**
         * Last host-side failure (unreachable host, missing Codex CLI, …).
         * Cleared automatically by the next successful RPC.
         */
        hostError: null,
      },
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      set(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      },
      /** Patch one thread view in place, preserving identity of the others. */
      setThread(thread) {
        if (!thread?.threadId) return
        this.state = {
          ...this.state,
          threads: { ...this.state.threads, [thread.threadId]: thread },
        }
        for (const listener of this.listeners) listener()
      },
      setApproval(request) {
        this.state = {
          ...this.state,
          approvals: { ...this.state.approvals, [request.requestId]: request },
        }
        for (const listener of this.listeners) listener()
      },
      clearApproval(requestId) {
        if (!this.state.approvals[requestId]) return
        const next = { ...this.state.approvals }
        delete next[requestId]
        this.state = { ...this.state, approvals: next }
        for (const listener of this.listeners) listener()
      },
      setBusy(key, value) {
        this.state = { ...this.state, busy: { ...this.state.busy, [key]: value } }
        for (const listener of this.listeners) listener()
      },
    }

    function useStore(selector = (s) => s) {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => store.subscribe(force), [])
      return selector(store.state)
    }

    /** Stand-in for a host hook the slot did not provide, keeping hook order stable. */
    function noopHook() {
      return null
    }

    // ------------------------------------------------------------------ transport

    /**
     * One RPC round-trip.
     *
     * `hostError` is tracked separately from the render-error slot so the banner
     * can clear itself: the host answers with something actionable (for example
     * "Codex CLI not found") while it is unusable, and the moment a call
     * succeeds again the stale complaint disappears on its own.
     */
    async function rpc(method, params = {}) {
      let response
      try {
        response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, params }),
        })
      } catch (error) {
        const message = `无法连接插件宿主进程（${method}）：${error?.message ?? error}`
        store.set({ hostError: message })
        throw new Error(message)
      }
      const payload = await response.json().catch(() => null)
      if (!payload) {
        const message = `插件宿主进程返回了空响应（${method}）`
        store.set({ hostError: message })
        throw new Error(message)
      }
      if (!payload.ok) {
        const message = payload.error?.message ?? `dsh-native-codex-cli: ${method} failed`
        store.set({ hostError: message })
        throw new Error(message)
      }
      if (store.state.hostError) store.set({ hostError: null })
      return payload.result
    }

    /** Client-side diagnostics are readable at GET /dsh-native-codex-cli/log. */
    function diag(kind, detail) {
      try {
        const line = { kind, detail, at: new Date().toISOString() }
        store.state.diagnostics = [...store.state.diagnostics.slice(-49), line]
        void fetch(DIAG_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(line),
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the UI */
      }
    }

    function reportError(error, context) {
      const message = error?.message ?? String(error)
      store.set({ error: `${context}: ${message}` })
      // The stack is what makes a minified host error ("l is not a function")
      // actionable: it points at the exact component and hook call site.
      diag('error', {
        context,
        message,
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 3000) : null,
      })
      console.error(`[dsh-native-codex-cli] ${context}`, error)
    }

    // ------------------------------------------------------------------- events

    let eventSource = null
    let reconnectTimer = null

    function connectEvents() {
      if (eventSource) return
      try {
        eventSource = new EventSource(EVENTS_URL)
      } catch (error) {
        reportError(error, 'events connect')
        return
      }
      eventSource.onopen = () => {
        store.set({ connection: 'open' })
        diag('events', 'open')
      }
      eventSource.onmessage = (event) => {
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }
        handleEvent(payload)
      }
      eventSource.onerror = () => {
        store.set({ connection: 'reconnecting' })
        if (eventSource) {
          eventSource.close()
          eventSource = null
        }
        if (reconnectTimer) return
        // Requirement 8: after any drop, re-read authoritative state instead of
        // trusting the in-memory mirror.
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connectEvents()
        }, 1500)
      }
    }

    function handleEvent(payload) {
      switch (payload.type) {
        case 'hello':
          store.set({ connection: 'open', appServer: payload.appServer ?? store.state.appServer })
          void refreshSnapshot()
          return
        case 'thread':
          store.setThread(payload.thread)
          return
        case 'approval':
          store.setApproval(payload.request)
          return
        case 'approval-resolved':
          store.clearApproval(payload.requestId)
          return
        case 'notice':
          store.set({ notices: [payload.notice, ...store.state.notices].slice(0, 100) })
          return
        case 'app-server-exit':
          store.set({ appServer: { ...(store.state.appServer ?? {}), running: false, lastExit: payload.info } })
          return
        case 'wire':
        default:
          return
      }
    }

    // -------------------------------------------------------------- state sync

    async function refreshSnapshot(sessionId) {
      try {
        const key = sessionId ?? activeSessionId()
        const snapshot = await rpc('snapshot', key ? { dshSessionId: key } : {})
        const approvals = {}
        for (const request of snapshot.pendingApprovals ?? []) approvals[request.requestId] = request
        store.set({
          snapshotLoaded: true,
          appServer: snapshot.appServer,
          defaults: snapshot.defaults ?? {},
          panel: snapshot.panel ?? { lastThreadId: null },
          sessionBinding: snapshot.binding ?? null,
          approvals,
        })
        if (snapshot.thread) store.setThread(snapshot.thread)
        void refreshBindings()
        return snapshot
      } catch (error) {
        reportError(error, 'snapshot')
        return null
      }
    }

    async function refreshBindings() {
      try {
        const result = await rpc('bindings.list')
        store.set({ bindings: result.bindings ?? [], panel: result.panel ?? store.state.panel })
      } catch (error) {
        reportError(error, 'bindings.list')
      }
    }

    async function refreshThreadList({ searchTerm, archived = false } = {}) {
      store.set({ loadingList: true })
      try {
        const result = await rpc('threads.list', { limit: 50, searchTerm: searchTerm || undefined, archived })
        store.set({ threadList: result.threads ?? [], threadListCursor: result.nextCursor ?? null, loadingList: false })
      } catch (error) {
        store.set({ loadingList: false })
        reportError(error, 'threads.list')
      }
    }

    async function refreshCatalogues(cwd) {
      try {
        const [models, profiles] = await Promise.all([
          rpc('models.list', { limit: 100 }),
          rpc('permissions.list', { cwd: cwd || undefined, limit: 100 }),
        ])
        store.set({ models: models.models ?? [], profiles: profiles.profiles ?? [] })
      } catch (error) {
        reportError(error, 'catalogues')
      }
    }

    // ------------------------------------------------------------------ actions

    /** Attach a Codex thread to a DSH session (or just read it in the panel). */
    async function openThread(threadId, sessionId) {
      store.setBusy(`thread:${threadId}`, true)
      try {
        if (sessionId) {
          const result = await rpc('threads.attach', { dshSessionId: sessionId, threadId })
          if (result.thread) store.setThread(result.thread)
          store.set({ sessionBinding: result.binding ?? null })
        } else {
          const result = await rpc('threads.read', { threadId, includeTurns: true })
          if (result.thread) store.setThread(result.thread)
        }
        await rpc('panel.set', { patch: { lastThreadId: threadId } }).catch(() => {})
        return true
      } catch (error) {
        reportError(error, `open thread ${threadId}`)
        return false
      } finally {
        store.setBusy(`thread:${threadId}`, false)
      }
    }

    /** Requirement 2: create a native Codex thread with explicit settings. */
    async function createThread({ cwd, model, approvalPolicy, sandbox, sessionId }) {
      store.setBusy('create', true)
      try {
        const result = await rpc('threads.create', {
          dshSessionId: sessionId || undefined,
          cwd: cwd || undefined,
          model: model || undefined,
          approvalPolicy: approvalPolicy || undefined,
          sandbox: sandbox || undefined,
        })
        if (result.thread) store.setThread(result.thread)
        store.set({ sessionBinding: result.binding ?? null })
        await refreshThreadList({})
        return result.thread?.threadId ?? null
      } catch (error) {
        reportError(error, 'create thread')
        return null
      } finally {
        store.setBusy('create', false)
      }
    }

    /**
     * Give a Codex thread its own entry in DSH's session list.
     *
     * Requirement: a bound Codex conversation should be reachable from the
     * workspace like any other session, not only through the Codex panel.
     * `workspaces.create({path})` resolves/creates the workspace for the
     * thread's cwd and `uiWorkspace.connectWorkspace(id)` opens a session in it
     * and hands back its id, which is what we then bind the thread to.
     *
     * Every step is defensive and reported through the diag channel: the exact
     * shapes of these two client services are the least-documented surface this
     * plugin touches, so a failure must land in the log as data, not as a crash.
     */
    async function ensureDshSessionForThread(threadId, cwd) {
      const ctx = ctxRef.current
      const get = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined)
      const uiWorkspace = get('uiWorkspace')
      const workspaces = get('workspaces')
      if (!uiWorkspace && !workspaces) {
        diag('workspace-api-missing', { threadId, hasUiWorkspace: false, hasWorkspaces: false })
        return null
      }

      let workspaceId = null
      try {
        if (cwd && typeof workspaces?.create === 'function') {
          const view = await workspaces.create({ path: cwd })
          workspaceId = view?.workspaceId ?? view?.id ?? null
          diag('workspace-resolved', { cwd, workspaceId, keys: view ? Object.keys(view) : null })
        }
      } catch (error) {
        diag('workspace-create-failed', String(error?.message ?? error))
      }

      let sessionId = null
      try {
        if (workspaceId && typeof uiWorkspace?.connectWorkspace === 'function') {
          sessionId = await uiWorkspace.connectWorkspace(workspaceId)
          diag('workspace-connected', { workspaceId, sessionId: sessionId ?? null })
        } else if (typeof uiWorkspace?.startSession === 'function') {
          uiWorkspace.startSession(workspaceId ?? undefined)
          diag('workspace-start-session-called', { workspaceId })
        } else {
          diag('workspace-no-session-api', {
            connectWorkspace: typeof uiWorkspace?.connectWorkspace,
            startSession: typeof uiWorkspace?.startSession,
          })
        }
      } catch (error) {
        diag('workspace-connect-failed', String(error?.message ?? error))
      }

      if (sessionId) {
        try {
          await rpc('threads.attach', { dshSessionId: sessionId, threadId })
          await refreshBindings()
          diag('thread-bound-to-new-session', { threadId, sessionId })
        } catch (error) {
          diag('thread-attach-to-new-session-failed', String(error?.message ?? error))
        }
      }
      return sessionId
    }

    function newClientMessageId() {
      try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
      } catch {
        /* fall through */
      }
      return `dshc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }

    /**
     * Requirement 3: hand the text straight to Codex.
     * A live turn is steered instead of queued so the user is never blocked.
     */
    async function sendMessage({ sessionId, threadId, text, model, approvalPolicy, sandbox, images }) {
      const trimmed = typeof text === 'string' ? text : ''
      const shots = Array.isArray(images) ? images : []
      // A pasted screenshot with no caption is a complete message.
      if (!trimmed.trim() && shots.length === 0) return false
      const target = stripCodexMention(trimmed)
      store.setBusy('send', true)
      try {
        const thread = threadId ? store.state.threads[threadId] : null
        const activeTurnId = thread?.activeTurnId
        if (activeTurnId && shots.length === 0) {
          // A live turn can only be steered with more text; model/permission
          // changes and new images apply from the next turn.
          await rpc('turn.steer', { dshSessionId: sessionId || undefined, text: target, expectedTurnId: activeTurnId })
        } else {
          const result = await rpc('turn.start', {
            dshSessionId: sessionId || undefined,
            threadId: threadId || undefined,
            text: target,
            clientMessageId: newClientMessageId(),
            model: model || undefined,
            approvalPolicy: approvalPolicy || undefined,
            sandbox: sandbox || undefined,
            images: shots.length ? shots : undefined,
          })
          if (result.threadId) {
            const view = store.state.threads[result.threadId]
            if (!view && sessionId) void openThread(result.threadId, sessionId)
          }
        }
        await refreshBindings()
        return true
      } catch (error) {
        reportError(error, 'send message')
        return false
      } finally {
        store.setBusy('send', false)
      }
    }

    /** Requirement 6: ask Codex to stop, then drop anything it was waiting on. */
    async function interrupt({ sessionId, threadId }) {
      store.setBusy('interrupt', true)
      try {
        await rpc('turn.interrupt', { dshSessionId: sessionId || undefined, threadId: threadId || undefined })
        return true
      } catch (error) {
        reportError(error, 'interrupt')
        return false
      } finally {
        store.setBusy('interrupt', false)
      }
    }

    /** Requirement 7: send the user's choice back to Codex. */
    async function answerApproval(request, choice) {
      store.setBusy(`approval:${request.requestId}`, true)
      try {
        await rpc('approval.respond', { requestId: request.requestId, method: request.method, choice })
        store.clearApproval(request.requestId)
        return true
      } catch (error) {
        reportError(error, 'approval.respond')
        return false
      } finally {
        store.setBusy(`approval:${request.requestId}`, false)
      }
    }

    async function refuseApproval(request) {
      try {
        await rpc('approval.refuse', { requestId: request.requestId })
        store.clearApproval(request.requestId)
      } catch (error) {
        reportError(error, 'approval.refuse')
      }
    }

    /**
     * Hard-forget the Codex association for a session.
     *
     * Distinct from "交还 DSH" (which suspends and remembers the thread so the
     * session can resume it): this one drops the association entirely, so the
     * next hand-off starts a fresh Codex conversation.
     */
    async function unbindSession(sessionId) {
      try {
        await rpc('bindings.detach', { dshSessionId: sessionId })
        store.set({ sessionBinding: null })
        await refreshBindings()
        diag('session-unbound', { sessionId })
      } catch (error) {
        reportError(error, 'bindings.detach')
      }
    }

    /**
     * Give this session a brand-new Codex thread, displacing whatever it was
     * bound to — without the "hand back, then create elsewhere" detour.
     */
    async function newThreadForSession(sessionId) {
      store.setBusy('create', true)
      try {
        const threadId = await createThread({ sessionId })
        diag('session-new-thread', { sessionId, threadId: threadId ?? null })
        return threadId
      } finally {
        store.setBusy('create', false)
      }
    }

    /**
     * "交还 DSH": stop routing this session to Codex, but **keep** the thread
     * association.
     *
     * Deleting the binding made the next "@codex" look like a new conversation
     * and spawn a second Codex thread, so the original one appeared to vanish.
     * Suspending instead lets the hand-off resume the very same thread.
     */
    async function detachSession(sessionId) {
      try {
        await rpc('bindings.suspend', { dshSessionId: sessionId })
        store.set({ sessionBinding: null })
        await refreshBindings()
      } catch (error) {
        reportError(error, 'bindings.suspend')
      }
    }

    /** The suspended (handed-back) binding for a session, if any. */
    function suspendedBindingFor(sessionId) {
      if (!sessionId) return null
      return store.state.bindings.find((binding) => binding.dshSessionId === sessionId
        && binding.active === false
        && Boolean(binding.threadId)) ?? null
    }

    /**
     * Take a session over for Codex: resume the thread this session was
     * previously bound to, or start a new one the first time.
     */
    async function takeOverSession(sessionId) {
      const suspended = suspendedBindingFor(sessionId)
      if (suspended) {
        try {
          const result = await rpc('threads.attach', { dshSessionId: sessionId, threadId: suspended.threadId })
          await rpc('bindings.activate', { dshSessionId: sessionId }).catch(() => {})
          if (result.thread) store.setThread(result.thread)
          await refreshBindings()
          diag('handoff-resumed-thread', { sessionId, threadId: suspended.threadId })
          return suspended.threadId
        } catch (error) {
          diag('handoff-resume-failed', String(error?.message ?? error))
        }
      }
      return createThread({
        cwd: undefined,
        model: undefined,
        approvalPolicy: undefined,
        sandbox: undefined,
        sessionId,
      })
    }

    /**
     * The optional `@codex` prefix that marks a draft as a Codex hand-off.
     *
     * Case-insensitive on purpose — the user should never have to hold Shift to
     * address Codex, so `@codex`, `@Codex` and `@CODEX` are all accepted, as is
     * the full-width `＠` produced by a CJK IME.
     */
    const CODEX_MENTION = /^\s*[@＠]codex\b[\s:：,，、-]*/i
    const CODEX_MENTION_TEST = /^\s*[@＠]codex\b/i

    function stripCodexMention(text) {
      return String(text ?? '').replace(CODEX_MENTION, '')
    }

    // ------------------------------------------------------ session id discovery

    /**
     * The slot system hands the active `sessionId` to session-scoped slots. The
     * root-scoped panel does not receive one, so it remembers the last session
     * it saw from any session-scoped surface.
     */
    let lastSessionId = null

    /** One-shot guard so the InputState shape is reported exactly once. */
    let inputShapeLogged = false

    /** One-shot guards for the first live report of each seat's prop shape. */
    const seatPropsLogged = new Set()

    /**
     * Resolve the active Session id from whatever a seat was handed.
     *
     * Session-scoped seats do not all receive the same props: the catalog's
     * `standardProps` promise a `sessionId`, while `conversation.input.dock`
     * additionally declares `ownerProps { session, input }`. Rather than assume
     * one shape (and silently render nothing when it is the other), accept all
     * of them and report the real keys once per seat.
     */
    function sessionIdFromProps(seat, props) {
      if (!seatPropsLogged.has(seat)) {
        seatPropsLogged.add(seat)
        const session = props?.session
        diag('seat-props', {
          seat,
          keys: Object.keys(props ?? {}),
          sessionKeys: session ? Object.keys(session) : null,
          sessionId: props?.sessionId ?? null,
          sessionDotId: session?.id ?? session?.sessionId ?? null,
        })
      }
      return props?.sessionId
        ?? props?.session?.id
        ?? props?.session?.sessionId
        ?? props?.session?.header?.id
        ?? null
    }

    function noteSession(sessionId) {
      if (sessionId && sessionId !== lastSessionId) {
        lastSessionId = sessionId
        void refreshSnapshot(sessionId)
      }
    }

    function activeSessionId() {
      return lastSessionId
    }

    /** Only an *active* binding means DSH has handed this session to Codex. */
    function isSessionBound(sessionId) {
      return Boolean(bindingFor(sessionId)?.threadId)
    }

    function bindingFor(sessionId) {
      if (!sessionId) return null
      const current = store.state.sessionBinding
      if (current?.dshSessionId === sessionId && current.threadId && current.active !== false) return current
      return store.state.bindings.find((binding) => binding.dshSessionId === sessionId
        && binding.threadId
        && binding.active !== false) ?? null
    }

    // -------------------------------------------------------------- markdown
    //
    // Codex answers in Markdown, so the transcript has to render it: the first
    // version only understood fenced blocks and inline code, which left
    // `**bold**`, `- lists` and `# headings` visible as literal punctuation.
    // This is a dependency-free subset covering what Codex actually emits —
    // ATX headings, fenced/indented code, ordered and unordered lists,
    // blockquotes, horizontal rules, and inline code / bold / italic / links.

    /** Inline spans: `code`, **bold**, *italic*, [text](url). */
    function renderInline(text, prefix) {
      const source = String(text ?? '')
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)/g
      const nodes = []
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        const token = match[0]
        const key = `${prefix}-i${index++}`
        if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'dsh-native-codex-cli-inline-code' }, token.slice(1, -1)))
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key }, renderInline(token.slice(2, -2), key)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          nodes.push(link
            ? h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1])
            : token)
        } else {
          nodes.push(h('em', { key }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    /** Block-level Markdown to React nodes. */
    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0

      const headingLevels = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6']

      while (index < lines.length) {
        const line = lines[index]

        const fence = /^\s*```(\S*)\s*$/.exec(line)
        if (fence) {
          const language = fence[1]
          const body = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h(
            'pre',
            { key: key++, className: 'dsh-native-codex-cli-code' },
            h('code', language ? { className: `language-${language}` } : null, body.join('\n')),
          ))
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push(h(headingLevels[heading[1].length - 1], { key: key++, className: 'dsh-native-codex-cli-h' }, renderInline(heading[2], `h${key}`)))
          index += 1
          continue
        }

        if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().length >= 3) {
          blocks.push(h('hr', { key: key++ }))
          index += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: key++ }, renderInline(quoted.join('\n'), `q${key}`)))
          continue
        }

        if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const items = []
          while (index < lines.length && (/^\s*([-*+])\s+/.test(lines[index]) || /^\s*\d+[.)]\s+/.test(lines[index]))) {
            items.push(lines[index].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
            index += 1
          }
          blocks.push(h(
            ordered ? 'ol' : 'ul',
            { key: key++, className: 'dsh-native-codex-cli-list' },
            items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, `l${key}-${itemIndex}`))),
          ))
          continue
        }

        if (!line.trim()) {
          index += 1
          continue
        }

        // Paragraph: consecutive plain lines, single newlines kept as breaks
        // (chat replies rely on them far more than GFM's soft-wrap rule).
        const paragraph = []
        while (
          index < lines.length
          && lines[index].trim()
          && !/^\s*```/.test(lines[index])
          && !/^(#{1,6})\s+/.test(lines[index])
          && !/^\s*>/.test(lines[index])
          && !/^\s*([-*+])\s+/.test(lines[index])
          && !/^\s*\d+[.)]\s+/.test(lines[index])
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        const children = []
        paragraph.forEach((text, lineIndex) => {
          if (lineIndex > 0) children.push(h('br', { key: `br${lineIndex}` }))
          children.push(...renderInline(text, `p${key}-${lineIndex}`))
        })
        blocks.push(h('p', { key: key++, className: 'dsh-native-codex-cli-p' }, children))
      }

      return blocks
    }

    /** Render one Markdown source into nodes. Returns null when empty. */
    function renderRichText(text) {
      const source = typeof text === 'string' ? text : ''
      if (!source.trim()) return null
      return renderMarkdown(source)
    }

    // ------------------------------------------------------------------- pieces

    /**
     * A render error inside this plugin must never take the DSH conversation
     * down with it, so every seat we occupy is wrapped in its own boundary.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        reportError(error, `render:${this.props.label ?? 'unknown'}`)
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'dsh-native-codex-cli-error dsh-native-codex-cli-error-bar' },
            `Codex 界面渲染出错（已隔离，不影响 DSH）：${this.state.error.message}`,
          )
        }
        return this.props.children
      }
    }

    function guard(label, element) {
      return h(Boundary, { label }, element)
    }

    function StatusDot({ status, label }) {
      const tone = status === 'open' ? 'ok' : status === 'reconnecting' ? 'warn' : 'off'
      return h('span', { className: `dsh-native-codex-cli-dot dsh-native-codex-cli-dot-${tone}`, title: asText(label ?? status, '') }, null)
    }

    function CodexIcon({ size = 18, active }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.85,
        }),
        h('path', { d: 'M9.2 9.4 7.6 12l1.6 2.6M14.8 9.4l1.6 2.6-1.6 2.6', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function Empty({ text }) {
      return h('div', { className: 'dsh-native-codex-cli-empty' }, text)
    }

    function Spinner({ label }) {
      return h('span', { className: 'dsh-native-codex-cli-spinner', role: 'status' }, label ?? '')
    }

    // ------------------------------------------------------------- item renderers

    /**
     * Coerce any protocol value to display text.
     *
     * This exists because React error #31 ("Objects are not valid as a React
     * child ... object with keys {type}") crashed the whole panel on the first
     * live run: several Codex fields are **tagged unions**, not strings. The
     * app-server schemas declare `TurnStatus`, `ThreadStatus`, `PatchApplyStatus`
     * and friends as `oneOf` tagged objects (`{type:"completed"}`, `{type:"idle"}`,
     * `{type:"active", activeFlags:[...]}`), while the smoke test's own output
     * happened to show plain strings for the turn/item cases it exercised — so a
     * permissive cast is the only safe way to render them.
     */
    function asText(value, fallback = '') {
      if (value === null || value === undefined) return fallback
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value === 'object') {
        for (const key of ['type', 'kind', 'status', 'state', 'message', 'name', 'label', 'text', 'reason']) {
          if (typeof value[key] === 'string') return value[key]
        }
        try {
          return JSON.stringify(value)
        } catch {
          return fallback
        }
      }
      return String(value)
    }

    function statusBadge(status) {
      const key = asText(status, 'unknown')
      const map = {
        inProgress: ['running', '进行中'],
        in_progress: ['running', '进行中'],
        completed: ['ok', '完成'],
        failed: ['error', '失败'],
        interrupted: ['warn', '已中断'],
        declined: ['warn', '已拒绝'],
      }
      const [tone, text] = map[key] ?? ['off', key]
      return h('span', { className: `dsh-native-codex-cli-badge dsh-native-codex-cli-badge-${tone}` }, text)
    }

    /** Turn a staged upload path back into something the browser can render. */
    function imageUrlFor(path) {
      return `/dsh-native-codex-cli/image?p=${encodeURIComponent(String(path ?? ''))}`
    }

    /**
     * One user turn, with real thumbnails for its images.
     *
     * A `localImage` input block only carries a filesystem path, so it used to
     * render as the literal text `[localImage] C:\...\png`. The host serves the
     * staged file, so the picture (and a click-to-enlarge view) is what the
     * transcript shows now.
     */
    function UserMessageItem({ item }) {
      const parts = item.content ?? []
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      const images = parts.filter((part) => part.type === 'image' || part.type === 'localImage')
      const others = parts.filter((part) => part.type !== 'text' && part.type !== 'image' && part.type !== 'localImage')

      return h(
        'div',
        { className: 'dsh-native-codex-cli-row dsh-native-codex-cli-row-user' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-bubble dsh-native-codex-cli-bubble-user' },
          text ? renderRichText(text) : null,
          images.length
            ? h(
              'div',
              { className: 'dsh-native-codex-cli-bubble-images' },
              images.map((part, index) => {
                const src = part.type === 'image' ? part.url : imageUrlFor(part.path)
                return h('img', {
                  key: `${index}-${src ?? ''}`,
                  className: 'dsh-native-codex-cli-thumb',
                  src,
                  alt: part.name ?? '图片',
                  title: '点击放大',
                  onClick: () => store.set({ lightbox: src }),
                })
              }),
            )
            : null,
          others.length
            ? h('div', { className: 'dsh-native-codex-cli-muted' }, others.map((part) => `[${part.type}] ${part.path ?? part.url ?? part.name ?? ''}`).join(' '))
            : null,
        ),
      )
    }

    /** Full-screen view of one image; click anywhere to dismiss. */
    function Lightbox() {
      const src = useStore((state) => state.lightbox)
      if (!src) return null
      return h(
        'div',
        {
          className: 'dsh-native-codex-cli-lightbox',
          title: '点击关闭',
          onClick: () => store.set({ lightbox: null }),
        },
        h('img', { src, alt: '', onClick: (event) => event.stopPropagation() }),
      )
    }

    function AgentMessageItem({ item }) {
      const streaming = item.__streaming
      return h(
        'div',
        { className: 'dsh-native-codex-cli-row' },
        h('div', { className: 'dsh-native-codex-cli-bubble' }, renderRichText(item.text ?? ''), streaming ? h(Spinner, { label: '' }) : null),
      )
    }

    function ReasoningItem({ item }) {
      const body = item.reasoningText || (item.summary ?? []).join('\n\n') || item.summaryText || (item.content ?? []).join('\n')
      if (!body) return null
      return h(
        'details',
        { className: 'dsh-native-codex-cli-card dsh-native-codex-cli-reasoning' },
        h('summary', null, `思考过程 (${body.length} 字)`),
        h('pre', { className: 'dsh-native-codex-cli-pre' }, body),
      )
    }

    function PlanItem({ item }) {
      return h('div', { className: 'dsh-native-codex-cli-card' }, h('div', { className: 'dsh-native-codex-cli-card-title' }, '计划'), renderRichText(item.text ?? ''))
    }

    function CommandExecutionItem({ item }) {
      const [open, setOpen] = React.useState(false)
      const output = item.aggregatedOutput ?? ''
      return h(
        'div',
        { className: 'dsh-native-codex-cli-card dsh-native-codex-cli-tool' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-card-head' },
          h('span', { className: 'dsh-native-codex-cli-tool-kind' }, '命令'),
          statusBadge(item.status),
          item.exitCode !== undefined && item.exitCode !== null
            ? h('span', { className: `dsh-native-codex-cli-badge ${item.exitCode === 0 ? 'dsh-native-codex-cli-badge-ok' : 'dsh-native-codex-cli-badge-error'}` }, `exit ${item.exitCode}`)
            : null,
          item.durationMs ? h('span', { className: 'dsh-native-codex-cli-muted' }, `${(item.durationMs / 1000).toFixed(1)}s`) : null,
        ),
        h('pre', { className: 'dsh-native-codex-cli-pre dsh-native-codex-cli-pre-cmd' }, `$ ${item.command ?? ''}`),
        item.cwd ? h('div', { className: 'dsh-native-codex-cli-muted dsh-native-codex-cli-cwd' }, asText(item.cwd)) : null,
        output
          ? h(
            'div',
            null,
            h(
              'button',
              { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => setOpen(!open) },
              open ? '收起输出' : `展开输出 (${output.length} 字)`,
            ),
            open ? h('pre', { className: 'dsh-native-codex-cli-pre' }, output) : null,
          )
          : null,
      )
    }

    function FileChangeItem({ item }) {
      const changes = item.changes ?? []
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        { className: 'dsh-native-codex-cli-card dsh-native-codex-cli-tool' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-card-head' },
          h('span', { className: 'dsh-native-codex-cli-tool-kind' }, '文件改动'),
          statusBadge(item.status),
          h('span', { className: 'dsh-native-codex-cli-muted' }, `${changes.length} 个文件`),
        ),
        h(
          'ul',
          { className: 'dsh-native-codex-cli-filelist' },
          changes.map((change, index) => h(
            'li',
            { key: index },
            h('span', { className: 'dsh-native-codex-cli-filekind' }, change.kind ?? change.type ?? '?'),
            h('span', { className: 'dsh-native-codex-cli-filepath' }, change.path ?? change.move_path ?? ''),
          )),
        ),
        changes.some((change) => change.diff)
          ? h(
            'div',
            null,
            h('button', { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => setOpen(!open) }, open ? '收起 diff' : '查看 diff'),
            open ? h('pre', { className: 'dsh-native-codex-cli-pre' }, changes.map((change) => change.diff).filter(Boolean).join('\n')) : null,
          )
          : null,
        item.outputText ? h('pre', { className: 'dsh-native-codex-cli-pre' }, item.outputText) : null,
      )
    }

    function GenericToolItem({ item, label }) {
      const [open, setOpen] = React.useState(false)
      const details = JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error, output: item.output }, null, 2)
      return h(
        'div',
        { className: 'dsh-native-codex-cli-card dsh-native-codex-cli-tool' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-card-head' },
          h('span', { className: 'dsh-native-codex-cli-tool-kind' }, label),
          item.server ? h('span', { className: 'dsh-native-codex-cli-muted' }, asText(item.server)) : null,
          h('span', { className: 'dsh-native-codex-cli-mono' }, asText(item.tool ?? item.name, '')),
          statusBadge(item.status),
        ),
        item.error ? h('div', { className: 'dsh-native-codex-cli-error' }, String(item.error.message ?? item.error)) : null,
        h('button', { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => setOpen(!open) }, open ? '收起详情' : '查看详情'),
        open ? h('pre', { className: 'dsh-native-codex-cli-pre' }, details) : null,
      )
    }

    function NoticeItem({ notice }) {
      return h('div', { className: `dsh-native-codex-cli-notice dsh-native-codex-cli-notice-${notice.level}` }, String(notice.message ?? ''))
    }

    function renderItem(item, index, streamingItemId) {
      if (!item) return null
      const streaming = item.id && item.id === streamingItemId
      const key = item.id ?? `i${index}`
      switch (item.type) {
        case 'userMessage':
          return h(UserMessageItem, { key, item })
        case 'agentMessage':
          return h(AgentMessageItem, { key, item: { ...item, __streaming: streaming } })
        case 'reasoning':
          return h(ReasoningItem, { key, item })
        case 'plan':
          return h(PlanItem, { key, item })
        case 'commandExecution':
          return h(CommandExecutionItem, { key, item })
        case 'fileChange':
          return h(FileChangeItem, { key, item })
        case 'mcpToolCall':
          return h(GenericToolItem, { key, item, label: 'MCP 工具' })
        case 'dynamicToolCall':
          return h(GenericToolItem, { key, item, label: '动态工具' })
        case 'functionCallOutput':
          return h(GenericToolItem, { key, item, label: '工具输出' })
        case 'webSearch':
          return h(GenericToolItem, { key, item, label: '联网搜索' })
        case 'imageView':
          return h(GenericToolItem, { key, item, label: '查看图片' })
        case 'imageGeneration':
          return h(GenericToolItem, { key, item, label: '生成图片' })
        case 'contextCompaction':
          return h('div', { key, className: 'dsh-native-codex-cli-notice dsh-native-codex-cli-notice-info' }, '上下文已压缩')
        case 'hookPrompt':
          return h(GenericToolItem, { key, item, label: 'Hook' })
        default:
          return h(GenericToolItem, { key, item, label: item.type ?? '事件' })
      }
    }

    // ------------------------------------------------------------------ transcript

    function TurnView({ turn, streamingItemId }) {
      const items = (turn.items ?? []).filter(Boolean)
      return h(
        'div',
        { className: 'dsh-native-codex-cli-turn' },
        items.map((item, index) => renderItem(item, index, streamingItemId)),
        turn.diff
          ? h(
            'details',
            { className: 'dsh-native-codex-cli-card' },
            h('summary', null, '本轮改动 diff'),
            h('pre', { className: 'dsh-native-codex-cli-pre' }, turn.diff),
          )
          : null,
        turn.error ? h('div', { className: 'dsh-native-codex-cli-error' }, `本轮错误：${turn.error.message ?? JSON.stringify(turn.error)}`) : null,
        h(
          'div',
          { className: 'dsh-native-codex-cli-turn-foot' },
          statusBadge(turn.status),
          turn.durationMs ? h('span', { className: 'dsh-native-codex-cli-muted' }, `${(turn.durationMs / 1000).toFixed(1)}s`) : null,
        ),
      )
    }

    function Transcript({ threadId, sessionId }) {
      const thread = useStore((state) => (threadId ? state.threads[threadId] : null))
      const scroller = React.useRef(null)
      const [pinned, setPinned] = React.useState(true)

      React.useEffect(() => {
        if (!pinned || !scroller.current) return
        scroller.current.scrollTop = scroller.current.scrollHeight
      }, [thread?.updatedAtMs, thread?.turns, pinned])

      if (!thread) {
        return h(Empty, { text: threadId ? '正在从 Codex 读取线程…' : '选择一个 Codex 线程，或在下方输入框直接开始新任务。' })
      }

      const streamingTurn = thread.turns.find((turn) => turn.turnId === thread.activeTurnId)
      const streamingItemId = (() => {
        if (!streamingTurn) return null
        const agent = [...(streamingTurn.items ?? [])].reverse().find((item) => item.type === 'agentMessage')
        return agent?.id ?? null
      })()

      return h(
        'div',
        { className: 'dsh-native-codex-cli-transcript-wrap' },
        h(
          'div',
          {
            className: 'dsh-native-codex-cli-transcript',
            ref: scroller,
            onScroll: (event) => {
              const el = event.currentTarget
              setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
            },
          },
          thread.turns.length === 0 ? h(Empty, { text: '这个 Codex 线程还没有内容。' }) : null,
          thread.turns.map((turn) => h(Boundary, { key: turn.turnId, label: 'turn' }, h(TurnView, { turn, streamingItemId }))),
          (thread.notices ?? []).map((notice) => h(NoticeItem, { key: notice.id, notice })),
        ),
        h(ApprovalDock, { threadId, sessionId }),
        h(Lightbox, null),
      )
    }

    // ------------------------------------------------------------------ approvals

    function ApprovalDock({ threadId, sessionId }) {
      const approvals = useStore((state) => state.approvals)
      const relevant = Object.values(approvals).filter((request) => {
        const id = request.params?.threadId ?? request.params?.conversationId
        return !threadId || !id || id === threadId
      })
      if (relevant.length === 0) return null
      return h('div', { className: 'dsh-native-codex-cli-approval-dock' }, relevant.map((request) => h(ApprovalCard, { key: request.requestId, request })))
    }

    function ApprovalCard({ request }) {
      const busy = useStore((state) => state.busy[`approval:${request.requestId}`])
      const params = request.params ?? {}

      const decide = (choice) => answerApproval(request, choice)

      if (request.kind === 'question') {
        return h(QuestionCard, { request, busy })
      }

      let title = 'Codex 请求授权'
      let body = null
      if (request.kind === 'command') {
        title = params.kind === 'writeStdin' ? 'Codex 请求向命令写入输入' : 'Codex 请求执行命令'
        body = h(
          'div',
          null,
          h('pre', { className: 'dsh-native-codex-cli-pre dsh-native-codex-cli-pre-cmd' }, params.command ?? '(无命令文本)'),
          params.cwd ? h('div', { className: 'dsh-native-codex-cli-muted dsh-native-codex-cli-cwd' }, asText(params.cwd)) : null,
          params.reason ? h('div', { className: 'dsh-native-codex-cli-muted' }, params.reason) : null,
        )
      } else if (request.kind === 'fileChange') {
        title = 'Codex 请求修改文件'
        body = h(
          'div',
          null,
          params.grantRoot ? h('div', { className: 'dsh-native-codex-cli-muted' }, `范围：${params.grantRoot}`) : null,
          params.reason ? h('div', { className: 'dsh-native-codex-cli-muted' }, params.reason) : null,
        )
      } else if (request.kind === 'permissions') {
        title = 'Codex 请求额外权限'
        body = h('pre', { className: 'dsh-native-codex-cli-pre' }, JSON.stringify(params.permissions ?? {}, null, 2))
      } else if (request.kind === 'elicitation') {
        title = 'MCP 服务请求输入'
        body = h('div', null, h('div', null, params.message ?? ''), h('pre', { className: 'dsh-native-codex-cli-pre' }, JSON.stringify(params.requestedSchema ?? {}, null, 2)))
      } else {
        body = h('pre', { className: 'dsh-native-codex-cli-pre' }, JSON.stringify(params, null, 2))
      }

      return h(
        'div',
        { className: 'dsh-native-codex-cli-approval' },
        h('div', { className: 'dsh-native-codex-cli-approval-title' }, title),
        body,
        request.kind === 'elicitation'
          ? h(
            'div',
            { className: 'dsh-native-codex-cli-approval-actions' },
            h('button', { type: 'button', onClick: () => refuseApproval(request) }, '拒绝'),
          )
          : h(
            'div',
            { className: 'dsh-native-codex-cli-approval-actions' },
            h('button', { type: 'button', className: 'dsh-native-codex-cli-primary', disabled: busy, onClick: () => decide({ decision: 'accept' }) }, APPROVAL_LABELS.accept),
            h('button', { type: 'button', disabled: busy, onClick: () => decide({ decision: 'acceptForSession' }) }, APPROVAL_LABELS.acceptForSession),
            h('button', { type: 'button', onClick: () => decide({ decision: 'decline' }) }, APPROVAL_LABELS.decline),
            h('button', { type: 'button', className: 'dsh-native-codex-cli-danger', onClick: () => decide({ decision: 'cancel' }) }, APPROVAL_LABELS.cancel),
          ),
      )
    }

    function QuestionCard({ request, busy }) {
      const questions = request.params?.questions ?? []
      const [answers, setAnswers] = React.useState({})
      const [custom, setCustom] = React.useState({})

      const toggle = (question, label) => {
        setAnswers((current) => {
          const existing = current[question.id] ?? []
          const next = question.options?.length && existing.includes(label)
            ? existing.filter((value) => value !== label)
            : [...existing.filter((value) => value !== label), label]
          return { ...current, [question.id]: next }
        })
      }

      const submit = () => {
        const payload = {}
        for (const question of questions) {
          const picked = answers[question.id] ?? []
          const extra = custom[question.id]?.trim()
          const final = extra ? [...picked, extra] : picked
          payload[question.id] = { answers: final.length ? final : [''] }
        }
        void answerApproval(request, { answers: payload })
      }

      return h(
        'div',
        { className: 'dsh-native-codex-cli-approval' },
        h('div', { className: 'dsh-native-codex-cli-approval-title' }, 'Codex 需要你确认'),
        questions.map((question) => h(
          'div',
          { key: question.id, className: 'dsh-native-codex-cli-question' },
          h('div', { className: 'dsh-native-codex-cli-question-header' }, question.header || question.question),
          question.header && question.question !== question.header ? h('div', { className: 'dsh-native-codex-cli-question-text' }, question.question) : null,
          (question.options ?? []).map((option) => h(
            'label',
            { key: option.label, className: 'dsh-native-codex-cli-option' },
            h('input', { type: 'checkbox', checked: (answers[question.id] ?? []).includes(option.label), onChange: () => toggle(question, option.label) }),
            h('span', null, option.label),
            option.description ? h('span', { className: 'dsh-native-codex-cli-muted' }, option.description) : null,
          )),
          question.isOther !== false
            ? h('input', {
              type: 'text',
              className: 'dsh-native-codex-cli-input',
              placeholder: '其他回答…',
              value: custom[question.id] ?? '',
              onChange: (event) => setCustom((current) => ({ ...current, [question.id]: event.target.value })),
            })
            : null,
        )),
        h(
          'div',
          { className: 'dsh-native-codex-cli-approval-actions' },
          h('button', { type: 'button', className: 'dsh-native-codex-cli-primary', disabled: busy, onClick: submit }, '提交'),
          h('button', { type: 'button', onClick: () => refuseApproval(request) }, '拒绝'),
        ),
      )
    }

    // ------------------------------------------------------------------- composer

    /**
     * The Codex input box.
     *
     * `model` / `approvalPolicy` / `sandbox` are per-turn in the app-server
     * protocol (`turn/start` accepts all three), so changing them here takes
     * effect on the next message without recreating the thread — and the choice
     * is written back to the binding so it survives a reload.
     */
    /**
     * Read a pasted / picked image into a data URL — byte-for-byte, no
     * re-encoding.
     *
     * Compression was tried first to fit a small RPC body limit, but re-encoding
     * a screenshot costs exactly the fidelity Codex needs to read it, so the
     * original bytes are sent and the host's body limit was raised instead.
     */
    function readImageFile(file) {
      return new Promise((resolve) => {
        try {
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = String(reader.result ?? '')
            diag('image-read', { bytes: dataUrl.length, mediaType: file.type || 'image/png', compressed: false })
            resolve({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: file.name || 'pasted.png',
              mediaType: file.type || 'image/png',
              dataUrl,
            })
          }
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(file)
        } catch {
          resolve(null)
        }
      })
    }

    function Composer({ sessionId, threadId, compact }) {
      const [draft, setDraft] = React.useState('')
      const [images, setImages] = React.useState([])
      const fileInput = React.useRef(null)
      const sending = useStore((state) => state.busy.send)
      const interrupting = useStore((state) => state.busy.interrupt)
      const thread = useStore((state) => (threadId ? state.threads[threadId] : null))
      const binding = useStore((state) => (sessionId ? bindingFor(sessionId) : null))
      const models = useStore((state) => state.models)
      const [model, setModel] = React.useState('')
      const [approvalPolicy, setApprovalPolicy] = React.useState('')
      const [sandbox, setSandbox] = React.useState('')
      const running = Boolean(thread?.activeTurnId)

      React.useEffect(() => {
        setModel(binding?.model ?? thread?.model ?? '')
        setApprovalPolicy(binding?.approvalPolicy ?? 'on-request')
        setSandbox(binding?.sandbox ?? 'workspace-write')
      }, [binding?.threadId, binding?.model, binding?.approvalPolicy, binding?.sandbox, thread?.model])

      const choose = (patch) => {
        if (patch.model !== undefined) setModel(patch.model)
        if (patch.approvalPolicy !== undefined) setApprovalPolicy(patch.approvalPolicy)
        if (patch.sandbox !== undefined) setSandbox(patch.sandbox)
        if (!sessionId) return
        void rpc('bindings.update', { dshSessionId: sessionId, patch })
          .then(() => refreshBindings())
          .catch((error) => diag('binding-update-failed', String(error?.message ?? error)))
      }

      const addImages = async (files) => {
        const list = Array.from(files ?? []).filter((file) => String(file?.type ?? '').startsWith('image/'))
        if (list.length === 0) return
        const read = (await Promise.all(list.map(readImageFile))).filter(Boolean)
        if (read.length) {
          setImages((current) => [...current, ...read].slice(0, 8))
          diag('images-attached', { count: read.length, source: 'paste-or-pick' })
        }
      }

      const onPaste = (event) => {
        const files = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file' && String(item.type ?? '').startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter(Boolean)
        if (files.length === 0) return // plain text paste keeps working
        event.preventDefault()
        void addImages(files)
      }

      const submit = async () => {
        const text = draft
        const shots = images
        if ((!text.trim() && shots.length === 0) || sending) return
        setDraft('')
        setImages([])
        const ok = await sendMessage({ sessionId, threadId, text, model, approvalPolicy, sandbox, images: shots })
        // Requirement 8: only drop the draft once Codex actually accepted it.
        if (!ok) {
          setDraft(text)
          setImages(shots)
        }
      }

      return h(
        'div',
        { className: `dsh-native-codex-cli-composer${compact ? ' dsh-native-codex-cli-composer-compact' : ''}` },
        // Attachment rail: pasted/picked screenshots, removable before sending.
        images.length
          ? h(
            'div',
            { className: 'dsh-native-codex-cli-attachments' },
            images.map((image) => h(
              'span',
              { key: image.id, className: 'dsh-native-codex-cli-attachment' },
              h('img', { src: image.dataUrl, alt: image.name, title: image.name }),
              h('button', {
                type: 'button',
                className: 'dsh-native-codex-cli-attachment-remove',
                title: '移除',
                onClick: () => setImages((current) => current.filter((item) => item.id !== image.id)),
              }, '×'),
            )),
          )
          : null,
        h('textarea', {
          className: 'dsh-native-codex-cli-textarea',
          value: draft,
          rows: compact ? 2 : 3,
          placeholder: running ? 'Codex 正在执行；输入内容会作为追加指令发送' : '交给 Codex 执行…（可直接粘贴图片与任务，无需转述）',
          onChange: (event) => setDraft(event.target.value),
          onPaste,
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault()
              void submit()
            }
          },
        }),
        h(
          'div',
          { className: 'dsh-native-codex-cli-composer-bar' },
          h(
            'div',
            { className: 'dsh-native-codex-cli-composer-selects' },
            h(
              'label',
              { className: 'dsh-native-codex-cli-select-field', title: '下一个 turn 使用的 Codex 模型' },
              h('span', null, '模型'),
              h(
                'select',
                {
                  className: 'dsh-native-codex-cli-select',
                  value: model,
                  onChange: (event) => choose({ model: event.target.value }),
                },
                h('option', { value: '' }, 'Codex 默认'),
                models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.displayName || entry.id)),
              ),
            ),
            h(
              'label',
              { className: 'dsh-native-codex-cli-select-field', title: '审批策略（随 turn 生效）' },
              h('span', null, '审批'),
              h(
                'select',
                {
                  className: 'dsh-native-codex-cli-select',
                  value: approvalPolicy || 'on-request',
                  onChange: (event) => choose({ approvalPolicy: event.target.value }),
                },
                h('option', { value: 'on-request' }, '按需询问'),
                h('option', { value: 'untrusted' }, '仅可信命令免问'),
                h('option', { value: 'never' }, '从不询问'),
              ),
            ),
            h(
              'label',
              { className: 'dsh-native-codex-cli-select-field', title: '沙箱（随 turn 生效）' },
              h('span', null, '沙箱'),
              h(
                'select',
                {
                  className: 'dsh-native-codex-cli-select',
                  value: sandbox || 'workspace-write',
                  onChange: (event) => choose({ sandbox: event.target.value }),
                },
                h('option', { value: 'read-only' }, '只读'),
                h('option', { value: 'workspace-write' }, '可写工作区'),
                h('option', { value: 'danger-full-access' }, '完全访问'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-native-codex-cli-composer-actions' },
            // Attach button, mirroring the native composer's "+" seat.
            h('button', {
              type: 'button',
              className: 'dsh-native-codex-cli-attach',
              title: '添加图片（也可以直接粘贴到输入框）',
              onClick: () => fileInput.current?.click?.(),
            }, '＋'),
            h('input', {
              ref: fileInput,
              type: 'file',
              accept: 'image/*',
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                void addImages(event.target.files)
                event.target.value = ''
              },
            }),
            h('span', { className: 'dsh-native-codex-cli-muted' }, running ? '执行中' : 'Enter 发送'),
            running ? h('button', { type: 'button', className: 'dsh-native-codex-cli-danger', disabled: interrupting, onClick: () => interrupt({ sessionId, threadId }) }, interrupting ? '正在停止…' : '停止') : null,
            h('button', { type: 'button', className: 'dsh-native-codex-cli-primary', disabled: sending || (!draft.trim() && images.length === 0), onClick: submit }, sending ? '发送中…' : '发送给 Codex'),
          ),
        ),
      )
    }

    // --------------------------------------------------------------- thread list

    function NewThreadForm({ sessionId, onCreated }) {
      const defaults = useStore((state) => state.defaults)
      const models = useStore((state) => state.models)
      const profiles = useStore((state) => state.profiles)
      const creating = useStore((state) => state.busy.create)
      const [cwd, setCwd] = React.useState('')
      const [model, setModel] = React.useState('')
      const [approvalPolicy, setApprovalPolicy] = React.useState(defaults.approvalPolicy ?? 'on-request')
      const [sandbox, setSandbox] = React.useState(defaults.sandbox ?? 'workspace-write')

      React.useEffect(() => {
        void refreshCatalogues(cwd)
      }, [])

      const pickDirectory = async () => {
        try {
          const uiWorkspace = ctxRef.current?.get?.('uiWorkspace')
          if (uiWorkspace?.pickDirectory) {
            const picked = await uiWorkspace.pickDirectory()
            if (picked) setCwd(picked)
            return
          }
        } catch (error) {
          diag('pickDirectory-failed', String(error?.message ?? error))
        }
        const typed = globalThis.prompt?.('Codex 工作目录（绝对路径）')
        if (typed) setCwd(typed)
      }

      return h(
        'div',
        { className: 'dsh-native-codex-cli-newthread' },
        h('div', { className: 'dsh-native-codex-cli-field' },
          h('label', null, '工作目录'),
          h('div', { className: 'dsh-native-codex-cli-field-row' },
            h('input', { className: 'dsh-native-codex-cli-input', value: cwd, placeholder: 'C:\\path\\to\\project', onChange: (event) => setCwd(event.target.value) }),
            h('button', { type: 'button', onClick: pickDirectory }, '选择…'),
          )),
        h('div', { className: 'dsh-native-codex-cli-field' },
          h('label', null, '模型'),
          h('select', { className: 'dsh-native-codex-cli-input', value: model, onChange: (event) => setModel(event.target.value) },
            h('option', { value: '' }, '（Codex 默认）'),
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.displayName || entry.id}${entry.isDefault ? ' · 默认' : ''}`)),
          )),
        h('div', { className: 'dsh-native-codex-cli-field' },
          h('label', null, '权限策略'),
          h('select', { className: 'dsh-native-codex-cli-input', value: approvalPolicy, onChange: (event) => setApprovalPolicy(event.target.value) },
            h('option', { value: 'on-request' }, '按需询问'),
            h('option', { value: 'untrusted' }, '仅可信命令免问'),
            h('option', { value: 'never' }, '从不询问'),
          )),
        h('div', { className: 'dsh-native-codex-cli-field' },
          h('label', null, '沙箱'),
          h('select', { className: 'dsh-native-codex-cli-input', value: sandbox, onChange: (event) => setSandbox(event.target.value) },
            h('option', { value: 'read-only' }, '只读'),
            h('option', { value: 'workspace-write' }, '可写工作区'),
            h('option', { value: 'danger-full-access' }, '完全访问'),
          )),
        profiles.length
          ? h('div', { className: 'dsh-native-codex-cli-muted' }, `可用权限配置：${profiles.map((profile) => profile.id).join('、')}`)
          : null,
        h('div', { className: 'dsh-native-codex-cli-approval-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-native-codex-cli-primary',
            disabled: creating,
            onClick: async () => {
              const threadId = await createThread({ cwd, model, approvalPolicy, sandbox, sessionId })
              if (threadId && onCreated) onCreated(threadId, cwd)
            },
          }, creating ? '创建中…' : '创建 Codex 线程'),
        ),
      )
    }

    function ThreadList({ sessionId, bindSessionId, onOpen, onBind, selectedId }) {
      const threadList = useStore((state) => state.threadList)
      const loading = useStore((state) => state.loadingList)
      const bindings = useStore((state) => state.bindings)
      const [search, setSearch] = React.useState('')
      const [showNew, setShowNew] = React.useState(false)

      React.useEffect(() => {
        void refreshThreadList({})
      }, [])

      const boundThreadIds = new Set(bindings.map((binding) => binding.threadId))

      return h(
        'div',
        { className: 'dsh-native-codex-cli-threadlist' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-threadlist-head' },
          h('input', {
            className: 'dsh-native-codex-cli-input',
            placeholder: '搜索 Codex 线程…',
            value: search,
            onChange: (event) => setSearch(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void refreshThreadList({ searchTerm: search })
            },
          }),
          h('button', { type: 'button', onClick: () => refreshThreadList({ searchTerm: search }) }, '刷新'),
          h('button', { type: 'button', className: 'dsh-native-codex-cli-primary', onClick: () => setShowNew(!showNew) }, showNew ? '收起' : '新任务'),
        ),
        showNew ? h(NewThreadForm, { sessionId, onCreated: (id, cwd) => { setShowNew(false); onOpen(id, { ensureSession: true, cwd }) } }) : null,
        loading ? h(Spinner, { label: '加载线程列表…' }) : null,
        threadList.length === 0 && !loading ? h(Empty, { text: 'Codex 里还没有线程。点「新任务」创建第一个。' }) : null,
        h(
          'ul',
          { className: 'dsh-native-codex-cli-threaditems' },
          threadList.map((thread) => h(
            'li',
            {
              key: thread.threadId,
              className: `dsh-native-codex-cli-threaditem${selectedId === thread.threadId ? ' dsh-native-codex-cli-threaditem-active' : ''}`,
              onClick: () => onOpen(thread.threadId),
            },
            h('div', { className: 'dsh-native-codex-cli-threaditem-title' }, thread.name || thread.preview || thread.threadId.slice(0, 8)),
            h(
              'div',
              { className: 'dsh-native-codex-cli-threaditem-meta' },
              h('span', null, thread.cwd ? shortPath(asText(thread.cwd)) : ''),
              h('span', null, thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : ''),
              boundThreadIds.has(thread.threadId) ? h('span', { className: 'dsh-native-codex-cli-badge dsh-native-codex-cli-badge-ok' }, '已绑定会话') : null,
              // Recovery affordance: a thread whose binding was dropped by the
              // earlier delete-on-detach behaviour is still alive in Codex, and
              // this is how it gets attached to the session again.
              bindSessionId && !boundThreadIds.has(thread.threadId)
                ? h('button', {
                  type: 'button',
                  className: 'dsh-native-codex-cli-link',
                  onClick: (event) => {
                    event.stopPropagation()
                    onBind?.(thread.threadId, thread.cwd)
                  },
                }, '绑定到当前会话')
                : null,
            ),
          )),
        ),
      )
    }

    function shortPath(path) {
      if (!path) return ''
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      return parts.length <= 2 ? path : `…\\${parts.slice(-2).join('\\')}`
    }

    // ---------------------------------------------------------------- main panel

    function CodexPanel() {
      const appServer = useStore((state) => state.appServer)
      const connection = useStore((state) => state.connection)
      const panel = useStore((state) => state.panel)
      const error = useStore((state) => state.error)
      const hostError = useStore((state) => state.hostError)
      const [selectedThreadId, setSelectedThreadId] = React.useState(panel.lastThreadId ?? null)
      const [showList, setShowList] = React.useState(true)

      React.useEffect(() => {
        void refreshCatalogues()
        void refreshSnapshot()
        void refreshThreadList({})
      }, [])

      React.useEffect(() => {
        if (panel.lastThreadId && !selectedThreadId) setSelectedThreadId(panel.lastThreadId)
      }, [panel.lastThreadId])

      const open = async (threadId, options) => {
        setSelectedThreadId(threadId)
        await openThread(threadId)
        // A thread created from this panel gets its own DSH session so it shows
        // up in the workspace list; opening an existing list row does not.
        if (options?.ensureSession) await ensureDshSessionForThread(threadId, options.cwd)
      }

      return h(
        'div',
        { className: 'dsh-native-codex-cli-panel' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-panel-head' },
          h('div', { className: 'dsh-native-codex-cli-panel-title' },
            h(CodexIcon, { size: 18, active: true }),
            h('span', null, 'Codex'),
            h(StatusDot, { status: connection, label: `事件流：${connection}` }),
            appServer?.running ? h('span', { className: 'dsh-native-codex-cli-muted' }, `pid ${appServer.pid ?? '-'}`) : h('span', { className: 'dsh-native-codex-cli-muted' }, 'Codex 未启动'),
          ),
          h(
            'div',
            { className: 'dsh-native-codex-cli-panel-actions' },
            h('button', { type: 'button', onClick: () => setShowList(!showList) }, showList ? '隐藏线程' : '线程列表'),
            h('button', { type: 'button', onClick: () => { void refreshSnapshot(); void refreshThreadList({}) } }, '刷新'),
            h('button', {
              type: 'button',
              onClick: async () => {
                try {
                  const result = await rpc('restart')
                  store.set({ appServer: result.appServer })
                } catch (rpcError) {
                  reportError(rpcError, 'restart')
                }
              },
            }, '重启 Codex'),
          ),
        ),
        (hostError || error) ? h('div', { className: 'dsh-native-codex-cli-error dsh-native-codex-cli-error-bar' }, hostError || error) : null,
        h(
          'div',
          { className: 'dsh-native-codex-cli-panel-body' },
          showList
            ? guard('threadlist', h(ThreadList, {
              sessionId: null,
              bindSessionId: activeSessionId(),
              onOpen: open,
              onBind: async (threadId) => {
                const target = activeSessionId()
                if (!target) return
                try {
                  await rpc('threads.attach', { dshSessionId: target, threadId })
                  await refreshBindings()
                  diag('manual-bind', { sessionId: target, threadId })
                } catch (error) {
                  reportError(error, 'manual bind')
                }
              },
              selectedId: selectedThreadId,
            }))
            : null,
          h(
            'div',
            { className: 'dsh-native-codex-cli-panel-main' },
            selectedThreadId
              ? h('div', { className: 'dsh-native-codex-cli-thread-head' },
                h('span', { className: 'dsh-native-codex-cli-mono' }, selectedThreadId),
                h('button', {
                  type: 'button',
                  onClick: async () => {
                    const name = globalThis.prompt?.('线程名称')
                    if (name) {
                      await rpc('threads.rename', { threadId: selectedThreadId, name }).catch((renameError) => reportError(renameError, 'rename'))
                      await refreshThreadList({})
                    }
                  },
                }, '重命名'),
              )
              : null,
            guard('transcript', h(Transcript, { threadId: selectedThreadId, sessionId: activeSessionId() })),
            guard('composer', h(Composer, { sessionId: activeSessionId(), threadId: selectedThreadId })),
          ),
        ),
      )
    }

    // ------------------------------------------------------- session-scoped view

    function SessionCodexView(props) {
      const sessionId = sessionIdFromProps('view', props)
      React.useEffect(() => noteSession(sessionId), [sessionId])
      const binding = useStore((state) => (sessionId ? bindingFor(sessionId) : null))
      const threadId = binding?.threadId ?? null

      React.useEffect(() => {
        if (threadId && !store.state.threads[threadId]) void openThread(threadId, sessionId)
      }, [threadId, sessionId])

      if (!sessionId) return h(Empty, { text: '未选择会话。' })
      if (!threadId) {
        return h(
          'div',
          { className: 'dsh-native-codex-cli-sessionview' },
          h(Empty, { text: '这个会话还没有绑定 Codex 线程。' }),
          h(NewThreadForm, { sessionId, onCreated: (id) => { void openThread(id, sessionId) } }),
        )
      }
      return h(
        'div',
        { className: 'dsh-native-codex-cli-sessionview' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-sessionview-head' },
          h('span', { className: 'dsh-native-codex-cli-muted' }, `Codex 线程 ${threadId.slice(0, 8)}`),
          h('button', { type: 'button', onClick: () => detachSession(sessionId) }, '解除绑定，交还 DSH'),
        ),
        h(Transcript, { threadId, sessionId }),
        // No Composer here on purpose: `conversation.composer` already replaces
        // this session's resident input, and the dock sits above it. Rendering
        // one here as well produced two stacked input boxes.
      )
    }

    /**
     * The bound session's Codex conversation, rendered directly above the
     * composer.
     *
     * `conversation.view` only renders the view the user selected, so a bound
     * session would otherwise show DSH's own (empty) chat view until the user
     * clicks the Codex tab. The input dock is session-scoped and always mounted,
     * so putting the transcript here makes the Codex conversation part of the
     * main page itself — no click required.
     */
    function CodexSessionDock(props) {
      // Fall back to the last session any seat reported: this dock is the whole
      // point of "show the Codex conversation on the main page", so it must not
      // silently render nothing just because its own props looked different.
      const sessionId = sessionIdFromProps('dock', props) ?? activeSessionId()
      React.useEffect(() => noteSession(sessionId), [sessionId])
      const binding = useStore((state) => (sessionId ? bindingFor(sessionId) : null))
      const threadId = binding?.threadId ?? null
      const thread = useStore((state) => (threadId ? state.threads[threadId] : null))
      const [collapsed, setCollapsed] = React.useState(false)

      React.useEffect(() => {
        if (threadId && !store.state.threads[threadId]) void openThread(threadId, sessionId)
      }, [threadId, sessionId])

      if (!sessionId || !threadId) return null

      return h(
        'div',
        { className: 'dsh-native-codex-cli-dock' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-dock-head' },
          h(CodexIcon, { size: 13, active: true }),
          h('span', null, 'Codex 对话'),
          h('span', { className: 'dsh-native-codex-cli-mono' }, threadId.slice(0, 8)),
          h('button', { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => setCollapsed(!collapsed) }, collapsed ? '展开' : '收起'),
          h('button', { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => detachSession(sessionId) }, '交还 DSH'),
        ),
        // The conversation's context, so the session is not just a bare input
        // box: which directory Codex is rooted at, and under which settings.
        collapsed
          ? null
          : h(
            'div',
            { className: 'dsh-native-codex-cli-dock-context' },
            h('span', null, `目录 ${asText(binding?.cwd ?? thread?.cwd, '未指定')}`),
            h('span', null, `模型 ${asText(binding?.model ?? thread?.model, 'Codex 默认')}`),
            h('span', null, `审批 ${asText(binding?.approvalPolicy, 'on-request')}`),
            h('span', null, `沙箱 ${asText(binding?.sandbox, 'workspace-write')}`),
          ),
        collapsed ? null : h(Transcript, { threadId, sessionId }),
      )
    }

    /** Composer takeover: once bound, this session's input belongs to Codex. */
    function CodexComposerTakeover(props) {
      const sessionId = props?.matched?.sessionId ?? sessionIdFromProps('composer', props)
      const binding = useStore((state) => (sessionId ? bindingFor(sessionId) : null))
      const creating = useStore((state) => state.busy.create)
      React.useEffect(() => noteSession(sessionId), [sessionId])
      if (!sessionId || !binding?.threadId) return null
      return h(
        'div',
        { className: 'dsh-native-codex-cli-takeover' },
        h(
          'div',
          { className: 'dsh-native-codex-cli-takeover-banner' },
          h(CodexIcon, { size: 14, active: true }),
          h('span', null, '本会话由 Codex 接管'),
          h('span', { className: 'dsh-native-codex-cli-mono' }, binding.threadId.slice(0, 8)),
          // Direct controls, so a binding can be changed or dropped without the
          // "hand back, then create a thread somewhere else" detour.
          h('button', {
            type: 'button',
            className: 'dsh-native-codex-cli-link',
            title: '给这个会话换一条新的 Codex 线程',
            disabled: creating,
            onClick: () => void newThreadForSession(sessionId),
          }, creating ? '创建中…' : '新建线程'),
          h('button', {
            type: 'button',
            className: 'dsh-native-codex-cli-link',
            title: '彻底解除绑定（不保留线程关联，下次交给 Codex 会开始新对话）',
            onClick: () => void unbindSession(sessionId),
          }, '解除绑定'),
          h('button', { type: 'button', className: 'dsh-native-codex-cli-link', onClick: () => detachSession(sessionId) }, '交还 DSH'),
        ),
        h(Composer, { sessionId, threadId: binding.threadId, compact: true }),
      )
    }

    /**
     * "@Codex" affordance in the native composer.
     *
     * The draft is read through the slot's standard `useInput` hook when the
     * host provides it. If it does, one click hands the draft to Codex (creating
     * and binding a thread) without ever routing it through the DSH model.
     */
    function ComposerCodexAction(props) {
      const sessionId = sessionIdFromProps('input-right', props)
      React.useEffect(() => noteSession(sessionId), [sessionId])
      const binding = useStore((state) => (sessionId ? bindingFor(sessionId) : null))
      const [draft, setDraft] = React.useState('')
      const inputActions = props?.inputActions
      const useInput = props?.useInput

      // Probe the host-provided input hooks once, and record their shape so the
      // wiring can be corrected from the plugin log if the names differ.
      React.useEffect(() => {
        if (!useInput && !inputActions) {
          diag('composer-hooks-missing', { keys: Object.keys(props ?? {}) })
          return
        }
        diag('composer-hooks', {
          inputActions: inputActions ? Object.keys(inputActions) : null,
          hasUseInput: Boolean(useInput),
        })
      }, [])

      // Call the slot's hook unconditionally so React's hook order is stable;
      // `noopHook` stands in wherever the host did not supply one.
      //
      // `useInput` is a `SnapshotSelectorHook<InputState>`: it MUST be given a
      // selector. Calling it bare makes the host invoke `undefined(state)`,
      // which surfaces as the minified "l is not a function" — the exact error
      // the first live run reported. This is the last hook in the component, so
      // a throw here cannot desynchronise any later hook.
      const inputHook = typeof useInput === 'function' ? useInput : noopHook
      let snapshot = null
      try {
        snapshot = inputHook((state) => state)
      } catch (error) {
        diag('useInput-failed', String(error?.message ?? error))
        snapshot = null
      }
      // Report the real `InputState` shape once, so the draft extraction below
      // can be pinned to actual field names rather than to guesses.
      if (!inputShapeLogged && snapshot && typeof snapshot === 'object') {
        inputShapeLogged = true
        diag('input-snapshot', { keys: Object.keys(snapshot), sample: JSON.stringify(snapshot).slice(0, 400) })
      }
      const liveDraft = typeof snapshot === 'string'
        ? snapshot
        : snapshot?.text ?? snapshot?.draft ?? snapshot?.value ?? snapshot?.input?.text ?? draft
      const mentionsCodex = CODEX_MENTION_TEST.test(liveDraft ?? '')

      const handOff = async () => {
        const text = stripCodexMention(liveDraft ?? '')
        let threadId = binding?.threadId ?? null
        diag('handoff', {
          sessionId,
          hasBinding: Boolean(threadId),
          draftLength: typeof liveDraft === 'string' ? liveDraft.length : null,
          draftPreview: typeof liveDraft === 'string' ? liveDraft.slice(0, 80) : null,
          snapshotKeys: snapshot && typeof snapshot === 'object' ? Object.keys(snapshot) : null,
        })

        // Task path: the plugin relays the draft to Codex itself.
        //
        // An earlier revision routed this through DSH's `/codex` command because
        // that is what makes the session durable. It is not an AI path — the
        // commands service explicitly runs "without sending it to the model" —
        // but it did mean the task no longer flowed plugin→Codex: it became
        // "ask DSH to run a command", which is not what this plugin is for.
        // Durability is handled separately, by the host half, as bookkeeping.
        if (text.trim()) {
          try {
            if (typeof inputActions?.setDraft === 'function') inputActions.setDraft('')
            else if (typeof inputActions?.setText === 'function') inputActions.setText('')
            else if (typeof inputActions?.clear === 'function') inputActions.clear()
            else if (typeof inputActions?.reset === 'function') inputActions.reset()
          } catch (error) {
            diag('clear-draft-failed', String(error?.message ?? error))
          }
          setDraft('')
        } else {
          // Nothing readable in the native draft. Binding still has to work:
          // taking the session over swaps in the Codex composer, which is where
          // the user can type instead of clicking a button that silently did
          // nothing.
          diag('handoff-without-draft', 'native draft unreadable; binding session and taking the composer over')
        }

        if (!threadId) {
          // Resume the session's previous Codex thread when it was handed back
          // earlier; only a first-ever hand-off creates a new one.
          threadId = await takeOverSession(sessionId)
        }
        if (threadId) {
          if (text.trim()) await sendMessage({ sessionId, threadId, text })
          else await refreshBindings()
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: `dsh-native-codex-cli-inline-action${mentionsCodex ? ' dsh-native-codex-cli-inline-action-hot' : ''}`,
          title: mentionsCodex ? '把这条消息直接交给 Codex' : '把当前输入框内容交给 Codex（输入 @codex 可高亮，不分大小写）',
          onClick: handOff,
        },
        h(CodexIcon, { size: 14, active: mentionsCodex }),
        h('span', null, mentionsCodex ? '交给 Codex' : 'Codex'),
      )
    }

    // -------------------------------------------------------------------- styles

    const CSS = `
/* Map this plugin's internal aliases onto DSH's real theme tokens.
   The live Theme provider registers names under --dsw-alias-* (label-primary,
   bg-layer-1/2, border-l1, brand-primary, state-*), NOT the --dsh-* names this
   stylesheet was first written against — so every var() below was silently
   falling back to a hard-coded colour and never matched the active theme. */
.dsh-native-codex-cli-panel,.dsh-native-codex-cli-sessionview,.dsh-native-codex-cli-takeover,.dsh-native-codex-cli-inline-action,.dsh-native-codex-cli-threadlist,.dsh-native-codex-cli-transcript-wrap,.dsh-native-codex-cli-approval,.dsh-native-codex-cli-dock{
  --dsh-text-primary: var(--dsw-alias-label-primary);
  --dsh-border: var(--dsw-alias-border-l1);
  --dsh-hover: var(--dsw-alias-bg-layer-2);
  --dsh-selected: var(--dsw-alias-bg-layer-2);
  --dsh-surface-1: var(--dsw-alias-bg-layer-1);
  --dsh-surface-2: var(--dsw-alias-bg-layer-2);
  --dsh-input-bg: var(--dsw-alias-bg-layer-2);
  --dsh-button-bg: var(--dsw-alias-bg-layer-2);
  --dsh-code-bg: var(--dsw-alias-bg-layer-2);
  --dsh-code-accent: var(--dsw-alias-brand-primary);
  --dsh-link: var(--dsw-alias-brand-primary);
  --dsh-accent: var(--dsw-alias-brand-primary);
  --dsh-accent-soft: color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent);
  --dsh-error: var(--dsw-alias-state-error-primary);
  --dsh-success: var(--dsw-alias-state-success-primary);
  --dsh-warn: var(--dsw-alias-state-warn-primary);
  --dsh-muted: var(--dsw-alias-label-secondary);
}
.dsh-native-codex-cli-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsh-text-primary,inherit)}
.dsh-native-codex-cli-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.25))}
.dsh-native-codex-cli-panel-title{display:flex;align-items:center;gap:8px;font-weight:600}
.dsh-native-codex-cli-panel-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-native-codex-cli-panel-body{display:flex;flex:1;min-height:0}
.dsh-native-codex-cli-panel-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.dsh-native-codex-cli-threadlist{width:290px;min-width:220px;border-right:1px solid var(--dsh-border,rgba(128,128,128,.25));display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.dsh-native-codex-cli-threadlist-head{display:flex;gap:6px;padding:8px;flex-wrap:wrap}
.dsh-native-codex-cli-threaditems{list-style:none;margin:0;padding:0}
.dsh-native-codex-cli-threaditem{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.12))}
.dsh-native-codex-cli-threaditem:hover{background:var(--dsh-hover,rgba(128,128,128,.12))}
.dsh-native-codex-cli-threaditem-active{background:var(--dsh-selected,rgba(128,128,128,.2))}
.dsh-native-codex-cli-threaditem-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-native-codex-cli-threaditem-meta{display:flex;gap:8px;font-size:11px;opacity:.65;margin-top:3px;flex-wrap:wrap}
.dsh-native-codex-cli-thread-head{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.15));font-size:11px}
.dsh-native-codex-cli-transcript-wrap{display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-native-codex-cli-transcript{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;min-height:0}
.dsh-native-codex-cli-turn{display:flex;flex-direction:column;gap:10px;padding-bottom:10px;border-bottom:1px dashed var(--dsh-border,rgba(128,128,128,.2))}
.dsh-native-codex-cli-turn-foot{display:flex;gap:8px;align-items:center;opacity:.75;font-size:11px}
.dsh-native-codex-cli-row{display:flex}
.dsh-native-codex-cli-row-user{justify-content:flex-end}
.dsh-native-codex-cli-bubble{padding:9px 12px;border-radius:10px;background:var(--dsh-surface-2,rgba(128,128,128,.14));max-width:min(760px,88%)}
.dsh-native-codex-cli-bubble-user{background:var(--dsh-accent-soft,rgba(80,140,255,.2))}
.dsh-native-codex-cli-text{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55}
.dsh-native-codex-cli-code,.dsh-native-codex-cli-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;background:var(--dsh-code-bg,rgba(0,0,0,.28));border-radius:8px;padding:8px 10px;margin:6px 0;max-height:420px;overflow:auto}
.dsh-native-codex-cli-pre-cmd{color:var(--dsh-code-accent,#7ec8ff)}
.dsh-native-codex-cli-inline-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:var(--dsh-code-bg,rgba(0,0,0,.28));border-radius:4px;padding:1px 4px}
.dsh-native-codex-cli-card{border:1px solid var(--dsh-border,rgba(128,128,128,.28));border-radius:10px;padding:9px 11px;font-size:12px;background:var(--dsh-surface-1,rgba(128,128,128,.07))}
.dsh-native-codex-cli-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.dsh-native-codex-cli-card-title{font-weight:600;margin-bottom:4px}
.dsh-native-codex-cli-tool-kind{font-weight:600;font-size:12px}
.dsh-native-codex-cli-reasoning summary{cursor:pointer;opacity:.8}
.dsh-native-codex-cli-badge{font-size:10px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsh-muted,currentColor) 22%,transparent)}
.dsh-native-codex-cli-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3cb46e) 30%,transparent)}
.dsh-native-codex-cli-badge-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc4646) 32%,transparent)}
.dsh-native-codex-cli-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6aa32) 32%,transparent)}
.dsh-native-codex-cli-badge-running{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#508cff) 32%,transparent)}
.dsh-native-codex-cli-badge-off{background:color-mix(in srgb,var(--dsh-muted,currentColor) 18%,transparent)}
.dsh-native-codex-cli-muted{opacity:.62;font-size:11px}
.dsh-native-codex-cli-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
.dsh-native-codex-cli-cwd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-native-codex-cli-filelist{list-style:none;margin:4px 0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsh-native-codex-cli-filelist li{display:flex;gap:8px}
.dsh-native-codex-cli-filekind{opacity:.7;min-width:52px}
.dsh-native-codex-cli-filepath{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.dsh-native-codex-cli-link{background:none;border:none;color:var(--dsh-link,#6cb2ff);cursor:pointer;padding:2px 0;font-size:11px;text-align:left}
.dsh-native-codex-cli-error{color:var(--dsw-alias-state-error-primary,#ff8a8a);font-size:12px;margin-top:6px}
.dsh-native-codex-cli-error-bar{padding:6px 14px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc4646) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc4646) 14%,transparent)}
.dsh-native-codex-cli-notice{font-size:12px;padding:6px 9px;border-radius:8px;background:var(--dsh-surface-2,rgba(128,128,128,.12))}
.dsh-native-codex-cli-notice-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc4646) 18%,transparent)}
.dsh-native-codex-cli-notice-warning{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6aa32) 18%,transparent)}
.dsh-native-codex-cli-empty{padding:20px;opacity:.6;font-size:13px;text-align:center}
.dsh-native-codex-cli-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#888}
.dsh-native-codex-cli-dot-ok{background:#3cb46e}
.dsh-native-codex-cli-dot-warn{background:#e6aa32}
.dsh-native-codex-cli-dot-off{background:#888}
.dsh-native-codex-cli-spinner{opacity:.6;font-size:11px}
.dsh-native-codex-cli-composer{border-top:1px solid var(--dsh-border,rgba(128,128,128,.25));padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.dsh-native-codex-cli-textarea,.dsh-native-codex-cli-input{width:100%;box-sizing:border-box;background:var(--dsh-input-bg,rgba(128,128,128,.12));color:inherit;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;resize:vertical}
.dsh-native-codex-cli-composer-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dsh-native-codex-cli-composer-selects{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dsh-native-codex-cli-select-field{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-native-codex-cli-select{background:var(--dsh-input-bg,rgba(128,128,128,.12));color:var(--dsh-text-primary,inherit);border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:6px;padding:2px 4px;font-size:11px;max-width:190px}
.dsh-native-codex-cli-dock{border-top:1px solid var(--dsh-border,rgba(128,128,128,.25));display:flex;flex-direction:column;min-height:0}
.dsh-native-codex-cli-dock .dsh-native-codex-cli-transcript{max-height:28vh;padding:0 12px 6px}
.dsh-native-codex-cli-dock-head{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px}
.dsh-native-codex-cli-dock-context{display:flex;gap:12px;flex-wrap:wrap;padding:0 12px 4px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-native-codex-cli-dock-body{display:flex;flex-direction:column;gap:10px;padding:0 12px 8px}
.dsh-native-codex-cli-composer-actions{display:flex;gap:6px}
.dsh-native-codex-cli-attachments{display:flex;gap:6px;flex-wrap:wrap;padding:2px 0 4px}
.dsh-native-codex-cli-attachment{position:relative;display:inline-block;line-height:0}
.dsh-native-codex-cli-attachment img{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35))}
.dsh-native-codex-cli-attachment-remove{position:absolute;top:-6px;right:-6px;width:18px;height:18px;padding:0!important;border-radius:999px!important;font-size:12px;line-height:16px;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.6))!important;color:var(--dsw-alias-label-primary,inherit)!important}
.dsh-native-codex-cli-attach{font-size:14px!important;line-height:1!important;padding:2px 8px!important;border-radius:999px!important}
/* Image thumbnails inside a user turn, and the click-to-enlarge overlay. */
.dsh-native-codex-cli-bubble-images{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dsh-native-codex-cli-thumb{
  display:block;
  max-width:190px;
  max-height:190px;
  border-radius:8px;
  cursor:zoom-in;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));
  background:color-mix(in srgb,currentColor 6%,transparent);
}
.dsh-native-codex-cli-lightbox{
  position:fixed;
  inset:0;
  z-index:9999;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:3vh 3vw;
  background:rgba(0,0,0,.78);
  cursor:zoom-out;
}
.dsh-native-codex-cli-lightbox img{
  max-width:100%;
  max-height:94vh;
  object-fit:contain;
  border-radius:8px;
  box-shadow:0 10px 46px rgba(0,0,0,.55);
  cursor:default;
}
/* --- rendered Markdown -------------------------------------------------------
   Codex answers in Markdown, so the bubble styles real block elements now:
   paragraphs, headings, lists, quotes, rules and links. */
.dsh-native-codex-cli-bubble{font-size:13px;line-height:1.58;white-space:normal;word-break:break-word}
.dsh-native-codex-cli-p{margin:0 0 8px;white-space:pre-wrap}
.dsh-native-codex-cli-p:last-child{margin-bottom:0}
.dsh-native-codex-cli-h{margin:10px 0 6px;font-weight:600;line-height:1.3}
h3.dsh-native-codex-cli-h{font-size:15px}
h4.dsh-native-codex-cli-h{font-size:14px}
h5.dsh-native-codex-cli-h,h6.dsh-native-codex-cli-h{font-size:13px}
.dsh-native-codex-cli-list{margin:4px 0 8px;padding-left:20px}
.dsh-native-codex-cli-list li{margin:2px 0}
.dsh-native-codex-cli-bubble blockquote{
  margin:6px 0;
  padding:2px 10px;
  border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));
  color:var(--dsw-alias-label-secondary,inherit);
}
.dsh-native-codex-cli-bubble hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));margin:10px 0}
.dsh-native-codex-cli-bubble a{color:var(--dsw-alias-brand-primary,inherit);text-decoration:underline}
.dsh-native-codex-cli-bubble strong{font-weight:600}
.dsh-native-codex-cli-bubble em{font-style:italic}
.dsh-native-codex-cli-panel button,.dsh-native-codex-cli-takeover button,.dsh-native-codex-cli-sessionview button{cursor:pointer;background:var(--dsh-button-bg,rgba(128,128,128,.18));color:inherit;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:7px;padding:4px 9px;font-size:12px}
.dsh-native-codex-cli-panel button:disabled,.dsh-native-codex-cli-takeover button:disabled{opacity:.5;cursor:default}
.dsh-native-codex-cli-primary{background:var(--dsh-accent,rgba(80,140,255,.55))!important;border-color:transparent!important}
.dsh-native-codex-cli-danger{background:rgba(220,70,70,.35)!important}
.dsh-native-codex-cli-approval-dock{padding:0 14px 10px;display:flex;flex-direction:column;gap:8px}
.dsh-native-codex-cli-approval{border:1px solid rgba(230,170,50,.5);background:rgba(230,170,50,.1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px}
.dsh-native-codex-cli-approval-title{font-weight:600;font-size:13px}
.dsh-native-codex-cli-approval-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-native-codex-cli-question{display:flex;flex-direction:column;gap:4px;margin:4px 0}
.dsh-native-codex-cli-question-header{font-weight:600;font-size:12px}
.dsh-native-codex-cli-question-text{font-size:12px;opacity:.85}
.dsh-native-codex-cli-option{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.dsh-native-codex-cli-newthread{padding:10px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.25))}
.dsh-native-codex-cli-field{display:flex;flex-direction:column;gap:3px}
.dsh-native-codex-cli-field label{font-size:11px;opacity:.7}
.dsh-native-codex-cli-field-row{display:flex;gap:6px}
.dsh-native-codex-cli-sessionview{display:flex;flex-direction:column;height:100%;min-height:0}
.dsh-native-codex-cli-sessionview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;font-size:11px;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.15))}
.dsh-native-codex-cli-takeover{display:flex;flex-direction:column;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:12px;overflow:hidden}
.dsh-native-codex-cli-takeover-banner{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;background:rgba(80,140,255,.14)}
.dsh-native-codex-cli-inline-action{display:inline-flex;align-items:center;gap:4px}
.dsh-native-codex-cli-inline-action-hot{background:var(--dsh-accent,rgba(80,140,255,.55))!important;border-color:transparent!important}

/* --- readability pass -------------------------------------------------------
   The first live build painted several controls with their own filled colours;
   on the dark theme those read as opaque black boxes (worst at the composer's
   bottom-right, where the submit button and the selects sit). Everything this
   plugin owns is now transparent and inherits DSH's own text colour, so it
   tracks the active theme in both light and dark. Declared last so it wins
   against the earlier rules without editing each one. */
.dsh-native-codex-cli-textarea,
.dsh-native-codex-cli-input,
.dsh-native-codex-cli-select{
  background:transparent!important;
  color:inherit!important;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35))!important;
}
.dsh-native-codex-cli-panel button,
.dsh-native-codex-cli-sessionview button,
.dsh-native-codex-cli-takeover button,
.dsh-native-codex-cli-dock button,
.dsh-native-codex-cli-inline-action,
.dsh-native-codex-cli-approval button{
  background:transparent!important;
  color:inherit!important;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35))!important;
}
.dsh-native-codex-cli-primary{
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#508cff) 34%,transparent)!important;
  color:inherit!important;
  border-color:transparent!important;
}
.dsh-native-codex-cli-danger{
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc4646) 30%,transparent)!important;
  color:inherit!important;
  border-color:transparent!important;
}
.dsh-native-codex-cli-inline-action-hot,
.dsh-native-codex-cli-inline-action-hot:hover{
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#508cff) 34%,transparent)!important;
  color:inherit!important;
  border-color:transparent!important;
}
.dsh-native-codex-cli-link,
.dsh-native-codex-cli-link:hover{
  background:transparent!important;
  color:var(--dsw-alias-brand-primary,inherit)!important;
  border:none!important;
}
.dsh-native-codex-cli-code,
.dsh-native-codex-cli-pre,
.dsh-native-codex-cli-inline-code{background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-native-codex-cli-bubble{background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-native-codex-cli-bubble-user{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#508cff) 24%,transparent)}
.dsh-native-codex-cli-card,
.dsh-native-codex-cli-notice,
.dsh-native-codex-cli-approval{background:color-mix(in srgb,currentColor 7%,transparent)}
.dsh-native-codex-cli-panel,
.dsh-native-codex-cli-sessionview,
.dsh-native-codex-cli-takeover,
.dsh-native-codex-cli-dock{color:var(--dsw-alias-label-primary,inherit)}
.dsh-native-codex-cli-muted{color:var(--dsw-alias-label-secondary,currentColor)!important}

/* --- match DSH's own composer ------------------------------------------------
   Reference: DSH's native input is a *centred rounded card* with a max width,
   not an edge-to-edge strip. The takeover replaces the resident composer's
   contents, so the centring has to be done here or it stretches across the
   whole column and swallows the bottom of the page. */
.dsh-native-codex-cli-takeover{
  display:flex!important;
  flex-direction:column!important;
  box-sizing:border-box!important;
  width:100%!important;
  /* 56rem was still too wide and hugged the window edge; 38rem is ~2/3 of that,
     and the bottom margin lifts the card off the edge the way DSH's own
     composer sits. */
  max-width:38rem!important;
  margin:0 auto 18px!important;
  padding:8px 12px 10px!important;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28))!important;
  border-radius:16px!important;
  background:var(--dsw-alias-bg-layer-1,transparent)!important;
  overflow:visible!important;
  gap:0!important;
}
.dsh-native-codex-cli-takeover-banner{
  background:transparent!important;
  border:none!important;
  padding:0 2px 4px!important;
  color:var(--dsw-alias-label-secondary,inherit);
  font-size:11px;
}
.dsh-native-codex-cli-composer{
  border-top:none!important;
  background:transparent!important;
  padding:0!important;
  gap:4px!important;
}
.dsh-native-codex-cli-textarea{
  border:none!important;
  background:transparent!important;
  resize:none!important;
  padding:4px 2px!important;
}
.dsh-native-codex-cli-textarea:focus{outline:none!important}
/* Toolbar row: selectors left, send action right — like the native composer. */
.dsh-native-codex-cli-composer-bar{flex-wrap:nowrap!important;gap:8px!important}
.dsh-native-codex-cli-composer-selects{gap:10px!important;min-width:0;flex:1 1 auto}
.dsh-native-codex-cli-composer-actions{flex:0 0 auto;margin-left:auto}
.dsh-native-codex-cli-select{border:none!important;background:transparent!important;padding:0 2px!important}
.dsh-native-codex-cli-primary{
  border-radius:999px!important;
  padding:4px 14px!important;
}
/* The dock lines up with the composer card instead of the full column. */
.dsh-native-codex-cli-dock{
  background:transparent!important;
  width:100%!important;
  max-width:38rem!important;
  margin:0 auto 6px!important;
  box-sizing:border-box!important;
}
`

    function injectStyles() {
      if (document.getElementById(`${NS}-styles`)) return () => {}
      const style = document.createElement('style')
      style.id = `${NS}-styles`
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    // --------------------------------------------------------------- registration

    /** Cordis context captured for cross-component access (e.g. directory pick). */
    const ctxRef = { current: null }

    function safeRegister(slots, declaration, render, label) {
      try {
        const dispose = slots.register(declaration, render)
        diag('slot-registered', { slot: declaration.name, id: declaration.id ?? declaration.key, label })
        return dispose
      } catch (error) {
        reportError(error, `register ${label}`)
        return () => {}
      }
    }

    /**
     * Take one seat, waiting for the owning entry to declare its slot first.
     *
     * Registering immediately only works for slots that already exist when the
     * plugin is applied. The root-scoped seats (`main`, `sidebar.panellist`) and
     * the conversation views are declared by the shell later during boot, so an
     * eager `register` fails with "slot ... is not declared" — which is exactly
     * what the first live run reported. `slots.inject(key, ...)` is the
     * supported way to wait for the declaration.
     */
    function seat(ctx, slots, key, factory, label) {
      const install = () => {
        try {
          const dispose = slots.inject(key, factory)
          return typeof dispose === 'function' ? dispose : () => {}
        } catch (error) {
          reportError(error, `inject ${label}`)
          return () => {}
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(install, `${NS}: ${label}`)
      else install()
    }

    function apply(ctx) {
      ctxRef.current = ctx
      // `inject = ['slots']` makes `ctx.slots` the hard path, and the restricted
      // client context also exposes `get`; try both so a difference in either
      // one cannot silently disable the whole plugin.
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) ?? ctx.slots
      if (ctx.effect) ctx.effect(() => injectStyles(), `${NS}: styles`)
      connectEvents()

      // Probe the client services a future "put this Codex thread in the
      // session list" feature needs. `get` may hand back a proxy whose methods
      // are not enumerable, so probe names explicitly.
      try {
        const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
        const has = (service, methods) => {
          if (!service) return null
          const out = {}
          for (const method of methods) out[method] = typeof service[method]
          return out
        }
        diag('client-services', {
          uiWorkspace: has(get('uiWorkspace'), ['startSession', 'openSession', 'connectWorkspace', 'openWorkspace', 'forkSession', 'pickDirectory']),
          workspaces: has(get('workspaces'), ['create', 'rename', 'insertSessionBefore']),
          sessions: has(get('sessions'), ['retain', 'scope', 'binding', 'retainInfo']),
          layout: has(get('layout'), ['selectPanel', 'openRightbar']),
        })
      } catch (error) {
        diag('client-services-failed', String(error?.message ?? error))
      }

      if (!slots?.register || !slots?.inject) {
        reportError(new Error('slots service unavailable or missing inject()'), 'apply')
        return
      }

      // 1. Standalone Codex workspace panel + its sidebar entry.
      seat(ctx, slots, 'main', () => safeRegister(
        slots,
        { name: 'main', key: 'codex' },
        () => guard('panel', h(CodexPanel)),
        'main[codex]',
      ), 'main[codex]')

      seat(ctx, slots, 'sidebar.panellist', () => safeRegister(
        slots,
        { name: 'sidebar.panellist', id: 'codex', order: 20, label: () => 'Codex' },
        (props) => guard('sidebar', h(CodexIcon, { size: props?.size ?? 18, active: props?.active })),
        'sidebar.panellist[codex]',
      ), 'sidebar.panellist[codex]')

      // 2. A Codex view inside an ordinary DSH session.
      seat(ctx, slots, 'conversation.view', () => safeRegister(
        slots,
        { name: 'conversation.view', id: 'codex', order: 5, label: () => 'Codex' },
        (props) => guard('session-view', h(SessionCodexView, props ?? {})),
        'conversation.view[codex]',
      ), 'conversation.view[codex]')

      // 3. Composer takeover for bound sessions: the FIRST non-null selector wins.
      seat(ctx, slots, 'conversation.composer', () => safeRegister(
        slots,
        {
          name: 'conversation.composer',
          select: (owner) => (owner?.sessionId && isSessionBound(owner.sessionId) ? { sessionId: owner.sessionId } : null),
        },
        (props) => guard('composer', h(CodexComposerTakeover, props ?? {})),
        'conversation.composer',
      ), 'conversation.composer')

      // 4. "@Codex" hand-off control in the native composer.
      seat(ctx, slots, 'conversation.input.right', () => safeRegister(
        slots,
        { name: 'conversation.input.right', id: 'codex', order: 40 },
        (props) => guard('input-action', h(ComposerCodexAction, props ?? {})),
        'conversation.input.right[codex]',
      ), 'conversation.input.right[codex]')

      // 5. The Codex transcript on the main page, above the composer.
      seat(ctx, slots, 'conversation.input.dock', () => safeRegister(
        slots,
        { name: 'conversation.input.dock', id: 'codex', order: 5 },
        (props) => guard('session-dock', h(CodexSessionDock, props ?? {})),
        'conversation.input.dock[codex]',
      ), 'conversation.input.dock[codex]')
    }

    const name = NS
    const inject = ['slots']

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // Test seam: the Markdown renderer is pure, so the load check can exercise
    // it directly instead of needing a browser.
    exports.__renderMarkdown = renderRichText
    return module.exports
  },
})
