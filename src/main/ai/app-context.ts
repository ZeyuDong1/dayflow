/**
 * 应用内全量上下文(零 LLM):导师聊天/反思用的"真实数据"摘要。
 * 长期记忆(ai-memory)+ AI 卡片之外,agent 还应能直接引用应用里的
 * 任务系统(任务树/进行中计时/专注历史/番茄余额)与原生活动明细
 * (按 类型×应用 聚合 + 最长样本),全部本地直查,不花 token。
 */
import { db } from '../db'
import { dayEndTs, dayStartTs } from '../paths'
import { getForegroundInfoSync } from '../foreground'
import { getInterruptState } from '../supervision'
import { TaskService } from '../todo/service'
import type { TaskRow } from '../../shared/todo-types'

const MAX_TASK_LINES = 40
const MAX_DIGEST_GROUPS = 18
const MAX_SAMPLE_TITLES = 8
const MAX_CONTEXT_CHARS = 12_000

function fmtMinutes(min: number): string {
  const m = Math.max(1, Math.round(min))
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
}

/** ISO 时间串 → "MM-DD HH:MM"(无效值原样返回)。 */
function fmtIso(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, 16)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 任务系统现状:进行中的计时、任务列表(非归档)、番茄余额、最近专注会话。 */
export function buildTaskContext(): string {
  const sections: string[] = []

  const svc = new TaskService(db)
  const tasks = svc.getAllTasks().filter((t) => t.status !== 'archived')
  const running = tasks.filter((t) => t.started_at)
  const rest = tasks
    .filter((t) => !t.started_at)
    .sort((a, b) => (b.status === 'active' ? 1 : 0) - (a.status === 'active' ? 1 : 0))

  const projectTitle = (id: number | null): string =>
    id != null ? (db.get<{ title: string }>('SELECT title FROM projects WHERE id = ?', [id])?.title ?? '') : ''

  const lines: string[] = []
  for (const t of running.slice(0, 3)) {
    lines.push(`- [计时中] ${t.title} — 从 ${fmtIso(t.started_at ?? '')} 起在计时`)
  }
  for (const t of rest.slice(0, MAX_TASK_LINES - lines.length)) {
    const bits: string[] = [`[${t.status === 'active' ? '进行中' : '待办'}]`]
    const proj = projectTitle(t.project_id)
    if (proj) bits.push(`类型:${proj}`)
    if (t.total_duration > 60) bits.push(`累计专注 ${fmtMinutes(t.total_duration / 60)}`)
    if (t.estimated_duration) bits.push(`预估 ${t.estimated_duration} 分钟`)
    if (t.context_memo) bits.push(`备注:${t.context_memo.slice(0, 80)}`)
    lines.push(`- ${bits.join(' | ')} ${t.title}`)
  }
  if (tasks.length === 0) lines.push('(任务列表为空)')
  else if (tasks.length > MAX_TASK_LINES) lines.push(`(仅显示前 ${MAX_TASK_LINES} 条,共 ${tasks.length} 条)`)
  sections.push(`任务列表:\n${lines.join('\n')}`)

  const st = getInterruptState()
  const breakBalance = st && typeof st.breakBalanceMinutes === 'number' ? (st.breakBalanceMinutes as number) : 0
  sections.push(`番茄休息余额:${breakBalance} 分钟`)

  const sessions = db.all<{ title: string; start_time: string; end_time: string }>(
    'SELECT title, start_time, end_time FROM history ORDER BY start_time DESC LIMIT 10'
  )
  if (sessions.length > 0) {
    const sl = sessions.map((h) => {
      const min = (new Date(h.end_time).getTime() - new Date(h.start_time).getTime()) / 60000
      return `- ${fmtIso(h.start_time)}–${fmtIso(h.end_time)} 《${h.title}》 ${fmtMinutes(min)}`
    })
    sections.push(`最近专注会话(新→旧):\n${sl.join('\n')}`)
  }

  return sections.join('\n\n')
}

/** 指定日期范围(4 点日界)的原生活动明细:按 类型×应用 聚合 + 占时最长的样本。 */
export function buildActivityDigest(days: string[]): string {
  const startDay = days[0]
  const endDay = days[days.length - 1]
  const startTs = dayStartTs(startDay)
  const endTs = dayEndTs(endDay)

  const rows = db.all<{ proj: string | null; app_name: string; ms: number; idle_ms: number }>(
    `SELECT pr.title AS proj, a.app_name,
            SUM(a.end_ts - a.start_ts) AS ms,
            SUM(CASE WHEN a.is_idle = 1 THEN a.end_ts - a.start_ts ELSE 0 END) AS idle_ms
     FROM app_activities a LEFT JOIN projects pr ON pr.id = a.project_id
     WHERE a.is_deleted = 0 AND a.start_ts < ? AND a.end_ts > ?
     GROUP BY a.project_id, a.app_name
     ORDER BY ms DESC
     LIMIT ?`,
    [endTs, startTs, MAX_DIGEST_GROUPS]
  )
  if (rows.length === 0) return `活动明细(${startDay} ~ ${endDay}):无记录`

  const totalMin = rows.reduce((a, r) => a + r.ms, 0) / 60000
  const idleMin = rows.reduce((a, r) => a + r.idle_ms, 0) / 60000
  const lines = rows.map((r) => {
    const min = r.ms / 60000
    const idle = r.idle_ms > 60_000 ? `(其中离开 ${fmtMinutes(r.idle_ms / 60000)})` : ''
    return `- ${r.proj ?? '未归类'} · ${r.app_name}:${fmtMinutes(min)}${idle}`
  })
  const samples = [
    ...new Set(
      db
        .all<{ title: string | null }>(
          `SELECT title FROM app_activities
           WHERE is_deleted = 0 AND is_idle = 0 AND title IS NOT NULL AND title != '' AND start_ts < ? AND end_ts > ?
           ORDER BY end_ts - start_ts DESC LIMIT ?`,
          [endTs, startTs, MAX_SAMPLE_TITLES]
        )
        .map((r) => (r.title ?? '').slice(0, 70))
    )
  ]
  const sampleLine = samples.length > 0 ? `\n占时最长的页面/窗口样本:\n${samples.map((s) => `- ${s}`).join('\n')}` : ''
  return (
    `活动明细(${startDay} ~ ${endDay},共 ${fmtMinutes(totalMin)}${idleMin > 1 ? `,离开 ${fmtMinutes(idleMin)}` : ''}):\n` +
    lines.join('\n') +
    sampleLine
  )
}

/** 聊天上下文用的应用内状态全量摘要(任务 + 当前前台 + 活动明细),超长截断。 */
export function buildAppContext(days: string[]): string {
  const fg = getForegroundInfoSync()
  const fgLine = fg ? `当前前台:${fg.appName} — ${fg.windowTitle.slice(0, 80)}` : '当前前台:(无法获取)'
  const body = [fgLine, buildTaskContext(), buildActivityDigest(days)].join('\n\n')
  return body.length > MAX_CONTEXT_CHARS ? `${body.slice(0, MAX_CONTEXT_CHARS)}\n(已截断)` : body
}

export type { TaskRow }
