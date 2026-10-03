/**
 * Framing probe: determine the exact stdio wire format of `codex app-server`.
 *
 * Sends one `initialize` request using a candidate framing, then prints every
 * raw byte chunk that comes back so the framing can be read off directly.
 *
 * Usage: node test/probe-framing.mjs [newline|content-length|both]
 */
import { spawn } from 'node:child_process'

const mode = process.argv[2] ?? 'both'
const bin = process.env.CODEX_BIN || 'codex'

const child = spawn(bin, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env,
})

const rawChunks = []
child.stdout.on('data', (d) => {
  rawChunks.push(d)
  console.log('[stdout chunk]', JSON.stringify(d.toString('utf8').slice(0, 600)))
})
child.stderr.on('data', (d) => {
  console.log('[stderr]', d.toString('utf8').trimEnd())
})
child.on('error', (e) => {
  console.log('[spawn error]', e.message)
})
child.on('exit', (code, signal) => {
  console.log('[exit]', code, signal)
})

const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    clientInfo: { name: 'dsh_codex_probe', title: 'DSH Codex Probe', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  },
}
const json = JSON.stringify(request)

function sendNewline() {
  console.log('[send] newline-delimited')
  child.stdin.write(json + '\n')
}

function sendContentLength() {
  console.log('[send] content-length')
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
}

setTimeout(() => {
  if (mode === 'newline') sendNewline()
  else if (mode === 'content-length') sendContentLength()
  else {
    // Try newline first; if nothing arrives, fall back to content-length.
    sendNewline()
    setTimeout(() => {
      if (Buffer.concat(rawChunks).length === 0) sendContentLength()
    }, 2500)
  }
}, 800)

setTimeout(() => {
  const all = Buffer.concat(rawChunks).toString('utf8')
  console.log('\n===== RAW TOTAL BYTES:', Buffer.concat(rawChunks).length, '=====')
  console.log(JSON.stringify(all.slice(0, 4000)))
  console.log('\n===== FIRST LINE =====')
  console.log(JSON.stringify(all.split('\n')[0]))
  try {
    child.kill()
  } catch {}
  setTimeout(() => process.exit(0), 300)
}, 7000)
