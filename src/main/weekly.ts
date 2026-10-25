import { db } from './db'
import { listProjects } from './projects'
import { addDaysKey, dayStartTs, dayEndTs } from './paths'
import type { TimelineCard, WeeklyReview, CategorySlice, AppUsage } from '../shared/types'

/** Monday-based week containing dayKey. */
export function weekStartFor(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dow = (dt.getDay() + 6) % 7 // Monday = 0
  return addDaysKey(dayKey, -dow)
}

function cardMinutes(c: TimelineCard): number {
  return Math.max(0, (c.endTs - c.startTs) / 60000)
}

/** Projects are the single classification system. */
function projectColor(name: string): string {
  return listProjects().find((p) => p.title === name)?.color ?? '#b0a794'
}

/** Low-productivity projects (score <= 3, e.g. 网页浏览/娱乐消遣) count as distraction. */
function isLowProductivity(name: string): boolean {
  const p = listProjects().find((x) => x.title === name)
  if (p) return p.productivityScore <= 3
  return /distraction|娱乐|消遣|浏览|idle|空闲/i.test(name)
}

function isIdleName(name: string): boolean {
  return /idle|空闲/i.test(name)
}

function isDistractionCard(c: TimelineCard): boolean {
  if (c.isIdle) return false
  return isLowProductivity(c.category)
}

function isPersonalCard(c: TimelineCard): boolean {
  return /personal|个人/i.test(c.category)
}

