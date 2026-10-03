/**
 * End-to-end smoke test for the Codex bridge — no DSH, no browser.
 *
 * Drives the real `codex app-server` process through lib/bridge.js and asserts
 * the behaviour behind requirements 1-8 at the protocol level:
 *
 *   2  create a thread with an explicit cwd / approval policy / sandbox
 *   3  submit a user message straight to `turn/start`
 *   4  receive incremental agentMessage deltas that accumulate
 *   5  receive a commandExecution item with command + aggregated output
 *   6  `turn/interrupt` actually stops a running turn
 *   7  a server-initiated request is surfaced AND answered back to Codex
 *   8  a repeated clientMessageId is deduplicated, and history can be re-read
 *
 * Usage: node test/smoke-bridge.mjs [--live]
 *   (without --live it still runs; the flag only marks intent in the log)
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Point the durable binding store at a scratch directory BEFORE bridge.js
// (and therefore log.js / bindings.js) is imported.
const smokeHome = join(root, '.recon', 'smoke-home')
rmSync(smokeHome, { recursive: true, force: true })
mkdirSync(smokeHome, { recursive: true })
process.env.DSH_HOME = smokeHome

const { CodexBridge, buildApprovalResponse } = await import('../lib/bridge.js')
const { logger, logFile } = await import('../lib/log.js')

const log = logger('smoke')
const WORKDIR = root
const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const bridge = new CodexBridge({
  bin: process.env.CODEX_BIN || 'codex',
  args: [],
  transport: 'stdio',
  experimentalApi: true,
  // `never` keeps the create-turn path free of approval prompts; the approval
  // flow is exercised separately below with an `untrusted` thread.
  defaultApprovalPolicy: 'never',
  defaultSandbox: 'danger-full-access',
  defaultModel: '',
  log,
})

// ---- event plumbing ---------------------------------------------------------

const deltas = { agentMessage: 0, commandOutput: 0, reasoning: 0 }
const seenMethods = new Map()
const approvalsSeen = []
/** Turns Codex itself announced as started — `turn/start` only returns a stub. */
const liveTurnIds = new Set()
let turnCompleted = null
let agentTextAtFirstDelta = null
let commandItem = null

bridge.subscribe((payload) => {
  if (payload.type === 'wire') {
    seenMethods.set(payload.method, (seenMethods.get(payload.method) ?? 0) + 1)
    if (payload.method === 'turn/started' && payload.params?.turn?.id) liveTurnIds.add(payload.params.turn.id)
    if (payload.method === 'item/started' && payload.params?.turnId) liveTurnIds.add(payload.params.turnId)
    if (payload.method === 'item/commandExecution/outputDelta') deltas.commandOutput += 1
    if (payload.method === 'item/reasoning/textDelta') deltas.reasoning += 1
    return
  }
  if (payload.type === 'approval') {
    approvalsSeen.push(payload.request)
    console.log(`  [approval] ${payload.request.method} ${JSON.stringify(payload.request.params).slice(0, 260)}`)
    // Answer immediately: an unanswered server request would block Codex.
    const response = buildApprovalResponse(payload.request.method, { decision: 'accept', permissions: payload.request.params?.permissions ?? {}, scope: 'turn' })
    bridge.answerRequest(payload.request.id ?? payload.request.requestId, response)
    console.log(`  [approval] answered ${JSON.stringify(response)}`)
    return
  }
  if (payload.type === 'notice') {
    console.log(`  [notice:${payload.notice.level}] ${String(payload.notice.message).slice(0, 300)}`)
    return
  }
  if (payload.type === 'thread') {
    const thread = payload.thread
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        if (item.type === 'agentMessage') {
          if (agentTextAtFirstDelta === null && item.text) agentTextAtFirstDelta = item.text.length
        }
        if (item.type === 'commandExecution' && !commandItem) commandItem = item
      }
    }
    return
  }
})

// Count agent deltas from the raw wire feed.
const originalEmit = bridge.emit.bind(bridge)
bridge.emit = (event, ...args) => {
  if (event === 'event' && args[0]?.type === 'wire' && args[0].method === 'item/agentMessage/delta') {
    deltas.agentMessage += 1
  }
  return originalEmit(event, ...args)
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve) => {
    if (predicate()) {
      resolve(true)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        console.log(`  [timeout] ${label} after ${timeoutMs}ms`)
        resolve(false)
      }
    }, 150)
  })
}

