/**
 * Codex app-server process client.
 *
 * Owns ONE `codex app-server` child process over the stdio transport, performs
 * the JSON-RPC `initialize` handshake, correlates responses, fans out
 * notifications, and — critically — answers server-initiated requests
 * (approvals / user-questions) so Codex never blocks forever on a client that
 * forgot to reply.
 *
 * Verified against codex-cli 0.153.4: the wire format is newline-delimited
 * JSON, responses are `{id, result|error}`, notifications are `{method, params}`,
 * and server requests are `{id, method, params}`.
 *
 * The transport is deliberately factored behind {@link createTransport} so a
 * future shared `codex app-server` daemon adapter can be slotted in without
 * touching the protocol client.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { LineRpc } from './rpc.js'
import { resolveCodexBin } from './resolve-bin.js'

const HANDSHAKE_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/**
 * Turn a raw spawn failure into something a user can act on.
 *
 * `spawn codex ENOENT` is the most common failure by far, and the bare errno
 * tells the user nothing. When the CLI could not be found anywhere, the list of
 * places that were searched is the only useful piece of information.
 * @param {any} error
 * @param {string} bin
 * @param {string[]} [searched]
 */
function describeSpawnFailure(error, bin, searched = []) {
  if (error?.code === 'ENOENT') {
    const where = searched.length
      ? `\n已查找以下位置 / searched: ${searched.slice(0, 24).join('  |  ')}`
      : ''
    return new Error(
      `未找到 Codex CLI：无法执行 "${bin}"。请安装 Codex CLI（桌面端自带，或 npm i -g @openai/codex），`
        + `或在配置里把 codexBin 指向它的完整路径`
        + `（~/.dsh/storages/dsh-native-codex-cli/config.json）。`
        + ` Codex CLI not found: cannot spawn "${bin}".${where}`,
    )
  }
  if (error?.code === 'EACCES') {
    return new Error(`无法执行 "${bin}"（权限不足）。Codex CLI is not executable: "${bin}".`)
  }
  return error instanceof Error ? error : new Error(String(error?.message ?? error))
}

/**
 * Spawn `codex app-server` and expose its stdio as a byte duplex.
 * @param {{bin: string, args: string[], cwd?: string, env?: Record<string,string>}} spec
 */