export function buildWeeklyReview(weekStartKey: string): WeeklyReview {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysKey(weekStartKey, i))
  const startTs = dayStartTs(weekDays[0])
  const endTs = dayEndTs(weekDays[6])

  const rows = db.all<{
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
  }>(
    `SELECT * FROM timeline_cards WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ? ORDER BY start_ts ASC`,
    [endTs, startTs]
  )

  const cards: TimelineCard[] = rows.map((r) => {
    let meta: { distractions?: unknown[]; appSites?: { primary: string | null; secondary: string | null } | null } = {}
    try {
      meta = r.metadata ? JSON.parse(r.metadata) : {}
    } catch {
      meta = {}
    }
    return {
      id: r.id,
      batchId: r.batch_id,
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
      distractions: (meta.distractions ?? []) as TimelineCard['distractions'],
      appSites: meta.appSites ?? null,
      isIdle: r.category === 'Idle',
      screenshotCount: 0
    }
  })

  const activeCards = cards.filter((c) => !c.isIdle)

  // ---- Stats ----
  let totalMinutes = 0
  let distractionMinutes = 0
  let personalMinutes = 0
  let idleMinutes = 0
  const catMinutes = new Map<string, number>()
  const appMinutes = new Map<string, { minutes: number; category: string }>()

  for (const c of cards) {
    const min = cardMinutes(c)
    totalMinutes += min
    if (c.isIdle) {
      idleMinutes += min
      catMinutes.set('Idle', (catMinutes.get('Idle') ?? 0) + min)
      continue
    }
    const distract = isDistractionCard(c)
    if (distract) distractionMinutes += min
    if (isPersonalCard(c)) personalMinutes += min
    catMinutes.set(c.category, (catMinutes.get(c.category) ?? 0) + min)
    const app = c.appSites?.primary?.trim()
    const appKey = app && app.length > 0 ? app : inferAppFromCard(c)
    if (appKey) {
      const entry = appMinutes.get(appKey) ?? { minutes: 0, category: c.category }
      entry.minutes += min
      appMinutes.set(appKey, entry)
    }
  }

  const focusMinutes = Math.max(0, totalMinutes - distractionMinutes - idleMinutes - personalMinutes)

  // Longest focus streak: consecutive non-distraction, non-idle cards (gap < 5 min)
  let longestStreak = 0
  let currentStreak = 0
  let prevEnd = 0
  for (const c of activeCards) {
    const distract = isDistractionCard(c)
    const gapOk = prevEnd === 0 || c.startTs - prevEnd < 5 * 60_000
    if (!distract && !isPersonalCard(c) && gapOk) {
      currentStreak += cardMinutes(c)
    } else if (!distract && !isPersonalCard(c)) {
      currentStreak = cardMinutes(c)
    } else {
      currentStreak = 0
    }
    longestStreak = Math.max(longestStreak, currentStreak)
    prevEnd = c.endTs
  }

  const activeDays = new Set(activeCards.map((c) => c.day)).size

  const startMinutes = activeCards.map((c) => minutesOfDay(c.startTs)).sort((a, b) => a - b)
  const endMinutes = activeCards.map((c) => minutesOfDay(c.endTs)).sort((a, b) => a - b)
  const avgStart = startMinutes.length ? Math.round(startMinutes[Math.floor(startMinutes.length * 0.1)]) : null
  const avgEnd = endMinutes.length ? Math.round(endMinutes[Math.floor(endMinutes.length * 0.9)]) : null

  const catSlices: CategorySlice[] = [...catMinutes.entries()]
    .map(([name, minutes]) => ({
      name,
      colorHex: projectColor(name),
      minutes: Math.round(minutes)
    }))
    .sort((a, b) => b.minutes - a.minutes)

  const appUsage: AppUsage[] = [...appMinutes.entries()]
    .map(([app, v]) => ({
      app,
      minutes: Math.round(v.minutes),
      category: v.category,
      colorHex: projectColor(v.category)
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 12)

  // ---- Workflow grid: 7 days x 30-min slots over 4 AM..4 AM ----
  const workflow = weekDays.map((day, idx) => {
    const dayCards = cards.filter((c) => c.day === day)
    const cells = []
    for (let slot = 0; slot < 48; slot++) {
      const slotStart = slot * 30
      const slotEnd = slotStart + 30
      let best: { name: string; colorHex: string; minutes: number } | null = null
      const byCat = new Map<string, number>()
      for (const c of dayCards) {
        const cStart = minutesOfDay(c.startTs)
        const cEnd = cStart + cardMinutes(c)
        const overlap = Math.min(cEnd, slotEnd) - Math.max(cStart, slotStart)
        if (overlap > 0) {
          byCat.set(c.category, (byCat.get(c.category) ?? 0) + overlap)
        }
      }
      const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]
      if (top) {
        best = { name: top[0], colorHex: projectColor(top[0]), minutes: Math.round(top[1]) }
      }
      cells.push({
        minute: slotStart,
        categoryName: best?.name ?? null,
        colorHex: best?.colorHex ?? null,
        minutes: best?.minutes ?? 0
      })
    }
    return {
      day,
      dayLabel: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx],
      cells
    }
  })

  // ---- Focus heatmap: 7 days x 24 hours ----
  const heatmap = weekDays.map((day, idx) => {
    const dayCards = cards.filter((c) => c.day === day)
    const cells = []
    for (let h = 0; h < 24; h++) {
      const hourStart = h * 60
      const hourEnd = hourStart + 60
      let tracked = 0
      let distract = 0
      for (const c of dayCards) {
        const cStart = minutesOfDay(c.startTs)
        const cEnd = cStart + cardMinutes(c)
        const overlap = Math.min(cEnd, hourEnd) - Math.max(cStart, hourStart)
        if (overlap > 0) {
          tracked += overlap
          if (isDistractionCard(c)) distract += overlap
        }
      }
      cells.push({
        hour: h,
        focusRatio: tracked >= 5 ? 1 - distract / tracked : -1,
        minutes: Math.round(tracked)
      })
    }
    return {
      day,
      dayLabel: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx],
      cells
    }
  })

  // ---- Interaction graph: app -> app transitions across consecutive cards ----
  const transitions = new Map<string, number>()
  const nodeMinutes = new Map<string, number>()
  for (const c of activeCards) {
    const app = c.appSites?.primary?.trim() || inferAppFromCard(c)
    if (app) nodeMinutes.set(app, (nodeMinutes.get(app) ?? 0) + cardMinutes(c))
  }
  for (let i = 1; i < activeCards.length; i++) {
    const from = activeCards[i - 1].appSites?.primary?.trim() || inferAppFromCard(activeCards[i - 1])
    const to = activeCards[i].appSites?.primary?.trim() || inferAppFromCard(activeCards[i])
    if (from && to && from !== to) {
      const key = `${from}\u0000${to}`
      transitions.set(key, (transitions.get(key) ?? 0) + 1)
    }
  }
  const topApps = new Set(
    [...nodeMinutes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([app]) => app)
  )
  const interactions = {
    nodes: [...nodeMinutes.entries()]
      .filter(([app]) => topApps.has(app))
      .map(([app, minutes]) => ({ app, minutes: Math.round(minutes) }))
      .sort((a, b) => b.minutes - a.minutes),
    edges: [...transitions.entries()]
      .filter(([key]) => {
        const [from, to] = key.split('\u0000')
        return topApps.has(from) && topApps.has(to)
      })
      .map(([key, count]) => {
        const [from, to] = key.split('\u0000')
        return { from, to, count }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
  }

  return {
    weekStart: weekStartKey,
    weekEnd: weekDays[6],
    stats: {
      totalMinutes: Math.round(totalMinutes),
      focusMinutes: Math.round(focusMinutes),
      distractionMinutes: Math.round(distractionMinutes),
      idleMinutes: Math.round(idleMinutes),
      personalMinutes: Math.round(personalMinutes),
      topCategory: catSlices[0]?.name ?? null,
      topApp: appUsage[0]?.app ?? null,
      longestFocusStreakMin: Math.round(longestStreak),
      activeDays,
      avgStartMinute: avgStart,
      avgEndMinute: avgEnd
    },
    categories: catSlices,
    apps: appUsage,
    workflow,
    heatmap,
    interactions
  }
}

function minutesOfDay(ts: number): number {
  const d = new Date(ts)
  let min = d.getHours() * 60 + d.getMinutes()
  // Fold pre-4 AM into the previous day's tail (day runs 4 AM..4 AM)
  if (min < 240) min += 1440
  return min
}

function inferAppFromCard(c: TimelineCard): string {
  const m = c.detailedSummary.match(/\[(?:in|on)\s+([^\]]+)\]/i) ?? c.detailedSummary.match(/in\s+([A-Za-z][\w. +_-]{1,24})/)
  return m?.[1]?.trim() ?? 'Other'
}

