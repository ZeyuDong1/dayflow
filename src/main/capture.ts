import { desktopCapturer, powerMonitor, screen, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import { db } from './db'
import { getSettings } from './settings'
import { getForegroundInfo } from './foreground'
import { dayKeyForTs, getRecordingsDirForDay } from './paths'

export interface CapturedFrame {
  id: number
  capturedAt: number
  filePath: string
  idleSeconds: number
  isPrivate: boolean
}

let timer: NodeJS.Timeout | null = null
let capturing = false
let lastCaptureAt = 0
let screenLocked = false
let onFrame: ((frame: CapturedFrame) => void) | null = null
let lastError: string | null = null

export function isPaused(): boolean {
  const { pauseUntil } = getSettings().capture
  return pauseUntil !== null && Date.now() < pauseUntil
}

export function captureEnabled(): boolean {
  return getSettings().capture.enabled && !isPaused() && !screenLocked
}

export function onFrameCaptected(cb: (frame: CapturedFrame) => void): void {
  onFrame = cb
}

export function getLastCaptureAt(): number {
  return lastCaptureAt
}

export function getLastError(): string | null {
  return lastError
}

export function startCapture(): void {
  stopCapture()
  const { intervalSec } = getSettings().capture
  timer = setInterval(tick, Math.max(1, intervalSec) * 1000)
  // Don't fire immediately at startup; wait one interval.
}

export function stopCapture(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function restartCapture(): void {
  if (captureEnabled()) startCapture()
  else stopCapture()
}

export function initPowerMonitoring(): void {
  powerMonitor.on('lock-screen', () => {
    screenLocked = true
  })
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
  })
  powerMonitor.on('suspend', () => {
    screenLocked = true
  })
  powerMonitor.on('resume', () => {
    screenLocked = false
  })
}

/** A tiny neutral-gray JPEG used as the privacy placeholder frame. */
const PLACEHOLDER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAKAAsBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k='

/**
 * Capture every monitor, scale each to `targetHeight`, and stitch them
 * side-by-side into one panorama JPEG (empty buffer on failure).
 */
async function captureDisplays(targetHeight: number, allDisplays: boolean): Promise<Buffer> {
  const displays = allDisplays
    ? screen.getAllDisplays()
    : [screen.getPrimaryDisplay()]
  if (displays.length === 0) return Buffer.alloc(0)

  // Request at each screen's physical resolution so downscaling stays sharp.
  let reqW = 0
  let reqH = 0
  for (const d of displays) {
    const sf = Math.max(1, d.scaleFactor ?? 1)
    reqW = Math.max(reqW, Math.round(d.size.width * sf))
    reqH = Math.max(reqH, Math.round(d.size.height * sf))
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: reqW, height: reqH }
  })
  if (sources.length === 0) return Buffer.alloc(0)

  // Order frames by display position (left to right), primary first on ties.
  const byId = new Map(sources.map((s) => [String(s.display_id), s]))
  const ordered = [...displays]
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d) => byId.get(String(d.id)))
    .filter((s): s is Electron.DesktopCapturerSource => !!s)
  const frames = (ordered.length > 0 ? ordered : sources).map((s) =>
    s.thumbnail.resize({ height: targetHeight })
  )
  if (frames.length === 0) return Buffer.alloc(0)

  if (frames.length === 1) {
    return frames[0].toJPEG(72)
  }

  // Horizontal BGRA stitch at a shared height.
  const H = frames[0].getSize().height
  const widths = frames.map((f) => f.getSize().width)
  const totalW = widths.reduce((a, b) => a + b, 0)
  const rowBytes = totalW * 4
  const out = Buffer.alloc(rowBytes * H)
  let xOff = 0
  for (let i = 0; i < frames.length; i++) {
    const bmp = frames[i].toBitmap() // width*H*4, BGRA
    const w = widths[i]
    for (let y = 0; y < H; y++) {
      bmp.copy(out, y * rowBytes + xOff * 4, y * w * 4, (y + 1) * w * 4)
    }
    xOff += w
  }
  return nativeImage.createFromBuffer(out, { width: totalW, height: H }).toJPEG(72)
}

async function tick(): Promise<void> {
  if (capturing) return
  if (!captureEnabled()) return
  capturing = true
  try {
    const settings = getSettings()
    const idleSeconds = Math.floor(powerMonitor.getSystemIdleTime())

    // Idle beyond the threshold: skip capture entirely (the gap becomes idle time).
    if (idleSeconds > settings.capture.idleThresholdSec) {
      lastError = null
      return
    }

    const fg = await getForegroundInfo()
    const isPrivate =
      !!fg &&
      settings.capture.privateApps.some(
        (p) =>
          p.trim().length > 0 &&
          (fg.appName.toLowerCase().includes(p.trim().toLowerCase()) ||
            fg.windowTitle.toLowerCase().includes(p.trim().toLowerCase()))
      )

    let jpegBuf: Buffer
    if (isPrivate) {
      jpegBuf = Buffer.from(PLACEHOLDER_JPEG_BASE64, 'base64')
    } else {
      jpegBuf = await captureDisplays(settings.capture.captureHeight, settings.capture.captureAllDisplays)
      if (jpegBuf.length === 0) {
        lastError = 'Empty capture'
        return
      }
    }

    const now = Date.now()
    const dayKey = dayKeyForTs(now)
    const dir = getRecordingsDirForDay(dayKey)
    const fileName = `${now}.jpg`
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, jpegBuf)

    const fgInfo = isPrivate ? null : fg
    db.run(
      `INSERT INTO screenshots (captured_at, file_path, file_size, idle_seconds, is_private, is_deleted, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [now, filePath, jpegBuf.length, idleSeconds, isPrivate ? 1 : 0, now]
    )
    const id = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id

    // Window metadata is attached to the pending analysis queue via a lightweight
    // in-memory map so titles stay out of the database (privacy).
    noteForeground(id, fgInfo)

    lastCaptureAt = now
    lastError = null
    if (onFrame) {
      onFrame({ id, capturedAt: now, filePath, idleSeconds, isPrivate })
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    console.error('[capture] failed:', err)
  } finally {
    capturing = false
  }
}

// ---------------------------------------------------------------------------
// Foreground window metadata (kept in memory only, never persisted)
// ---------------------------------------------------------------------------

const foregroundMeta = new Map<number, { appName: string; windowTitle: string } | null>()
const MAX_META = 5000

function noteForeground(id: number, fg: { appName: string; windowTitle: string } | null): void {
  foregroundMeta.set(id, fg)
  if (foregroundMeta.size > MAX_META) {
    const oldest = foregroundMeta.keys().next().value
    if (oldest !== undefined) foregroundMeta.delete(oldest)
  }
}

export function getForegroundForScreenshot(id: number): { appName: string; windowTitle: string } | null {
  return foregroundMeta.get(id) ?? null
}

export function countPendingScreenshots(): number {
  return db.count(
    `SELECT COUNT(*) AS c FROM screenshots s
     WHERE s.is_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = s.id)`
  )
}

export function pendingScreenshots(sinceTs = 0): { id: number; captured_at: number }[] {
  return db.all<{ id: number; captured_at: number }>(
    `SELECT s.id, s.captured_at FROM screenshots s
     WHERE s.is_deleted = 0 AND s.captured_at >= ?
       AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = s.id)
     ORDER BY s.captured_at ASC`,
    [sinceTs]
  )
}
