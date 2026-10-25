/**
 * 任务页（Dayflow 主窗口新增导航页）——承载 EpochToDo Dashboard 拆分出的功能：
 * Current Focus 大卡 / Paused-Waiting 网格 / 过期软提醒横幅 / Next Actions 队列（子任务缩进递归）/
 * 右侧栏（GPU 卡、AI 提醒、提醒倒计时）/ 轻量任务项目管理。
 *
 * 规格：docs/superpowers/specs/2026-10-25-epochtodo-feature-inventory.md §一/§八/§十三
 * 语义：docs/superpowers/specs/2026-10-25-epochtodo-semantics.md §1/§6
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { buildTaskTree, type TaskNode } from '@shared/hierarchy'
import { computeBangPriorities, countBangs } from '@shared/priority'
import { getTimerDisplay } from '@shared/reminder-logic'
import type { GpuRow, TaskProject, TaskRow, TodoEvent } from '@shared/todo-types'
import '../taskpage.css'

interface AiCard {
  id: string
  source: string
  title: string
  status: string
  detail?: string
  link?: string
}

interface GpuCard extends GpuRow {
  activeTaskId: number | null
}

/**
 * 主进程已注册 todo:create-gpu / todo:delete-gpu，但预载桥尚未暴露；
 * 这里以可选通道访问，缺失时按钮降级为提示，待预载补齐后即刻生效。
 */
interface GpuAdminBridge {
  createGpu?: (name: string) => Promise<GpuRow>
  deleteGpu?: (id: number) => Promise<void>
}

interface QueueGroup {
  projectId: number | null
  name: string
  color: string | null
  nodes: TaskNode<TaskRow>[]
}

/** 任务项目预设色（规格 §一「项目管理轻量化」）。 */
const PROJECT_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']

const NEUTRAL_COLOR = '#b9a58c'

const AI_GLYPH: Record<string, string> = {
  success: '✓',
  failure: '✕',
  needs_input: '!',
  review: '?',
  progress: '⋯'
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Current Focus 秒表恒为 HH:MM:SS。 */
function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
}

/** GPU 卡空闲时长：Idle: Xm / Xh。 */
function formatIdle(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}

