import crypto from 'crypto'
import { BrowserWindow } from 'electron'
import { db } from '../db'
import { getCardsInRange } from './analyze'
import { chatStream, textComplete, type ChatTurn } from './providers'
import { buildTutorSystemPrompt, extractAndSaveMemo, stripMemoLine, buildGreeting } from './tutor'
import { gatherMemory } from '../memory/client'
import { addDaysKey, todayKey } from '../paths'
import type { ChatConversation, ChatMessage } from '../../shared/types'

const CONTEXT_DAYS_DEFAULT = 3
const MAX_CONTEXT_CHARS = 60_000

export function listConversations(): ChatConversation[] {
  return db.all<ChatConversation & { id: string }>(
    'SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM chat_conversations ORDER BY updated_at DESC LIMIT 50'
  )
}

export function createConversation(title: string): ChatConversation {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.run('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    title.slice(0, 80) || 'New chat',
    now,
    now
  ])
  // 导师开场白:先放占位(保证 sort_order=0),再异步换成结合记忆的个性化问候。
  db.run(
    'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, 'assistant', '在。今天想从哪开始?', now, 0]
  )
  void buildGreeting((p) => textComplete(p, 'tutor-greet'))
    .then((greeting) => {
      db.run('UPDATE chat_messages SET content = ? WHERE conversation_id = ? AND sort_order = 0', [greeting, id])
    })
    .catch(() => {})
  return { id, title: title.slice(0, 80) || 'New chat', createdAt: now, updatedAt: now }
}

export function deleteConversation(id: string): void {
  db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [id])
  db.run('DELETE FROM chat_conversations WHERE id = ?', [id])
}

export function getMessages(conversationId: string): ChatMessage[] {
  return db.all<ChatMessage & { id: number }>(
    'SELECT id, role, content, created_at AS "createdAt" FROM chat_messages WHERE conversation_id = ? ORDER BY sort_order ASC',
    [conversationId]
  )
}

/**
 * Figure out which days the question is about. Falls back to the last few days.
 */
