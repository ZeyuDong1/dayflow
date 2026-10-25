/**
 * Spotlight Enter 执行语义（纯函数；逐分支对齐 EpochToDo Spotlight.tsx handleKeyDown 源码）。
 * 解析（parseCommand）在 commands.ts；本模块把 ParsedCommand + 上下文映射为领域调用序列。
 */
import type { ParsedCommand } from './commands'
import type { TaskRow } from '../../shared/todo-types'

export interface ExecGpu {
  id: number
  name: string
}

export interface ExecTaskProjectRef {
  id: number
  name: string
}

export interface ExecDomainOps {
  getTasks(): TaskRow[]
  listTaskProjects(): ExecTaskProjectRef[]
  getGpus(): ExecGpu[]
  createTask(
    title: string,
    opts: { type?: string; projectId?: number | null; parentId?: number | null; skipDedup?: boolean },
  ): TaskRow
  updateTask(id: number, updates: Partial<TaskRow>): TaskRow | null
  appendMemo(id: number, text: string): void
  startFocus(id: number): void
  startWait(id: number, seconds: number): void
  assignTaskToGpu(taskId: number, gpuId: number, minutes: number): void
}

export interface ExecCtx {
  activeTask: TaskRow | null
  /** 建议列表高亮项（-1 = 无）；以高亮任务传入 */
  highlighted: TaskRow | null
  /** 当前建议列表（parentSearch 模式即父候选） */
  suggestions: TaskRow[]
  domain: ExecDomainOps
}

export interface TrainingDraft {
  title: string
  time: number
  projectId: number | null
  sub?: string
}

export type ExecResult =
  | { kind: 'done'; taskId?: number }
  | { kind: 'need-gpu-pick'; draft: TrainingDraft }
  | { kind: 'noop'; reason?: string }

/** GPU 选择模式确认（源码 confirmGpuSelection）：建 training 任务 + 备忘 + 分配。 */
export function confirmGpuPick(ctx: ExecCtx, draft: TrainingDraft, gpuId: number): ExecResult {
  const task = ctx.domain.createTask(draft.title, {
    type: 'training',
    projectId: draft.projectId ?? undefined,
    skipDedup: true,
  })
  if (draft.sub) ctx.domain.appendMemo(task.id, `Context: ${draft.sub}`)
  ctx.domain.assignTaskToGpu(task.id, gpuId, Math.ceil(draft.time / 60))
  return { kind: 'done', taskId: task.id }
}

