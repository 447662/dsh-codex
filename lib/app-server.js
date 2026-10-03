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

const HANDSHAKE_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/**
 * Spawn `codex app-server` and expose its stdio as a byte duplex.
 * @param {{bin: string, args: string[], cwd?: string, env?: Record<string,string>}} spec
 */
function createStdioTransport(spec, log) {
  const args = ['app-server', ...(spec.args ?? [])]
  log.info('spawning', spec.bin, args.join(' '))
  const child = spawn(spec.bin, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
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
    /** Server requests awaiting a client answer, keyed by JSON-RPC id. */
    this._serverRequests = new Map()
    this._serverRequestSeq = 0
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

    const transport = createTransport(this.options.transport ?? 'stdio', {
      bin: this.options.bin,
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
    transport.onStdout((text) => rpc.push(text))
    transport.onStderr((text) => {
      stderrTail = `${stderrTail}${text}`.slice(-4000)
      this.log.debug('app-server stderr', text.trimEnd())
      this.emit('stderr', text)
    })
    transport.onError((error) => {
      this.log.error('app-server spawn failed', error)
      this.emit('error', error)
    })
    transport.onExit((code, signal) => {
      this._lastExit = { code, signal, at: Date.now(), stderrTail }
      this.log.warn('app-server exited', code, signal, stderrTail.slice(-600))
      rpc.close(`process exited (${code ?? signal})`)
      this._transport = null
      this._initialized = false
      this._failPendingServerRequests('app-server exited')
      this.emit('exit', this._lastExit)
    })

    const result = await rpc.request('initialize', {
      clientInfo: { name: 'dsh_codex', title: 'DSH Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: this.options.experimentalApi !== false },
    }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })

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
