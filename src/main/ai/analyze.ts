import fs from 'fs'
import { db } from '../db'
import { getSettings, getCategories } from '../settings'
import { listProjects } from '../projects'
import { formatClock, dayKeyForTs } from '../paths'
import { pendingScreenshots, getForegroundForScreenshot } from '../capture'
import {
  visionComplete,
  extractJsonArray,
  resolveProvider,
  ProviderError
} from './providers'
import { buildTimelinePrompt } from './prompts'
import type { Distraction, TimelineCard } from '../../shared/types'

/** Matches Dayflow's BatchingConfig.standard. */
const TARGET_BATCH_MS = 15 * 60 * 1000 // 15-minute analysis batches
const MAX_GAP_MS = 2 * 60 * 1000 // split batches when the gap exceeds 2 minutes
const CARD_LOOKBACK_MS = 45 * 60 * 1000 // cards build with a 45-minute lookback
const MAX_FRAMES_PER_BATCH = 90 // hard cap (15 min at a 10 s interval)
const INACTIVE_FLUSH_MS = 3 * 60 * 1000 // flush a partial batch once capture went quiet

let pipelineTimer: NodeJS.Timeout | null = null
let busy = false
let failureCooldownUntil = 0
let consecutiveFailures = 0
let lastPipelineError: string | null = null
let cardsChangedHandler: (() => void) | null = null

export function onCardsChanged(cb: () => void): void {
  cardsChangedHandler = cb
}

function notifyCardsChanged(): void {
  cardsChangedHandler?.()
}

export function getLastPipelineError(): string | null {
  return lastPipelineError
}

export function startPipeline(): void {
  stopPipeline()
  pipelineTimer = setInterval(() => {
    void runPipelineTick()
  }, 20_000)
}

export function stopPipeline(): void {
  if (pipelineTimer) {
    clearInterval(pipelineTimer)
    pipelineTimer = null
  }
}

interface PendingFrame {
  id: number
  captured_at: number
}

async function runPipelineTick(force = false): Promise<void> {
  if (busy) return
  if (Date.now() < failureCooldownUntil) return
  const settings = getSettings()
  const rt = resolveProvider(settings)
  if (!rt.ready) return

  const pending = pendingScreenshots()
  if (pending.length === 0) return

  const first = pending[0]
  const last = pending[pending.length - 1]
  const windowMs = last.captured_at - first.captured_at
  const quietFor = Date.now() - last.captured_at

  // Close the batch when the target window is reached, the frame cap is hit,
  // or capture has gone quiet (user idle / locked / paused) for a few minutes.
  const shouldClose =
    force ||
    windowMs >= TARGET_BATCH_MS ||
    pending.length >= MAX_FRAMES_PER_BATCH ||
    quietFor >= INACTIVE_FLUSH_MS
  if (!shouldClose) return

  // Split on gaps > 2 minutes; process the oldest segment.
  const segment: PendingFrame[] = [first]
  for (let i = 1; i < pending.length; i++) {
    if (pending[i].captured_at - pending[i - 1].captured_at > MAX_GAP_MS) break
    segment.push(pending[i])
  }

  busy = true
  try {
    await processSegment(segment, settings)
    consecutiveFailures = 0
    lastPipelineError = null
  } catch (err) {
    consecutiveFailures++
    lastPipelineError = err instanceof Error ? err.message : String(err)
    console.error('[pipeline] analysis failed:', lastPipelineError)
    const cooldown = Math.min(60_000 * Math.pow(2, consecutiveFailures - 1), 600_000)
    failureCooldownUntil = Date.now() + cooldown
  } finally {
    busy = false
  }
}

