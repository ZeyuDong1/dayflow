/**
 * AI 软提醒（语义规格 §3）：归一化、aiFeed（桌宠桥领取制）、软硬路由、promote/dismiss。
 * 硬提醒 = success/needs_input/review → 落库 🤖 notification 任务 + 弹窗信号；
 * 软卡 = failure/progress/info → 仅内存临时卡。两路都进 aiFeed。
 */
import type { TodoDB } from './db'
import type { TaskService } from './service'
import type { TaskRow } from '../../shared/todo-types'

export const AI_STATUS_WHITELIST = ['success', 'failure', 'needs_input', 'review', 'progress'] as const
export type AiStatus = (typeof AI_STATUS_WHITELIST)[number] | 'info'
export const HARD_REMINDER_STATUSES: readonly AiStatus[] = ['success', 'needs_input', 'review']

export interface NormalizedAiReminder {
  source: string
  title: string
  status: AiStatus
  detail?: string
  link?: string
  timestamp: number
}

/** 归一化（纯函数）。source/title String().trim() 后空即抛；status 白名单外归 info。 */
export function normalizeAiReminder(data: unknown, now: number): NormalizedAiReminder {
  const d = (data ?? {}) as Record<string, unknown>
  const source = d.source == null ? '' : String(d.source).trim()
  const title = d.title == null ? '' : String(d.title).trim()
  if (!source || !title) {
    throw new Error('ai reminder requires "source" and "title"')
  }
  const status: AiStatus = (AI_STATUS_WHITELIST as readonly string[]).includes(String(d.status))
    ? (d.status as AiStatus)
    : 'info'
  const out: NormalizedAiReminder = { source, title, status, timestamp: now }
  if (d.detail != null) out.detail = String(d.detail)
  if (typeof d.link === 'string') out.link = d.link
  const ts = d.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    out.timestamp = ts > 1e12 ? ts : ts * 1000
  }
  return out
}

export interface AiFeedEntry extends NormalizedAiReminder {
  id: string
  announced: boolean
}

export interface AiFeed {
  push(entry: NormalizedAiReminder): void
  /** 一次性领取未播报的提醒（旧→新），领取后置 announced，重启拉取不重复。 */
  drain(): (NormalizedAiReminder & { id: string })[]
  size(): number
}

export function createAiFeed(cap = 100): AiFeed {
  let seq = 0
  const entries: AiFeedEntry[] = []
  return {
    push(entry) {
      entries.push({ ...entry, id: `ai-${++seq}`, announced: false })
      while (entries.length > cap) entries.shift()
    },
    drain() {
      const out = entries.filter((e) => !e.announced).map((e) => ({ ...e }))
      for (const e of entries) e.announced = true
      return out
    },
    size: () => entries.length,
  }
}

export type AiBroadcast =
  | { type: 'ai:reminder'; reminder: NormalizedAiReminder & { id: string } }
  | { type: 'ai:reminder-dismissed'; source?: string; title?: string; force?: boolean; dismissed: number }
  | { type: 'timer:ended'; taskId: number; task: TaskRow | null }
  | { type: 'fetch-tasks' }

export interface AiReminderDeps {
  db: TodoDB
  tasks: TaskService
  broadcast: (event: AiBroadcast) => void
  now: () => number
}

/** 🤖 前缀硬提醒任务的标题编码：`🤖 {source} · {title}`（首个 ' · ' 分隔） */
export function formatAiTaskTitle(source: string, title: string): string {
  return `🤖 ${source} · ${title}`
}

export function parseAiTaskTitle(stored: string): { source: string; title: string } | null {
  if (!stored.startsWith('🤖 ')) return null
  const body = stored.slice('🤖 '.length)
  const sep = body.indexOf(' · ')
  if (sep < 0) return null
  return { source: body.slice(0, sep), title: body.slice(sep + 3) }
}

export class AiReminderService {
  readonly feed: AiFeed

  constructor(private deps: AiReminderDeps, feed?: AiFeed) {
    this.feed = feed ?? createAiFeed()
  }

  /** kind:"ai" 入口：软硬路由 + 一律进 aiFeed。硬提醒创建失败回退临时卡（不抛给调用方）。 */
  handle(data: unknown): NormalizedAiReminder {
    const reminder = normalizeAiReminder(data, this.deps.now())
    this.feed.push(reminder)
    if (HARD_REMINDER_STATUSES.includes(reminder.status)) {
      try {
        const memo = [reminder.detail, reminder.link].filter(Boolean).join('\n')
        const task = this.deps.tasks.createTask(formatAiTaskTitle(reminder.source, reminder.title), {
          type: 'notification',
          context_memo: memo || undefined,
          skipDedup: true,
        })
        this.deps.broadcast({ type: 'timer:ended', taskId: task.id, task })
        this.deps.broadcast({ type: 'fetch-tasks' })
        return reminder
      } catch {
        // 落库失败回退临时卡
      }
    }
    this.deps.broadcast({ type: 'ai:reminder', reminder: { ...reminder, id: `eph-${this.deps.now()}-${Math.random().toString(36).slice(2, 8)}` } })
    return reminder
  }

  /** 转为软提醒：建 reminder 任务 + 已过期 wait 行 → 出现在过期提醒横幅（不弹窗）。 */
  promote(source: string, title: string, detail?: string, link?: string): TaskRow {
    const memo = [detail, link].filter(Boolean).join('\n')
    const task = this.deps.tasks.createTask(formatAiTaskTitle(source, title), {
      type: 'reminder',
      context_memo: memo || undefined,
      skipDedup: true,
    })
    const nowIso = new Date(this.deps.now()).toISOString()
    const target = new Date(this.deps.now() - 1000).toISOString()
    this.deps.db.run('DELETE FROM timers WHERE task_id = ?', [task.id])
    this.deps.db.run(
      "INSERT INTO timers (task_id, type, target_timestamp, original_duration, started_at) VALUES (?, 'wait', ?, 0, ?)",
      [task.id, target, nowIso],
    )
    this.deps.db.run("UPDATE tasks SET status = 'waiting' WHERE id = ?", [task.id])
    this.deps.broadcast({ type: 'fetch-tasks' })
    return this.deps.tasks.getTask(task.id)!
  }

  /** kind:"ai-dismiss"：只删本集成自产的 🤖 任务；source/title 缺省=通配；删除不看 force。 */
  dismiss(input: { source?: string; title?: string; force?: boolean }): number {
    const { source, title } = input
    if (!source && !title) {
      throw new Error('ai-dismiss requires "source" and/or "title"')
    }
    let dismissed = 0
    const rows = this.deps.db.all<TaskRow>("SELECT * FROM tasks WHERE title LIKE '🤖 %'")
    for (const row of rows) {
      const parsed = parseAiTaskTitle(row.title)
      if (!parsed) continue
      if (source !== undefined && parsed.source !== source) continue
      if (title !== undefined && parsed.title !== title) continue
      this.deps.tasks.deleteTask(row.id)
      dismissed++
    }
    this.deps.broadcast({
      type: 'ai:reminder-dismissed',
      source,
      title,
      force: input.force === true,
      dismissed,
    })
    this.deps.broadcast({ type: 'fetch-tasks' })
    return dismissed
  }
}