function resolveContextDays(question: string, now = new Date()): string[] {
  const q = question.toLowerCase()
  const today = todayKey()
  const days = new Set<string>()

  if (/\byesterday\b|\byesterday's\b|昨天/.test(q)) {
    days.add(addDaysKey(today, -1))
  }
  if (/\btoday\b|今天/.test(q)) {
    days.add(today)
  }
  if (/\blast week\b|上(一|个)?周|past week/.test(q)) {
    for (let i = 1; i <= 7; i++) days.add(addDaysKey(today, -i))
  }
  if (/\bthis week\b|本周|这周/.test(q)) {
    for (let i = 0; i <= 6; i++) days.add(addDaysKey(today, -i))
  }
  if (/\blast month\b|上(个)?月/.test(q)) {
    for (let i = 1; i <= 30; i++) days.add(addDaysKey(today, -i))
  }

  // Explicit dates: "on 2026-10-20", "Oct 20", "10/20", "October 20"
  const iso = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) {
    const [y, m, d] = iso.slice(1).map(Number)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      days.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  const slash = q.match(/\b(\d{1,2})\/(\d{1,2})\b/)
  if (slash) {
    const m = parseInt(slash[1], 10)
    const d = parseInt(slash[2], 10)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const y = now.getFullYear()
      days.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'
  ]
  const monthAbbr = monthNames.map((mn) => mn.slice(0, 3))
  const named = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)
  if (named) {
    const m = monthAbbr.indexOf(named[1]) + 1
    const d = parseInt(named[2], 10)
    if (m > 0 && d >= 1 && d <= 31) {
      days.add(`${now.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }

  if (days.size === 0) {
    for (let i = 0; i < CONTEXT_DAYS_DEFAULT; i++) days.add(addDaysKey(today, -i))
  }
  return [...days].sort()
}

function buildTimelineContext(question: string): string {
  const days = resolveContextDays(question)
  const startDay = days[0]
  const endDay = days[days.length - 1]
  const [sy, sm, sd] = startDay.split('-').map(Number)
  const [ey, em, ed] = endDay.split('-').map(Number)
  const startTs = new Date(sy, sm - 1, sd, 4, 0, 0, 0).getTime()
  const endTs = new Date(ey, em - 1, ed + 1, 4, 0, 0, 0).getTime()

  const cards = getCardsInRange(startTs, endTs)
  if (cards.length === 0) {
    return `Timeline context: no recorded activity between ${startDay} and ${endDay}.`
  }

  const lines: string[] = [`Timeline context (${startDay} to ${endDay}), one line per activity card:`]
  let used = 0
  for (const c of cards) {
    const durationMin = Math.round((c.endTs - c.startTs) / 60000)
    const line = `- ${c.day} ${c.start}–${c.end} (${durationMin} min, ${c.category}${c.subcategory ? `/${c.subcategory}` : ''}): ${c.title} — ${c.summary}${c.appSites?.primary ? ` [app: ${c.appSites.primary}]` : ''}`
    if (used + line.length > MAX_CONTEXT_CHARS) {
      lines.push('(context truncated — older cards omitted)')
      break
    }
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

export interface ChatStreamHandlers {
  onToken: (delta: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
}

const activeStreams = new Map<string, AbortController>()

export function abortChat(conversationId: string): void {
  activeStreams.get(conversationId)?.abort()
}

export async function sendChat(
  win: BrowserWindow,
  conversationId: string,
  question: string,
  handlers: ChatStreamHandlers
): Promise<void> {
  const now = Date.now()
  const sortOrder = db.count('SELECT COUNT(*) AS c FROM chat_messages WHERE conversation_id = ?', [conversationId])

  db.run(
    'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
    [conversationId, 'user', question, now, sortOrder]
  )
  db.run('UPDATE chat_conversations SET updated_at = ? WHERE id = ?', [now, conversationId])
  if (sortOrder === 0) {
    db.run('UPDATE chat_conversations SET title = ? WHERE id = ?', [question.slice(0, 80), conversationId])
  }

  const history = db
    .all<{ role: string; content: string }>(
      'SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY sort_order ASC',
      [conversationId]
    )
    .slice(-24)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const timelineContext = buildTimelineContext(question)
  const contextTurn: ChatTurn = {
    role: 'user',
    content: `Here is my recorded timeline activity data for reference:\n\n${timelineContext}\n\nMy question: ${question}`
  }
  // Replace the raw question with the enriched one; the assistant's prior turns stay.
  const turns: ChatTurn[] = []
  for (let i = 0; i < history.length; i++) {
    if (i === history.length - 1 && history[i].role === 'user') {
      turns.push(contextTurn)
    } else {
      turns.push(history[i])
    }
  }

  const memory = await gatherMemory(question)
  const system = buildTutorSystemPrompt(
    memory,
    new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  )

  const controller = new AbortController()
  activeStreams.set(conversationId, controller)

  let full = ''
  try {
    await chatStream(
      system,
      turns,
      (delta) => {
        if (controller.signal.aborted) return
        full += delta
        handlers.onToken(delta)
      },
      undefined,
      controller.signal
    )
    if (!controller.signal.aborted) {
      // MEMO: 导师默默记住重要事实(写入长期记忆),用户不需要看到这行。
      void extractAndSaveMemo(full).catch(() => {})
      const clean = stripMemoLine(full)
      db.run(
        'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
        [conversationId, 'assistant', clean, Date.now(), sortOrder + 1]
      )
      db.run('UPDATE chat_conversations SET updated_at = ? WHERE id = ?', [Date.now(), conversationId])
      handlers.onDone(clean)
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      handlers.onError(err instanceof Error ? err.message : String(err))
    }
  } finally {
    activeStreams.delete(conversationId)
  }
}
