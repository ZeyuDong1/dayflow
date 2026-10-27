import { powerMonitor } from 'electron'
import { db } from './db'
import { getSettings } from './settings'
import { getForegroundInfo } from './foreground'
import { classifyActivity, isKnownApp, isBrowserApp, titlePattern } from './projects'
import { classifyNewAppIfNeeded, classifyBrowserTitleIfNeeded } from './ai/llm-classify'
import { lookupPageUrl } from './browser-history'
import { noteExePath } from './app-icons'

/**
 * Timing-style foreground-window tracker (the primary behavior signal).
 * Polls the foreground window every 2s, merges consecutive identical
 * (app, title) into app_activity segments, excludes idle gaps, and folds
 * too-short fragments into neighbors.
 */

const POLL_MS = 2000
const MIN_SEGMENT_MS = 20_000 // Timing's preventTooShortDurations
const TITLE_MAX = 300

interface OpenSegment {
  dbId: number // 行在打开时即写入，段持续期间实时更新 end_ts
  appName: string
  title: string
  startTs: number
  lastSeenTs: number
  maxIdleSec: number
}

let timer: NodeJS.Timeout | null = null
let open: OpenSegment | null = null
let screenLocked = false
let onSegmentHandler: (() => void) | null = null

export function onSegmentClosed(cb: () => void): void {
  onSegmentHandler = cb
}

/** Normalize a window title: strip browser/editors suffixes for cleaner grouping. */
function normalizeTitle(appName: string, rawTitle: string): string {
  let t = rawTitle.replace(/\s+/g, ' ').trim()
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX)
  return t
}