// Also used by the Timeline page header stats.
export function buildDaySummary(day: string): {
  day: string
  totalMinutes: number
  focusMinutes: number
  distractionMinutes: number
  categories: CategorySlice[]
} {
  const rows = db.all<{ category: string; start_ts: number; end_ts: number; metadata: string | null }>(
    'SELECT category, start_ts, end_ts, metadata FROM timeline_cards WHERE day = ? AND is_deleted = 0',
    [day]
  )
  let total = 0
  let distraction = 0
  const catMinutes = new Map<string, number>()
  for (const r of rows) {
    const min = Math.max(0, (r.end_ts - r.start_ts) / 60000)
    total += min
    catMinutes.set(r.category, (catMinutes.get(r.category) ?? 0) + min)
    if (isIdleName(r.category)) continue
    if (/distraction/i.test(r.category)) distraction += min
  }
  const catSlices = [...catMinutes.entries()]
    .map(([name, minutes]) => ({
      name,
      colorHex: projectColor(name),
      minutes: Math.round(minutes)
    }))
    .sort((a, b) => b.minutes - a.minutes)
  const idleMin = catSlices.find((c) => isIdleName(c.name))?.minutes ?? 0
  return {
    day,
    totalMinutes: Math.round(total),
    focusMinutes: Math.round(Math.max(0, total - distraction - idleMin)),
    distractionMinutes: Math.round(distraction),
    categories: catSlices
  }
}
