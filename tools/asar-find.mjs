/**
 * Search inside an Electron asar archive: match file paths, and optionally the
 * *contents* of those files, without extracting the whole archive.
 *
 * Why: the DSH host ships inside `app.asar`, so the services a plugin can
 * `ctx.inject()` (their exact names and method shapes) can only be read from
 * there. This tool answers "which file defines service X" in one command.
 *
 * Usage:
 *   node asar-find.mjs <archive.asar> [--path <regex>] [--grep <regex>] [--max <n>]
 *
 * Defaults: --path matches everything, --max 40 matches printed.
 */
import { openSync, readSync } from 'node:fs'

const argv = process.argv.slice(2)
const archive = argv.shift()
if (!archive) {
  console.error('usage: node asar-find.mjs <archive.asar> [--path <re>] [--grep <re>] [--max <n>]')
  process.exit(2)
}
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const pathRe = new RegExp(opt('--path', ''), 'i')
const grepSrc = opt('--grep', null)
const grepRe = grepSrc ? new RegExp(grepSrc, 'i') : null
const max = Number(opt('--max', '40'))

const fd = openSync(archive, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const jsonBuffer = Buffer.alloc(jsonLen)
readSync(fd, jsonBuffer, 0, jsonLen, 16)
const directory = JSON.parse(jsonBuffer.toString('utf8'))
const dataOffset = 8 + headerPickleSize

const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (entry.files) walk(entry, p)
    else files.push({ path: p, size: Number(entry.size), offset: Number(entry.offset) })
  }
}
walk(directory, '')

const read = (file) => {
  const buffer = Buffer.alloc(file.size)
  readSync(fd, buffer, 0, file.size, dataOffset + file.offset)
  return buffer
}

let shown = 0
let scanned = 0
for (const file of files) {
  if (!pathRe.test(file.path)) continue
  if (!grepRe) {
    console.log(`${file.size}\t${file.path}`)
    if (++shown >= max) break
    continue
  }
  if (file.size > 8 * 1024 * 1024) continue
  const text = read(file).toString('utf8')
  const lines = text.split(/\r?\n/)
  const hits = []
  lines.forEach((line, index) => {
    if (grepRe.test(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 220)}`)
  })
  if (!hits.length) continue
  scanned++
  console.log(`\n=== ${file.path} (${file.size} bytes, ${hits.length} hits) ===`)
  console.log(hits.slice(0, 30).join('\n'))
  if (++shown >= max) break
}
console.error(`\n[asar-find] files=${files.length} matchedFiles=${shown}${grepRe ? ` (content-scanned ${scanned})` : ''}`)
