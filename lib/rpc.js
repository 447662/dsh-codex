/**
 * Newline-delimited JSON-RPC for the Codex app-server stdio transport.
 *
 * Verified against codex-cli 0.153.4 (`codex app-server`, default `--listen
 * stdio://`): every frame is a single line of JSON terminated by `\n`. There is
 * no `Content-Length` header and no framing preamble.
 *
 * Frame taxonomy, distinguished structurally:
 *   request      { id, method, params? }            -> we send, server answers
 *   response     { id, result } | { id, error }     -> server answers us
 *   notification { method, params? } (no id)        -> server pushes
 *   server req   { id, method, params? }            -> server asks US; we must respond
 *
 * Note the asymmetry: our outgoing requests carry `jsonrpc: "2.0"`, but the
 * server's responses and notifications omit it. Parsing therefore keys off the
 * presence of `id` and `method`, never off `jsonrpc`.
 */

/** JSON-RPC reserved error codes. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

export class RpcRequestError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'RpcRequestError'
    this.code = code
    this.data = data
  }
}

export class LineRpc {
  /**
   * @param {object} options
   * @param {(line: string) => void} options.write      sink for outgoing frames
   * @param {(msg: {method: string, params?: unknown}) => void} [options.onNotification]
   * @param {(msg: {id: unknown, method: string, params?: unknown}) => void} [options.onServerRequest]
   * @param {(error: Error) => void} [options.onProtocolError]
   * @param {object} [options.log]
   */
  constructor({ write, onNotification, onServerRequest, onProtocolError, log } = {}) {
    this._write = write
    this._onNotification = onNotification
    this._onServerRequest = onServerRequest
    this._onProtocolError = onProtocolError
    this._log = log ?? { info() {}, warn() {}, error() {}, debug() {} }
    this._pending = new Map()
    this._nextId = 1
    this._buffer = ''
    this._closed = false
    this._closeReason = null
  }

  get closed() {
    return this._closed
  }

  get pendingCount() {
    return this._pending.size
  }

  /** Feed raw stdout text. Partial lines are buffered across calls. */
  push(chunk) {
    this._buffer += chunk
    let index = this._buffer.indexOf('\n')
    while (index !== -1) {
      const line = this._buffer.slice(0, index).replace(/\r$/, '')
      this._buffer = this._buffer.slice(index + 1)
      if (line.trim()) this._dispatch(line)
      index = this._buffer.indexOf('\n')
    }
    // Guard against a pathological peer that never emits a newline.
    if (this._buffer.length > 64 * 1024 * 1024) {
      this._buffer = ''
      this._report(new Error('rpc: dropped an unterminated 64MB line'))
    }
  }

  _dispatch(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (error) {
      this._report(new Error(`rpc: unparseable line: ${line.slice(0, 400)}`))
      return
    }
    if (msg === null || typeof msg !== 'object') {
      this._report(new Error('rpc: non-object frame'))
      return
    }
    this._log.debug('recv', line.length > 2000 ? `${line.slice(0, 2000)}…` : line)

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null
    const hasMethod = typeof msg.method === 'string'

    if (hasId && hasMethod) {
      // Server-initiated request: it needs an answer from us or Codex blocks.
      try {
        this._onServerRequest?.(msg)
      } catch (error) {
        this._report(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (hasMethod) {
      try {
        this._onNotification?.(msg)
      } catch (error) {
        this._report(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (hasId) {
      const pending = this._pending.get(msg.id)
      if (!pending) {
        this._log.warn('rpc: response for unknown id', msg.id)
        return
      }
      this._pending.delete(msg.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.error) {
        const { code, message, data } = msg.error
        pending.reject(new RpcRequestError(code, message ?? 'app-server error', data))
      } else {
        pending.resolve(msg.result)
      }
      return
    }
    this._log.warn('rpc: unrecognised frame shape')
  }

  _report(error) {
    this._log.error('rpc', error)
    this._onProtocolError?.(error)
  }

  /** Send a request and await its result. */
  request(method, params, { timeoutMs = 120_000, signal } = {}) {
    if (this._closed) {
      return Promise.reject(new Error(`rpc closed (${this._closeReason ?? 'unknown'}); cannot send ${method}`))
    }
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this._pending.delete(id)
          reject(new Error(`rpc timeout after ${timeoutMs}ms: ${method}`))
        }, timeoutMs)
        : null
      if (timer && typeof timer.unref === 'function') timer.unref()

      this._pending.set(id, { resolve, reject, timer, method })

      if (signal) {
        const onAbort = () => {
          if (!this._pending.has(id)) return
          this._pending.delete(id)
          if (timer) clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      this._send({ jsonrpc: '2.0', id, method, params: params ?? {} })
    })
  }

  /** Send a fire-and-forget notification (no response expected). */
  notify(method, params) {
    if (this._closed) return
    this._send({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  /** Answer a server-initiated request. */
  respond(id, result) {
    if (this._closed) return
    this._send({ jsonrpc: '2.0', id, result: result ?? {} })
  }

  /** Answer a server-initiated request with an error. */
  respondError(id, code, message, data) {
    if (this._closed) return
    this._send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  _send(frame) {
    let line
    try {
      line = JSON.stringify(frame)
    } catch (error) {
      this._report(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this._log.debug('send', line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
    try {
      this._write(`${line}\n`)
    } catch (error) {
      this._report(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Fail every in-flight request. Used when the child dies or we close it. */
  close(reason) {
    if (this._closed) return
    this._closed = true
    this._closeReason = reason ?? 'closed'
    const pending = [...this._pending.values()]
    this._pending.clear()
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new Error(`rpc closed (${this._closeReason}) during ${entry.method}`))
    }
  }
}
