/**
 * HTTP-boundary check — the exact surface the browser half uses.
 *
 * Brings up a bare node:http server wired the way `ctx.webServer` is, mounts
 * lib/routes.js on it, and drives it with fetch:
 *
 *   POST /dsh-native-codex-cli/rpc      every bridge operation
 *   GET  /dsh-native-codex-cli/events   the SSE stream the UI renders from
 *
 * This is the closest verification of the shipped plugin that is possible
 * without launching DSH itself.
 *
 * Usage: node test/http-check.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const scratchHome = join(root, '.recon', 'http-home')
rmSync(scratchHome, { recursive: true, force: true })
mkdirSync(scratchHome, { recursive: true })
process.env.DSH_HOME = scratchHome

const { CodexBridge } = await import('../lib/bridge.js')
const { mountCodexRoutes } = await import('../lib/routes.js')
const { logger } = await import('../lib/log.js')

const log = logger('http-check')
const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// --------------------------------------------------- a webServer stand-in

const routes = new Map()
const webServerStub = {
  register(route) {
    routes.set(`${route.kind}:${route.path}`, route.handler)
    return () => routes.delete(`${route.kind}:${route.path}`)
  },
}

const bridge = new CodexBridge({
  bin: process.env.CODEX_BIN || 'codex',
  args: [],
  transport: 'stdio',
  experimentalApi: true,
  defaultApprovalPolicy: 'never',
  defaultSandbox: 'danger-full-access',
  defaultModel: '',
  log,
})

mountCodexRoutes(webServerStub, bridge)

const server = createServer((request, response) => {
  const path = (request.url ?? '').split('?')[0]
  const handler = routes.get(`exact:${path}`)
  if (!handler) {
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
    return
  }
  Promise.resolve(handler(request, response)).catch((error) => {
    try {
      response.writeHead(500)
      response.end(String(error?.message ?? error))
    } catch {
      /* already sent */
    }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
console.log(`harness listening on ${base}\n`)