async function processSegment(
  segment: PendingFrame[],
  settings: ReturnType<typeof getSettings>
): Promise<void> {
  const intervalMs = settings.capture.intervalSec * 1000
  const windowStart = segment[0].captured_at
  const windowEnd = Math.min(segment[segment.length - 1].captured_at + intervalMs, Date.now())
  const windowDurationMs = Math.max(windowEnd - windowStart, intervalMs)

  const batchId = insertBatch(windowStart, windowEnd)

  try {
    const rows = db.all<{
      id: number
      captured_at: number
      file_path: string
      idle_seconds: number | null
      is_private: number
    }>(
      `SELECT id, captured_at, file_path, idle_seconds, is_private FROM screenshots
       WHERE id IN (${segment.map((s) => s.id).join(',')}) AND is_deleted = 0
       ORDER BY captured_at ASC`
    )
    if (rows.length === 0) {
      db.run(`UPDATE analysis_batches SET status = 'empty', reason = 'no frames' WHERE id = ?`, [batchId])
      return
    }

    // Idle classifier (ported from Dayflow's IdleBatchClassifier): when the
    // user was idle for more than half the window, emit an idle card without
    // calling the LLM.
    const idleSecondsTotal = rows.reduce((acc, r) => acc + Math.max(r.idle_seconds ?? 0, 0), 0)
    const avgIdle = idleSecondsTotal / rows.length
    if (avgIdle > windowDurationMs / 2000) {
      insertIdleCard(batchId, windowStart, windowEnd, rows.length)
      linkScreenshots(batchId, rows.map((r) => r.id))
      db.run(`UPDATE analysis_batches SET status = 'success', reason = 'idle' WHERE id = ?`, [batchId])
      notifyCardsChanged()
      return
    }

    const categories = getCategories()
    const prompt = buildTimelinePrompt(categories, listProjects())

    // Previous cards overlapping the window (with lookback) — the contract
    // treats them as a draft that this run revises and extends.
    const lookbackStart = windowStart - CARD_LOOKBACK_MS
    const prevCards = getCardsInRange(lookbackStart, windowEnd)

    // Timing-style window-event timeline: the PRIMARY behavior signal.
    const windowTimeline = buildWindowTimeline(lookbackStart, windowEnd)

    const inputs = buildInputsBlock(settings, prevCards, windowStart, windowEnd, rows, windowTimeline)

    // Screenshots are the SECONDARY (visual corroboration) signal — a few
    // samples are enough on top of the authoritative window timeline.
    const sampled = sampleFrames(rows, intervalMs, 6)
    const images = sampled.map((r) => ({
      base64: fs.readFileSync(r.file_path).toString('base64'),
      label: formatClock(r.captured_at)
    }))

    const raw = await visionComplete(`${prompt}\n\n${inputs}`, images, 'timeline', settings)
    const parsed = extractJsonArray<RawCard>(raw)
    const cards = parsed
      .map((c) => normalizeCard(c, windowStart, windowEnd))
      .filter((c): c is NormalizedCard => c !== null)

    if (cards.length === 0) {
      throw new ProviderError('Model returned no usable cards')
    }

    applyCards(batchId, cards, lookbackStart, windowEnd)
    linkScreenshots(batchId, rows.map((r) => r.id))
    // Link Timing-style window segments to the new cards for the timeline UI.
    db.run(
      `UPDATE app_activities SET card_id = NULL WHERE start_ts < ? AND end_ts > ?`,
      [windowEnd, lookbackStart]
    )
    for (const c of cards) {
      db.run(
        `UPDATE app_activities SET card_id = ? WHERE start_ts < ? AND end_ts > ?`,
        [(db.get<{ id: number }>('SELECT id FROM timeline_cards WHERE is_deleted = 0 AND start_ts = ? ORDER BY id DESC', [c.startTs]) ?? { id: null }).id, c.endTs, c.startTs]
      )
    }
    db.run(
      `UPDATE analysis_batches SET status = 'success', llm_metadata = ? WHERE id = ?`,
      [JSON.stringify({ frames: rows.length, sampled: sampled.length }), batchId]
    )
    notifyCardsChanged()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Content-moderation rejections (e.g. Zhipu 1301) will never succeed on
    // retry — mark the frames as processed so the pipeline moves on.
    const isContentBlocked = /1301|敏感|不安全|content_filter|content policy/i.test(msg)
    if (isContentBlocked) {
      const rows2 = db.all<{ id: number }>(
        `SELECT id FROM screenshots WHERE is_deleted = 0 AND captured_at >= ? AND captured_at < ?
         AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = screenshots.id)`,
        [windowStart, windowEnd]
      )
      linkScreenshots(batchId, rows2.map((r) => r.id))
      db.run(`UPDATE analysis_batches SET status = 'skipped', reason = 'content-filtered' WHERE id = ?`, [batchId])
    } else {
      db.run(
        `UPDATE analysis_batches SET status = 'failed', reason = ? WHERE id = ?`,
        [msg.slice(0, 500), batchId]
      )
    }
    throw err
  }
}

