import { db } from './db'
import type { TaskActivity } from '../shared/types'

interface TaskRow {
  id: number
  start_ts: number
  end_ts: number | null
  title: string
  notes: string | null
  project_id: number | null
  billable: number
}

function rowToTask(r: TaskRow): TaskActivity {
  return {
    id: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    title: r.title,
    notes: r.notes ?? '',
    projectId: r.project_id,
    billable: r.billable === 1,
    running: r.end_ts === null
  }
}

export function listTasks(startTs: number, endTs: number): TaskActivity[] {
  return db
    .all<TaskRow>(
      `SELECT * FROM task_activities WHERE is_deleted = 0 AND start_ts < ? AND (end_ts IS NULL OR end_ts > ?)
       ORDER BY start_ts ASC`,
      [endTs, startTs]
    )
    .map(rowToTask)
}

export function startTask(title: string, projectId: number | null, billable: boolean): TaskActivity {
  // Close any running task first.
  db.run('UPDATE task_activities SET end_ts = ? WHERE end_ts IS NULL AND is_deleted = 0', [Date.now()])
  db.run(
    'INSERT INTO task_activities (start_ts, end_ts, title, notes, project_id, billable) VALUES (?, NULL, ?, ?, ?, ?)',
    [Date.now(), title, '', projectId, billable ? 1 : 0]
  )
  const id = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id
  return rowToTask(
    db.get<TaskRow>('SELECT * FROM task_activities WHERE id = ?', [id]) as TaskRow
  )
}

export function stopTask(): boolean {
  const running = db.get<{ id: number }>('SELECT id FROM task_activities WHERE end_ts IS NULL AND is_deleted = 0')
  if (!running) return false
  db.run('UPDATE task_activities SET end_ts = ? WHERE id = ?', [Date.now(), running.id])
  return true
}

export function getRunningTask(): TaskActivity | null {
  const row = db.get<TaskRow>('SELECT * FROM task_activities WHERE end_ts IS NULL AND is_deleted = 0')
  return row ? rowToTask(row) : null
}

export function createManualTask(
  startTs: number,
  endTs: number,
  title: string,
  projectId: number | null,
  billable: boolean
): void {
  db.run(
    'INSERT INTO task_activities (start_ts, end_ts, title, notes, project_id, billable) VALUES (?, ?, ?, ?, ?, ?)',
    [startTs, endTs, title, '', projectId, billable ? 1 : 0]
  )
}

export function deleteTask(id: number): void {
  db.run('UPDATE task_activities SET is_deleted = 1 WHERE id = ?', [id])
}
