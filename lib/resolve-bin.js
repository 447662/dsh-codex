/**
 * Locate the Codex CLI.
 *
 * `spawn('codex')` relies on `PATH`, and on Windows that is not good enough for
 * a desktop app: the Codex desktop installer puts the CLI in its own directory
 * and appends it to the *user* environment, but a process that was already
 * running — or one started by `explorer.exe`, which keeps the environment it had
 * at logon — never sees the updated `PATH`. DSH is Electron, so this plugin
 * inherited exactly that stale environment and reported `spawn codex ENOENT` on
 * machines where Codex was in fact installed.
 *
 * So `PATH` is only the first candidate here, not the only one.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, isAbsolute } from 'node:path'

/** Join with the separators of the *target* platform, not the host's. */
function joinerFor(platform) {
  return platform === 'win32' ? join : posix.join
}

/** Split PATH with the *target* platform's separator, not the host's. */
function delimiterFor(platform) {
  return platform === 'win32' ? ';' : ':'
}

/** Executable names to look for, most specific first. */
export function codexBinNames(platform = process.platform) {
  return platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex']
    : ['codex']
}

/**
 * Directories worth probing, in priority order.
 *
 * Pure: takes the environment explicitly so the ordering can be unit-tested
 * without touching the machine that runs the tests.
 *
 * @param {{platform?: string, env?: Record<string,string|undefined>, home?: string}} [context]
 * @returns {string[]}
 */
export function codexCandidateDirs(context = {}) {
  const platform = context.platform ?? process.platform
  const env = context.env ?? process.env
  const home = context.home ?? homedir()
  const dirs = []

  const push = (value) => {
    if (value && !dirs.includes(value)) dirs.push(value)
  }

  // 1. PATH itself, probed explicitly. Node's own spawn would also use PATH, but
  //    we want to know *which* entry matched so the log can say so.
  const pathValue = env.PATH ?? env.Path ?? ''
  for (const entry of pathValue.split(delimiterFor(platform))) {
    if (entry.trim()) push(entry.trim().replace(/^"|"$/g, ''))
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    const appData = env.APPDATA
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
    const programFilesX86 = env['ProgramFiles(x86)']
    // This is where the Codex desktop app puts its bundled CLI.
    push(localAppData && join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'))
    push(localAppData && join(localAppData, 'OpenAI', 'Codex', 'bin'))
    push(localAppData && join(localAppData, 'Codex', 'bin'))
    push(programFiles && join(programFiles, 'OpenAI', 'Codex', 'bin'))
    push(programFilesX86 && join(programFilesX86, 'OpenAI', 'Codex', 'bin'))
    // npm global installs (`npm i -g @openai/codex`).
    push(appData && join(appData, 'npm'))
    push(localAppData && join(localAppData, 'pnpm'))
    // The Codex CLI's own standalone updater.
    push(join(home, '.codex', 'packages', 'standalone', 'current', 'bin'))
    push(join(home, '.codex', 'bin'))
    push(join(home, '.codex', 'plugins', '.plugin-appserver'))
    push(join(home, 'AppData', 'Roaming', 'npm'))
  } else {
    const p = joinerFor(platform)
    push(p(home, '.codex', 'packages', 'standalone', 'current', 'bin'))
    push(p(home, '.codex', 'bin'))
    push(p(home, '.local', 'bin'))
    push('/usr/local/bin')
    push('/opt/homebrew/bin')
    push('/usr/bin')
  }

  return dirs
}

/**
 * Versioned directories under the standalone package tree, newest first.
 * Pure enough to test: only the listing is filesystem-dependent.
 */
export function codexReleaseDirs(home = homedir(), platform = process.platform) {
  const p = joinerFor(platform)
  const releases = p(home, '.codex', 'packages', 'standalone', 'releases')
  let names = []
  try {
    names = readdirSync(releases)
  } catch {
    return []
  }
  const withTime = []
  for (const name of names) {
    const binDir = p(releases, name, 'bin')
    try {
      if (!statSync(binDir).isDirectory()) continue
      withTime.push({ binDir, mtime: statSync(binDir).mtimeMs })
    } catch {
      /* not a directory with a bin/ */
    }
  }
  return withTime.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.binDir)
}

function firstExecutable(dir, names) {
  for (const name of names) {
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* unreadable entry */
    }
  }
  return null
}

/**
 * Resolve the CLI to an absolute path.
 *
 * An explicit `codexBin` always wins: if the user configured something, respect
 * it verbatim (spawn will surface a clear error if it is wrong) rather than
 * silently substituting a different binary.
 *
 * @param {{configured?: string, platform?: string, env?: object, home?: string, log?: object}} options
 * @returns {{bin: string, resolved: string|null, searched: string[]}}
 */
export function resolveCodexBin(options = {}) {
  const platform = options.platform ?? process.platform
  const log = options.log
  const configured = (options.configured ?? '').trim()
  const names = codexBinNames(platform)
  const searched = [...codexCandidateDirs(options), ...codexReleaseDirs(options.home, platform)]

  const finish = (bin) => {
    if (log) log.info('resolved the Codex CLI', bin)
    return { bin, resolved: bin, searched }
  }

  if (configured && configured !== 'codex' && configured !== 'codex.exe') {
    // A configured path is respected verbatim rather than silently replaced.
    if (isAbsolute(configured) || /[\\/]/.test(configured)) {
      return { bin: configured, resolved: existsSync(configured) ? configured : null, searched: [configured] }
    }
    // A bare name other than "codex": search for that name instead.
    for (const dir of searched) {
      const hit = firstExecutable(dir, [configured])
      if (hit) return finish(hit)
    }
    if (log) log.warn(`could not find the configured CLI "${configured}" in any known location`)
    return { bin: configured, resolved: null, searched }
  }

  for (const dir of searched) {
    const hit = firstExecutable(dir, names)
    if (hit) return finish(hit)
  }

  if (log) {
    log.warn(
      'could not find the Codex CLI in any known location; falling back to a PATH lookup. Searched:',
      searched.join(' | '),
    )
  }
  return { bin: configured || 'codex', resolved: null, searched }
}
