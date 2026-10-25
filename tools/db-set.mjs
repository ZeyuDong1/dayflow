// Read/write the Dayflow app_settings row (app must be stopped).
// Usage:
//   node tools/db-set.mjs set '{"ai":{"provider":"openai-compatible"}}'   (merged shallowly into stored JSON)
//   node tools/db-set.mjs get
//   node tools/db-set.mjs wipe-data     (delete screenshots/cards/batches tables + recordings dir)
//   node tools/db-set.mjs reset-settings (drop app-settings + onboarding rows -> factory defaults)
import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(process.env.APPDATA, 'Dayflow', 'data', 'dayflow.db')
const recordings = path.join(process.env.APPDATA, 'Dayflow', 'recordings')
const SQL = await initSqlJs({
  locateFile: (f) => path.join(here, '..', 'node_modules', 'sql.js', 'dist', f)
})

const exists = fs.existsSync(dbPath)
const db = exists ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)`)

const save = () => {
  const tmp = dbPath + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(db.export()))
  fs.renameSync(tmp, dbPath)
}

const getRow = () => {
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  stmt.bind(['app-settings'])
  let val = null
  if (stmt.step()) val = stmt.getAsObject().value
  stmt.free()
  return val
}

const cmd = process.argv[2]
if (cmd === 'get') {
  console.log(getRow() ?? '(no settings row)')
} else if (cmd === 'set') {
  const patch = JSON.parse(process.argv[3])
  const current = getRow() ? JSON.parse(getRow()) : {}
  const next = { ...current, ...patch, ai: { ...(current.ai ?? {}), ...(patch.ai ?? {}) }, capture: { ...(current.capture ?? {}), ...(patch.capture ?? {}) } }
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', ['app-settings', JSON.stringify(next)])
  save()
  console.log('settings updated')
} else if (cmd === 'wipe-data') {
  for (const t of ['batch_screenshots', 'timeline_cards', 'analysis_batches', 'screenshots', 'llm_calls', 'chat_messages', 'chat_conversations']) {
    db.run(`DELETE FROM ${t}`)
  }
  save()
  fs.rmSync(recordings, { recursive: true, force: true })
  fs.mkdirSync(recordings, { recursive: true })
  console.log('data wiped')
} else if (cmd === 'reset-settings') {
  db.run(`DELETE FROM app_settings`)
  save()
  console.log('settings reset to factory defaults')
} else {
  console.log('unknown command')
}
