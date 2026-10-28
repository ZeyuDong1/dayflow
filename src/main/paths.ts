import { app } from 'electron'
import path from 'path'
import fs from 'fs'

let dataRoot = ''

export function initPaths(): void {
  dataRoot = app.getPath('userData')
  for (const dir of [dataRoot, getRecordingsRoot(), getDataDir()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function getDataDir(): string {
  return path.join(dataRoot, 'data')
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'dayflow.db')
}

export function getRecordingsRoot(): string {
  return path.join(dataRoot, 'recordings')
}

export function getRecordingsDirForDay(dayKey: string): string {
  const dir = path.join(getRecordingsRoot(), dayKey)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Local YYYY-MM-DD for a timestamp, calendar day boundary (00:00). */
export function dayKeyForTs(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Start-of-day (00:00 local) epoch ms for a YYYY-MM-DD key. */
export function dayStartTs(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

export function dayEndTs(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime()
}

export function formatDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/** Format epoch ms as local clock "h:MM AM/PM" like Dayflow frame labels. */
export function formatClock(ts: number): string {
  let s = new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
  // Normalize locale variants (e.g. "上午9:03" zh) — force en-US style for the LLM.
  s = new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return s.replace(/\s?([AP])M/i, (_m, p) => ` ${p.toUpperCase()}M`)
}

export function addDaysKey(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d + delta)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function todayKey(): string {
  return dayKeyForTs(Date.now())
}
