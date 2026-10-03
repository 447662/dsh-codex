/**
 * Load-time self check — run BEFORE installing into a DSH profile.
 *
 * Installs a stub `window.__ModuleLoader__` and a stub `react`, evaluates the
 * client bundle exactly the way the DSH web shell does, then applies both halves
 * against stub cordis contexts. It catches syntax errors, bad import wiring and
 * slot declarations that would otherwise surface only as a broken app.
 *
 * Usage: node test/load-check.mjs
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Isolate the scratch home BEFORE the host half is imported: otherwise this
// check writes into the real ~/.dsh plugin log and pollutes live diagnostics.
const scratchHome = join(root, '.recon', 'loadcheck-home')
rmSync(scratchHome, { recursive: true, force: true })
mkdirSync(scratchHome, { recursive: true })
process.env.DSH_HOME = scratchHome

let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------- client half

const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered.push(entry)
    },
  },
}
if (!globalThis.document) {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', parentNode: null }),
    head: { appendChild() {} },
  }
}
globalThis.EventSource = class {
  constructor() {
    this.readyState = 0
  }
  close() {}
}
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: {} }) })

// A class component base is required: the plugin wraps its seats in an error
// boundary so a render bug cannot take the DSH conversation down with it.
class ReactComponentStub {
  constructor(props) {
    this.props = props ?? {}
  }

  setState() {}
}

const reactStub = {
  Component: ReactComponentStub,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
}
const requireStub = (id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require(${JSON.stringify(id)}) from the client bundle`)
}

const clientPath = join(root, 'client', 'client.js')
readFileSync(clientPath, 'utf8') // readability probe before execution
await import(new URL('../client/client.js', import.meta.url).href)

check('client bundle calls window.__ModuleLoader__.load', registered.length === 1, `${registered.length} registration(s)`)
const entry = registered[0]
check('client bundle declares the plugin id', entry?.id === 'dsh-codex', String(entry?.id))

let clientExports = null
try {
  clientExports = entry.factory(requireStub)
} catch (error) {
  check('client factory executes', false, error.message)
}
check('client factory executes without throwing', Boolean(clientExports))
check('client exports apply()', typeof clientExports?.apply === 'function')
check('client exports inject as a service list', Array.isArray(clientExports?.inject), JSON.stringify(clientExports?.inject))
check('client declares the plugin name', clientExports?.name === 'dsh-codex', String(clientExports?.name))

// Apply against a stub slot service that records every declaration.
const registeredSlots = []
const stubSlots = {
  register(declaration, render) {
    registeredSlots.push({ declaration, render })
    return () => {}
  },
  registerFactory() {
    return () => {}
  },
  inject(key, callback) {
    callback()
    return () => {}
  },
}
const clientCtx = {
  get: (service) => (service === 'slots' ? stubSlots : undefined),
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on: () => () => {},
  provide: () => () => {},
}

try {
  clientExports.apply(clientCtx)
  check('client apply() runs against a stub slot service', true)
} catch (error) {
  check('client apply() runs against a stub slot service', false, error.message)
}

const slotNames = registeredSlots.map((item) => `${item.declaration.name}${item.declaration.key ? `[${item.declaration.key}]` : ''}${item.declaration.id ? `[${item.declaration.id}]` : ''}`)
console.log(`      registered slots: ${slotNames.join(', ') || '(none)'}`)
check('registers the standalone main panel', slotNames.includes('main[codex]'), slotNames.join(', '))
check('registers the sidebar panel entry', slotNames.includes('sidebar.panellist[codex]'))
check('registers the in-session Codex view', slotNames.includes('conversation.view[codex]'))
check('registers the composer takeover', registeredSlots.some((item) => item.declaration.name === 'conversation.composer' && typeof item.declaration.select === 'function'))
check('registers the @Codex composer control', slotNames.includes('conversation.input.right[codex]'))
check('registers the main-page Codex dock', slotNames.includes('conversation.input.dock[codex]'))

// ---- Markdown rendering (Codex answers in Markdown) -------------------------
if (typeof clientExports?.__renderMarkdown === 'function') {
  const collectTypes = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) collectTypes(child, out)
      return out
    }
    if (node.type) out.push(node.type)
    collectTypes(node.children, out)
    return out
  }
  const tree = clientExports.__renderMarkdown([
    '# 标题',
    '',
    '- 项目一',
    '- 项目二',
    '',
    '这是 **加粗**、`行内代码` 和 [链接](https://example.com)。',
    '',
    '> 引用',
    '',
    '```ts',
    'const a = 1',
    '```',
  ].join('\n'))
  const rendered = collectTypes(tree)
  const has = (type) => rendered.includes(type)
  check('markdown renders headings', has('h3'), rendered.join(','))
  check('markdown renders unordered lists', has('ul') && rendered.filter((t) => t === 'li').length === 2, rendered.join(','))
  check('markdown renders bold / inline code / links', has('strong') && has('code') && has('a'), rendered.join(','))
  check('markdown renders blockquotes', has('blockquote'), rendered.join(','))
  check('markdown renders fenced code', has('pre'), rendered.join(','))
  check('markdown leaves no literal ** markers', !JSON.stringify(tree).includes('**'), 'asterisks leaked into the output')
}

// The composer selector must be pure and must not claim unbound sessions.
const chainEntry = registeredSlots.find((item) => item.declaration.name === 'conversation.composer')
if (chainEntry) {
  let unbound = 'threw'
  try {
    unbound = chainEntry.declaration.select({ sessionId: 'session-not-bound' })
  } catch (error) {
    unbound = `threw: ${error.message}`
  }
  check('composer selector declines an unbound session', unbound === null || unbound === undefined, JSON.stringify(unbound))
  let anonymous = 'threw'
  try {
    anonymous = chainEntry.declaration.select({})
  } catch (error) {
    anonymous = `threw: ${error.message}`
  }
  check('composer selector tolerates a session-less owner', anonymous === null || anonymous === undefined, JSON.stringify(anonymous))
}

// ------------------------------------------------------------------ host half

// Import the loader-facing entry (`main` / `exports["."]`), which is the
// namespace the cordis loader reads `runtime.Config` from.
const hostModule = await import(new URL('../lib/entry.js', import.meta.url).href)
check('host entry resolves through lib/entry.js', typeof hostModule.apply === 'function')
check('host module exports name', hostModule.name === 'dsh-codex', String(hostModule.name))
check('host module exports apply()', typeof hostModule.apply === 'function')
// Regression guard: a plain-object `Config` export is read by the cordis loader
// as a *schema*. In the live host that left the entry in the `unsupported` state
// and stopped apply() from ever running, so plugins without a real schema must
// omit it entirely (the shipped third-party plugin is reported as `absent`).
check('host module exports NO Config (loader would parse it as a schema)', hostModule.Config === undefined, `Config=${typeof hostModule.Config}`)

const hostEffects = []
const mountedRoutes = []
const registeredCommands = []
const hostCtx = {
  effect: (callback, label) => {
    hostEffects.push(label ?? 'effect')
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject: (services, callback) => {
    hostEffects.push(`inject:${services.join(',')}`)
    callback({
      webServer: {
        register(route) {
          mountedRoutes.push(route)
          return () => {}
        },
      },
      // The `/codex` command is what makes a bound session durable in DSH's own
      // log, so the stub has to expose a commands registry for it to be built.
      commands: {
        register(definition) {
          registeredCommands.push(definition)
          return () => {}
        },
      },
      sessions: {
        get: () => ({ header: { cwd: 'C:\\stub-workspace' } }),
      },
      effect: (callback, label) => {
        hostEffects.push(label ?? 'inject-effect')
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    })
  },
}

try {
  hostModule.apply(hostCtx, { codexBin: 'codex' })
  check('host apply() runs against a stub host context', true)
} catch (error) {
  check('host apply() runs against a stub host context', false, error.message)
}

const paths = mountedRoutes.map((route) => route.path).sort()
console.log(`      host routes: ${paths.join(', ') || '(none)'}`)
check('host registers the RPC route', paths.includes('/dsh-codex/rpc'))
check('host registers the SSE route', paths.includes('/dsh-codex/events'))
check('host does NOT spawn Codex at load time', !hostEffects.some((label) => String(label).includes('spawn')), hostEffects.join(' | '))

const command = registeredCommands.find((definition) => definition.name === 'codex')
check('host registers the /codex human command', Boolean(command), registeredCommands.map((d) => d.name).join(', ') || '(none)')
check('/codex declares a handler and an input hint', typeof command?.handler === 'function' && Boolean(command?.input?.hint))
// The handler must refuse an empty invocation instead of calling Codex.
if (command) {
  const empty = await command.handler({ agent: { id: 'session-stub' }, rawInput: '   ', attachments: [], signal: new AbortController().signal })
  check('/codex rejects an empty task', empty?.kind === 'error', JSON.stringify(empty))
}

// ------------------------------------------------------- session mirror shape

// The mirror writes real DSH session events; a malformed one would be rejected
// by `Session.append` at runtime, so the exact shape is asserted here.
const { SessionMirror } = await import(new URL('../lib/session-mirror.js', import.meta.url).href)
const appended = []
const fakeSession = {
  snapshotEvents: () => appended.slice(),
  append(type, data, opts) {
    if (data?.content?.[0]?.text === 'REJECT-ME') throw new Error('stub validation failure')
    appended.push({ type, data, surfaceOp: opts?.surfaceOp })
    return { type, data }
  },
}
const mirror = new SessionMirror({ resolveSession: () => fakeSession, log: { warn: () => {}, info: () => {}, error: () => {} } })

const mirrorKey = mirror.beginTurn({ sessionId: 'session-stub', threadId: 'thread-stub', codexTurnId: 'turn-stub', text: 'hello codex', clientMessageId: 'cid-1' })
check('mirror opens a turn', Boolean(mirrorKey), String(mirrorKey))
check('mirror closes the turn', mirror.finishTurn(mirrorKey, ['codex says hi'], 'completed') === true)

const types = appended.map((event) => event.type)
console.log(`      mirrored events: ${types.join(' -> ')}`)
check('mirror writes the DSH turn lifecycle in order', types.join(',') === 'turn/start,step/start,user/message,step/end,turn/end', types.join(','))
const userEvent = appended.find((event) => event.type === 'user/message')
check('mirrored user/message carries role + text + surfaceOp', userEvent?.data?.role === 'user' && userEvent?.data?.content?.[0]?.text === 'hello codex' && userEvent?.surfaceOp === 'append')
check('mirrored user/message carries the client time zone', typeof userEvent?.data?.source?.clientTimeZone === 'string')
// Regression guard: an authored `assistant/message` lacks the provider `stream`
// the host's projection requires, which broke the session's history loading.
check('mirror never authors assistant/message', !types.includes('assistant/message'), types.join(','))
check('mirrored turn numbers advance', appended.filter((event) => event.type === 'turn/start')[0]?.data?.turn === 1, `turn=${appended.find((e) => e.type === 'turn/start')?.data?.turn}`)

// A session whose append throws must be disabled, never retried per message.
const brokenMirror = new SessionMirror({ resolveSession: () => ({ append() { throw new Error('nope') } }), log: { warn: () => {} } })
check('mirror tolerates a rejecting session', brokenMirror.beginTurn({ sessionId: 's', text: 'x' }) === null)

console.log(`\n=== ${failures === 0 ? 'load check OK' : `${failures} load check(s) failed`} ===`)
process.exit(failures ? 1 : 0)
