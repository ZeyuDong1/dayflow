/**
 * 任务服务：CRUD、创建去重、备注追加、建议、递归删除。
 * 语义对齐语义规格 §1.3；纯 DB 层，不碰计时（计时在 TimerManager）。
 */
import type { TodoDB } from './db'
import type { TaskRow, TaskStatus, TaskType } from '../../shared/todo-types'

export interface CreateTaskOpts {
  tag?: string
  type?: TaskType
  projectId?: number | null
  parentId?: number | null
  skipDedup?: boolean
  status?: TaskStatus
  sort_order?: number
  is_next_action?: number
  is_webhook?: number
  estimated_duration?: number | null
  gpu_id?: number | null
  context_memo?: string
}

const FORBIDDEN_UPDATE_FIELDS = new Set(['started_at', 'target_timestamp', 'timer_type', 'is_webhook'])

export class TaskService {
  constructor(private db: TodoDB) {}

  /** 同名未归档去重（training 除外，可 skipDedup 跳过）；新建默认 queued/next_action/计时 0。 */
  createTask(title: string, opts: CreateTaskOpts = {}): TaskRow {
    const type: TaskType = opts.type ?? 'standard'
    if (type !== 'training' && !opts.skipDedup) {
      const existing = this.db.get<TaskRow>('SELECT * FROM tasks WHERE title = ? AND status != ? LIMIT 1', [
        title,
        'archived',
      ])
      if (existing) return existing
    }
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO tasks (title, status, type, context_memo, total_duration, estimated_duration, tag,
         project_id, parent_id, is_next_action, is_side_focus, sort_order, gpu_id, created_at, is_webhook)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        title,
        opts.status ?? 'queued',
        type,
        opts.context_memo ?? null,
        opts.estimated_duration ?? null,
        opts.tag ?? null,
        opts.projectId ?? null,
        opts.parentId ?? null,
        opts.is_next_action ?? 1,
        opts.sort_order ?? Date.now(),
        opts.gpu_id ?? null,
        now,
        opts.is_webhook ?? 0,
      ],
    )
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE created_at = ? AND title = ? ORDER BY id DESC LIMIT 1', [
      now,
      title,
    ])
    return row!
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id])
  }

  /** 全量任务 LEFT JOIN timers（虚拟字段 started_at/target_timestamp/timer_type），按 sort_order 升序。 */
  getAllTasks(): TaskRow[] {
    const rows = this.db.all<TaskRow>(
      `SELECT t.*, tm.started_at AS started_at, tm.target_timestamp AS target_timestamp, tm.type AS timer_type
       FROM tasks t LEFT JOIN timers tm ON tm.task_id = t.id
       ORDER BY t.sort_order ASC, t.id ASC`,
    )
    // 每任务一行 timer；历史脏数据出现重复行时优先保留信息更全的行
    const byTask = new Map<number, TaskRow>()
    for (const r of rows) {
      const prev = byTask.get(r.id)
      if (!prev) {
        byTask.set(r.id, r)
        continue
      }
      const richer =
        (r.started_at != null || r.target_timestamp != null) && prev.started_at == null && prev.target_timestamp == null
      if (richer) byTask.set(r.id, r)
    }
    return [...byTask.values()]
  }

  /** 禁改 started_at/target_timestamp/timer_type/is_webhook（静默忽略）。 */
  updateTask(id: number, updates: Partial<TaskRow>): TaskRow | null {
    const entries = Object.entries(updates).filter(([k, v]) => !FORBIDDEN_UPDATE_FIELDS.has(k) && v !== undefined)
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${k} = ?`).join(', ')
      this.db.run(`UPDATE tasks SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id])
    }
    return this.getTask(id) ?? null
  }

  /** 追加式备注：空则直写，否则换行拼接。 */
  appendMemo(id: number, content: string): void {
    const row = this.db.get<{ context_memo: string | null }>('SELECT context_memo FROM tasks WHERE id = ?', [id])
    if (!row) return
    const next = row.context_memo ? `${row.context_memo}\n${content}` : content
    this.db.run('UPDATE tasks SET context_memo = ? WHERE id = ?', [next, id])
  }

  /** queued 建议，可选估计时长上限（分钟），限 5 条。 */
  getSuggestions(maxDurationMinutes?: number): TaskRow[] {
    if (maxDurationMinutes != null) {
      return this.db.all<TaskRow>(
        `SELECT * FROM tasks WHERE status = 'queued' AND estimated_duration IS NOT NULL AND estimated_duration <= ?
         LIMIT 5`,
        [maxDurationMinutes],
      )
    }
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'queued' LIMIT 5")
  }

  /** 递归删除子树（防环）；history 故意保留（标题快照），timer 行一并清理。 */
  deleteTask(id: number): number[] {
    const doomed = this.collectSubtree(id)
    if (doomed.length === 0) return []
    const marks = doomed.map(() => '?').join(',')
    this.db.run(`DELETE FROM timers WHERE task_id IN (${marks})`, doomed)
    this.db.run(`DELETE FROM tasks WHERE id IN (${marks})`, doomed)
    return doomed
  }

  /** 清空 tasks + history（timer 行一并清理）；内存 timeout 由 TimerManager.cancelAll 负责。 */
  deleteAllTasks(): void {
    this.db.run('DELETE FROM timers')
    this.db.run('DELETE FROM history')
    this.db.run('DELETE FROM tasks')
  }

  /** 副焦点（◎，最多 2 个）：archived/active 的带旗任务不占额度；满员返回 false 不改动。 */
  setSideFocus(id: number, enabled: boolean): boolean {
    const task = this.getTask(id)
    if (!task) return false
    if (!enabled) {
      this.db.run('UPDATE tasks SET is_side_focus = 0 WHERE id = ?', [id])
      return true
    }
    const used = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE is_side_focus = 1 AND status NOT IN ('archived','active') AND id != ?`,
      [id],
    )
    if ((used?.n ?? 0) >= 2) return false
    this.db.run('UPDATE tasks SET is_side_focus = 1, side_focus_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ])
    return true
  }

  /** 晋升替补：有专注历史者优先（最近者先），无历史者按最早打旗（NULL 时间戳视为最老）。 */
  pickSideFocusPromotion(excludeId: number): number | null {
    const rows = this.db.all<{ id: number }>(
      `SELECT id FROM tasks
       WHERE is_side_focus = 1 AND status NOT IN ('archived','active') AND id != ?
       ORDER BY (last_focused_at IS NULL) ASC, last_focused_at DESC,
                (side_focus_at IS NULL) ASC, side_focus_at ASC
       LIMIT 1`,
      [excludeId],
    )
    return rows[0]?.id ?? null
  }

  private collectSubtree(id: number): number[] {
    const out: number[] = []
    const visited = new Set<number>()
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (visited.has(cur)) continue
      visited.add(cur)
      const exists = this.db.get<{ id: number }>('SELECT id FROM tasks WHERE id = ?', [cur])
      if (!exists) continue
      out.push(cur)
      for (const c of this.db.all<{ id: number }>('SELECT id FROM tasks WHERE parent_id = ?', [cur])) {
        stack.push(c.id)
      }
    }
    return out
  }
}
