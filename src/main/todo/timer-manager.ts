/**
 * 计时引擎（语义规格 §2）：focus 秒表 / wait·training 倒计时 / 到期分流 / nag / GPU 健康检查。
 * 主进程无 tick 循环——focus 以 timers.started_at 为真值，前端本地推算；
 * wait/training 用内存 timeout 调度。所有广播经注入的 broadcast 外发（P2 接 IPC）。
 * 时钟与 timeout 均可注入，便于测试。
 */
import type { TodoDB } from './db'
import type { TaskService } from './service'
import type { GpuService } from './gpu-service'
import type { TodoSettings } from './settings'
import type { TaskRow, TimerRow } from '../../shared/todo-types'

export type TimerEvent =
  | { type: 'timer:update' }
  | { type: 'timer:ended'; taskId: number; task: TaskRow | null }
  | { type: 'timer:training-update'; status: unknown }
  | { type: 'fetch-tasks' }

export interface TimerDeps {
  db: TodoDB
  tasks: TaskService
  gpus: GpuService
  getSettings: () => TodoSettings
  broadcast: (event: TimerEvent) => void
  now: () => number
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

const FOCUS_MIN_ACCOUNTING_SECONDS = 180

export class TimerManager {
  private waitTimers = new Map<number, unknown>()

  constructor(private deps: TimerDeps) {}

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  private clearWaitTimeout(taskId: number): void {
    const handle = this.waitTimers.get(taskId)
    if (handle !== undefined) {
      ;(this.deps.clearTimeoutFn ?? clearTimeout)(handle as never)
      this.waitTimers.delete(taskId)
    }
  }

  // ---------- focus 秒表 ----------

  /** 开始专注：结算当前 → 排他清场 → 删本任务计时 → 插 focus 行 → active → 广播。 */
  startFocus(taskId: number): void {
    const { db, tasks, broadcast } = this.deps
    this.stopFocus()
    const nowIso = this.nowIso()
    // 排他清场：其他非 training 的 active 任务降级回队列
    db.run(
      `UPDATE tasks SET status = 'queued', last_focused_at = ? WHERE status = 'active' AND id != ? AND type != 'training'`,
      [nowIso, taskId],
    )
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    this.clearWaitTimeout(taskId)
    db.run("INSERT INTO timers (task_id, type, started_at) VALUES (?, 'focus', ?)", [taskId, nowIso])
    tasks.updateTask(taskId, { status: 'active' })
    broadcast({ type: 'timer:update' })
  }

  /** 结算一条 focus 计时：<180s 丢弃时长；≥180s 记账+写 history+祖先累加；最后删行。 */
  settleFocusTimer(focus: TimerRow): void {
    const { db, tasks, now } = this.deps
    const task = tasks.getTask(focus.task_id)
    if (task && focus.started_at == null) {
      // 已知瑕疵对齐：started_at 为 null 时只删行，不更新任务
      db.run('DELETE FROM timers WHERE id = ?', [focus.id])
      return
    }
    if (task) {
      const startMs = Date.parse(focus.started_at!)
      const elapsed = Math.max(0, Math.floor((now() - startMs) / 1000)) // 时钟回拨按 0
      if (elapsed >= FOCUS_MIN_ACCOUNTING_SECONDS) {
        this.accumulateDuration(task, elapsed)
        db.run('INSERT INTO history (task_id, title, type, start_time, end_time) VALUES (?, ?, ?, ?, ?)', [
          task.id,
          task.title,
          'focus',
          focus.started_at,
          this.nowIso(),
        ])
      }
      db.run("UPDATE tasks SET status = 'queued', last_focused_at = ? WHERE id = ?", [this.nowIso(), task.id])
    }
    db.run('DELETE FROM timers WHERE id = ?', [focus.id])
  }

  /** 结算所有 focus 计时（容忍重复行），并广播。 */
  stopFocus(): void {
    const rows = this.deps.db.all<TimerRow>("SELECT * FROM timers WHERE type = 'focus'")
    for (const r of rows) this.settleFocusTimer(r)
    this.deps.broadcast({ type: 'timer:update' })
  }

  /** 时长累加：自身 + 沿 parent_id 链全部祖先（防环）。 */
  private accumulateDuration(task: TaskRow, seconds: number): void {
    const { db } = this.deps
    const visited = new Set<number>()
    let cur: TaskRow | undefined = task
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id)
      db.run('UPDATE tasks SET total_duration = total_duration + ? WHERE id = ?', [seconds, cur.id])
      cur = cur.parent_id != null ? this.deps.tasks.getTask(cur.parent_id) : undefined
    }
  }
}
