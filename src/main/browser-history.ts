import fs from 'fs'
import os from 'os'
import path from 'path'
import initSqlJs from 'sql.js'
import { isBrowserApp } from './projects'

/**
 * Timing-style browser history lookup (its SEGBV2 parsed Safari/Edge
 * History.db). We copy each browser's history SQLite and resolve the current
 * page's URL by matching the live window title against the most recent
 * history entries. Incognito tabs never hit the history DB — they resolve to
 * nothing, which is exactly the privacy behavior we want.
 */

interface HistoryEntry {
  url: string
  title: string
  lastVisit: number // epoch ms
}

interface BrowserProfile {
  /** exe base names this profile belongs to */
  apps: string[]
  historyPath: string | null
  /** chromium visits are microseconds; firefox uses ms */
  kind: 'chromium' | 'firefox'
}

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const ROAMING = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}

function firefoxProfileDir(): string | null {
  // 各衍生浏览器的 profile 命名不一致(Zen 是「xxx.Default (release)」),
  // 名字启发式不可靠——直接取 places.sqlite mtime 最新的目录=最近在用的 profile。
  return newestHistoryIn(path.join(ROAMING, 'Mozilla', 'Firefox', 'Profiles'), 'places.sqlite')
}

/**
 * 在 profile 根目录下找"活跃"的 profile:遍历所有含目标历史库的子目录,
 * 取历史库 mtime 最新的那个(名字规则在衍生浏览器上各不相同,靠不住)。
 */
function newestHistoryIn(root: string, file: string): string | null {
  let best: { p: string; mt: number } | null = null
  try {
    for (const dir of fs.readdirSync(root)) {
      const cand = path.join(root, dir, file)
      try {
        if (!fs.existsSync(cand)) continue
        const mt = fs.statSync(cand).mtimeMs
        if (!best || mt > best.mt) best = { p: cand, mt }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return best?.p ?? null
}

function buildProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = []
  const chromium = (apps: string[], ...candidates: string[][]): void => {
    profiles.push({ apps, historyPath: firstExisting(candidates.flat()), kind: 'chromium' })
  }
  chromium(
    ['chrome'],
    [
      path.join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'History'),
      path.join(LOCAL, 'Google', 'Chrome', 'User Data', 'Profile 1', 'History')
    ]
  )
  chromium(
    ['msedge', 'edge'],
    [
      path.join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'History'),
      path.join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Profile 1', 'History')
    ]
  )
  chromium(['brave'], [
    path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'History')
  ])
  chromium(['vivaldi'], [path.join(LOCAL, 'Vivaldi', 'User Data', 'Default', 'History')])
  chromium(['opera'], [
    path.join(ROAMING, 'Opera Software', 'Opera Stable', 'History'),
    path.join(LOCAL, 'Opera Software', 'Opera Stable', 'History')
  ])
  // Zen Browser is a Firefox fork: pick its most recently used profile by history mtime.
  profiles.push({
    apps: ['zen'],
    historyPath: newestHistoryIn(path.join(ROAMING, 'zen', 'Profiles'), 'places.sqlite'),
    kind: 'firefox'
  })
  const ffDir = firefoxProfileDir()
  profiles.push({
    apps: ['firefox'],
    historyPath: ffDir ? path.join(ffDir, 'places.sqlite') : null,
    kind: 'firefox'
  })
  return profiles
}

const profiles = buildProfiles()

/** Refreshed snapshots: profile -> recent history entries. */
const snapshots = new Map<BrowserProfile, HistoryEntry[]>()
const snapshotAt = new Map<BrowserProfile, number>()
const REFRESH_MS = 60_000
const MAX_ENTRIES = 800

async function refreshSnapshot(profile: BrowserProfile): Promise<void> {
  if (!profile.historyPath) return
  const now = Date.now()
  if (now - (snapshotAt.get(profile) ?? 0) < REFRESH_MS && snapshots.has(profile)) return
  snapshotAt.set(profile, now)
  try {
    const tmp = path.join(os.tmpdir(), `dayflow-hist-${Math.random().toString(36).slice(2)}.db`)
    fs.copyFileSync(profile.historyPath, tmp)
    const SQL = await initSqlJs({
      locateFile: (f) => path.join(__dirname, '../../node_modules/sql.js/dist', f)
    })
    const db = new SQL.Database(fs.readFileSync(tmp))
    let rows: HistoryEntry[] = []
    if (profile.kind === 'chromium') {
      const stmt = db.prepare(
        `SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?`
      )
      stmt.bind([MAX_ENTRIES])
      while (stmt.step()) {
        const r = stmt.getAsObject() as { url: string; title: string; last_visit_time: number }
        rows.push({ url: r.url, title: r.title ?? '', lastVisit: r.last_visit_time / 1000 - 11644473600000 })
      }
      stmt.free()
    } else {
      const stmt = db.prepare(
        `SELECT url, title, last_visit_date / 1000 AS t FROM moz_places ORDER BY last_visit_date DESC LIMIT ?`
      )
      stmt.bind([MAX_ENTRIES])
      while (stmt.step()) {
        const r = stmt.getAsObject() as { url: string; title: string; t: number }
        rows.push({ url: r.url, title: r.title ?? '', lastVisit: Number(r.t) || 0 })
      }
      stmt.free()
    }
    db.close()
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort
    }
    snapshots.set(profile, rows)
  } catch {
    snapshots.set(profile, [])
  }
}

function profileFor(appName: string): BrowserProfile | null {
  if (!isBrowserApp(appName)) return null
  const exe = appName.toLowerCase().replace(/\.exe$/, '')
  return profiles.find((p) => p.apps.some((a) => exe === a || exe.startsWith(a))) ?? null
}

/** Resolve the URL of the current page from its window title. */
export async function lookupPageUrl(appName: string, title: string): Promise<string | null> {
  const profile = profileFor(appName)
  if (!profile || !profile.historyPath || !title) return null
  await refreshSnapshot(profile)
  const entries = snapshots.get(profile) ?? []
  const lower = title.toLowerCase()
  // Exact title match (most recent wins), then startsWith fallback.
  let best: HistoryEntry | null = null
  for (const e of entries) {
    if (!e.title) continue
    if (e.title.toLowerCase() === lower) {
      if (!best || e.lastVisit > best.lastVisit) best = e
    }
  }
  if (!best) {
    for (const e of entries) {
      if (e.title && (lower.startsWith(e.title.toLowerCase()) || e.title.toLowerCase().startsWith(lower))) {
        if (!best || e.lastVisit > best.lastVisit) best = e
      }
    }
  }
  if (!best) return null
  // Ignore internal browser pages.
  if (/^(about|chrome|edge|moz-extension|extension):/i.test(best.url)) return null
  return best.url
}

/** Domain for stats/rules (e.g. https://a.b.example.com/x -> example.com). */
export function domainOfUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.hostname.replace(/^www\./, '').split('.')
    if (parts.length <= 2) return u.hostname.replace(/^www\./, '')
    return parts.slice(-2).join('.')
  } catch {
    return null
  }
}
