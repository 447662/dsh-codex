/**
 * Print the method → params/result wiring of the three big app-server unions.
 *
 *   node test/method-map.mjs <ClientRequest.json|ServerRequest.json|ServerNotification.json> [...]
 *
 * Each of those files is a `oneOf` over per-method envelopes shaped like
 * `{ method: { const: "thread/start" }, params: { $ref: "#/definitions/ThreadStartParams" } }`.
 * Resolving that by hand across 700 schemas is error-prone, so this flattens it.
 */
import { readFileSync } from 'node:fs'

function refName(node) {
  if (!node) return ''
  if (node.$ref) return node.$ref.split('/').pop()
  if (Array.isArray(node.anyOf)) return node.anyOf.map(refName).filter(Boolean).join('|')
  if (Array.isArray(node.oneOf)) return node.oneOf.map(refName).filter(Boolean).join('|')
  return ''
}

for (const file of process.argv.slice(2)) {
  const schema = JSON.parse(readFileSync(file, 'utf8'))
  const name = file.replace(/\\/g, '/').split('/').pop()
  console.log(`\n===== ${name} =====`)
  const variants = schema.oneOf ?? schema.anyOf ?? []
  for (const variant of variants) {
    const props = variant.properties ?? {}
    const methodNode = props.method
    const method = methodNode?.const ?? methodNode?.enum?.[0] ?? refName(methodNode) ?? '?'
    const params = refName(props.params)
    const result = refName(props.result) ?? refName(props.response)
    const extras = Object.keys(props).filter((k) => k !== 'method' && k !== 'params' && k !== 'result' && k !== 'response')
    console.log(
      `${String(method).padEnd(52)} params=${params || '-'} result=${result || '-'}${
        extras.length ? ` extra=${extras.join(',')}` : ''
      }`,
    )
  }
}
