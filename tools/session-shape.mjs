/**
 * Print the real shape of DSH's own session events.
 *
 * Session logs are `session.v4.jsonl.zstd`, so they cannot be read as text.
 * When a plugin needs to append its own durable events, copying the exact shape
 * the host itself writes is far safer than reconstructing it from the validator
 * source.
 *
 * Usage: node .recon/tools/session-shape.mjs <session.v4.jsonl.zstd> [type ...]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * The log is a sequence of concatenated zstd frames (one per flush) and neither
 * `zstdDecompressSync` nor the stream decoder walks past the first frame, so the
 * frames are split on the zstd magic number and decoded one by one.
 */
function decompressAll(file) {
  const raw = readFileSync(file)
  const offsets = []
  let at = raw.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = raw.indexOf(ZSTD_MAGIC, at + 4)
  }
  if (offsets.length === 0) return raw.toString('utf8')
  offsets.push(raw.length)
  const parts = []
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const frame = raw.subarray(offsets[index], offsets[index + 1])
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch (error) {
      parts.push(`\n{"type":"__decode-error__","message":${JSON.stringify(String(error?.message ?? error))}}\n`)
    }
  }
  return parts.join('')
}

const [file, ...wantedArg] = process.argv.slice(2)
const wanted = wantedArg.length
  ? new Set(wantedArg)
  : new Set(['user/message', 'assistant/message', 'turn/start', 'turn/end', 'step/start', 'step/end', 'system/message', 'request/header'])

const text = await decompressAll(file)

if (process.argv.includes('--head')) {
  console.log(`bytes: ${Buffer.byteLength(text)}  newlines: ${(text.match(/\n/g) ?? []).length}`)
  console.log('--- first 1200 chars ---')
  console.log(text.slice(0, 1200))
  process.exit(0)
}

const lines = text.split('\n').filter((line) => line.trim())

if (process.argv.includes('--order')) {
  const limit = Number(process.argv[process.argv.indexOf('--order') + 1] || 25)
  console.log('--- first events in log order ---')
  let index = 0
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (index >= limit) break
    index += 1
    const extra = event.data?.turn !== undefined ? ` turn=${event.data.turn} step=${event.data.step}` : ''
    const marker = event.surfaceOp ? ` surfaceOp=${event.surfaceOp}` : ''
    console.log(`${String(event.seq).padStart(4)}  ${event.type}${extra}${marker}`)
  }
  process.exit(0)
}

console.log(`events: ${lines.length}`)

const seen = new Map()
const counts = new Map()
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  if (!wanted.has(event.type) || seen.has(event.type)) continue
  seen.set(event.type, event)
}

console.log('\n--- event type counts ---')
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => `${String(n).padStart(5)}  ${type}`).join('\n'))

for (const [type, event] of seen) {
  console.log(`\n=== ${type} ===`)
  console.log(`data keys: ${Object.keys(event.data ?? {}).join(', ')}`)
  if (event.data?.message) console.log(`data.message keys: ${Object.keys(event.data.message).join(', ')}`)
  if (event.data?.source) console.log(`data.source keys: ${Object.keys(event.data.source).join(', ')}`)
  if (Array.isArray(event.data?.content)) console.log(`data.content[0] keys: ${Object.keys(event.data.content[0] ?? {}).join(', ')}`)
  if (Array.isArray(event.data?.message?.content)) {
    for (const block of event.data.message.content.slice(0, 3)) console.log(`  message.content[] keys: ${Object.keys(block ?? {}).join(', ')} (type=${block?.type})`)
  }
  console.log(JSON.stringify(event, null, 2).slice(0, 1200))
}
