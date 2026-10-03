/**
 * Durable DSH-session ⇄ Codex-thread association store.
 *
 * Requirement 8 ("keep the thread association, re-read history, never send a
 * message twice") needs three things persisted outside the browser:
 *   1. which Codex thread belongs to which DSH session,
 *   2. the settings that thread was created with (cwd/model/approval/sandbox),
 *   3. the ids of user messages already handed to Codex, so a page reload or an
 *      app restart cannot replay them.
 *
 * Storage is a single JSON document under the DSH home directory, written
 * atomically (temp file + rename) and debounced, because bindings change on
 * every send.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_FILE = join(DSH_HOME, 'storages', 'dsh-native-codex-cli', 'bindings.json')
const WRITE_DEBOUNCE_MS = 120
const SENT_ID_CAP = 200

function emptyDocument() {
  return { version: 1, updatedAt: 0, sessions: {}, panel: { lastThreadId: null } }
}

function normaliseBinding(raw, dshSessionId) {
  if (!raw || typeof raw !== 'object') return null
  const sentClientMessageIds = Array.isArray(raw.sentClientMessageIds)
    ? raw.sentClientMessageIds.filter((id) => typeof id === 'string').slice(-SENT_ID_CAP)
    : []
  return {
    dshSessionId,
    threadId: typeof raw.threadId === 'string' ? raw.threadId : null,
    /**
     * `false` means the user handed the session back to DSH ("交还 DSH").
     *
     * This is deliberately NOT a deletion: dropping the record made the next
     * "@codex" look like a brand-new conversation and create a *second* Codex
     * thread, orphaning the first one. A suspended binding keeps the thread id
     * so re-taking the session resumes the same conversation.
     */
    active: raw.active !== false,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    modelProvider: typeof raw.modelProvider === 'string' ? raw.modelProvider : null,
    approvalPolicy: raw.approvalPolicy ?? null,
    sandbox: raw.sandbox ?? null,
    permissionProfile: typeof raw.permissionProfile === 'string' ? raw.permissionProfile : null,
    reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : null,
    threadName: typeof raw.threadName === 'string' ? raw.threadName : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    lastTurnId: typeof raw.lastTurnId === 'string' ? raw.lastTurnId : null,
    lastTurnStatus: typeof raw.lastTurnStatus === 'string' ? raw.lastTurnStatus : null,
    sentClientMessageIds,
  }
}

export class BindingStore {
  constructor(log) {
    this.log = log
    this.file = STORE_FILE
    this._doc = emptyDocument()
    this._timer = null
    this._loaded = false
  }

  load() {
    if (this._loaded) return this._doc
    this._loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const doc = emptyDocument()
      doc.updatedAt = Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : 0
      doc.panel = { lastThreadId: parsed?.panel?.lastThreadId ?? null }
      for (const [id, raw] of Object.entries(parsed?.sessions ?? {})) {
        const binding = normaliseBinding(raw, id)
        if (binding) doc.sessions[id] = binding
      }
      this._doc = doc
      this.log.info('bindings loaded', Object.keys(doc.sessions).length, 'session(s)')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log.warn('bindings unreadable, starting empty', error)
      this._doc = emptyDocument()
    }
    return this._doc
  }

  get(dshSessionId) {
    if (!dshSessionId) return null
    return this.load().sessions[dshSessionId] ?? null
  }

  list() {
    return Object.values(this.load().sessions)
  }

  /** Look up the binding that owns a Codex thread (reverse index). */
  findByThreadId(threadId) {
    if (!threadId) return null
    return this.list().find((binding) => binding.threadId === threadId) ?? null
  }

  put(dshSessionId, patch) {
    const doc = this.load()
    const current = doc.sessions[dshSessionId] ?? normaliseBinding({}, dshSessionId)
    doc.sessions[dshSessionId] = { ...current, ...patch, updatedAt: Date.now() }
    this._schedule()
    return doc.sessions[dshSessionId]
  }

  remove(dshSessionId) {
    const doc = this.load()
    if (!(dshSessionId in doc.sessions)) return false
    delete doc.sessions[dshSessionId]
    this._schedule()
    return true
  }

  getPanelState() {
    return { ...this.load().panel }
  }

  setPanelState(patch) {
    const doc = this.load()
    doc.panel = { ...doc.panel, ...patch }
    this._schedule()
    return { ...doc.panel }
  }

  /**
   * Record a client-generated user-message id as handed to Codex.
   * @returns {boolean} false when it was already recorded (a duplicate send).
   */
  noteSentClientMessage(dshSessionId, clientMessageId) {
    if (!clientMessageId) return true
    const binding = this.get(dshSessionId) ?? this.put(dshSessionId, {})
    if (binding.sentClientMessageIds.includes(clientMessageId)) return false
    const next = [...binding.sentClientMessageIds, clientMessageId].slice(-SENT_ID_CAP)
    this.put(dshSessionId, { sentClientMessageIds: next })
    return true
  }

  hasSentClientMessage(dshSessionId, clientMessageId) {
    if (!clientMessageId) return false
    return Boolean(this.get(dshSessionId)?.sentClientMessageIds.includes(clientMessageId))
  }

  _schedule() {
    this._doc.updatedAt = Date.now()
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, WRITE_DEBOUNCE_MS)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  /** Write now. Never throws: a failed save must not break a live turn. */
  flush() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this._doc, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log.error('bindings write failed', error)
    }
  }

  dispose() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this.flush()
  }
}
