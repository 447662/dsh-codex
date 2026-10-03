/**
 * Expand named definitions (and top-level schemas) into a readable outline.
 *
 *   node test/schema-def.mjs <file.json>::<DefinitionName> [more specs...]
 *   node test/schema-def.mjs <file.json>            # whole top-level schema
 *   node test/schema-def.mjs <file.json> --list      # just the definition names
 *
 * For a `oneOf`/`anyOf` union it prints one indented line per variant with the
 * discriminator value and that variant's own fields — which is how the Codex
 * protocol's `ThreadItem`, `UserInput` and approval-decision unions are read.
 */
import { readFileSync } from 'node:fs'

function ref(node) {
  return node?.$ref ? node.$ref.split('/').pop() : ''
}

function typeOf(node) {
  if (!node || typeof node !== 'object') return '?'
  const depth = typeOf.depth ?? 0
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

function discriminator(variant) {
  for (const [key, schema] of Object.entries(variant.properties ?? {})) {
    if (schema?.const !== undefined) return { key, value: schema.const }
  }
  return null
}

function fieldLines(schema, skipKeys = new Set()) {
  const out = []
  const required = new Set(schema.required ?? [])
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (skipKeys.has(key)) continue
    out.push(`      ${key}${required.has(key) ? '' : '?'}: ${typeOf(value)}`)
  }
  return out
}

function outline(node, indent, out) {
  const variants = node.oneOf ?? node.anyOf
  if (Array.isArray(variants)) {
    out.push(`${indent}union of ${variants.length}:`)
    for (const variant of variants) {
      const disc = discriminator(variant)
      let label = disc ? `${disc.key}=${JSON.stringify(disc.value)}` : ref(variant) || '(inline)'
      if (variant.title) label += ` (${variant.title})`
      out.push(`${indent}  - ${label}`)
      const skip = disc ? new Set([disc.key]) : new Set()
      const inner = fieldLines(variant, skip)
      if (inner.length === 0) out.push(`${indent}      (no own fields)`)
      else out.push(...inner.map((l) => `${indent}${l}`))
    }
    return
  }
  const required = new Set(node.required ?? [])
  const props = Object.entries(node.properties ?? {})
  if (props.length === 0) {
    out.push(`${indent}(no properties) type=${typeOf(node)}`)
    return
  }
  out.push(`${indent}object${required.size ? ` required=${[...required].join(',')}` : ''}`)
  for (const [key, value] of props) {
    out.push(`${indent}  ${key}${required.has(key) ? '' : '?'}: ${typeOf(value)}`)
  }
}

for (const spec of process.argv.slice(2).filter((arg) => !arg.startsWith('--'))) {
  const [file, defName] = spec.includes('::') ? spec.split('::') : [spec, null]
  const schema = JSON.parse(readFileSync(file, 'utf8'))
  const short = file.replace(/\\/g, '/').split('/').pop()
  if (defName === '--list' || (defName === null && process.argv.includes('--list'))) {
    console.log(`=== ${short} definitions ===`)
    console.log(Object.keys(schema.definitions ?? {}).join(' | '))
    continue
  }
  if (defName === null) {
    const lines = []
    outline(schema, '  ', lines)
    console.log(`\n=== ${short} (top level) ===`)
    console.log(lines.join('\n'))
    continue
  }
  const target = schema.definitions?.[defName]
  console.log(`\n=== ${short} :: ${defName} ===`)
  if (!target) {
    console.log('  NOT FOUND')
    continue
  }
  if (process.argv.includes('--raw')) {
    console.log(JSON.stringify(target, null, 2))
    continue
  }
  const lines = []
  outline(target, '  ', lines)
  console.log(lines.join('\n'))
}