function createStdioTransport(spec, log) {
  const args = ['app-server', ...(spec.args ?? [])]
  log.info('spawning', spec.bin, args.join(' '))
  let child
  try {
    child = spawn(spec.bin, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    // A synchronous throw (bad cwd, invalid arguments) must not escape either.
    const failure = describeSpawnFailure(error, spec.bin)
    log.error('spawn threw', failure.message)
    return {
      kind: 'stdio',
      child: null,
      spawnError: failure,
      write: () => {},
      onStdout: () => {},
      onStderr: () => {},
      onExit: () => {},
      onError: (fn) => queueMicrotask(() => fn(failure)),
      kill: () => {},
      pid: () => null,
    }
  }
  return {
    kind: 'stdio',
    child,
    write: (text) => child.stdin.write(text),
    onStdout: (fn) => child.stdout.on('data', (chunk) => fn(chunk.toString('utf8'))),
    onStderr: (fn) => child.stderr.on('data', (chunk) => fn(chunk.toString('utf8'))),
    onExit: (fn) => child.on('exit', fn),
    onError: (fn) => child.on('error', fn),
    kill: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
    pid: () => child.pid,
  }
}

/**
 * Reserved seam for a shared `codex app-server daemon` adapter.
 * Unimplemented on purpose: `transport: 'daemon'` fails loudly rather than
 * silently spawning a second, unsynchronised Codex instance.
 */
function createDaemonTransport() {
  throw new Error(
    "transport 'daemon' is not implemented yet. Run `codex app-server daemon start` and wire "
      + 'createDaemonTransport() to the control socket (see docs/app-server).',
  )
}

export function createTransport(kind, spec, log) {
  if (kind === 'daemon') return createDaemonTransport(spec, log)
  return createStdioTransport(spec, log)
}

/** Events: `notification`, `server-request`, `server-request-resolved`, `exit`, `error`, `stderr`. */
export class CodexAppServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.bin
   * @param {string[]} [options.args]
   * @param {'stdio'|'daemon'} [options.transport]
   * @param {boolean} [options.experimentalApi]
   * @param {object} options.log
   */
  constructor(options) {
    super()
    this.options = options
    this.log = options.log
    this._transport = null
    this._rpc = null
    this._startPromise = null
    this._initialized = false
    this._userAgent = null
    this._codexHome = null
    this._lastExit = null
    /** Absolute path of the CLI that was found, or null when it was not. */
    this._resolvedBin = null
    /** Every directory that was probed, for the "not found" report. */
    this._searchedDirs = []
    /** Server requests awaiting a client answer, keyed by JSON-RPC id. */
    this._serverRequests = new Map()
    this._serverRequestSeq = 0
    /**
     * EventEmitter throws when `'error'` is emitted with no listener, and an
     * uncaught exception here takes the whole DSH host down with it — on a
     * machine without the Codex CLI that turned "codex is not installed" into
     * "the app cannot start". A default handler is therefore always installed;
     * extra listeners still receive the same error.
     */
    this.on('error', (error) => {
      this.log.error('app-server error', error?.message ?? error)
    })
  }

  get running() {
    return Boolean(this._transport) && !this._rpc?.closed
  }

  get initialized() {
    return this._initialized
  }

  get info() {
    return {
      running: this.running,
      initialized: this._initialized,
      pid: this._transport?.pid?.() ?? null,
      userAgent: this._userAgent,
      codexHome: this._codexHome,
      transport: this.options.transport ?? 'stdio',
      codexBin: this._resolvedBin ?? this.options.bin,
      pendingServerRequests: this._serverRequests.size,
      lastExit: this._lastExit,
    }
  }

  /** Pending server requests (approvals/questions) as a serialisable list. */
  pendingServerRequests() {
    return [...this._serverRequests.values()].map((entry) => ({
      requestId: entry.requestId,
      method: entry.method,
      params: entry.params,
      receivedAt: entry.receivedAt,
    }))
  }

  /** Start (or reuse) the child and complete the `initialize` handshake. */
  async start() {
    if (this.running && this._initialized) return this.info
    if (this._startPromise) return this._startPromise
    this._startPromise = this._start().finally(() => {
      this._startPromise = null
    })
    return this._startPromise
  }

  async _start() {
    this._teardown('restart')

    // Resolve the CLI ourselves first. `PATH` alone misses the Codex desktop
    // app's own directory whenever this process inherited a stale environment —
    // which is the normal case for an Electron app started from the shell/start
    // menu, and it made "Codex is installed" look identical to "Codex is missing".
    const resolution = resolveCodexBin({ configured: this.options.bin, log: this.log })
    this._resolvedBin = resolution.resolved
    this._searchedDirs = resolution.searched

    const transport = createTransport(this.options.transport ?? 'stdio', {
      bin: resolution.bin,
      args: this.options.args ?? [],
      cwd: this.options.cwd,
      env: this.options.env,
    }, this.log)
    this._transport = transport

    const rpc = new LineRpc({
      write: (text) => transport.write(text),
      onNotification: (msg) => this._handleNotification(msg),
      onServerRequest: (msg) => this._handleServerRequest(msg),
      onProtocolError: (error) => this.emit('error', error),
      log: this.log,
    })
    this._rpc = rpc

    let stderrTail = ''

    /**
     * A spawn failure must *reject* `start()`, not merely emit an event: the
     * caller is awaiting the handshake, and an unhandled rejection here is
     * exactly what used to take the whole DSH host down when `codex` was not
     * installed. The race below turns it into a normal, catchable error.
     */
    let failStart = () => {}
    const startFailure = new Promise((_, reject) => {
      failStart = reject
    })
    // Prevent "unhandled rejection" if the handshake wins the race first.
    startFailure.catch(() => {})

    transport.onStdout((text) => rpc.push(text))
    transport.onStderr((text) => {
      stderrTail = `${stderrTail}${text}`.slice(-4000)
      this.log.debug('app-server stderr', text.trimEnd())
      this.emit('stderr', text)
    })
    transport.onError((error) => {
      const failure = describeSpawnFailure(error, this._resolvedBin ?? this.options.bin, this._searchedDirs ?? [])
      this.log.error('app-server spawn failed', failure.message)
      // Reject `start()` *before* closing the RPC: `rpc.close` rejects the
      // pending `initialize`, and whichever rejection lands first wins the race
      // above. Closing first would bury the actionable message inside a generic
      // "rpc closed (...)".
      failStart(failure)
      rpc.close(failure.message)
      this._transport = null
      this._initialized = false
      this.emit('error', failure)
    })
    transport.onExit((code, signal) => {
      const wasInitialized = this._initialized
      this._lastExit = { code, signal, at: Date.now(), stderrTail }
      this.log.warn('app-server exited', code, signal, stderrTail.slice(-600))
      rpc.close(`process exited (${code ?? signal})`)
      this._transport = null
      this._initialized = false
      this._failPendingServerRequests('app-server exited')
      // Died before the handshake finished: do not make the caller sit out the
      // 20s timeout.
      if (!wasInitialized) {
        failStart(new Error(
          `codex app-server 在握手完成前退出（exit ${code ?? signal}）：${stderrTail.slice(-300).trim() || '无 stderr 输出'}`,
        ))
      }
      this.emit('exit', this._lastExit)
    })

    let result
    try {
      result = await Promise.race([
        rpc.request('initialize', {
          clientInfo: { name: 'dsh_native_codex_cli', title: 'DSH Codex Bridge', version: '0.2.0' },
          capabilities: { experimentalApi: this.options.experimentalApi !== false },
        }, { timeoutMs: HANDSHAKE_TIMEOUT_MS }),
        startFailure,
      ])
    } catch (error) {
      // Leave nothing half-started behind: kill the child and drop the RPC.
      this._teardown('start failed')
      throw error
    }

    this._initialized = true
    this._userAgent = result?.userAgent ?? null
    this._codexHome = result?.codexHome ?? null
    // `ClientNotification` declares an `initialized` follow-up. The server
    // tolerates its absence, but sending it is the documented handshake.
    rpc.notify('initialized', {})
    this.log.info('app-server ready', this._userAgent)
    this.emit('ready', this.info)
    return this.info
  }

  async request(method, params, options = {}) {
    await this.start()
    return this._rpc.request(method, params, {
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    })
  }

  _handleNotification(msg) {
    this.emit('notification', msg)
  }

  _handleServerRequest(msg) {
    const requestId = String(msg.id)
    const entry = {
      requestId,
      rpcId: msg.id,
      method: msg.method,
      params: msg.params ?? {},
      receivedAt: Date.now(),
      seq: ++this._serverRequestSeq,
    }
    this._serverRequests.set(requestId, entry)
    this.log.info('server request', entry.method, requestId)
    this.emit('server-request', entry)
  }

  /** True when `requestId` is a live server request. */
  hasServerRequest(requestId) {
    return this._serverRequests.has(String(requestId))
  }

  /**
   * Answer a server-initiated request. Idempotent: a second answer for the same
   * request is ignored, so a double-clicked approval button cannot wedge the
   * RPC stream.
   */
  answerServerRequest(requestId, result, error) {
    const entry = this._serverRequests.get(String(requestId))
    if (!entry) return false
    this._serverRequests.delete(String(requestId))
    if (error) this._rpc.respondError(entry.rpcId, error.code ?? -32603, error.message ?? 'client error')
    else this._rpc.respond(entry.rpcId, result ?? {})
    this.emit('server-request-resolved', { requestId: entry.requestId, method: entry.method, answered: true })
    return true
  }

  /** Force-answer every pending server request with the plugin's safe default. */
  _failPendingServerRequests(reason) {
    for (const entry of [...this._serverRequests.values()]) {
      this.log.warn('auto-answering server request after', reason, entry.method)
      this.answerServerRequest(entry.requestId, defaultRefusal(entry.method), undefined)
    }
  }

  /** Refuse everything still pending, e.g. when the user stops a turn. */
  refusePendingServerRequests(reason) {
    for (const entry of [...this._serverRequests.values()]) {
      this.log.info('refusing pending server request', entry.method, reason ?? '')
      this.answerServerRequest(entry.requestId, defaultRefusal(entry.method))
    }
  }

  _teardown(reason) {
    if (this._rpc) {
      this._rpc.close(reason)
      this._rpc = null
    }
    if (this._transport) {
      this._transport.kill()
      this._transport = null
    }
    this._initialized = false
  }

  /** Stop the child. The next `start()` spawns a fresh one. */
  async stop(reason = 'stopped by plugin') {
    this._failPendingServerRequests(reason)
    this._teardown(reason)
  }
}

/**
 * The refusal payload for each server request kind.
 *
 * Codex treats an unanswered server request as a hang, so every branch must
 * produce a shape the protocol accepts — never `{}`.
 */
export function defaultRefusal(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return { permissions: {} }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline' }
    case 'item/tool/call':
      return { contentItems: [], success: false }
    case 'applyPatchApproval':
      return { decision: 'denied' }
    case 'execCommandApproval':
      return { decision: 'denied' }
    case 'account/chatgptAuthTokens/refresh':
      return {}
    case 'attestation/generate':
      return {}
    default:
      return {}
  }
}