export function executeCommand(p: ParsedCommand, ctx: ExecCtx): ExecResult {
  const { domain, activeTask, highlighted, suggestions } = ctx

  // TRAINING 带时间无 GPU → 先进 GPU 选择模式（必须先于通用路径判断）
  if (p.type === 'TRAINING' && p.time != null && !p.gpu) {
    return {
      kind: 'need-gpu-pick',
      draft: {
        title: p.main || 'Training Task',
        time: p.time,
        projectId: resolveProjectId(p.project, domain) ?? null,
        sub: p.sub,
      },
    }
  }

  if (p.type === 'MEMO' && p.memo && activeTask) {
    domain.appendMemo(activeTask.id, p.memo)
    return { kind: 'done', taskId: activeTask.id }
  }

  if (p.type === 'SUSPEND' && p.time != null && activeTask) {
    domain.startWait(activeTask.id, p.time)
    return { kind: 'done', taskId: activeTask.id }
  }

  if (p.type === 'SUSPEND' && p.time != null && !activeTask) {
    const reminderTask = domain.createTask('提醒', { type: 'reminder' })
    domain.startWait(reminderTask.id, p.time)
    return { kind: 'done', taskId: reminderTask.id }
  }

  if (p.type === 'FOCUS' || p.type === 'CREATE' || p.type === 'REMINDER' || p.type === 'TRAINING') {
    const title = p.main || (p.type === 'REMINDER' ? '提醒' : '')
    let projectId: number | undefined = resolveProjectId(p.project, domain)

    // 子任务父级解析
    let parentTaskId: number | undefined
    if (p.isSubtask) {
      if (p.parentSearch) {
        // 父搜索模式：父 = 高亮建议（无高亮取第 1 条），项目继承父
        const parent = highlighted ?? suggestions[0] ?? null
        if (parent) {
          parentTaskId = parent.id
          if (projectId === undefined && parent.project_id != null) projectId = parent.project_id
        }
      } else if (activeTask) {
        // 同级语义：活动任务是子 → 建兄弟；是根 → 建子
        parentTaskId = activeTask.parent_id ?? activeTask.id
        if (projectId === undefined) {
          const parentRow = activeTask.parent_id != null
            ? domain.getTasks().find((t) => t.id === activeTask.parent_id)
            : undefined
          projectId = parentRow?.project_id ?? activeTask.project_id ?? undefined
          if (projectId == null) projectId = undefined
        }
      }
    }

    // 目标解析（仅非父搜索模式）
    const isParentSearchMode = Boolean(p.isSubtask && p.parentSearch)
    let targetTask: TaskRow | undefined
    if (!isParentSearchMode) {
      if (highlighted && p.type === 'FOCUS') {
        targetTask = highlighted
      } else if (title) {
        targetTask = domain
          .getTasks()
          .find(
            (t) =>
              t.title.toLowerCase() === title.toLowerCase() &&
              (projectId !== undefined ? t.project_id === projectId : true) &&
              t.status !== 'archived',
          )
      }
    }

    if (!targetTask) {
      if (!title) return { kind: 'noop', reason: 'empty-title' }
      const type = p.type === 'REMINDER' ? 'reminder' : p.type === 'TRAINING' ? 'training' : 'standard'
      targetTask = domain.createTask(title, {
        type,
        projectId: projectId ?? undefined,
        parentId: parentTaskId,
      })
      domain.updateTask(targetTask.id, { is_next_action: 1 })
    } else {
      if (projectId !== undefined) domain.updateTask(targetTask.id, { project_id: projectId })
      domain.updateTask(targetTask.id, { is_next_action: 1 })
    }

    if (p.sub) domain.appendMemo(targetTask.id, `Context: ${p.sub}`)

    if (p.type === 'FOCUS') {
      if (p.time != null && activeTask) {
        // 切换+挂起：先挂旧（结算不丢时长）再专注新（审查重点#1）
        domain.startWait(activeTask.id, p.time)
        domain.startFocus(targetTask.id)
      } else if (p.time != null) {
        domain.startWait(targetTask.id, p.time)
      } else {
        domain.startFocus(targetTask.id)
      }
    } else if (p.type === 'CREATE') {
      // 仅创建入队
    } else if (p.gpu) {
      const gpuCandidate = domain.getGpus().find((g) => g.name.toLowerCase().includes(p.gpu!.toLowerCase()))
      if (gpuCandidate) {
        domain.assignTaskToGpu(targetTask.id, gpuCandidate.id, p.time != null ? Math.ceil(p.time / 60) : 60)
      } else {
        // GPU 不中：仅警告，任务留队列（审查重点#4）
        console.warn(`GPU not found: ${p.gpu}`)
      }
    } else {
      // REMINDER 或 TRAINING（入队路径）
      if (p.type === 'REMINDER') {
        domain.startWait(targetTask.id, p.time ?? 1800)
      } else if (p.time != null) {
        domain.startWait(targetTask.id, p.time)
      }
    }
    return { kind: 'done', taskId: targetTask.id }
  }

  return { kind: 'noop', reason: 'unhandled' }
}

function resolveProjectId(name: string | undefined, domain: ExecDomainOps): number | undefined {
  if (!name) return undefined
  const found = domain.listTaskProjects().find((pr) => pr.name.toLowerCase().includes(name.toLowerCase()))
  return found?.id
}

/** 空白标题草稿清理（Spotlight 隐藏时）：只删 title 空白且非 active/archived（审查重点#5）。 */
export function cleanupDraftTasks(tasks: Pick<TaskRow, 'id' | 'title' | 'status'>[], deleteTask: (id: number) => void): void {
  for (const t of tasks) {
    if (!t.title.trim() && t.status !== 'active' && t.status !== 'archived') deleteTask(t.id)
  }
}
