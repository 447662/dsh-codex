/**
 * Host HTTP surface for the Codex bridge.
 *
 * The browser half cannot call Host services directly, so — exactly like the
 * shipped plugin-hub example — this plugin exposes its own same-origin routes:
 *
 *   POST /dsh-codex/rpc      request/response for every bridge operation
 *   GET  /dsh-codex/events   Server-Sent Events: streaming Codex output,
 *                            approvals, notices and app-server lifecycle
 *   GET  /dsh-codex/health   cheap liveness probe
 *   GET  /dsh-codex/log      recent plugin log lines (developer diagnostics)
 *   POST /dsh-codex/diag     client-side diagnostics appended to the plugin log
 *
 * `webServer.register` is unique per (kind, path), so each path registers ONE
 * handler that dispatches on `request.method`.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { logFile, logger, recent } from './log.js'
import { buildApprovalResponse, classifyServerRequest, UPLOAD_DIR } from './bridge.js'

/**
 * Upload ceiling for one RPC call. Image turns carry base64 payloads (the
 * browser half shrinks them first), so this bound is only a backstop — and it is
 * deliberately generous, because an over-limit body aborts the socket and the
 * page then sees an opaque "Failed to fetch" instead of an HTTP error.
 */
const MAX_BODY_BYTES = 48 * 1024 * 1024
const HEARTBEAT_MS = 15_000

