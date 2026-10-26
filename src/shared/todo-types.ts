/** 任务域共享类型（主进程与渲染端共用）。 */

export type TaskType = 'standard' | 'reminder' | 'training' | 'notification'
export type TaskStatus = 'active' | 'waiting' | 'queued' | 'archived'
export type TimerKind = 'focus' | 'wait' | 'training'

export interface TaskRow {
  id: number
  title: string
  status: TaskStatus
  type: TaskType
  context_memo: string | null
  total_duration: number
  estimated_duration: number | null
  tag: string | null
  project_id: number | null
  parent_id: number | null
  is_next_action: number
  is_side_focus: number
  side_focus_at: string | null
  sort_order: number
  gpu_id: number | null
  last_focused_at: string | null
  created_at: string
  is_webhook: number
  md_file_path: string | null
  md_line_hash: string | null
  /** 联表派生（getAllTasks） */
  started_at?: string | null
  target_timestamp?: string | null
  timer_type?: TimerKind | null
}

export interface TimerRow {
  id: number
  task_id: number
  type: TimerKind
  target_timestamp: string | null
  original_duration: number | null
  started_at: string | null
}

export interface HistoryRow {
  id: number
  task_id: number | null
  title: string
  type: TimerKind
  start_time: string
  end_time: string
}

export interface TaskProject {
  id: number
  name: string
  color: string | null
  created_at: string
}

export interface GpuRow {
  id: number
  name: string
  host_id: string | null
  color: string | null
  created_at: string
  last_active_at: string | null
}

/** 主进程广播到渲染端的统一事件（channel: 'todo:event'） */
export interface TodoEvent {
  type:
    | 'timer:update'
    | 'timer:ended'
    | 'timer:training-update'
    | 'fetch-tasks'
    | 'ai:reminder'
    | 'ai:reminder-dismissed'
  taskId?: number
  task?: TaskRow | { id: number; title: string; context_memo: string | null; type: string } | null
  reminder?: {
    id: string
    source: string
    title: string
    status: string
    detail?: string
    link?: string
    timestamp: number
  }
  source?: string
  title?: string
  id?: string
  force?: boolean
  dismissed?: number
  status?: unknown
}
