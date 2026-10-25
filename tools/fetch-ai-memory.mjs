// Fetch the pinned ai-memory release binary into vendor/ai-memory/.
// The binary is NOT committed (see .gitignore); this script is the source of
// truth for which version Dayflow ships. Independent update = bump the version
// in vendor/ai-memory/manifest.json and re-run this script.
//
// Usage: node tools/fetch-ai-memory.mjs [--force]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'ai-memory')
const MANIFEST = path.join(VENDOR, 'manifest.json')
const EXE = path.join(VENDOR, 'ai-memory.exe')

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'))
const { version, sha256 } = manifest
const base = `https://github.com/akitaonrails/ai-memory/releases/download/v${version}`
const zipName = 'ai-memory-windows-x86_64.zip'

if (fs.existsSync(EXE) && !process.argv.includes('--force')) {
  console.log(`[fetch-ai-memory] already present (${version}); use --force to re-fetch`)
  process.exit(0)
}

fs.mkdirSync(VENDOR, { recursive: true })
const tmp = path.join(VENDOR, zipName)
console.log(`[fetch-ai-memory] downloading ${zipName} (v${version})...`)
const res = await fetch(`${base}/${zipName}`)
if (!res.ok) throw new Error(`download failed: ${res.status}`)
fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))

const actual = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex')
if (actual !== sha256) {
  fs.unlinkSync(tmp)
  throw new Error(`sha256 mismatch: expected ${sha256}, got ${actual}`)
}
console.log('[fetch-ai-memory] sha256 verified')

// The zip carries ai-memory.exe at its root; extract just the exe.
const outDir = path.join(VENDOR, '.tmp')
fs.rmSync(outDir, { recursive: true, force: true })
execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Expand-Archive -Path '${tmp.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`
], { stdio: 'inherit' })
fs.copyFileSync(path.join(outDir, 'ai-memory.exe'), EXE)
fs.rmSync(outDir, { recursive: true, force: true })
fs.unlinkSync(tmp)
manifest.fetchedAt = new Date().toISOString()
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
console.log(`[fetch-ai-memory] ready: ${EXE} (v${version})`)