const log = logger('routes')

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Keep draining instead of destroying the socket: an aborted upload
        // reaches the browser as an opaque "Failed to fetch", while draining
        // lets the handler answer 413 with a readable message.
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes; send a smaller image`))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJson(request) {
  const text = await readBody(request)
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/**
 * Dispatch one RPC method. Throwing produces `{ ok: false, error }`.
 * @param {import('./bridge.js').CodexBridge} bridge
 */
async function dispatch(bridge, method, params = {}) {
  switch (method) {
    case 'status':
      return bridge.status()
    case 'snapshot':
      return bridge.snapshot(params)
    case 'restart':
      return bridge.restart()
    case 'health':
      return { ok: true, appServer: bridge.server.info }

    case 'bindings.list':
      return { bindings: bridge.store.list(), panel: bridge.store.getPanelState() }
    case 'bindings.get':
      return { binding: bridge.store.get(params.dshSessionId) }
    case 'bindings.update': {
      // Persist per-session Codex choices (model / approval policy / sandbox) so
      // a reload keeps them, without recreating the thread.
      if (!params.dshSessionId) throw new Error('bindings.update: dshSessionId is required')
      return { binding: bridge.store.put(params.dshSessionId, params.patch ?? {}) }
    }
    case 'bindings.detach': {
      const removed = bridge.store.remove(params.dshSessionId)
      return { removed }
    }
    case 'bindings.suspend': {
      // Hand the session back to DSH but KEEP the Codex thread association, so
      // re-taking it resumes the same conversation instead of creating a second
      // thread and orphaning the first.
      if (!params.dshSessionId) throw new Error('bindings.suspend: dshSessionId is required')
      return { binding: bridge.store.put(params.dshSessionId, { active: false }) }
    }
    case 'bindings.activate': {
      if (!params.dshSessionId) throw new Error('bindings.activate: dshSessionId is required')
      return { binding: bridge.store.put(params.dshSessionId, { active: true }) }
    }
    case 'panel.get':
      return { panel: bridge.store.getPanelState() }
    case 'panel.set':
      return { panel: bridge.store.setPanelState(params.patch ?? {}) }

    case 'threads.list':
      return bridge.listThreads(params)
    case 'threads.loaded':
      return bridge.listLoadedThreads()
    case 'threads.create':
      return bridge.createThread(params)
    case 'threads.attach':
      return bridge.attachThread(params)
    case 'threads.read':
      return bridge.readThread(params)
    case 'threads.turns':
      return bridge.listTurns(params)
    case 'threads.items':
      return bridge.listItems(params)
    case 'threads.rename':
      return bridge.renameThread(params)
    case 'threads.archive':
      return bridge.archiveThread(params)
    case 'threads.delete':
      return bridge.deleteThread(params)
    case 'threads.unsubscribe':
      return bridge.unsubscribeThread(params)

    case 'models.list':
      return bridge.listModels(params)
    case 'permissions.list':
      return bridge.listPermissionProfiles(params)

    case 'turn.start':
      return bridge.startTurn(params)
    case 'turn.interrupt':
      return bridge.interruptTurn(params)
    case 'turn.steer':
      return bridge.steerTurn(params)

    case 'approval.respond': {
      const pending = bridge.server.pendingServerRequests().find((r) => r.requestId === String(params.requestId))
      const method = params.method ?? pending?.method
      if (!method) throw new Error(`approval.respond: unknown request ${params.requestId}`)
      const response = params.response ?? buildApprovalResponse(method, params.choice ?? {})
      const answered = bridge.answerRequest(params.requestId, response)
      return { answered, kind: classifyServerRequest(method) }
    }
    case 'approval.refuse':
      return { answered: bridge.refuseRequest(params.requestId) }

    case 'diag.log':
      return { file: logFile, lines: recent(params.limit ?? 200) }

    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/** The `/dsh-codex/rpc` handler: one request in, one JSON envelope out. */
async function handleRpc(bridge, request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: { message: 'use POST' } })
    return
  }
  let envelope
  try {
    envelope = await readJson(request)
  } catch (error) {
    sendJson(response, 400, { ok: false, error: { message: `bad request body: ${error.message}` } })
    return
  }
  const { method, params } = envelope ?? {}
  if (typeof method !== 'string') {
    sendJson(response, 400, { ok: false, error: { message: 'missing method' } })
    return
  }
  try {
    const result = await dispatch(bridge, method, params ?? {})
    sendJson(response, 200, { ok: true, result: result === undefined ? null : result })
  } catch (error) {
    log.warn('rpc failed', method, error?.message ?? error)
    sendJson(response, 200, {
      ok: false,
      error: { message: error?.message ?? String(error), name: error?.name ?? 'Error', code: error?.code ?? null },
    })
  }
}

/** The `/dsh-codex/events` handler: long-lived SSE fan-out. */
function handleEvents(bridge, request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: { message: 'use GET' } })
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // Tell proxies and the browser not to buffer this stream.
  response.write(': dsh-codex stream open\n\n')

  const send = (payload) => {
    try {
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      /* the socket is gone; the close handler will unsubscribe */
    }
  }

  send({ type: 'hello', appServer: bridge.server.info, at: Date.now() })
  const unsubscribe = bridge.subscribe((payload) => send(payload))
  const heartbeat = setInterval(() => {
    try {
      response.write(': ping\n\n')
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
    try {
      response.end()
    } catch {
      /* ignore */
    }
  }
  request.on('close', cleanup)
  request.on('error', cleanup)
}

/** Content types for the staged uploads. */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * Serve a staged image by absolute path.
 *
 * A rendered `localImage` user-input block only carries a filesystem path, which
 * the browser cannot load, so the transcript showed `[localImage] C:\...\png`
 * instead of the picture. This route turns that path back into pixels for the
 * thumbnail and the click-to-enlarge overlay.
 *
 * Paths are confined to {@link UPLOAD_DIR}: a request for anything else is
 * refused, so this cannot be used to read arbitrary files.
 */
async function handleImage(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: { message: 'use GET' } })
    return
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const requested = url.searchParams.get('p')
  if (!requested) {
    sendJson(response, 400, { ok: false, error: { message: 'missing image path' } })
    return
  }
  const target = resolve(requested)
  const root = resolve(UPLOAD_DIR)
  if (target !== root && !target.startsWith(root + sep)) {
    log.warn('image request outside the upload directory refused', target)
    sendJson(response, 403, { ok: false, error: { message: 'path outside the upload directory' } })
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
    response.writeHead(200, {
      'Content-Type': IMAGE_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'private, max-age=3600',
    })
    createReadStream(target).pipe(response)
  } catch (error) {
    sendJson(response, 404, { ok: false, error: { message: error?.message ?? 'not found' } })
  }
}

/** Client-side diagnostics land in the same file as the host log. */
async function handleDiag(request, response) {  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: { message: 'use POST' } })
    return
  }
  try {
    const payload = await readJson(request)
    log.info('client diag', JSON.stringify(payload).slice(0, 4000))
    sendJson(response, 200, { ok: true })
  } catch (error) {
    sendJson(response, 400, { ok: false, error: { message: error.message } })
  }
}

/**
 * Register every route. Returns the disposer that removes them.
 * @param {{register: (route: object) => () => void}} webServer
 * @param {import('./bridge.js').CodexBridge} bridge
 */
export function mountCodexRoutes(webServer, bridge) {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/dsh-codex/rpc',
      handler: (request, response) => handleRpc(bridge, request, response),
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh-codex/events',
      handler: (request, response) => handleEvents(bridge, request, response),
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh-codex/health',
      handler: (_request, response) => sendJson(response, 200, { ok: true, appServer: bridge.server.info }),
    }),
    // `prefix`: the image path travels as a query parameter, so the route cannot
    // be an exact match.
    webServer.register({
      kind: 'prefix',
      path: '/dsh-codex/image',
      handler: (request, response) => handleImage(request, response),
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh-codex/log',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false })
          return
        }
        sendJson(response, 200, { ok: true, file: logFile, lines: recent(300) })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh-codex/diag',
      handler: (request, response) => handleDiag(request, response),
    }),
  ]
  log.info('routes mounted: /dsh-codex/{rpc,events,health,log,diag}')
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log.warn('route dispose failed', error)
      }
    }
  }
}
