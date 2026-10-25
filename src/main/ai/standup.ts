import { db } from '../db'
import { getSettings, getCategories } from '../settings'
import { getCardsForDay } from './analyze'
import { textComplete, extractJsonObject, resolveProvider } from './providers'
import { buildStandupPrompt } from './prompts'
import { formatClock } from '../paths'
import type { DayPlan, StandupPayload } from '../../shared/types'

export function getStandup(day: string): StandupPayload | null {
  const row = db.get<{ payload_json: string }>(
    'SELECT payload_json FROM daily_standup_entries WHERE standup_day = ?',
    [day]
  )
  if (!row) return null
  try {
    return JSON.parse(row.payload_json) as StandupPayload
  } catch {
    return null
  }
}

export async function generateStandup(day: string): Promise<StandupPayload> {
  const settings = getSettings()
  const rt = resolveProvider(settings)
  if (!rt.ready) throw new Error('Configure an AI provider in Settings first.')

  const [y, m, d] = day.split('-').map(Number)
  const yesterdayDate = new Date(y, m - 1, d - 1)
  const yesterdayKey = toKey(yesterdayDate)

  const cards = getCardsForDay(yesterdayKey).filter((c) => !c.isIdle)
  const cardsText =
    cards.length > 0
      ? cards
          .map(
            (c) =>
              `- ${c.start}–${c.end} (${c.category}${c.subcategory ? ` / ${c.subcategory}` : ''}): ${c.title} — ${c.summary}`
          )
          .join('\n')
      : '(no recorded activity yesterday)'

  const categoriesText = getCategories()
    .map((c) => `- ${c.name}${c.details ? `: ${c.details}` : ''}`)
    .join('\n')

  const prompt = buildStandupPrompt(
    settings.general.userName,
    formatLongDate(new Date(y, m - 1, d)),
    formatLongDate(yesterdayDate),
    cardsText,
    categoriesText
  )

  const raw = await textComplete(prompt, 'standup')
  const parsed = extractJsonObject<{ highlights?: string[]; blockers?: string[]; summary?: string }>(raw)
  const payload: StandupPayload = {
    highlights: (parsed.highlights ?? []).filter((h) => typeof h === 'string').slice(0, 8),
    blockers: (parsed.blockers ?? []).filter((h) => typeof h === 'string').slice(0, 6),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    generatedAt: Date.now(),
    model: rt.model
  }
  db.run(
    `INSERT OR REPLACE INTO daily_standup_entries (standup_day, payload_json, created_at, updated_at)
     VALUES (?, ?, COALESCE((SELECT created_at FROM daily_standup_entries WHERE standup_day = ?), ?), ?)`,
    [day, JSON.stringify(payload), day, Date.now(), Date.now()]
  )
  return payload
}

function toKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// ---------------------------------------------------------------------------
// Day plans (today's priorities + blockers the user edits by hand)
// ---------------------------------------------------------------------------

export function getDayPlan(day: string): DayPlan {
  const row = db.get<{ priorities_json: string | null; blockers: string | null }>(
    'SELECT priorities_json, blockers FROM day_plans WHERE day = ?',
    [day]
  )
  let priorities: DayPlan['priorities'] = []
  if (row?.priorities_json) {
    try {
      priorities = JSON.parse(row.priorities_json)
    } catch {
      priorities = []
    }
  }
  return {
    day,
    priorities,
    blockers: row?.blockers ?? '',
    updatedAt: Date.now()
  }
}

export function saveDayPlan(plan: DayPlan): void {
  db.run(
    `INSERT OR REPLACE INTO day_plans (day, priorities_json, blockers, updated_at) VALUES (?, ?, ?, ?)`,
    [plan.day, JSON.stringify(plan.priorities), plan.blockers, Date.now()]
  )
}

export { formatClock }
