/**
 * dsh-native-codex-cli logging.
 *
 * The Host half of this plugin runs inside the DSH Node process, where a stray
 * `console.log` is hard to observe. Every diagnostic therefore goes to a plain
 * file under the DSH home directory as well as to a bounded in-memory ring, so
 * the plugin's own HTTP diagnostics route can hand the recent tail back to the
 * browser (and to the developer) without a terminal.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_DIR = join(DSH_HOME, 'logs')
const LOG_FILE = join(LOG_DIR, 'dsh-native-codex-cli.log')

const RING_MAX = 800
const MAX_FIELD = 4000

/** @type {string[]} */
const ring = []
let dirReady = false
let fileBroken = false

function ensureDir() {
  if (dirReady || fileBroken) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    dirReady = true
  } catch {
    fileBroken = true
  }
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level, scope, args) {
  const text = args.map(stringify).join(' ')
  const line = `${new Date().toISOString()} ${level.padEnd(5)} pid=${process.pid} [${scope}] ${
    text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…(+${text.length - MAX_FIELD})` : text
  }`
  ring.push(line)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  ensureDir()
  if (fileBroken) return
  try {
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    fileBroken = true
  }
}

/** Scoped logger factory: `const L = logger('bridge')`. */
export function logger(scope) {
  return {
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    debug: (...args) => {
      if (process.env.DSH_CODEX_DEBUG) write('debug', scope, args)
    },
  }
}

export const logFile = LOG_FILE

/** Recent lines, newest last. */
export function recent(limit = 200) {
  const n = Math.max(1, Math.min(RING_MAX, limit | 0))
  return ring.slice(-n)
}
