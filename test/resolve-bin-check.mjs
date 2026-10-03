/**
 * The CLI search path must cover the Codex desktop app's own directory.
 *
 * Regression guard for a real false negative: the desktop app installs the CLI
 * under `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` and registers it on PATH, but
 * an Electron process that inherited a stale environment cannot see it — so the
 * plugin reported "Codex CLI not found" on machines where Codex was installed.
 *
 * Pure: the environment is injected, so this runs identically on any platform.
 *
 * Usage: node test/resolve-bin-check.mjs
 */
import { join, posix } from 'node:path'
import { codexCandidateDirs, codexBinNames, resolveCodexBin } from '../lib/resolve-bin.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const WIN_ENV = {
  LOCALAPPDATA: join('C:', 'Users', 'someone', 'AppData', 'Local'),
  APPDATA: join('C:', 'Users', 'someone', 'AppData', 'Roaming'),
  ProgramFiles: join('C:', 'Program Files'),
  PATH: [join('C:', 'Windows', 'system32'), join('C:', 'tools', 'bin')].join(';'),
}
const HOME = join('C:', 'Users', 'someone')

const winDirs = codexCandidateDirs({ platform: 'win32', env: WIN_ENV, home: HOME })
const has = (dir) => winDirs.includes(dir)

check(
  'win32 probes the Codex desktop app directory',
  has(join(WIN_ENV.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')),
  'this is where the desktop installer puts codex.exe',
)
check('win32 probes the per-user Codex app data directory', has(join(WIN_ENV.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')))
check('win32 probes the npm global directory', has(join(WIN_ENV.APPDATA, 'npm')))
check(
  'win32 probes the CLI standalone package tree',
  has(join(HOME, '.codex', 'packages', 'standalone', 'current', 'bin')),
)
check(
  'PATH entries are probed first, split on the target platform separator',
  winDirs[0] === join('C:', 'Windows', 'system32') && winDirs[1] === join('C:', 'tools', 'bin'),
  winDirs.slice(0, 2).join(' , '),
)
// Splitting a Windows PATH on `:` (the POSIX separator) shreds every drive
// letter into a bogus entry. This assertion is what caught that.
check(
  'no drive letter is split into a bogus entry',
  !winDirs.some((dir) => dir === 'C' || dir === 'C:' || /^[A-Za-z]$/.test(dir)),
  winDirs.filter((dir) => /^[A-Za-z]:?$/.test(dir)).join(' , ') || '(none)',
)
check(
  'win32 looks for .exe and .cmd shims',
  codexBinNames('win32').includes('codex.exe') && codexBinNames('win32').includes('codex.cmd'),
  codexBinNames('win32').join(','),
)

const posixDirs = codexCandidateDirs({
  platform: 'darwin',
  env: { PATH: '/usr/local/bin:/usr/bin' },
  home: '/Users/someone',
})
check(
  'darwin probes Homebrew and the user bin',
  posixDirs.includes('/opt/homebrew/bin') && posixDirs.includes(posix.join('/Users/someone', '.local', 'bin')),
  posixDirs.slice(-5).join(' , '),
)
check('posix looks for a bare `codex`', codexBinNames('linux').join(',') === 'codex')

// An explicit configured path must be respected verbatim, not silently replaced
// by a different binary that happens to be found first.
const explicit = join('C:', 'custom', 'codex.exe')
const configured = resolveCodexBin({ configured: explicit, platform: 'win32', env: WIN_ENV, home: HOME })
check('an explicit codexBin wins', configured.bin === explicit, configured.bin)
check('an explicit codexBin reports whether it exists', configured.resolved === null, 'this fake path should not exist')

// Live check on the machine running the tests: informational, never a failure,
// because CI has no Codex installed.
const live = resolveCodexBin({})
console.log(`      live resolution: ${live.resolved ?? '(not found — fine on CI)'}`)
if (live.resolved) {
  check('a resolved binary is an absolute path', /^([A-Za-z]:[\\/]|\/)/.test(live.resolved), live.resolved)
}

console.log(failures ? `\nresolve-bin check FAILED (${failures})` : '\nresolve-bin check OK')
process.exit(failures ? 1 : 0)