export default function TaskPage(): React.ReactElement {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [gpus, setGpus] = useState<GpuCard[]>([])
  const [focusToday, setFocusToday] = useState(0)
  const [now, setNow] = useState<number>(() => Date.now())
  const [aiCards, setAiCards] = useState<AiCard[]>([])
  const [memo, setMemo] = useState('')
  const [status, setStatus] = useState('')

  // 弹层 / 弹窗状态
  const [completePicker, setCompletePicker] = useState<TaskRow | null>(null)
  const [pickerProjName, setPickerProjName] = useState('')
  const [reRemindFor, setReRemindFor] = useState<number | null>(null)
  const [countdownFor, setCountdownFor] = useState<number | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const [addingGpu, setAddingGpu] = useState(false)
  const [gpuName, setGpuName] = useState('')
  const [gpuAssign, setGpuAssign] = useState<Record<number, { taskId: number | ''; minutes: number }>>({})

  // 轻量项目管理
  const [showProjMgr, setShowProjMgr] = useState(false)
  const [newProj, setNewProj] = useState<{ name: string; color: string }>({ name: '', color: PROJECT_COLORS[0] })
  const [editProj, setEditProj] = useState<{ id: number; name: string } | null>(null)
  const [colorPickerFor, setColorPickerFor] = useState<number | null>(null)
  const [projDeleteId, setProjDeleteId] = useState<number | null>(null)

  const gpuAdmin = window.dayflow.todo as unknown as GpuAdminBridge

  // ---- 数据刷新 ----------------------------------------------------------

  const refresh = useCallback(() => {
    void window.dayflow.todo.getTasks().then(setTasks)
    void window.dayflow.todo.getGpus().then((gs) => setGpus(gs as GpuCard[]))
    void window.dayflow.todo.focusToday().then(setFocusToday)
  }, [])

  const refreshProjects = useCallback(() => {
    void window.dayflow.todo.listTaskProjects().then(setProjects)
  }, [])

  useEffect(() => {
    refresh()
    refreshProjects()
  }, [refresh, refreshProjects])

  // 界面计时文本本地每秒推算（timers 无 tick 广播）
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(
    () =>
      window.dayflow.todo.onEvent((e: TodoEvent) => {
        if (e.type === 'fetch-tasks' || e.type === 'timer:update') refresh()
        if (e.type === 'ai:reminder' && e.reminder) {
          const r = e.reminder
          setAiCards((c) =>
            [
              { id: r.id, source: r.source, title: r.title, status: r.status, detail: r.detail, link: r.link },
              ...c
            ].slice(0, 20)
          )
        }
        if (e.type === 'ai:reminder-dismissed') {
          setAiCards((c) =>
            c.filter((card) => {
              if (e.source != null && card.source !== e.source) return true
              if (e.title != null && card.title !== e.title) return true
              // 同回复：force 全清；否则保留 needs_input/review 行动卡
              return e.force === true ? false : card.status === 'needs_input' || card.status === 'review'
            })
          )
        }
      }),
    [refresh]
  )

  useEffect(() => {
    if (!status) return
    const t = window.setTimeout(() => setStatus(''), 4000)
    return () => window.clearTimeout(t)
  }, [status])

  // ---- 派生数据 ----------------------------------------------------------

  const projectById = useMemo(() => {
    const m = new Map<number, TaskProject>()
    for (const p of projects) m.set(p.id, p)
    return m
  }, [projects])

  const priorities = useMemo(() => computeBangPriorities(tasks), [tasks])

  const activeTask = useMemo(
    () =>
      tasks.find((t) => t.status === 'active' && t.type === 'standard') ??
      tasks.find((t) => t.status === 'active' && t.timer_type === 'focus') ??
      null,
    [tasks]
  )

  const activeParent = useMemo(
    () => (activeTask?.parent_id != null ? tasks.find((t) => t.id === activeTask.parent_id) ?? null : null),
    [tasks, activeTask]
  )

  const sideFocusTasks = useMemo(() => tasks.filter((t) => t.is_side_focus === 1 && t.status !== 'archived'), [tasks])

  const waitingStandard = useMemo(() => tasks.filter((t) => t.type === 'standard' && t.status === 'waiting'), [tasks])

  const overdueReminders = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.type === 'reminder' &&
          t.status === 'waiting' &&
          t.target_timestamp != null &&
          Date.parse(t.target_timestamp) <= now
      ),
    [tasks, now]
  )

  const reminderCountdowns = useMemo(
    () =>
      tasks
        .filter((t) => t.type === 'reminder' && t.status !== 'archived' && t.target_timestamp != null)
        .sort((a, b) => (a.target_timestamp ?? '').localeCompare(b.target_timestamp ?? '')),
    [tasks]
  )

  const trainingQueued = useMemo(
    () => tasks.filter((t) => t.type === 'training' && t.status === 'queued'),
    [tasks]
  )

  /** Current Focus 为子任务时其父从队列隐藏（§十三 Dashboard 队列语义）。 */
  const hiddenParentId = activeTask?.parent_id != null ? activeTask.parent_id : null

  const queueGroups = useMemo<QueueGroup[]>(() => {
    const rows = tasks.filter((t) => t.status === 'queued' && t.is_next_action === 1 && t.id !== hiddenParentId)
    const byProject = new Map<number | null, TaskRow[]>()
    for (const t of rows) {
      const list = byProject.get(t.project_id)
      if (list) list.push(t)
      else byProject.set(t.project_id, [t])
    }
    const groups: QueueGroup[] = []
    for (const [projectId, list] of byProject) {
      const p = projectId != null ? projectById.get(projectId) ?? null : null
      groups.push({
        projectId,
        name: p?.name ?? 'Inbox',
        color: p?.color ?? null,
        nodes: buildTaskTree(list, priorities)
      })
    }
    groups.sort((a, b) => {
      if (a.projectId == null) return -1
      if (b.projectId == null) return 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return groups
  }, [tasks, projectById, priorities, hiddenParentId])

  const projectColor = useCallback(
    (projectId: number | null): string =>
      projectId != null ? projectById.get(projectId)?.color ?? NEUTRAL_COLOR : NEUTRAL_COLOR,
    [projectById]
  )

  // ---- 动作 --------------------------------------------------------------

  const focusTask = useCallback(
    (id: number) => {
      window.dayflow.todo.startFocus(id)
      refresh()
    },
    [refresh]
  )

  /** 完成强制选项目：无项目的 standard 任务先选/新建项目（§一 三入口之任务页 Complete）。 */
  const requestComplete = useCallback(
    (task: TaskRow) => {
      if (task.type === 'standard' && task.project_id == null) {
        setCompletePicker(task)
        setPickerProjName('')
        return
      }
      window.dayflow.todo.completeTask(task.id)
      refresh()
    },
    [refresh]
  )

  const completeWithProject = useCallback(
    (projectId: number) => {
      if (!completePicker) return
      const id = completePicker.id
      void window.dayflow.todo.updateTask(id, { project_id: projectId }).then(() => {
        window.dayflow.todo.completeTask(id)
        setCompletePicker(null)
        refresh()
      })
    },
    [completePicker, refresh]
  )

  const createProjectAndComplete = useCallback(() => {
    const name = pickerProjName.trim()
    if (!completePicker || !name) return
    void window.dayflow.todo.createTaskProject(name, PROJECT_COLORS[0]).then((p) => completeWithProject(p.id))
  }, [completePicker, pickerProjName, completeWithProject])

  const submitMemo = useCallback(() => {
    const text = memo.trim()
    if (!activeTask || !text) return
    window.dayflow.todo.addMemo(activeTask.id, text)
    setMemo('')
    refresh()
  }, [memo, activeTask, refresh])

  const toggleSideFocus = useCallback(
    (task: TaskRow) => {
      void window.dayflow.todo.setSideFocus(task.id, task.is_side_focus !== 1).then((ok) => {
        if (!ok) setStatus('副焦点最多 2 个，请先取消一个')
        refresh()
      })
    },
    [refresh]
  )

  const deleteTaskNow = useCallback(
    (id: number) => {
      void window.dayflow.todo.deleteTask(id).then(() => {
        setDeleteConfirmId(null)
        refresh()
      })
    },
    [refresh]
  )

  const setCountdown = useCallback(
    (id: number, minutes: number) => {
      window.dayflow.todo.startWait(id, Math.round(minutes) * 60)
      setCountdownFor(null)
      refresh()
    },
    [refresh]
  )

  const reRemind = useCallback(
    (id: number, minutes: number) => {
      window.dayflow.todo.startWait(id, Math.round(minutes) * 60)
      setReRemindFor(null)
      refresh()
    },
    [refresh]
  )

  /** 横幅 ✓ 完成：归档 + 清倒计时（语义规格 §1.4）。 */
  const completeReminder = useCallback(
    (task: TaskRow) => {
      void window.dayflow.todo.updateTask(task.id, { status: 'archived' }).then(() => {
        window.dayflow.todo.cancelWait(task.id)
        refresh()
      })
    },
    [refresh]
  )

  const switchAndFocus = useCallback(
    (group: QueueGroup) => {
      const flat: TaskRow[] = []
      const walk = (nodes: TaskNode<TaskRow>[]): void => {
        for (const n of nodes) {
          flat.push(n.task)
          walk(n.children)
        }
      }
      walk(group.nodes)
      if (flat.length === 0) return
      let target = flat[0]
      for (const t of flat) {
        if (t.last_focused_at != null && (target.last_focused_at == null || t.last_focused_at > target.last_focused_at)) {
          target = t
        }
      }
      focusTask(target.id)
    },
    [focusTask]
  )

  // GPU
  const addGpu = useCallback(() => {
    const name = gpuName.trim()
    if (!name) return
    if (typeof gpuAdmin.createGpu !== 'function') {
      setStatus('预载桥未暴露 todo:create-gpu，暂时无法新建 GPU 卡')
      return
    }
    void gpuAdmin.createGpu(name).then(() => {
      setGpuName('')
      setAddingGpu(false)
      refresh()
    })
  }, [gpuName, gpuAdmin, refresh])

  const removeGpu = useCallback(
    (id: number) => {
      if (typeof gpuAdmin.deleteGpu !== 'function') {
        setStatus('预载桥未暴露 todo:delete-gpu，暂时无法删除 GPU 卡')
        return
      }
      void gpuAdmin.deleteGpu(id).then(refresh)
    },
    [gpuAdmin, refresh]
  )

  const setAssign = useCallback((gpuId: number, patch: Partial<{ taskId: number | ''; minutes: number }>) => {
    setGpuAssign((s) => ({
      ...s,
      [gpuId]: { taskId: s[gpuId]?.taskId ?? '', minutes: s[gpuId]?.minutes ?? 60, ...patch }
    }))
  }, [])

  const doAssign = useCallback(
    (gpuId: number) => {
      const sel = gpuAssign[gpuId]
      if (!sel || sel.taskId === '') return
      window.dayflow.todo.assignGpu(sel.taskId, gpuId, Math.max(1, Math.floor(sel.minutes)))
      setAssign(gpuId, { taskId: '' })
      refresh()
    },
    [gpuAssign, setAssign, refresh]
  )

  // AI 提醒卡
  const promoteAi = useCallback(
    (c: AiCard) => {
      void window.dayflow.todo.aiPromote(c.source, c.title, c.detail, c.link)
      window.dayflow.todo.aiDismiss({ source: c.source, title: c.title })
      setAiCards((cs) => cs.filter((x) => x.id !== c.id))
      refresh()
    },
    [refresh]
  )

  const dismissAi = useCallback((c: AiCard) => {
    window.dayflow.todo.aiDismiss({ source: c.source, title: c.title })
    setAiCards((cs) => cs.filter((x) => x.id !== c.id))
  }, [])

  // 任务项目管理
  const addProject = useCallback(() => {
    const name = newProj.name.trim()
    if (!name) return
    void window.dayflow.todo.createTaskProject(name, newProj.color).then(() => {
      setNewProj({ name: '', color: PROJECT_COLORS[0] })
      refreshProjects()
    })
  }, [newProj, refreshProjects])

  const renameProject = useCallback(
    (p: TaskProject, name: string) => {
      const v = name.trim()
      setEditProj(null)
      if (!v || v === p.name) return
      void window.dayflow.todo.updateTaskProject(p.id, { name: v }).then(refreshProjects)
    },
    [refreshProjects]
  )

  const recolorProject = useCallback(
    (p: TaskProject, color: string) => {
      void window.dayflow.todo.updateTaskProject(p.id, { color }).then(() => {
        setColorPickerFor(null)
        refreshProjects()
      })
    },
    [refreshProjects]
  )

  const removeProject = useCallback(
    (id: number) => {
      void window.dayflow.todo.deleteTaskProject(id).then(() => {
        setProjDeleteId(null)
        refreshProjects()
        refresh()
      })
    },
    [refreshProjects, refresh]
  )

  // ---- 渲染辅助 ----------------------------------------------------------

  const focusSeconds = activeTask
    ? (activeTask.total_duration ?? 0) +
      (activeTask.started_at != null ? Math.max(0, Math.floor((now - Date.parse(activeTask.started_at)) / 1000)) : 0)
    : 0

  const taskCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const t of tasks) {
      if (t.status === 'archived' || t.project_id == null) continue
      m.set(t.project_id, (m.get(t.project_id) ?? 0) + 1)
    }
    return m
  }, [tasks])

  const renderQueueRow = (node: TaskNode<TaskRow>, depth: number): React.ReactNode => {
    const t = node.task
    const bangs = countBangs(t.title)
    return (
      <React.Fragment key={t.id}>
        <div className="tp-q-row" style={{ marginLeft: depth * 20 }}>
          <span className="tp-q-title" title={t.title}>
            {t.title || '（无标题）'}
          </span>
          {bangs > 0 && <span className="tp-bang" title={`bang 优先级 ×${bangs}`}>{'!'.repeat(Math.min(bangs, 5))}</span>}
          {t.total_duration > 0 && <span className="tp-dim">{Math.max(1, Math.round(t.total_duration / 60))}m logged</span>}
          {t.tag && <span className="tp-tag">#{t.tag}</span>}
          <span className={`tp-ops ${deleteConfirmId === t.id || countdownFor === t.id ? 'always' : ''}`}>
            {deleteConfirmId === t.id ? (
              <>
                <span className="tp-dim">删除整棵子树？</span>
                <button className="tp-mini danger" onClick={() => deleteTaskNow(t.id)}>
                  删除
                </button>
                <button className="tp-mini ghost" onClick={() => setDeleteConfirmId(null)}>
                  取消
                </button>
              </>
            ) : countdownFor === t.id ? (
              <span className="tp-pop">
                {[5, 15, 25].map((m) => (
                  <button key={m} className="tp-mini" onClick={() => setCountdown(t.id, m)}>
                    +{m}m
                  </button>
                ))}
                <button className="tp-mini ghost" onClick={() => setCountdownFor(null)}>
                  取消
                </button>
              </span>
            ) : (
              <>
                <button className="tp-op-btn" title="开始专注" onClick={() => focusTask(t.id)}>
                  ▶
                </button>
                <button
                  className="tp-op-btn"
                  title={t.is_side_focus === 1 ? '取消副焦点' : '设为副焦点（最多 2 个）'}
                  onClick={() => toggleSideFocus(t)}
                >
                  {t.is_side_focus === 1 ? '◎' : '○'}
                </button>
                <button className="tp-op-btn" title="完成" onClick={() => requestComplete(t)}>
                  ✓
                </button>
                <button
                  className="tp-op-btn danger"
                  title="删除（递归删除子树）"
                  onClick={() => setDeleteConfirmId(t.id)}
                >
                  🗑
                </button>
                <button
                  className="tp-op-btn"
                  title="设倒计时（挂起等待）"
                  onClick={() => setCountdownFor(t.id)}
                >
                  ⏱
                </button>
              </>
            )}
          </span>
        </div>
        {node.children.map((c) => renderQueueRow(c, depth + 1))}
      </React.Fragment>
    )
  }

  // ---- 页面 --------------------------------------------------------------

  return (
    <div className="tp-root">
      <div className="tp-main">
        {/* 1. Current Focus 大卡 */}
        <div className="tp-focus-card">
          {activeTask ? (
            <>
              <div className="tp-focus-head">
                <span className="tp-focus-badge">CURRENT FOCUS</span>
                <span className="tp-proj-chip">
                  <span className="tp-dot" style={{ background: projectColor(activeTask.project_id) }} />
                  {activeTask.project_id != null ? projectById.get(activeTask.project_id)?.name ?? '项目' : 'Inbox'}
                </span>
                {activeParent && <span className="tp-subtask-hint">Subtask of {activeParent.title}</span>}
                <span className="tp-focus-today">今日专注 {(focusToday / 3600).toFixed(1)}h</span>
              </div>
              <div className="tp-focus-title">{activeTask.title}</div>
              <div className="tp-focus-timer">{formatHms(focusSeconds)}</div>
              <div className="tp-focus-actions">
                <button className="btn primary" onClick={() => requestComplete(activeTask)}>
                  Complete
                </button>
                <input
                  className="tp-memo-input"
                  value={memo}
                  placeholder="context memo，回车追加到当前专注任务"
                  onChange={(e) => setMemo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitMemo()
                    }
                  }}
                />
              </div>
              {sideFocusTasks.length > 0 && (
                <div className="tp-sidefocus-row">
                  <span className="tp-dim">副焦点 ◎</span>
                  {sideFocusTasks.map((s) => (
                    <span key={s.id} className="tp-side-chip" title="点击开始专注" onClick={() => focusTask(s.id)}>
                      ◎ {s.title}
                      <button
                        className="tp-x"
                        title="取消副焦点"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleSideFocus(s)
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="tp-focus-head">
                <span className="tp-focus-badge">CURRENT FOCUS</span>
                <span className="tp-focus-today">今日专注 {(focusToday / 3600).toFixed(1)}h</span>
              </div>
              <div className="tp-focus-empty">无活动任务 · 按 Alt+Space 开始专注</div>
            </>
          )}
        </div>

        {/* 2. Paused / Waiting 网格 */}
        <div className="tp-card">
          <div className="tp-sec-head">
            <h3 className="tp-sec-title">Paused / Waiting</h3>
            <span className="tp-dim">点击卡片 = 开始专注</span>
          </div>
          {waitingStandard.length === 0 ? (
            <div className="tp-empty">没有挂起中的标准任务</div>
          ) : (
            <div className="tp-wait-grid">
              {waitingStandard.map((t) => (
                <div key={t.id} className="tp-wait-card" title="点击开始专注" onClick={() => focusTask(t.id)}>
                  <span className="tp-wait-strip" style={{ background: projectColor(t.project_id) }} />
                  <span className="tp-wait-title">{t.title}</span>
                  <span className="tp-wait-timer">{getTimerDisplay(t, now)}</span>
                  {t.tag && <span className="tp-tag">#{t.tag}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3. 过期软提醒横幅 */}
        {overdueReminders.length > 0 && (
          <div className="tp-banner">
            <div className="tp-banner-title">⏰ 过期软提醒（{overdueReminders.length}）</div>
            {overdueReminders.map((t) => (
              <div key={t.id} className="tp-banner-row">
                <span className="tp-banner-name">{t.title}</span>
                <span className="tp-dim">已过期 {getTimerDisplay(t, now)}</span>
                <button
                  className="tp-mini"
                  onClick={() => setReRemindFor(reRemindFor === t.id ? null : t.id)}
                >
                  再提醒
                </button>
                {reRemindFor === t.id && (
                  <span className="tp-pop">
                    {[5, 20, 40].map((m) => (
                      <button key={m} className="tp-mini" onClick={() => reRemind(t.id, m)}>
                        +{m}m
                      </button>
                    ))}
                  </span>
                )}
                <button className="tp-mini" title="开始专注" onClick={() => focusTask(t.id)}>
                  ▶ 开始专注
                </button>
                <button className="tp-mini primary" onClick={() => completeReminder(t)}>
                  ✓ 完成
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 4. Next Actions 队列 */}
        <div className="tp-card">
          <div className="tp-sec-head">
            <h3 className="tp-sec-title">Next Actions</h3>
            <span className="tp-dim">按项目分组 · 子任务缩进 · bang 优先级排序</span>
          </div>
          {queueGroups.length === 0 ? (
            <div className="tp-empty">暂无 Next Action</div>
          ) : (
            queueGroups.map((g) => (
              <div key={g.projectId ?? 'inbox'} className="tp-q-group">
                <div className="tp-q-head">
                  <span className="tp-q-head-name">
                    <span className="tp-dot" style={{ background: g.color ?? NEUTRAL_COLOR }} />
                    {g.name}
                  </span>
                  <button className="tp-mini primary" onClick={() => switchAndFocus(g)}>
                    Switch &amp; Focus
                  </button>
                </div>
                {g.nodes.map((n) => renderQueueRow(n, 0))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 5. 右侧栏 */}
      <aside className="tp-side">
        {/* GPUs */}
        <div className="tp-card">
          <div className="tp-sec-head">
            <h3 className="tp-sec-title">GPUs</h3>
            <button className="tp-mini" title="新建 GPU 卡" onClick={() => setAddingGpu((v) => !v)}>
              ＋ 新建
            </button>
          </div>
          {addingGpu && (
            <div className="tp-gpu-assign" style={{ borderTop: 'none', paddingTop: 0, marginBottom: 8 }}>
              <input
                className="tp-inline-input"
                style={{ flex: '1 1 120px' }}
                autoFocus
                value={gpuName}
                placeholder="GPU / 配置名"
                onChange={(e) => setGpuName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addGpu()
                  } else if (e.key === 'Escape') setAddingGpu(false)
                }}
              />
              <button className="tp-mini primary" onClick={addGpu}>
                创建
              </button>
            </div>
          )}
          {gpus.length === 0 ? (
            <div className="tp-empty">暂无 GPU 卡</div>
          ) : (
            <div className="tp-gpu-list">
              {gpus.map((g) => {
                const busy = g.activeTaskId != null
                const webhook = tasks.some((t) => t.gpu_id === g.id && t.is_webhook === 1)
                const idleMs = g.last_active_at != null ? now - Date.parse(g.last_active_at) : null
                const sel = gpuAssign[g.id] ?? { taskId: '' as number | '', minutes: 60 }
                return (
                  <div key={g.id} className={`tp-gpu-card ${webhook ? 'tp-gpu-webhook' : ''}`}>
                    <button
                      className="tp-op-btn danger tp-gpu-del"
                      title={webhook ? '删除卡（webhook 关联任务将一并清理）' : '删除卡'}
                      onClick={() => removeGpu(g.id)}
                    >
                      🗑
                    </button>
                    <div className="tp-gpu-head">
                      <span className={`tp-dot ${busy ? 'busy' : 'idle'}`} />
                      <span className="tp-gpu-name" title={g.name}>
                        {g.name}
                      </span>
                      {webhook && <span className="tp-tag">webhook</span>}
                    </div>
                    <div className="tp-gpu-meta">
                      {g.host_id && <span title={g.host_id}>{g.host_id}</span>}
                      <span>
                        {busy
                          ? `Busy · 任务 #${g.activeTaskId}`
                          : idleMs != null
                            ? `Idle: ${formatIdle(idleMs)}`
                            : 'Idle'}
                      </span>
                    </div>
                    <div className="tp-gpu-assign">
                      <select
                        className="tp-select"
                        title="把排队中的训练任务分配到此卡"
                        value={sel.taskId === '' ? '' : String(sel.taskId)}
                        onChange={(e) =>
                          setAssign(g.id, { taskId: e.target.value ? Number(e.target.value) : '' })
                        }
                      >
                        <option value="">选择 queued 训练任务…</option>
                        {trainingQueued.map((t) => (
                          <option key={t.id} value={String(t.id)}>
                            {t.title}
                          </option>
                        ))}
                      </select>
                      <input
                        className="tp-num"
                        type="number"
                        min={1}
                        title="分配时长（分钟）"
                        value={sel.minutes}
                        onChange={(e) => setAssign(g.id, { minutes: Number(e.target.value) || 60 })}
                      />
                      <span className="tp-dim">分钟</span>
                      <button
                        className="tp-mini"
                        disabled={sel.taskId === ''}
                        onClick={() => doAssign(g.id)}
                      >
                        分配
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* AI Reminders */}
        <div className="tp-card">
          <div className="tp-sec-head">
            <h3 className="tp-sec-title">AI Reminders</h3>
            <span className="tp-dim">{aiCards.length}/20</span>
          </div>
          {aiCards.length === 0 ? (
            <div className="tp-empty">暂无 AI 提醒（webhook 推送后出现在这里）</div>
          ) : (
            <div className="tp-ai-list">
              {aiCards.map((c) => (
                <div key={c.id} className="tp-ai-card">
                  <span className={`tp-ai-dot st-${c.status}`} title={c.status}>
                    {AI_GLYPH[c.status] ?? 'i'}
                  </span>
                  <span className="tp-ai-body">
                    <div className="tp-ai-text" title={`${c.source} · ${c.title}`}>
                      {c.source} · {c.title}
                    </div>
                  </span>
                  <button className="tp-op-btn" title="转软提醒" onClick={() => promoteAi(c)}>
                    🔔
                  </button>
                  <button className="tp-op-btn" title="忽略" onClick={() => dismissAi(c)}>
                    ✓
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 提醒倒计时 */}
        <div className="tp-card">
          <div className="tp-sec-head">
            <h3 className="tp-sec-title">提醒</h3>
            <span className="tp-dim">✕ 取消倒计时</span>
          </div>
          {reminderCountdowns.length === 0 ? (
            <div className="tp-empty">暂无软提醒倒计时</div>
          ) : (
            reminderCountdowns.map((t) => (
              <div key={t.id} className="tp-rem-row">
                <span className="tp-rem-title" title={t.title}>
                  {t.title}
                </span>
                <span className="tp-rem-timer">{getTimerDisplay(t, now)}</span>
                <button
                  className="tp-op-btn danger"
                  title="取消倒计时（软提醒将删除）"
                  onClick={() => {
                    window.dayflow.todo.cancelWait(t.id)
                    refresh()
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 6. 轻量项目管理 */}
      <div className="tp-bottom">
        <div className="tp-proj-mgr">
          <button className="tp-proj-toggle" onClick={() => setShowProjMgr((v) => !v)}>
            <span>{showProjMgr ? '▾' : '▸'}</span> 任务项目管理
            <span className="tp-dim">（名称 / 颜色 / 删除，任务项目独立于类型树）</span>
          </button>
          {showProjMgr && (
            <div className="tp-proj-body">
              <div className="tp-proj-row">
                <span className="tp-swatch" style={{ background: newProj.color }} />
                <input
                  className="tp-inline-input"
                  style={{ flex: '1 1 140px' }}
                  value={newProj.name}
                  placeholder="新项目名称"
                  onChange={(e) => setNewProj((s) => ({ ...s, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addProject()
                    }
                  }}
                />
                <span className="tp-swatch-row">
                  {PROJECT_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`tp-swatch-btn ${newProj.color === c ? 'sel' : ''}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => setNewProj((s) => ({ ...s, color: c }))}
                    />
                  ))}
                </span>
                <button className="tp-mini primary" onClick={addProject}>
                  ＋ 新建
                </button>
              </div>
              {projects.length === 0 ? (
                <div className="tp-empty">还没有任务项目</div>
              ) : (
                projects.map((p) => (
                  <div key={p.id} className="tp-proj-row">
                    <span className="tp-swatch" style={{ background: p.color ?? NEUTRAL_COLOR }} />
                    {editProj?.id === p.id ? (
                      <input
                        className="tp-inline-input"
                        style={{ flex: '1 1 140px' }}
                        autoFocus
                        value={editProj.name}
                        onChange={(e) => setEditProj({ id: p.id, name: e.target.value })}
                        onBlur={() => renameProject(p, editProj.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            renameProject(p, editProj.name)
                          } else if (e.key === 'Escape') setEditProj(null)
                        }}
                      />
                    ) : (
                      <span className="tp-proj-name">{p.name}</span>
                    )}
                    <span className="tp-proj-count">{taskCounts.get(p.id) ?? 0} 个任务</span>
                    <button
                      className="tp-op-btn"
                      title="改名"
                      onClick={() => setEditProj({ id: p.id, name: p.name })}
                    >
                      ✎
                    </button>
                    <button
                      className="tp-op-btn"
                      title="换色"
                      onClick={() => setColorPickerFor(colorPickerFor === p.id ? null : p.id)}
                    >
                      🎨
                    </button>
                    {colorPickerFor === p.id && (
                      <span className="tp-swatch-row">
                        {PROJECT_COLORS.map((c) => (
                          <button
                            key={c}
                            className={`tp-swatch-btn ${p.color === c ? 'sel' : ''}`}
                            style={{ background: c }}
                            title={c}
                            onClick={() => recolorProject(p, c)}
                          />
                        ))}
                      </span>
                    )}
                    {projDeleteId === p.id ? (
                      <>
                        <button className="tp-mini danger" onClick={() => removeProject(p.id)}>
                          确认删除
                        </button>
                        <button className="tp-mini ghost" onClick={() => setProjDeleteId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="tp-op-btn danger"
                        title="删除项目（其下任务归入 Inbox）"
                        onClick={() => setProjDeleteId(p.id)}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tp-status">{status}</div>

      {/* 完成强制选项目弹窗（无项目的 standard 任务） */}
      {completePicker && (
        <div className="modal-backdrop" onClick={() => setCompletePicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>选择项目后完成</h2>
            <p className="modal-sub">
              「{completePicker.title || '（无标题）'}」是无项目的标准任务，完成前必须先选项目。
            </p>
            {projects.map((p) => (
              <button key={p.id} className="tp-proj-pick" onClick={() => completeWithProject(p.id)}>
                <span className="tp-swatch" style={{ background: p.color ?? NEUTRAL_COLOR }} />
                {p.name}
                <span className="tp-proj-count" style={{ marginLeft: 'auto' }}>
                  {taskCounts.get(p.id) ?? 0} 个任务
                </span>
              </button>
            ))}
            <div className="tp-picker-new">
              <input
                className="tp-inline-input"
                style={{ flex: '1 1 140px' }}
                autoFocus={projects.length === 0}
                value={pickerProjName}
                placeholder="新建项目名称"
                onChange={(e) => setPickerProjName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    createProjectAndComplete()
                  }
                }}
              />
              <button className="tp-mini primary" onClick={createProjectAndComplete}>
                创建并完成
              </button>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCompletePicker(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
