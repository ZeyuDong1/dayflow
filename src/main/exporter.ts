import { dialog } from 'electron'
import fs from 'fs'
import { getCardsForDay } from './ai/analyze'
import { addDaysKey, formatDayLabel } from './paths'
import type { TimelineCard } from '../shared/types'

export async function exportMarkdown(startDay: string, endDay: string): Promise<{ ok: boolean; path?: string; message: string }> {
  const days: string[] = []
  let cursor = startDay
  let guard = 0
  while (cursor <= endDay && guard < 400) {
    days.push(cursor)
    cursor = addDaysKey(cursor, 1)
    guard++
  }

  const lines: string[] = []
  lines.push(`# Dayflow Timeline Export`)
  lines.push('')
  lines.push(`${formatDayLabel(startDay)} – ${formatDayLabel(endDay)}`)
  lines.push('')

  let any = false
  for (const day of days) {
    const cards = getCardsForDay(day).filter((c) => !c.isIdle)
    if (cards.length === 0) continue
    any = true
    lines.push(`## ${formatDayLabel(day)}`)
    lines.push('')
    let total = 0
    for (const c of cards) total += c.endTs - c.startTs
    lines.push(`> Tracked: ${Math.round(total / 60000)} min across ${cards.length} activities`)
    lines.push('')
    for (const c of cards) {
      lines.push(`### ${c.start} – ${c.end} · ${c.title}`)
      lines.push('')
      const meta: string[] = [`Category: **${c.category}**`]
      if (c.subcategory) meta.push(`Subcategory: ${c.subcategory}`)
      if (c.appSites?.primary) meta.push(`App: ${c.appSites.primary}${c.appSites.secondary ? `, ${c.appSites.secondary}` : ''}`)
      lines.push(meta.join(' · '))
      lines.push('')
      if (c.summary) {
        lines.push(c.summary)
        lines.push('')
      }
      if (c.detailedSummary) {
        lines.push('```')
        lines.push(c.detailedSummary.trim())
        lines.push('```')
        lines.push('')
      }
      if (c.distractions.length > 0) {
        lines.push(`Distractions: ${c.distractions.map((d) => `${d.startTime}–${d.endTime} ${d.title}`).join('; ')}`)
        lines.push('')
      }
    }
  }
  if (!any) {
    return { ok: false, message: 'No timeline activity found in that range.' }
  }

  const defaultName = `dayflow-${startDay}-to-${endDay}.md`
  const result = await dialog.showSaveDialog({
    title: 'Export timeline as Markdown',
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, message: 'Export cancelled.' }
  }
  fs.writeFileSync(result.filePath, lines.join('\n'), 'utf-8')
  return { ok: true, path: result.filePath, message: `Exported to ${result.filePath}` }
}

export function cardsToPlainText(cards: TimelineCard[]): string {
  return cards
    .map((c) => `${c.start}–${c.end} (${c.category}): ${c.title} — ${c.summary}`)
    .join('\n')
}