function insertBatch(startTs: number, endTs: number): number {
  db.run(
    `INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status, reason, llm_metadata, created_at)
     VALUES (?, ?, 'pending', NULL, NULL, ?)`,
    [startTs, endTs, Date.now()]
  )
  return (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id
}

function linkScreenshots(batchId: number, screenshotIds: number[]): void {
  db.runMany(
    screenshotIds.map((id) => ({
      sql: 'INSERT OR IGNORE INTO batch_screenshots (batch_id, screenshot_id) VALUES (?, ?)',
      params: [batchId, id]
    }))
  )
}

interface RawCard {
  startTime?: string
  endTime?: string
  category?: string
  subcategory?: string
  title?: string
  summary?: string
  detailedSummary?: string
  distractions?: { startTime?: string; endTime?: string; title?: string; summary?: string }[]
  appSites?: { primary?: string | null; secondary?: string | null } | null
}

interface NormalizedCard {
  startTs: number
  endTs: number
  start: string
  end: string
  category: string
  subcategory: string
  title: string
  summary: string
  detailedSummary: string
  distractions: Distraction[]
  appSites: { primary: string | null; secondary: string | null } | null
}

/** Parse "1:12 PM" / "13:12" against a reference instant in the local zone. */
function parseClockToTs(clock: string, refTs: number): number | null {
  const m = clock
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const ampm = m[4]?.toLowerCase().startsWith('p') ? 'pm' : m[4]?.toLowerCase().startsWith('a') ? 'am' : null
  if (ampm === 'pm' && h < 12) h += 12
  if (ampm === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  const ref = new Date(refTs)
  const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, min, 0, 0)
  let best = base.getTime()
  let bestDiff = Math.abs(best - refTs)
  for (const delta of [-86400000, 86400000]) {
    const cand = base.getTime() + delta
    const diff = Math.abs(cand - refTs)
    if (diff < bestDiff) {
      best = cand
      bestDiff = diff
    }
  }
  return best
}

/** Project holding the most tracked time inside [startTs, endTs) — the truthful fallback. */
function dominantProjectOf(startTs: number, endTs: number): string | null {
  const rows = db.all<{ project_id: number | null; ms: number }>(
    `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
     WHERE is_deleted = 0 AND project_id IS NOT NULL AND start_ts < ? AND end_ts > ?
     GROUP BY project_id ORDER BY ms DESC LIMIT 1`,
    [endTs, startTs]
  )
  if (rows.length === 0) return null
  const proj = listProjects().find((p) => p.id === rows[0].project_id)
  return proj?.title ?? null
}

function normalizeCard(raw: RawCard, windowStart: number, windowEnd: number): NormalizedCard | null {
  if (!raw.startTime || !raw.endTime || !raw.title) return null
  const startTs = parseClockToTs(raw.startTime, windowStart)
  const endTs = parseClockToTs(raw.endTime, windowEnd)
  if (startTs === null || endTs === null) return null
  const now = Date.now()
  const clampedEnd = Math.min(endTs, now + 60_000)
  if (clampedEnd <= startTs) return null

  // Projects are the ONLY classification system; map the model's pick onto one.
  const projects = listProjects()
  const requested = (raw.category ?? '').trim()
  const match = projects.find(
    (p) => p.title.toLowerCase() === requested.toLowerCase() || requested.toLowerCase().includes(p.title.toLowerCase())
  )
  const isIdleCat = /idle|空闲/i.test(requested)
  const category = isIdleCat
    ? '空闲'
    : match?.title ?? dominantProjectOf(startTs, endTs) ?? projects[0]?.title ?? '未分类'

  const distractions: Distraction[] = (raw.distractions ?? [])
    .filter((d) => d.title)
    .map((d) => ({
      startTime: d.startTime ?? '',
      endTime: d.endTime ?? '',
      title: d.title ?? '',
      summary: d.summary ?? ''
    }))

  return {
    startTs,
    endTs: clampedEnd,
    start: raw.startTime,
    end: raw.endTime,
    category,
    subcategory: (raw.subcategory ?? '').slice(0, 60),
    title: raw.title.slice(0, 200),
    summary: raw.summary ?? '',
    detailedSummary: raw.detailedSummary ?? '',
    distractions,
    appSites: raw.appSites
      ? {
          primary: raw.appSites.primary ?? null,
          secondary: raw.appSites.secondary ?? null
        }
      : null
  }
}

/** Soft-delete the draft cards in range and insert the revised set. */
function applyCards(batchId: number, cards: NormalizedCard[], rangeStart: number, rangeEnd: number): void {
  const statements: { sql: string; params?: unknown[] }[] = [
    {
      sql: `UPDATE timeline_cards SET is_deleted = 1
            WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ?`,
      params: [rangeEnd, rangeStart]
    }
  ]
  const now = Date.now()
  for (const c of cards) {
    statements.push({
      sql: `INSERT INTO timeline_cards
            (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory, detailed_summary, metadata, created_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      params: [
        batchId,
        c.start,
        c.end,
        c.startTs,
        c.endTs,
        dayKeyForTs(c.startTs),
        c.title,
        c.summary,
        c.category,
        c.subcategory,
        c.detailedSummary,
        JSON.stringify({ distractions: c.distractions, appSites: c.appSites }),
        now
      ]
    })
  }
  db.runMany(statements)
}

function insertIdleCard(batchId: number, startTs: number, endTs: number, frameCount: number): void {
  const start = formatClock(startTs)
  const end = formatClock(endTs)
  db.run(
    `INSERT INTO timeline_cards
     (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory, detailed_summary, metadata, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      batchId,
      start,
      end,
      startTs,
      endTs,
      dayKeyForTs(startTs),
      '空闲 / 离开屏幕',
      '这段时间没有检测到活动。',
      '空闲',
      '',
      `${start} - ${end}: idle, no input detected (${frameCount} frames)`,
      JSON.stringify({ distractions: [], appSites: null, idle: { skippedLLM: true } }),
      Date.now()
    ]
  )
  // Idle cards replace any overlapping draft cards too.
  db.run(
    `UPDATE timeline_cards SET is_deleted = 1
     WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ? AND category NOT IN ('Idle', '空闲')`,
    [endTs, startTs]
  )
}

/** Downsample to at most one frame per minute (what the prompt expects), capped. */
function sampleFrames<T extends { captured_at: number }>(rows: T[], intervalMs: number, hardCap = 32): T[] {
  if (rows.length === 0) return rows
  const windowMinutes = (rows[rows.length - 1].captured_at - rows[0].captured_at) / 60000
  const maxFrames = Math.max(4, Math.min(hardCap, Math.ceil(windowMinutes) + 2))
  if (intervalMs >= 55_000) return rows.slice(0, maxFrames)
  if (rows.length <= maxFrames) return rows
  const step = rows.length / maxFrames
  const out: T[] = []
  for (let i = 0; i < maxFrames; i++) {
    out.push(rows[Math.floor(i * step)])
  }
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1])
  return out
}

/** Timing-style: app/window-title segments covering the analysis window. */
function buildWindowTimeline(startTs: number, endTs: number): string {
  const rows = db.all<{ start_ts: number; end_ts: number; app_name: string; title: string }>(
    `SELECT start_ts, end_ts, app_name, title FROM app_activities
     WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ?
     ORDER BY start_ts ASC`,
    [endTs, startTs]
  )
  if (rows.length === 0) return '(no window events recorded)'
  return rows
    .map(
      (r) =>
        `${formatClock(r.start_ts)} - ${formatClock(r.end_ts)} | App: ${r.app_name} | Window title: ${r.title || '(untitled)'}`
    )
    .join('\n')
}

function buildInputsBlock(
  settings: ReturnType<typeof getSettings>,
  prevCards: TimelineCard[],
  windowStart: number,
  windowEnd: number,
  rows: { id: number; captured_at: number; is_private: number }[],
  windowTimeline: string
): string {
  const name = settings.general.userName.trim()
  const lines: string[] = ['INPUTS:']
  lines.push('- WINDOW EVENT TIMELINE (PRIMARY source of truth for what the user did):')
  lines.push(windowTimeline)
  if (name) lines.push(`- User name: ${name}`)
  const fg = getForegroundForScreenshot(rows[0].id)
  if (fg?.appName) {
    lines.push(`- The main apps visible on this machine include: ${fg.appName}`)
  }
  lines.push(
    `- Screenshots (SECONDARY, visual corroboration only) run from ${formatClock(windowStart)} to ${formatClock(
      Math.min(windowEnd, rows[rows.length - 1].captured_at)
    )}.`
  )
  const privacyCount = rows.filter((r) => r.is_private === 1).length
  if (privacyCount > 0) {
    lines.push(
      `- ${privacyCount} frame(s) are solid gray placeholder images: the user was using a private/excluded app. Describe that time as "private app in use" without guessing what it was.`
    )
  }
  if (prevCards.length > 0) {
    lines.push('- Previous cards (a DRAFT to revise and extend; keep their coverage):')
    lines.push(
      prevCards
        .map(
          (c) =>
            `  {"startTime": ${JSON.stringify(c.start)}, "endTime": ${JSON.stringify(c.end)}, "category": ${JSON.stringify(
              c.category
            )}, "title": ${JSON.stringify(c.title)}, "summary": ${JSON.stringify(c.summary)}, "detailedSummary": ${JSON.stringify(
              c.detailedSummary
            )}, "distractions": ${JSON.stringify(c.distractions)}, "appSites": ${JSON.stringify(c.appSites)}}`
        )
        .join('\n')
    )
  } else {
    lines.push('- Previous cards: none.')
  }
  const lang = settings.general.outputLanguage.trim()
  if (lang) {
    lines.push(`- Reminder: write every title, summary, detailedSummary line and distraction in ${lang}.`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Queries used by IPC
// ---------------------------------------------------------------------------

export function getCardsInRange(startTs: number, endTs: number): TimelineCard[] {
  const rows = db.all<CardRow>(
    `SELECT * FROM timeline_cards WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ? ORDER BY start_ts ASC`,
    [endTs, startTs]
  )
  return rows.map(rowToCard)
}

export function getCardsForDay(day: string): TimelineCard[] {
  const rows = db.all<CardRow>(
    `SELECT * FROM timeline_cards WHERE day = ? AND is_deleted = 0 ORDER BY start_ts ASC`,
    [day]
  )
  return rows.map(rowToCard)
}

interface CardRow {
  id: number
  batch_id: number | null
  start: string
  end: string
  start_ts: number
  end_ts: number
  day: string
  title: string
  summary: string | null
  category: string
  subcategory: string | null
  detailed_summary: string | null
  metadata: string | null
}

function rowToCard(r: CardRow): TimelineCard {
  let meta: { distractions?: Distraction[]; appSites?: { primary: string | null; secondary: string | null } | null } = {}
  try {
    meta = r.metadata ? JSON.parse(r.metadata) : {}
  } catch {
    meta = {}
  }
  const count = db.count(
    `SELECT COUNT(*) AS c FROM batch_screenshots bs
     JOIN screenshots s ON s.id = bs.screenshot_id
     JOIN analysis_batches ab ON ab.id = bs.batch_id
     WHERE ab.batch_start_ts < ? AND ab.batch_end_ts > ? AND s.is_deleted = 0`,
    [r.end_ts, r.start_ts]
  )
  return {
    id: r.id,
    batchId: r.batch_id ?? null,
    start: r.start,
    end: r.end,
    startTs: r.start_ts,
    endTs: r.end_ts,
    day: r.day,
    title: r.title,
    summary: r.summary ?? '',
    category: r.category,
    subcategory: r.subcategory ?? '',
    detailedSummary: r.detailed_summary ?? '',
    distractions: meta.distractions ?? [],
    appSites: meta.appSites ?? null,
    isIdle: r.category === 'Idle' || r.category === '空闲',
    screenshotCount: count
  }
}

export function deleteCard(id: number): void {
  db.run('UPDATE timeline_cards SET is_deleted = 1 WHERE id = ?', [id])
  notifyCardsChanged()
}

export function deleteDay(day: string): void {
  db.run('UPDATE timeline_cards SET is_deleted = 1 WHERE day = ?', [day])
  notifyCardsChanged()
}

export function reprocessDay(day: string): number {
  // Unlink all screenshots captured during the day so the pipeline re-runs.
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y, m - 1, d, 4, 0, 0, 0).getTime()
  const end = new Date(y, m - 1, d + 1, 4, 0, 0, 0).getTime()
  db.run(
    `DELETE FROM batch_screenshots WHERE screenshot_id IN (
       SELECT id FROM screenshots WHERE captured_at >= ? AND captured_at < ?
     )`,
    [start, end]
  )
  db.run('UPDATE timeline_cards SET is_deleted = 1 WHERE day = ?', [day])
  failureCooldownUntil = 0
  notifyCardsChanged()
  return db.count(
    'SELECT COUNT(*) AS c FROM screenshots WHERE captured_at >= ? AND captured_at < ? AND is_deleted = 0',
    [start, end]
  )
}

export function forceFlushPending(): void {
  failureCooldownUntil = 0
  void runPipelineTick(true)
}