/** Extract a URL/file path hint from the title when obvious. */
function extractUrlOrPath(title: string): string | null {
  const url = title.match(/https?:\/\/[^\s)"，」』]+/i)
  if (url) return url[0]
  const winPath = title.match(/\b[A-Za-z]:\\[^\s"，」』|<>?*]+/)
  if (winPath) return winPath[0]
  return null
}

function isPrivateApp(appName: string, title: string): boolean {
  const apps = getSettings().capture.privateApps
  return apps.some(
    (p) =>
      p.trim().length > 0 &&
      (appName.toLowerCase().includes(p.trim().toLowerCase()) ||
        title.toLowerCase().includes(p.trim().toLowerCase()))
  )
}

/** 收尾段：过短删除（防碎片），否则定稿 end_ts + 无输入标记、补 URL。 */
function finalizeSegment(seg: OpenSegment, endTs: number): void {
  const duration = endTs - seg.startTs
  const idleThreshold = getSettings().capture.idleThresholdSec
  const isIdle = seg.maxIdleSec > idleThreshold ? 1 : 0
  if (duration < Math.min(MIN_SEGMENT_MS, POLL_MS * 2)) {
    db.run('DELETE FROM app_activities WHERE id = ?', [seg.dbId]) // too short, drop
    return
  }
  db.run('UPDATE app_activities SET end_ts = ?, is_idle = ? WHERE id = ?', [endTs, isIdle, seg.dbId])
  // Resolve the real page URL from the browser's history DB (Timing-style);
  // incognito tabs are absent from history and resolve to nothing.
  if (isBrowserApp(seg.appName)) {
    void lookupPageUrl(seg.appName, seg.title).then((url) => {
      if (!url) return
      db.run('UPDATE app_activities SET url_or_path = ? WHERE id = ? AND url_or_path IS NULL', [
        url,
        seg.dbId
      ])
      // URL 到手后用完整三元组重分类(网址规则此时才能命中);
      // 只覆盖规则/未归类结果,用户手动指定的不动。
      const row = db.get<{ project_id: number | null; is_manual: number }>(
        'SELECT project_id, is_manual FROM app_activities WHERE id = ?',
        [seg.dbId]
      )
      if (!row || row.is_manual === 1) return
      const reclassified = classifyActivity(seg.appName, seg.title, url)
      if (reclassified !== row.project_id) {
        db.run('UPDATE app_activities SET project_id = ? WHERE id = ?', [reclassified, seg.dbId])
      }
    })
  }
  onSegmentHandler?.()
}

export function startWindowTracking(): void {
  stopWindowTracking()
  timer = setInterval(() => void poll(), POLL_MS)
  powerMonitor.on('lock-screen', () => {
    flushOpenSegment()
    screenLocked = true
  })
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
  })
  powerMonitor.on('suspend', () => {
    flushOpenSegment()
    screenLocked = true
  })
  powerMonitor.on('resume', () => {
    screenLocked = false
  })
}

export function stopWindowTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function flushOpenSegment(): void {
  if (open) {
    finalizeSegment(open, open.lastSeenTs + 2000)
    open = null
  }
}

async function poll(): Promise<void> {
  try {
    const settings = getSettings()
    if (!settings.capture.enabled) return
    if (settings.capture.pauseUntil !== null && Date.now() < settings.capture.pauseUntil) return
    if (screenLocked) return

    // 无键鼠输入 ≠ 离开电脑（读文档/看视频/思考都是活动）。
    // 窗口追踪不因输入空闲中断——只在锁屏/睡眠时停止；
    // 无输入时段收尾时打 is_idle 标记（UI 半透明显示），绝不留空白。
    const idleSec = powerMonitor.getSystemIdleTime()

    const fg = await getForegroundInfo()
    if (!fg) return
    noteExePath(fg.appName, fg.exePath)
    const now = Date.now()
    const title = normalizeTitle(fg.appName, fg.windowTitle)
    const key = `${fg.appName}\u0000${title}`

    if (open && `${open.appName}\u0000${open.title}` === key) {
      // 段持续中：实时续写 end_ts（时间轴立刻可见，不再缺失当前块）
      open.lastSeenTs = now
      open.maxIdleSec = Math.max(open.maxIdleSec, idleSec)
      db.run('UPDATE app_activities SET end_ts = ? WHERE id = ?', [now + 2000, open.dbId])
      return
    }
    // 前台切换：收尾旧段，打开新段（立即落库 + 归类 + LLM 兜底）
    if (open) finalizeSegment(open, now)
    const segTitle = isPrivateApp(fg.appName, title) ? '（隐私应用，标题已隐藏）' : title
    const segUrl = extractUrlOrPath(segTitle)
    const projectId = classifyActivity(fg.appName, segTitle, segUrl)
    db.run(
      `INSERT INTO app_activities (start_ts, end_ts, app_name, title, url_or_path, project_id, is_manual, is_deleted, is_idle)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      [now, now + 2000, fg.appName, segTitle, segUrl, projectId]
    )
    const dbId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id
    open = { dbId, appName: fg.appName, title: segTitle, startTs: now, lastSeenTs: now, maxIdleSec: idleSec }
    // First time we see this process: ask the LLM which project it belongs to.
    // Browsers classify per page instead.
    if (isBrowserApp(fg.appName)) {
      classifyBrowserTitleIfNeeded(fg.appName, segTitle)
    } else if (!isKnownApp(fg.appName)) {
      classifyNewAppIfNeeded(fg.appName, segTitle)
    }
  } catch (err) {
    console.error('[windows-poll] failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: number
  start_ts: number
  end_ts: number
  app_name: string
  title: string | null
  url_or_path: string | null
  project_id: number | null
  is_manual: number
  card_id: number | null
}

export function getActivitiesForDay(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y, m - 1, d, 4, 0, 0, 0).getTime()
  const end = new Date(y, m - 1, d + 1, 4, 0, 0, 0).getTime()
  const rows = db.all<ActivityRow>(
    `SELECT * FROM app_activities WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ?
     ORDER BY start_ts ASC`,
    [end, start]
  )
  return rows.map((r) => ({
    id: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    appName: r.app_name,
    title: r.title ?? '',
    urlOrPath: r.url_or_path,
    projectId: r.project_id,
    isManual: r.is_manual === 1,
    cardId: r.card_id
  }))
}

export function assignActivityProject(activityId: number, projectId: number | null, manual = true): void {
  db.run(
    `UPDATE app_activities SET project_id = ?, is_manual = ? WHERE id = ?`,
    [projectId, manual ? 1 : 0, activityId]
  )
  // Learn from manual classification (Timing's provenance-based suggestions).
  const row = db.get<{ app_name: string; title: string }>(
    'SELECT app_name, title FROM app_activities WHERE id = ?',
    [activityId]
  )
  if (row && projectId !== null) {
    const pattern = titlePattern(row.title)
    db.run(
      `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(app_name, title_pattern) DO UPDATE SET
         project_id = excluded.project_id, hits = hits + 1, updated_at = excluded.updated_at`,
      [row.app_name, pattern, projectId, Date.now()]
    )
    // Manual assignment overrides any app-level LLM verdict for this app.
    db.run(
      `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
       VALUES (?, '*', ?, 1, ?)
       ON CONFLICT(app_name, title_pattern) DO UPDATE SET
         project_id = excluded.project_id, updated_at = excluded.updated_at`,
      [row.app_name, projectId, Date.now()]
    )
  }
  onSegmentHandler?.()
}

/** Apply a rule/assignment to every matching unclassified activity (bulk). */
export function bulkAssign(appName: string, titlePatternStr: string, projectId: number): number {
  const rows = db.all<{ id: number; title: string }>(
    `SELECT id, title FROM app_activities WHERE is_deleted = 0 AND app_name = ? AND (project_id IS NULL OR is_manual = 0)`,
    [appName]
  )
  let n = 0
  for (const r of rows) {
    if (titlePattern(r.title ?? '').startsWith(titlePatternStr) || (r.title ?? '').includes(titlePatternStr)) {
      db.run('UPDATE app_activities SET project_id = ?, is_manual = 1 WHERE id = ?', [projectId, r.id])
      n++
    }
  }
  db.run(
    `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(app_name, title_pattern) DO UPDATE SET project_id = excluded.project_id, hits = hits + 1, updated_at = excluded.updated_at`,
    [appName, titlePatternStr, projectId, Date.now()]
  )
  return n
}
