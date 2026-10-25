import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { db } from './db'
import { getSettings } from './settings'
import { getRecordingsRoot } from './paths'
import { isPaused } from './capture'

let timer: NodeJS.Timeout | null = null

export function startCleanupSchedule(): void {
  stopCleanupSchedule()
  runCleanup()
  // Once a day is plenty; also run shortly after launch (above).
  timer = setInterval(runCleanup, 12 * 60 * 60 * 1000)
}

export function stopCleanupSchedule(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function dirSize(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else {
      try {
        total += fs.statSync(p).size
      } catch {
        // file vanished
      }
    }
  }
  return total
}

export function getStorageUsage(): {
  recordingsBytes: number
  dbBytes: number
  screenshotCount: number
  cardCount: number
} {
  return {
    recordingsBytes: dirSize(getRecordingsRoot()),
    dbBytes: (() => {
      try {
        return fs.statSync(path.join(app.getPath('userData'), 'data', 'dayflow.db')).size
      } catch {
        return 0
      }
    })(),
    screenshotCount: db.count('SELECT COUNT(*) AS c FROM screenshots WHERE is_deleted = 0'),
    cardCount: db.count('SELECT COUNT(*) AS c FROM timeline_cards WHERE is_deleted = 0')
  }
}

/** Delete screenshot files + rows for screenshots older than `cutoffTs`. */
function deleteScreenshotsOlderThan(cutoffTs: number): number {
  const rows = db.all<{ id: number; file_path: string }>(
    'SELECT id, file_path FROM screenshots WHERE captured_at < ?',
    [cutoffTs]
  )
  let deleted = 0
  for (const r of rows) {
    try {
      if (r.file_path && fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path)
    } catch {
      // best effort
    }
    db.run('DELETE FROM batch_screenshots WHERE screenshot_id = ?', [r.id])
    db.run('DELETE FROM screenshots WHERE id = ?', [r.id])
    deleted++
  }
  return deleted
}

/** Enforce the disk cap by deleting the oldest screenshot files first. */
function enforceDiskCap(limitBytes: number): number {
  const root = getRecordingsRoot()
  let total = dirSize(root)
  if (total <= limitBytes) return 0
  const rows = db.all<{ id: number; file_path: string; file_size: number | null; captured_at: number }>(
    'SELECT id, file_path, file_size, captured_at FROM screenshots ORDER BY captured_at ASC'
  )
  let deleted = 0
  for (const r of rows) {
    if (total <= limitBytes) break
    try {
      if (r.file_path && fs.existsSync(r.file_path)) {
        fs.unlinkSync(r.file_path)
        total -= r.file_size ?? fs.statSync(r.file_path).size ?? 0
      }
    } catch {
      // best effort
    }
    db.run('DELETE FROM batch_screenshots WHERE screenshot_id = ?', [r.id])
    db.run('DELETE FROM screenshots WHERE id = ?', [r.id])
    deleted++
  }
  // Also purge files with no DB row (orphans).
  purgeOrphanFiles()
  return deleted
}

function purgeOrphanFiles(): void {
  const root = getRecordingsRoot()
  let dayDirs: fs.Dirent[]
  try {
    dayDirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const known = new Set(
    db.all<{ file_path: string }>('SELECT file_path FROM screenshots').map((r) => r.file_path)
  )
  for (const d of dayDirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        const p = path.join(dir, f)
        if (!known.has(p)) {
          try {
            fs.unlinkSync(p)
          } catch {
            // in use; next pass will get it
          }
        }
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {
      // best effort
    }
  }
}

/** Remove soft-deleted cards older than 30 days and ancient failed batches. */
function pruneDatabase(): void {
  db.run(`DELETE FROM timeline_cards WHERE is_deleted = 1 AND created_at < ?`, [Date.now() - 30 * 86400_000])
  db.run(`DELETE FROM analysis_batches WHERE status = 'failed' AND created_at < ?`, [Date.now() - 7 * 86400_000])
  db.run(`DELETE FROM llm_calls WHERE created_at < ?`, [Date.now() - 14 * 86400_000])
}

export function runCleanup(): void {
  const settings = getSettings()
  if (!settings.storage.autoCleanup) return
  // Keep recordings for 30 days (cards/summaries stay forever).
  deleteScreenshotsOlderThan(Date.now() - 30 * 86400_000)
  enforceDiskCap(settings.storage.recordingsLimitBytes)
  purgeOrphanFiles()
  pruneDatabase()
}

export function deleteAllData(): void {
  const root = getRecordingsRoot()
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  db.exec(`
    DELETE FROM batch_screenshots;
    DELETE FROM screenshots;
    DELETE FROM timeline_cards;
    DELETE FROM analysis_batches;
    DELETE FROM daily_standup_entries;
    DELETE FROM day_plans;
    DELETE FROM llm_calls;
    DELETE FROM chat_messages;
    DELETE FROM chat_conversations;
  `)
}

export { isPaused }