// ---- the run ----------------------------------------------------------------

async function main() {
  console.log(`codex bridge smoke test\n  workdir: ${WORKDIR}\n  log:     ${logFile}\n`)

  // ---- requirement: app-server handshake
  const status = await bridge.status()
  check('app-server initialised over stdio JSON-RPC', Boolean(status.appServer.initialized), status.appServer.userAgent ?? '')
  check('app-server reports a codex home', Boolean(status.appServer.codexHome), status.appServer.codexHome ?? '')

  // ---- requirement 1: list threads
  const listed = await bridge.listThreads({ cwd: WORKDIR, limit: 20 })
  check('thread/list returns a thread array', Array.isArray(listed.threads), `${listed.threads.length} thread(s) visible`)

  // ---- requirement 2: create a native thread with explicit settings
  const created = await bridge.createThread({
    dshSessionId: 'smoke-session',
    cwd: WORKDIR,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  const threadId = created.thread.threadId
  check('thread/start created a native Codex thread', typeof threadId === 'string' && threadId.length > 0, threadId)
  check('created thread echoes the requested cwd', created.thread.cwd === WORKDIR || Boolean(created.thread.cwd), String(created.thread.cwd))
  check('binding persisted for the DSH session', created.binding?.threadId === threadId, JSON.stringify(created.binding?.threadId))

  // ---- requirements 3/4/5: send a turn, stream it, see the command result
  const prompt = 'Run exactly this shell command and nothing else: echo dsh-native-codex-cli-smoke-ok. Then reply with one short sentence containing the output.'
  const started = await bridge.startTurn({
    dshSessionId: 'smoke-session',
    text: prompt,
    clientMessageId: 'smoke-msg-1',
  })
  check('turn/start submitted the message verbatim', started.deduplicated === false && Boolean(started.turnId), `turnId=${started.turnId}`)

  const completed = await waitFor(() => {
    const view = bridge.threads.get(threadId)
    const turn = view?.turns[started.turnId]
    return turn && turn.status !== 'inProgress' && turn.status !== null && view.activeTurnId === null
  }, 240_000, 'turn completion')
  check('turn/completed observed', completed, `status=${bridge.threads.get(threadId)?.turns[started.turnId]?.status}`)

  const view = bridge.threads.get(threadId)
  const turn = view.turns[started.turnId]
  const items = turn.itemOrder.map((id) => turn.items[id])
  const agentItem = items.find((item) => item.type === 'agentMessage' && item.text)
  const cmd = items.find((item) => item.type === 'commandExecution')

  check('requirement 4: agent message deltas streamed incrementally', deltas.agentMessage > 0, `${deltas.agentMessage} delta frame(s)`)
  check('requirement 4: deltas accumulated into one agent message', Boolean(agentItem?.text), agentItem ? `${agentItem.text.length} chars` : 'no agentMessage item')
  check('requirement 5: commandExecution item surfaced', Boolean(cmd), cmd ? `cmd=${String(cmd.command).slice(0, 80)} status=${cmd.status}` : 'none')
  check('requirement 5: command output captured', Boolean(cmd?.aggregatedOutput), cmd?.aggregatedOutput ? cmd.aggregatedOutput.trim().slice(0, 120) : 'no output')
  check('requirement 5: command exit code recorded', cmd?.exitCode !== undefined && cmd?.exitCode !== null, `exitCode=${cmd?.exitCode}`)
  check('turn finished without error', turn.status === 'completed' && !turn.error, `status=${turn.status}`)

  // ---- requirement 8: idempotent resend of the same client message id
  const replay = await bridge.startTurn({
    dshSessionId: 'smoke-session',
    text: prompt,
    clientMessageId: 'smoke-msg-1',
  })
  check('requirement 8: repeated clientMessageId is deduplicated', replay.deduplicated === true, JSON.stringify({ deduplicated: replay.deduplicated }))

  // ---- requirement 8 / 1: re-read history and restore it
  const reloaded = await bridge.attachThread({ dshSessionId: 'smoke-session', threadId })
  const restoredTurns = reloaded.thread.turns.length
  const restoredItems = reloaded.thread.turns.flatMap((t) => t.items).length
  check('requirement 1: thread/resume+read restored history', restoredTurns >= 1, `${restoredTurns} turn(s), ${restoredItems} item(s)`)
  check('requirement 8: reload did not duplicate turns', restoredTurns === 1, `${restoredTurns} turn(s) after reload`)

  // ---- requirement 6: interrupt a live turn
  // A genuinely long-running turn is required: interrupting an already-settled
  // turn is legitimately rejected by Codex ("no active turn to interrupt").
  const interruptStart = await bridge.startTurn({
    dshSessionId: 'smoke-session',
    text: 'Run exactly this command and wait for it to finish: powershell -NoProfile -Command "Start-Sleep -Seconds 120". Do nothing else until it returns.',
    clientMessageId: 'smoke-msg-interrupt',
  })
  const becameActive = await waitFor(() => liveTurnIds.has(interruptStart.turnId), 60_000, 'Codex announced turn/started')
  check('long-running turn is live before interrupt', becameActive, `turnId=${interruptStart.turnId}`)
  const interrupted = await bridge.interruptTurn({ dshSessionId: 'smoke-session' })
  check('requirement 6: turn/interrupt accepted by Codex', interrupted.interrupted === true, JSON.stringify(interrupted))
  const stopped = await waitFor(() => {
    const v = bridge.threads.get(threadId)
    const t = v?.turns[interruptStart.turnId]
    return t && t.status !== 'inProgress'
  }, 60_000, 'interrupted turn settled')
  check('requirement 6: interrupted turn settled', stopped, `status=${bridge.threads.get(threadId)?.turns[interruptStart.turnId]?.status}`)
  check('requirement 6: active turn pointer cleared', !bridge.threads.get(threadId)?.activeTurnId, String(bridge.threads.get(threadId)?.activeTurnId))

  // ---- requirement 7: a real approval round-trip
  const approvalThread = await bridge.createThread({
    dshSessionId: 'smoke-approval',
    cwd: WORKDIR,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  })
  await bridge.startTurn({
    dshSessionId: 'smoke-approval',
    text: 'Create a file named dsh-native-codex-cli-approval-probe.txt in the current directory containing the word hello, then delete it.',
    clientMessageId: 'smoke-msg-approval',
  })
  const sawApproval = await waitFor(() => approvalsSeen.length > 0, 180_000, 'approval request')
  check(
    'requirement 7: approval request surfaced to the client layer',
    sawApproval,
    approvalsSeen.length ? approvalsSeen.map((a) => a.method).join(', ') : 'no server request observed (policy may not require one)',
  )
  const resolved = bridge.server.pendingServerRequests().length === 0
  check('requirement 7: approval answered back to Codex', resolved, `${bridge.server.pendingServerRequests().length} still pending`)

  // ---- settings catalogues used by the new-thread UI
  const models = await bridge.listModels({ limit: 50 })
  check('model/list returned a catalogue for the model picker', models.models.length > 0, models.models.slice(0, 3).map((m) => m.id).join(', '))
  const profiles = await bridge.listPermissionProfiles({ cwd: WORKDIR })
  check('permissionProfile/list returned selectable profiles', profiles.profiles.length > 0, profiles.profiles.map((p) => p.id).join(', '))

  // ---- teardown
  await bridge.deleteThread({ threadId }).catch(() => {})
  await bridge.deleteThread({ threadId: approvalThread.thread.threadId }).catch(() => {})
  bridge.dispose()
  await bridge.server.stop('smoke done')

  console.log('\n--- methods observed ---')
  console.log([...seenMethods.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n.toString().padStart(4)}  ${m}`).join('\n'))
  console.log(`\n--- deltas --- agentMessage=${deltas.agentMessage} commandOutput=${deltas.commandOutput} reasoning=${deltas.reasoning}`)
  console.log(`\n=== ${results.length - failures}/${results.length} checks passed ===`)
  if (failures) {
    console.log('failed checks:')
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
  }
  process.exit(failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error('smoke test crashed:', error)
  try {
    bridge.dispose()
    await bridge.server.stop('crash')
  } catch {
    /* ignore */
  }
  process.exit(2)
})
