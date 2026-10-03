/**
 * dsh-codex — Host half.
 *
 * DSH owns the chat interface; Codex CLI owns task execution and native thread
 * history. This half is deliberately thin: it owns one `codex app-server`
 * process and one durable session⇄thread binding store, and exposes both to the
 * browser half over same-origin HTTP routes (see routes.js).
 *
 * Nothing in this plugin asks a model to summarise, relay or reconstruct a
 * conversation. A user message is forwarded to `turn/start` verbatim and every
 * rendered byte comes from Codex's own notifications.
 *
 * NOTE on `Config`: this module deliberately exports NO `Config` symbol. The
 * cordis loader treats an exported `Config` as a *schema* and parses the entry's
 * patch config with it; a plain default-value object is not a schema, which
 * leaves the entry in the `unsupported` state and stops the plugin from ever
 * being applied (verified against the live host: `include:dsh-codex` sat in the
 * loader tree with zero log output). Third-party plugins without a declared
 * schema omit it entirely and are reported as `absent`. Defaults therefore live
 * here as a private constant, and the loader's raw config still arrives through
 * `apply(ctx, config)` unchanged.
 */
import { CodexBridge } from './bridge.js'
import { CONFIG_FILE, loadFileConfig } from './config.js'
import { logger } from './log.js'
import { mountCodexRoutes } from './routes.js'

export const name = 'dsh-codex'

/**
 * Record that the module was actually imported.
 *
 * A module-scope write makes the difference between "the loader never resolved
 * this package" and "the entry was created but never applied" visible from the
 * plugin log alone — the two failures need completely different fixes.
 */
logger('boot').info('module imported', { name: 'dsh-codex', pid: process.pid })

/** Defaults for every knob the profile patch may override. */
const DEFAULTS = {
  /** Codex executable; resolved from PATH when left as `codex`. */
  codexBin: 'codex',
  /** Extra argv appended after `app-server`. */
  codexArgs: [],
  /** Transport adapter: `stdio` (implemented) or `daemon` (reserved). */
  transport: 'stdio',
  /** Opt into experimental app-server methods/fields. */
  experimentalApi: true,
  /** Approval policy applied to threads this plugin creates. */
  approvalPolicy: 'on-request',
  /** Sandbox mode applied to threads this plugin creates. */
  sandbox: 'workspace-write',
  /** Default model id; empty string defers to Codex's own default. */
  model: '',
  /** Log every app-server wire frame at debug level. */
  traceWire: false,
}

/**
 * Mount the Codex bridge.
 *
 * The bridge is intentionally lazy: no Codex process is spawned until a surface
 * actually asks for something, so installing this plugin cannot slow down or
 * destabilise DSH startup.
 *
 * @param {any} ctx cordis host context
 * @param {Partial<typeof DEFAULTS>} [config]
 */
export function apply(ctx, config = {}) {
  const fileConfig = loadFileConfig(logger('config'))
  const resolved = { ...DEFAULTS, ...fileConfig, ...(config ?? {}) }
  const log = logger('host')

  if (resolved.traceWire) process.env.DSH_CODEX_DEBUG = '1'

  const bridge = new CodexBridge({
    bin: resolved.codexBin || 'codex',
    args: Array.isArray(resolved.codexArgs) ? resolved.codexArgs : [],
    transport: resolved.transport === 'daemon' ? 'daemon' : 'stdio',
    experimentalApi: resolved.experimentalApi !== false,
    defaultApprovalPolicy: resolved.approvalPolicy,
    defaultSandbox: resolved.sandbox,
    defaultModel: resolved.model,
    log,
  })

  log.info('dsh-codex host loaded', {
    bin: resolved.codexBin,
    transport: resolved.transport,
    approvalPolicy: resolved.approvalPolicy,
    sandbox: resolved.sandbox,
    configFile: CONFIG_FILE,
    pid: process.pid,
  })

  // Tear the bridge down with the plugin's own fiber.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      log.info('dsh-codex host unloading')
      try {
        bridge.dispose()
      } catch (error) {
        log.warn('bridge dispose failed', error)
      }
      void bridge.server.stop('plugin unloaded').catch(() => {})
    }, 'dsh-codex: bridge lifecycle')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (host) => {
      const webServer = host?.webServer ?? host
      if (!webServer?.register) {
        log.error('webServer service has no register(); HTTP surface unavailable')
        return
      }
      const mount = () => mountCodexRoutes(webServer, bridge)
      if (typeof host.effect === 'function') {
        host.effect(mount, 'dsh-codex: http routes')
      } else {
        mount()
      }
    })

    registerCodexCommand(ctx, bridge, log)
  } else {
    log.error('host context has no inject(); cannot reach webServer')
  }
}

/**
 * Register the `/codex` human command.
 *
 * This is what makes a Codex conversation a *first-class DSH session*. A session
 * that never records an event stays an empty draft and DSH drops it from the
 * workspace as soon as the user switches away — which is exactly why a session
 * bound to Codex used to vanish from the sidebar.
 *
 * `commands.execute` appends `command/run` + `command/done` to the session log
 * through DSH's own validated path **and never sends anything to the model**
 * ("Parse and execute a known command without sending it to the model"), so:
 *   - the session becomes durable and keeps its place in the session list,
 *   - the task still goes straight to Codex with no second AI in the loop,
 *   - the user keeps one natural entry point (`/codex <task>`), and the browser
 *     half routes its `@Codex` button through this same command.
 *
 * @param {any} ctx cordis host context
 * @param {import('./bridge.js').CodexBridge} bridge
 * @param {ReturnType<typeof logger>} log
 */
function registerCodexCommand(ctx, bridge, log) {
  ctx.inject(['commands', 'sessions'], (host) => {
    const commands = host?.commands
    const sessions = host?.sessions
    // Hand the bridge a way to reach the live Session so it can mirror each
    // Codex exchange into DSH's own log (durable session + native rendering).
    bridge.sessionResolver = (sessionId) => sessions?.get?.(sessionId)
    if (!commands?.register) {
      log.error('commands service unavailable; /codex disabled')
      return
    }

    const definition = {
      name: 'codex',
      description: '把这条消息直接交给 Codex CLI 执行（DSH 只负责界面，Codex 负责执行与原生历史）',
      input: { hint: '<交给 Codex 的任务>' },
      recordInput: true,
      handler: async (invocation) => {
        const sessionId = invocation?.agent?.id
        const text = String(invocation?.rawInput ?? '').trim()
        if (!text) return { kind: 'error', text: '用法：/codex <任务描述>' }
        if (!sessionId) return { kind: 'error', text: '/codex: 无法确定当前会话' }
        try {
          // Root Codex at the DSH session's own workspace directory.
          let cwd
          try {
            cwd = sessions?.get?.(sessionId)?.header?.cwd
          } catch {
            /* fall back to Codex's own default */
          }
          const result = await bridge.startTurn({ dshSessionId: sessionId, text, cwd })
          const short = String(result?.threadId ?? '').slice(0, 8)
          return {
            kind: 'success',
            text: result?.deduplicated
              ? `这条消息已交给 Codex（线程 ${short}，重复提交已忽略）`
              : `已交给 Codex 执行（线程 ${short}）`,
          }
        } catch (error) {
          log.warn('/codex handler failed', error)
          return { kind: 'error', text: `Codex 调用失败：${error?.message ?? error}` }
        }
      },
    }

    const dispose = commands.register(definition)
    log.info('command registered: /codex')
    if (typeof host.effect === 'function') host.effect(() => dispose, 'dsh-codex: /codex command')
    else if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-codex: /codex command')
  })
}
