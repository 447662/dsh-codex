/**
 * File-based plugin configuration.
 *
 * The cordis loader validates an entry's patch `config` against the plugin's
 * exported `Config` **schema** (it calls `schema.validate`). This plugin ships
 * no schema — exporting a plain default-value object under the name `Config` is
 * what made the live entry fail with
 * `TypeError: Cannot read properties of undefined (reading 'validate')`.
 * Supplying a patch config without a schema fails the same way.
 *
 * Runtime knobs therefore come from a small JSON file instead, which keeps the
 * plugin configurable without depending on a schema library that is not
 * resolvable from a pnpm-isolated profile package.
 *
 *   ~/.dsh/storages/dsh-codex/config.json
 *   { "codexBin": "codex", "sandbox": "danger-full-access" }
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Absolute path of the optional override file. */
export const CONFIG_FILE = join(DSH_HOME, 'storages', 'dsh-codex', 'config.json')

/**
 * Read the override file. A missing file is normal; a malformed one is logged
 * and ignored rather than allowed to fail plugin activation.
 * @param {{warn?: (...args: unknown[]) => void}} [log]
 * @returns {Record<string, unknown>}
 */
export function loadFileConfig(log) {
  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.warn?.('config.json unreadable; using defaults', error)
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    log?.warn?.('config.json is not a JSON object; using defaults')
    return {}
  } catch (error) {
    log?.warn?.('config.json is not valid JSON; using defaults', error)
    return {}
  }
}
