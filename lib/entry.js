/**
 * Host entry point (loader-facing).
 *
 * This file exists purely as a *fresh module URL*.
 *
 * The cordis loader validates a plugin's patch config with
 * `runtime.Config["~standard"].validate(config)` and skips validation entirely
 * only when `runtime.Config` is falsy:
 *
 *   function resolveConfig(runtime, config) {
 *     if (!runtime.Config) return config
 *     const result = runtime.Config["~standard"].validate(config)
 *     ...
 *   }
 *
 * An earlier revision of this plugin exported `Config` as a plain default-value
 * object. That made `runtime.Config` truthy while `["~standard"]` was undefined,
 * so the entry failed with "Cannot read properties of undefined (reading
 * 'validate')" and `apply()` never ran. ESM caches by resolved URL, so fixing
 * `lib/index.js` in place was not enough for the already-running host — it kept
 * reading the cached namespace that still carried `Config`.
 *
 * Because `runtime` here is *this* module's namespace, a thin re-export under a
 * path the loader has never imported is enough to hand it a namespace with no
 * `Config` at all. `package.json` therefore points `main` / `exports["."]` here.
 */
export { name, apply } from './index.js'
