/**
 * Compress the generated Codex app-server JSON Schemas into one greppable index.
 *
 * The raw dumps are ~700 files and several hundred KB each for the big
 * notification unions; reading them directly burns context. This prints, per
 * schema: its title, required top-level fields, one line per top-level property
 * with a resolved type hint, and the names of its local `definitions`.
 *
 * Usage:
 *   node test/schema-digest.mjs <dir> [more dirs/files...] > out.txt
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function typeOf(node) {
  if (!node || typeof node !== 'object') return '?'
  if (node.$ref) return node.$ref.split('/').pop()
  if (node.const !== undefined) return `const(${JSON.stringify(node.const)})`
  if (Array.isArray(node.anyOf)) return `anyOf(${node.anyOf.map(typeOf).join(' | ')})`
  if (Array.isArray(node.oneOf)) return `oneOf(${node.oneOf.map(typeOf).join(' | ')})`
  if (Array.isArray(node.allOf)) return `allOf(${node.allOf.map(typeOf).join(' & ')})`
  if (Array.isArray(node.enum)) return `enum(${node.enum.map((v) => JSON.stringify(v)).join('|')})`
  let t = node.type
  if (Array.isArray(t)) t = t.join('|')
  if (t === 'array') return `array<${typeOf(node.items ?? {})}>`
  if (t === 'object' && node.additionalProperties && typeof node.additionalProperties === 'object') {
    return `record<string, ${typeOf(node.additionalProperties)}>`
  }
  if (!t && node.properties) return 'object'
  return t ?? '?'
}

function describeSchema(name, schema, out) {
  out.push(`### ${name}`)
  if (schema.title) out.push(`title: ${schema.title}`)
  if (Array.isArray(schema.required) && schema.required.length) {
    out.push(`required: ${schema.required.join(', ')}`)
  }
  const props = schema.properties ?? {}
  const keys = Object.keys(props)
  if (keys.length === 0) out.push('  (no top-level properties)')
  for (const key of keys) out.push(`  - ${key}: ${typeOf(props[key])}`)
  const defs = schema.definitions ?? {}
  const defKeys = Object.keys(defs)
  if (defKeys.length) out.push(`  defs: ${defKeys.join(' | ')}`)
  out.push('')
}

function collect(target, out) {
  const stat = statSync(target)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      const child = join(target, entry)
      if (statSync(child).isDirectory()) collect(child, out)
      else if (entry.endsWith('.json')) {
        describeSchema(child.replace(/\\/g, '/').split('/').slice(-2).join('/'), JSON.parse(readFileSync(child, 'utf8')), out)
      }
    }
    return
  }
  describeSchema(target.replace(/\\/g, '/').split('/').pop(), JSON.parse(readFileSync(target, 'utf8')), out)
}

const out = []
for (const target of process.argv.slice(2)) collect(target, out)
process.stdout.write(out.join('\n'))
