/**
 * A missing Codex CLI must be a normal error, never a crashed host.
 *
 * This is the regression guard for the worst bug this plugin has had: on a
 * machine without `codex` on PATH, `spawn codex` failed with ENOENT, the
 * transport handler called `this.emit('error', error)` with no `'error'`
 * listener, and EventEmitter rethrew it *synchronously inside a Node event
 * handler* — so the route's try/catch never saw it and the whole DSH host died
 * with `fatal uncaught exception: spawn codex ENOENT`.
 *
 * Asserts three things, none of which need Codex installed:
 *   1. `start()` rejects;
 *   2. the rejection carries an actionable message rather than a bare errno;
 *   3. nothing escapes as an unhandled rejection or uncaught exception.
 *
 * Usage: node test/spawn-failure-check.mjs
 */
import { CodexAppServer } from '../lib/app-server.js'

const MISSING_BIN = 'dsh-no-such-codex-binary-xyz'

let failures = 0
let unhandled = null
let uncaught = null
process.on('unhandledRejection', (error) => {
  unhandled = error
})
process.on('uncaughtException', (error) => {
  uncaught = error
})

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const log = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: (message) => console.log(`      [host log] ${String(message).slice(0, 160)}`),
}

const server = new CodexAppServer({ bin: MISSING_BIN, log })

let rejected = null
try {
  await server.start()
} catch (error) {
  rejected = error
}

check('start() rejects when the binary is missing', Boolean(rejected), rejected ? '' : 'it resolved')
if (rejected) {
  const message = String(rejected.message ?? rejected)
  check(
    'the rejection is actionable, not a bare errno',
    /未找到 Codex CLI|not found/i.test(message) && /codexBin|npm i -g/i.test(message),
    message.slice(0, 140),
  )
  check(
    'the message is not buried inside a generic rpc error',
    !/^rpc closed/i.test(message),
    message.slice(0, 60),
  )
}

// Give any stray rejection a turn to surface before judging.
await new Promise((resolve) => setTimeout(resolve, 400))

check('no unhandled rejection escaped', !unhandled, unhandled ? String(unhandled.message).slice(0, 120) : '')
check('no uncaught exception escaped', !uncaught, uncaught ? String(uncaught.message).slice(0, 120) : '')

// A second attempt must behave the same way (the failure path must not wedge
// the instance into a permanently broken state).
let secondRejected = false
try {
  await server.start()
} catch {
  secondRejected = true
}
check('a retry after the failure also rejects cleanly', secondRejected, '')

console.log(failures ? `\nspawn-failure check FAILED (${failures})` : '\nspawn-failure check OK')
process.exit(failures ? 1 : 0)
