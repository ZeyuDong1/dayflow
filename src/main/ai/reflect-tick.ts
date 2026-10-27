import { db } from '../db'
import { getSettings } from '../settings'
import { textComplete, resolveProvider } from './providers'
import { runReflectionTick } from './tutor'

/**
 * 导师的"后台思考"调度器:
 * 按 tutor.reflectMinutes(默认 10 分钟,可自定义 1-240)把最近一段的
 * 活动/对话浓缩成一条反思,沉淀进 ai-memory。LLM 只在 tick 时调用,
 * 常驻监测不花 token。
 */

let timer: NodeJS.Timeout | null = null
let running = false

function collectRecentActivities(sinceTs: number): { appName: string; title: string; minutes: number }[] {
  const rows = db.all<{ app_name: string; title: string; ms: number }>(
    `SELECT app_name, title, SUM(end_ts - start_ts) AS ms FROM app_activities
     WHERE is_deleted = 0 AND is_idle = 0 AND start_ts >= ?
     GROUP BY app_name, title ORDER BY ms DESC LIMIT 12`,
    [sinceTs]
  )
  return rows.map((r) => ({ appName: r.app_name, title: r.title ?? '', minutes: r.ms / 60000 }))
}

function collectRecentChatExcerpt(): string {
  const rows = db.all<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT 6`,
    [Date.now() - 2 * 3600_000]
  )
  return rows
    .reverse()
    .map((r) => `${r.role === 'user' ? '用户' : '导师'}: ${r.content.slice(0, 120)}`)
    .join('\n')
}

async function tick(): Promise<boolean> {
  if (running) return false
  const settings = getSettings()
  if (!settings.tutor.enabled) return false
  if (!resolveProvider().ready) return false
  running = true
  let wrote = false
  try {
    const intervalMs = Math.min(240, Math.max(1, settings.tutor.reflectMinutes)) * 60_000
    const sinceTs = Date.now() - intervalMs
    const activities = collectRecentActivities(sinceTs)

    // 粗算专注/分心(效率分>=6 视为学习相关),供反思 prompt 参考
    const projectScore = new Map<number, number>()
    for (const p of db.all<{ id: number; productivity_score: number }>(
      'SELECT id, productivity_score FROM projects WHERE is_deleted = 0'
    )) {
      projectScore.set(p.id, p.productivity_score)
    }
    const rows = db.all<{ project_id: number | null; ms: number }>(
      `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
       WHERE is_deleted = 0 AND is_idle = 0 AND start_ts >= ? GROUP BY project_id`,
      [sinceTs]
    )
    let focusMs = 0
    let devMs = 0
    for (const r of rows) {
      const score = r.project_id !== null ? (projectScore.get(r.project_id) ?? 4) : 4
      if (score >= 6) focusMs += r.ms
      else if (score <= 3) devMs += r.ms
    }

    await runReflectionTick({
      recentActivities: activities,
      focusMinutes: focusMs / 60000,
      devMinutes: devMs / 60000,
      chatExcerpt: collectRecentChatExcerpt(),
      llmComplete: (prompt) => textComplete(prompt, 'tutor-reflect')
    }).then((note) => {
      wrote = !!note
    })
    console.log('[tutor] reflection tick done')
  } catch (err) {
    console.warn('[tutor] reflection tick failed:', err instanceof Error ? err.message : err)
  } finally {
    running = false
  }
  return wrote
}

export function startReflectionLoop(): void {
  stopReflectionLoop()
  const minutes = Math.min(240, Math.max(1, getSettings().tutor.reflectMinutes))
  timer = setInterval(() => void tick(), minutes * 60_000)
  console.log(`[tutor] reflection loop started (every ${minutes}min)`)
}

export function stopReflectionLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 设置变更后调用,重启计时器以应用新间隔。 */
export function restartReflectionLoop(): void {
  if (timer) startReflectionLoop()
}

/** 手动触发一次反思(设置页/对话页按钮)。 */
export async function reflectNow(): Promise<boolean> {
  return tick()
}
