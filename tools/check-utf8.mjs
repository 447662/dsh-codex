/**
 * Fail if any tracked text file is not valid UTF-8.
 *
 * A Windows shell round-trip once read these UTF-8 sources as GBK and wrote the
 * mojibake back, which silently destroyed every Chinese character in the
 * README. This guard makes that class of mistake impossible to commit again.
 *
 * Usage: node tools/check-utf8.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.woff', '.woff2'])

let files
try {
  files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch {
  console.error('not a git repository')
  process.exit(2)
}

const bad = []
const suspicious = []

for (const file of files) {
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase()
  if (BINARY_EXT.has(ext)) continue
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    continue
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    // Catch the *decoded* form too: GBK-mangled UTF-8 can occasionally survive a
    // strict decode while still being nonsense.
    if (/[\uFFFD]/.test(text)) suspicious.push(`${file} (contains U+FFFD)`)
    // Mojibake for common Chinese text very often lands in this block.
    if (/[\u9280-\u9FFF]{2,}/.test(text) && /[\uFFFD]/.test(text)) suspicious.push(`${file} (mojibake)`)
  } catch (error) {
    bad.push(`${file} (${error.message})`)
  }
}

for (const file of files) {
  const buffer = readFileSync(file)
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) suspicious.push(`${file} (UTF-8 BOM)`)
}

console.log(`checked ${files.length} tracked file(s)`)
if (bad.length) {
  console.log('\nNOT valid UTF-8:')
  for (const line of bad) console.log(`  - ${line}`)
}
if (suspicious.length) {
  console.log('\nSuspicious:')
  for (const line of suspicious) console.log(`  - ${line}`)
}
if (!bad.length && !suspicious.length) console.log('all files are clean UTF-8')
process.exit(bad.length ? 1 : 0)
