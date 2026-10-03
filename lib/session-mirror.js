/**
 * Mirror a Codex turn into the DSH session log as *native* DSH events.
 *
 * Why this exists: DSH renders the main page and keeps a session in the
 * workspace **only** from its own append-only event log. A session whose
 * messages all went to Codex has an empty log, so DSH treats it as a blank
 * draft and drops it from the list the moment the user switches away — and the
 * main page has nothing to draw.
 *
 * Recording the exchange as native events fixes both, without touching the task
 * path: the message still travels plugin → `turn/start` → Codex, and no model is
 * involved anywhere.
 *
 * The event shapes are copied from a real `session.v4.jsonl.zstd` produced by
 * this host (`.recon/tools/session-shape.mjs` dumps the reference):
 *
 *   turn/start    { turn }
 *   step/start    { turn, step }
 *   user/message  { content, source:{kind,rpcId,clientTimeZone}, role, id }  + surfaceOp:'append'
 *   step/end      { turn, step }
 *   turn/end      { turn, reason:{ kind } }
 *
 * Codex's own answers are NOT mirrored. `assistant/message` is the one surface
 * event a non-provider cannot author: a real one carries
 *
 *   data keys:         turn, step, message, usage, stream
 *   data.message keys: role, content, source, id
 *
 * and omitting `stream`/`usage` makes the host's session projection throw
 * `Cannot read properties of undefined (reading 'length')`, permanently breaking
 * that session's history. The browser half renders Codex's answers in the
 * main-page dock instead — the honest division: DSH owns the chat surface,
 * Codex owns the execution detail.
 *
 * Every append is individually guarded: `Session.append` validates and throws
 * on a bad event, and a mirroring failure must never break a live Codex turn.
 * The first failure for a session permanently disables mirroring for it.
 */
import { randomUUID } from 'node:crypto'

/** Turn number after the last `turn/start` in the session log, or null. */
function nextTurnNumber(session) {
  try {
    const events = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (session.events ?? [])
    let max = 0
    for (const event of events) {
      const turn = event?.type === 'turn/start' ? event.data?.turn : null
      if (Number.isFinite(turn)) max = Math.max(max, turn)
    }
    return max + 1
  } catch {
    return null
  }
}

export class SessionMirror {
  /**
   * @param {object} options
   * @param {(sessionId: string) => any} options.resolveSession
   * @param {ReturnType<import('./log.js').logger>} options.log
   */
  constructor({ resolveSession, log }) {
    this.resolveSession = resolveSession
    this.log = log
    /** Sessions where mirroring failed once and must not be retried. */
    this.broken = new Set()
    /** Sessions already reported as "not live yet", to keep the log quiet. */
    this.missingLogged = new Set()
    /** Open mirror turns: `${sessionId}:${threadId}:${codexTurnId}` -> state. */
    this.open = new Map()
    /** Fallback turn counter when the log cannot be read. */
    this.counters = new Map()
  }

  _session(sessionId) {
    if (!sessionId || this.broken.has(sessionId)) return null
    let session
    try {
      session = this.resolveSession?.(sessionId)
    } catch (error) {
      // Resolution itself failed: treat like "not live yet" and retry later.
      if (!this.missingLogged.has(sessionId)) {
        this.missingLogged.add(sessionId)
        this.log.warn('session mirror could not resolve session', sessionId, error)
      }
      return null
    }
    if (!session || typeof session.append !== 'function') {
      // The session is not live in this host yet (a cold session is only
      // materialised when something enters it). Not fatal — a later turn can
      // still mirror — so this is NOT recorded as permanently broken.
      if (!this.missingLogged.has(sessionId)) {
        this.missingLogged.add(sessionId)
        this.log.warn('session mirror skipped: session not live yet', sessionId)
      }
      return null
    }
    return session
  }

  _append(session, type, data, opts) {
    try {
      return session.append(type, data, opts)
    } catch (error) {
      this.log.warn('session mirror append rejected', type, error?.message ?? error)
      return null
    }
  }

  /**
   * An append was rejected: the shape is deterministic, so retrying every turn
   * would only spam the log. Stop mirroring this session and let the browser
   * dock carry the conversation instead.
   */
  _giveUp(sessionId) {
    this.broken.add(sessionId)
    this.log.warn('session mirror disabled for session after a rejected append', sessionId)
    return null
  }

  _claimTurn(session) {
    const fromLog = nextTurnNumber(session)
    if (fromLog !== null) return fromLog
    const key = 'counter'
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }

  /**
   * Open a mirror turn and record the user's message.
   * @returns {string|null} an opaque key for {@link finishTurn}, or null.
   */
  beginTurn({ sessionId, threadId, codexTurnId, text, clientMessageId }) {
    const session = this._session(sessionId)
    if (!session) return null
    const turn = this._claimTurn(session)
    const step = 1

    if (!this._append(session, 'turn/start', { turn })) return this._giveUp(sessionId)
    if (!this._append(session, 'step/start', { turn, step })) return this._giveUp(sessionId)

    const message = {
      content: [{ type: 'text', text: String(text ?? '') }],
      source: {
        kind: 'user',
        rpcId: clientMessageId ?? randomUUID(),
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      role: 'user',
      id: randomUUID(),
    }
    if (!this._append(session, 'user/message', message, { surfaceOp: 'append' })) return this._giveUp(sessionId)

    const key = `${sessionId}:${threadId ?? ''}:${codexTurnId ?? turn}`
    this.open.set(key, { sessionId, turn, step })
    return key
  }

  /**
   * Close a mirror turn.
   *
   * Codex's replies are deliberately NOT written as `assistant/message`: that
   * event type embeds the **provider stream** and cannot be authored from
   * outside a model call. A real one has
   *
   *   data keys:          turn, step, message, usage, stream
   *   data.message keys:  role, content, source, id
   *
   * and a hand-written one without `stream`/`usage` makes the host's session
   * projection throw `Cannot read properties of undefined (reading 'length')`,
   * after which the session's history no longer loads. The browser half renders
   * Codex's answers in the main-page dock instead, so nothing is lost visually.
   *
   * @param {string|null} key from {@link beginTurn}
   * @param {string[]} texts unused; kept so callers need no reshaping
   * @param {'completed'|'interrupted'|'failed'} reason
   */
  finishTurn(key, texts, reason = 'completed') {
    if (!key) return false
    const state = this.open.get(key)
    if (!state) return false
    this.open.delete(key)
    const session = this._session(state.sessionId)
    if (!session) return false

    this._append(session, 'step/end', { turn: state.turn, step: state.step })
    this._append(session, 'turn/end', { turn: state.turn, reason: { kind: reason } })
    return true
  }

  /** Forget tracking for a session that is being detached. */
  release(sessionId) {
    for (const [key, state] of [...this.open.entries()]) {
      if (state.sessionId === sessionId) this.open.delete(key)
    }
  }
}
