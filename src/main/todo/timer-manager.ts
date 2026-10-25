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
  /** 硬到期的系统通知（P2 接 Electron Notification；测试注入 spy；reminder 软路径不调用） */
  notify?: (opts: { title: string; body: string; silent?: boolean }) => void
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

  // ---------- wait / training 倒计时 ----------

  scheduleWaitCompletion(taskId: number, delayMs: number): void {
    this.clearWaitTimeout(taskId)
    const handle = (this.deps.setTimeoutFn ?? setTimeout)(() => {
      this.waitTimers.delete(taskId)
      this.handleTimerExpiration(taskId)
    }, Math.max(0, delayMs))
    this.waitTimers.set(taskId, handle)
  }

  /** 挂起倒计时：先结算同任务 focus（防丢时长）；每任务 timer 行唯一。 */
  startWait(taskId: number, durationSeconds: number): void {
    const { db, tasks, broadcast } = this.deps
    for (const r of db.all<TimerRow>("SELECT * FROM timers WHERE task_id = ? AND type = 'focus'", [taskId])) {
      this.settleFocusTimer(r)
    }
    this.clearWaitTimeout(taskId)
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    const nowIso = this.nowIso()
    const target = new Date(this.deps.now() + durationSeconds * 1000).toISOString()
    db.run(
      "INSERT INTO timers (task_id, type, target_timestamp, original_duration, started_at) VALUES (?, 'wait', ?, ?, ?)",
      [taskId, target, durationSeconds, nowIso],
    )
    tasks.updateTask(taskId, { status: 'waiting' })
    this.scheduleWaitCompletion(taskId, durationSeconds * 1000)
    broadcast({ type: 'timer:update' })
  }

  /** 取消倒计时：training/reminder 整任务删除（有 GPU 先释放）；其余回 queued；archived 不动。 */
  cancelWait(taskId: number): void {
    const { db, tasks, gpus, broadcast } = this.deps
    this.clearWaitTimeout(taskId)
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    const task = tasks.getTask(taskId)
    if (!task) return
    if (task.type === 'training' || task.type === 'reminder') {
      if (task.gpu_id != null) gpus.setGpuIdle(task.gpu_id)
      tasks.deleteTask(taskId)
    } else if (task.status !== 'archived') {
      tasks.updateTask(taskId, { status: 'queued' })
    }
    broadcast({ type: 'timer:update' })
  }

  /** 贪睡：只改 target_timestamp（不改 original_duration），status 不变。 */
  snoozeTrainingReminder(taskId: number, minutes: number): void {
    const { db, now } = this.deps
    const row = db.get<TimerRow>('SELECT * FROM timers WHERE task_id = ?', [taskId])
    if (!row) return
    const target = new Date(now() + minutes * 60000).toISOString()
    db.run('UPDATE timers SET target_timestamp = ? WHERE id = ?', [target, row.id])
    this.scheduleWaitCompletion(taskId, minutes * 60000)
  }

  /** 训练计时：同 GPU 串行（被占先暂停旧任务）；启动前结算同任务 focus（防丢时长）。 */
  startTraining(taskId: number, gpuId: number, durationSeconds: number): void {
    const { db, tasks, gpus, broadcast } = this.deps
    const busy = db.get<{ id: number }>(
      "SELECT id FROM tasks WHERE gpu_id = ? AND status = 'active' AND type = 'training' LIMIT 1",
      [gpuId],
    )
    if (busy && busy.id !== taskId) this.pauseTraining(busy.id)
    for (const r of db.all<TimerRow>("SELECT * FROM timers WHERE task_id = ? AND type = 'focus'", [taskId])) {
      this.settleFocusTimer(r)
    }
    this.clearWaitTimeout(taskId)
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    const nowIso = this.nowIso()
    const target = new Date(this.deps.now() + durationSeconds * 1000).toISOString()
    db.run(
      "INSERT INTO timers (task_id, type, target_timestamp, original_duration, started_at) VALUES (?, 'training', ?, ?, ?)",
      [taskId, target, durationSeconds, nowIso],
    )
    gpus.setGpuBusy(gpuId)
    tasks.updateTask(taskId, { status: 'active', gpu_id: gpuId })
    this.scheduleWaitCompletion(taskId, durationSeconds * 1000)
    broadcast({ type: 'timer:update' })
  }

  /** 暂停训练：释放 GPU、删计时、回队列、清 gpu_id。 */
  pauseTraining(taskId: number): void {
    const { db, tasks, gpus, broadcast } = this.deps
    this.clearWaitTimeout(taskId)
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    const task = tasks.getTask(taskId)
    if (task) {
      if (task.gpu_id != null) gpus.setGpuIdle(task.gpu_id)
      tasks.updateTask(taskId, { status: 'queued', gpu_id: null })
    }
    broadcast({ type: 'timer:update' })
  }

  /** 停止训练：已完成/forceComplete → 归档并建跟进任务 `Process {原标题}`；否则回队列。 */
  stopTraining(taskId: number, forceComplete = false): void {
    const { db, tasks, gpus, broadcast, now } = this.deps
    const task = tasks.getTask(taskId)
    const row = db.get<TimerRow>('SELECT * FROM timers WHERE task_id = ?', [taskId])
    this.clearWaitTimeout(taskId)
    db.run('DELETE FROM timers WHERE task_id = ?', [taskId])
    if (!task) return
    if (task.gpu_id != null) gpus.setGpuIdle(task.gpu_id)
    const expired = row?.target_timestamp != null && Date.parse(row.target_timestamp) - now() <= 0
    if (forceComplete || expired) {
      tasks.updateTask(taskId, { status: 'archived' })
      tasks.createTask(`Process ${task.title}`, { projectId: task.project_id })
    } else {
      tasks.updateTask(taskId, { status: 'queued', gpu_id: null })
    }
    broadcast({ type: 'timer:update' })
  }

  /** 到期：不删行、不改 status；reminder 软路径无通知；其余发静音通知；一律广播 timer:ended。 */
  handleTimerExpiration(taskId: number): void {
    const { db, tasks, gpus, broadcast, notify } = this.deps
    this.clearWaitTimeout(taskId)
    const task = tasks.getTask(taskId)
    const row = db.get<TimerRow>('SELECT * FROM timers WHERE task_id = ?', [taskId])
    if (!task || !row) return // 审查重点#4：缺任务/缺行静默返回
    if (task.type === 'training' && task.gpu_id != null) gpus.setGpuIdle(task.gpu_id)
    if (task.type !== 'reminder') {
      notify?.({
        title: task.type === 'training' ? 'Training Complete' : 'Timer Finished',
        body: task.title,
        silent: true,
      })
    }
    broadcast({ type: 'timer:ended', taskId, task })
    broadcast({ type: 'timer:update' })
  }

  /** 清空全部内存 timeout（delete-all-tasks 前由 main 调用）。 */
  cancelAll(): void {
    for (const taskId of [...this.waitTimers.keys()]) this.clearWaitTimeout(taskId)
  }
}