async function call(method, params) {
  const response = await fetch(`${base}/dsh-native-codex-cli/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return response.json()
}

// ------------------------------------------------------------ SSE consumer

const frames = []
let sseAbort = null
async function consumeEvents() {
  const controller = new AbortController()
  sseAbort = controller
  const response = await fetch(`${base}/dsh-native-codex-cli/events`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch {
      return
    }
    if (chunk.done) return
    buffer += decoder.decode(chunk.value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            frames.push(JSON.parse(line.slice(6)))
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve) => {
    if (predicate()) return resolve(true)
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        console.log(`  [timeout] ${label}`)
        resolve(false)
      }
    }, 120)
  })
}

// ---------------------------------------------------------------------- run

try {
  void consumeEvents()

  const health = await fetch(`${base}/dsh-native-codex-cli/health`).then((r) => r.json())
  check('GET /dsh-native-codex-cli/health responds', health.ok === true)

  const missing = await fetch(`${base}/dsh-native-codex-cli/nope`).then((r) => r.status)
  check('unknown route 404s', missing === 404, String(missing))

  const badMethod = await call('does.not.exist', {})
  check('unknown RPC method returns an error envelope', badMethod.ok === false, badMethod.error?.message ?? '')

  const badBody = await fetch(`${base}/dsh-native-codex-cli/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }).then((r) => r.json())
  check('malformed JSON body is rejected cleanly', badBody.ok === false, badBody.error?.message ?? '')

  const status = await call('status')
  check('rpc status starts the app-server', status.ok === true && Boolean(status.result.appServer.initialized), status.result?.appServer?.userAgent ?? '')

  const created = await call('threads.create', { dshSessionId: 'http-session', cwd: root, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  check('rpc threads.create returns a thread', created.ok === true && Boolean(created.result.thread.threadId), created.result?.thread?.threadId ?? created.error?.message)
  const threadId = created.result?.thread?.threadId

  const helloSeen = await waitFor(() => frames.some((f) => f.type === 'hello'), 5000, 'SSE hello frame')
  check('SSE stream opens with a hello frame', helloSeen)

  const turn = await call('turn.start', {
    dshSessionId: 'http-session',
    text: 'Run exactly this command: echo http-boundary-ok. Then answer with one short sentence.',
    clientMessageId: 'http-msg-1',
  })
  check('rpc turn.start accepted the message', turn.ok === true && Boolean(turn.result.turnId), turn.result?.turnId ?? turn.error?.message)
  const turnId = turn.result?.turnId

  const gotThreadFrame = await waitFor(() => frames.some((f) => f.type === 'thread' && f.thread?.threadId === threadId), 20_000, 'SSE thread frame')
  check('SSE stream carries thread updates', gotThreadFrame)

  // Incremental streaming is proven by the delta frames themselves, which land
  // early; whether the *accumulated* text is visible within a fixed window
  // depends on how fast the model answers, so that gets the whole turn budget.
  const sawAgentDelta = await waitFor(
    () => frames.some((f) => f.type === 'wire' && f.method === 'item/agentMessage/delta'),
    60_000,
    'agentMessage delta over SSE',
  )
  const deltaCount = frames.filter((f) => f.type === 'wire' && f.method === 'item/agentMessage/delta').length
  check('SSE stream carries incremental agentMessage deltas', sawAgentDelta, `${deltaCount} delta frame(s)`)

  const sawAgentText = await waitFor(() => frames.some((f) => f.type === 'thread'
    && f.thread?.threadId === threadId
    && f.thread.turns?.some((t) => (t.items ?? []).some((i) => i.type === 'agentMessage' && i.text))), 180_000, 'accumulated agent text')
  check('SSE stream carries the accumulated agent text', sawAgentText)

  const sawCommand = await waitFor(() => frames.some((f) => f.type === 'thread'
    && f.thread?.threadId === threadId
    && f.thread.turns?.some((t) => (t.items ?? []).some((i) => i.type === 'commandExecution'))), 20_000, 'command item')
  check('SSE stream carries the commandExecution item', sawCommand)

  const settled = await waitFor(() => {
    const latest = [...frames].reverse().find((f) => f.type === 'thread' && f.thread?.threadId === threadId)
    const t = latest?.thread?.turns?.find((x) => x.turnId === turnId)
    return t && t.status !== 'inProgress'
  }, 240_000, 'turn settled over SSE')
  check('turn settles over the HTTP/SSE surface', settled)

  const snapshot = await call('snapshot', { dshSessionId: 'http-session' })
  const items = snapshot.result?.thread?.turns?.flatMap((t) => t.items) ?? []
  check('rpc snapshot returns the mirrored thread', snapshot.ok === true && snapshot.result.thread.threadId === threadId)
  check('snapshot contains the user message and the agent reply', items.some((i) => i.type === 'userMessage') && items.some((i) => i.type === 'agentMessage'), `${items.length} item(s)`)
  const cmd = items.find((i) => i.type === 'commandExecution')
  check('snapshot keeps command output available after the fact', Boolean(cmd?.aggregatedOutput), cmd?.aggregatedOutput?.trim().slice(0, 60) ?? 'none')

  const replay = await call('turn.start', {
    dshSessionId: 'http-session',
    text: 'this must never be delivered',
    clientMessageId: 'http-msg-1',
  })
  check('requirement 8: HTTP replay of the same clientMessageId is deduplicated', replay.ok === true && replay.result.deduplicated === true, JSON.stringify(replay.result))

  const reattached = await call('threads.attach', { dshSessionId: 'http-session', threadId })
  const restoredTurns = reattached.result?.thread?.turns?.length ?? 0
  const restoredItems = reattached.result?.thread?.turns?.flatMap((t) => t.items).length ?? 0
  check('requirement 1: history restored over HTTP', restoredTurns >= 1 && restoredItems >= 2, `${restoredTurns} turn(s), ${restoredItems} item(s)`)

  const bindings = await call('bindings.list')
  check('requirement 8: binding persisted across HTTP calls', bindings.result?.bindings?.some((b) => b.dshSessionId === 'http-session' && b.threadId === threadId))

  const bogusApproval = await call('approval.respond', { requestId: 'no-such-request' })
  check('answering an unknown approval fails loudly, not silently', bogusApproval.ok === false, bogusApproval.error?.message ?? '')

  const models = await call('models.list')
  check('rpc models.list works over HTTP', models.ok === true && models.result.models.length > 0, models.result?.models?.length ? `${models.result.models.length} model(s)` : models.error?.message)

  const logTail = await fetch(`${base}/dsh-native-codex-cli/log`).then((r) => r.json())
  check('GET /dsh-native-codex-cli/log exposes recent plugin log lines', logTail.ok === true && Array.isArray(logTail.lines) && logTail.lines.length > 0, `${logTail.lines?.length ?? 0} line(s)`)

  await call('threads.delete', { threadId }).catch(() => {})
} finally {
  try {
    sseAbort?.abort()
  } catch {
    /* ignore */
  }
  bridge.dispose()
  await bridge.server.stop('http-check done').catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}

console.log(`\n=== ${results.length - failures}/${results.length} HTTP checks passed ===`)
if (failures) {
  console.log('failed checks:')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
}
process.exit(failures ? 1 : 0)
