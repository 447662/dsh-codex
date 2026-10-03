/**
 * Extract a single file from an Electron asar archive.
 *
 * The DSH runtime ships inside `app.asar`, so the cordis loader's own source is
 * not readable as a normal path. When a plugin fails to activate, reading the
 * exact loader code beats inferring its contract from error messages.
 *
 * asar layout: 16-byte header (UInt32LE x4: 4, headerPickleSize, jsonSize,
 * jsonLen) followed by the JSON directory; file bytes start at
 * 8 + headerPickleSize and each entry carries a byte offset.
 *
 * Usage: node .recon/tools/asar-extract.mjs <archive.asar> <inner/path> <outFile>
 */
import { mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [archive, innerPath, outFile] = process.argv.slice(2)
if (!archive || !innerPath || !outFile) {
  console.error('usage: node asar-extract.mjs <archive.asar> <inner/path> <outFile>')
  process.exit(2)
}

const fd = openSync(archive, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const jsonBuffer = Buffer.alloc(jsonLen)
readSync(fd, jsonBuffer, 0, jsonLen, 16)
const directory = JSON.parse(jsonBuffer.toString('utf8'))
const dataOffset = 8 + headerPickleSize

// `--list <inner/dir>`: print one archive directory's children.
if (innerPath === '--list') {
  const target = outFile && outFile !== '.' ? outFile : ''
  let listing = directory
  for (const part of target.split('/').filter(Boolean)) {
    listing = listing?.files?.[part]
    if (!listing) {
      console.error(`not found in archive: ${target} (missing "${part}")`)
      process.exit(1)
    }
  }
  for (const [name, child] of Object.entries(listing.files ?? {})) {
    console.log(`${child.files ? 'dir ' : 'file'}  ${child.files ? '' : String(child.size).padStart(9)}  ${target ? `${target}/` : ''}${name}`)
  }
  process.exit(0)
}

let node = directory
for (const part of innerPath.split('/').filter(Boolean)) {
  node = node?.files?.[part]
  if (!node) {
    console.error(`not found in archive: ${innerPath} (missing segment "${part}")`)
    process.exit(1)
  }
}
if (node.files) {
  console.error(`"${innerPath}" is a directory; pass a file path`)
  process.exit(1)
}

const size = Number(node.size)
const buffer = Buffer.alloc(size)
readSync(fd, buffer, 0, size, dataOffset + Number(node.offset))
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, buffer)
console.log(`extracted ${size} bytes -> ${outFile}`)
