import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseCommand, type ParsedCommand } from '@shared/commands'
import { computeBangPriorities } from '@shared/priority'
import { buildTaskTree, type TaskNode } from '@shared/hierarchy'
import { getTimerDisplay } from '@shared/reminder-logic'
import type { TaskRow, TaskProject, TodoEvent } from '@shared/todo-types'

interface AiCard {
  id: string
  source: string
  title: string
  status: string
  detail?: string
  link?: string
  ts: number
}

interface GpuLite {
  id: number
  name: string
  activeTaskId: number | null
}

const TYPE_LABEL: Record<string, string> = {
  EMPTY: '—',
  MEMO: 'MEMO 备注',
  CREATE: 'CREATE 创建',
  FOCUS: 'FOCUS 专注',
  REMINDER: 'REMINDER 提醒',
  TRAINING: 'TRAINING 训练',
  COMPLETE: 'COMPLETE 完成',
  SUSPEND: 'SUSPEND 挂起',
}

const PICKER_PRESETS: [number, string][] = [
  [5, '5m'],
  [15, '15m'],
  [25, '25m'],
  [45, '45m'],
  [60, '1h'],
  [120, '2h'],
]

function parseSimpleTime(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*([smh]?)$/i)
  if (!match) return null
  const value = parseInt(match[1], 10)
  const unit = (match[2] || 'm').toLowerCase()
  if (unit === 'h') return value * 3600
  if (unit === 's') return value
  return value * 60
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

/** 标题里的 URL 渲染为可点击分段（http(s) 起、空白/CJK 标点终止） */
function linkifySegments(title: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = []
  const re = /https?:\/\/[^\s"'）】」»]+/g
  let last = 0
  for (const m of title.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ text: title.slice(last, idx) })
    let url = m[0]
    while (/[)\].,!?;:]$/.test(url)) url = url.slice(0, -1) // 剥尾部标点
    if (url.length > 8) out.push({ text: url, url })
    else out.push({ text: m[0] })
    last = idx + m[0].length
  }
  if (last < title.length) out.push({ text: title.slice(last) })
  return out
}

export default function SpotlightWindow() {
  // 独立小窗路由：body 透明（窗口只显示圆角卡片本体）
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [gpus, setGpus] = useState<GpuLite[]>([])
  const [input, setInput] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [cards, setCards] = useState<AiCard[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [gpuPick, setGpuPick] = useState<{ title: string; time: number; projectId: number | null; sub?: string } | null>(null)
  const [gpuIdx, setGpuIdx] = useState(0)
  const [confirmTask, setConfirmTask] = useState<TaskRow | null>(null)
  const [pickingProject, setPickingProject] = useState(false)
  const [resetFor, setResetFor] = useState<TaskRow | null>(null)
  const [resetValue, setResetValue] = useState('')
  const [pickerFor, setPickerFor] = useState<TaskRow | null>(null)
  const [pickerCustom, setPickerCustom] = useState('')
  const [contextFor, setContextFor] = useState<{ task: TaskRow; x: number; y: number } | null>(null)
  const [cursorId, setCursorId] = useState<number | null>(null)
  const [focusToday, setFocusToday] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [showReady, setShowReady] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    void window.dayflow.todo.getTasks().then(setTasks)
    void window.dayflow.todo.focusToday().then(setFocusToday)
  }, [])

  useEffect(() => {
    refresh()
    void window.dayflow.todo.listTaskProjects().then(setProjects)
    void window.dayflow.todo.getGpus().then((gs) => setGpus(gs as GpuLite[]))
    inputRef.current?.focus()
  }, [refresh])

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
          setCards((c) =>
            [
              { id: r.id, source: r.source, title: r.title, status: r.status, detail: r.detail, link: r.link, ts: Date.now() },
              ...c,
            ].slice(0, 20),
          )
        }
        if (e.type === 'ai:reminder-dismissed') {
          setCards((c) =>
            c.filter((card) => {
              if (e.id != null) return card.id !== e.id // 单卡删
              if (e.source != null && card.source !== e.source) return true
              if (e.title != null && card.title !== e.title) return true
              return e.force === true ? false : card.status === 'needs_input' || card.status === 'review'
            }),
          )
        }
      }),
    [refresh],
  )

  const parsed: ParsedCommand = useMemo(() => parseCommand(input), [input])
  const priorities = useMemo(() => computeBangPriorities(tasks), [tasks])

  // 建议列表（语义规格 §4.2：过滤 reminder/training；bang 稳定排序；空输入=next_action 前 10）
  const suggestions: TaskRow[] = useMemo(() => {
    const nonSpecial = tasks.filter((t) => t.status !== 'archived' && t.type !== 'reminder' && t.type !== 'training')
    const byCreatedDesc = [...nonSpecial].sort((a, b) => b.created_at.localeCompare(a.created_at))
    const byPrio = (list: TaskRow[]) =>
      [...list].sort((a, b) => (priorities.get(b.id) ?? 0) - (priorities.get(a.id) ?? 0))
    if (!input.trim()) {
      return nonSpecial.filter((t) => t.status === 'queued' && t.is_next_action === 1).slice(0, 10)
    }
    if (parsed.type === 'COMPLETE') {
      const q = (parsed.query ?? '').toLowerCase()
      return byPrio(byCreatedDesc.filter((t) => t.title.toLowerCase().includes(q)))
    }
    if (parsed.isSubtask && parsed.parentSearch) {
      const q = parsed.parentSearch.toLowerCase()
      return byPrio(
        tasks.filter((t) => t.type === 'standard' && t.status !== 'archived' && t.title.toLowerCase().includes(q)),
      )
    }
    const main = (parsed.main ?? '').toLowerCase()
    return byPrio(
      byCreatedDesc.filter(
        (t) =>
          t.title.toLowerCase().includes(main) ||
          (parsed.project
            ? (projects.find((p) => p.id === t.project_id)?.name.toLowerCase().includes(parsed.project.toLowerCase()) ??
              false)
            : false),
      ),
    )
  }, [input, parsed, tasks, projects, priorities])

  const tree: TaskNode<TaskRow>[] = useMemo(
    () => buildTaskTree(tasks.filter((t) => t.type !== 'training'), priorities),
    [tasks, priorities],
  )
  const flatRows = useMemo(() => {
    const out: TaskNode<TaskRow>[] = []
    const walk = (nodes: TaskNode<TaskRow>[]) => {
      for (const n of nodes) {
        out.push(n)
        if (!collapsed.has(n.task.id)) walk(n.children)
      }
    }
    walk(tree)
    return out
  }, [tree, collapsed])

  const activeTask = useMemo(
    () =>
      tasks.find((t) => t.status === 'active' && t.type === 'standard') ??
      tasks.find((t) => t.status === 'active' && t.timer_type === 'focus') ??
      null,
    [tasks],
  )
  const waitingRows = useMemo(() => tasks.filter((t) => t.type === 'standard' && t.status === 'waiting'), [tasks])
  const trainingChips = useMemo(
    () =>
      tasks
        .filter((t) => t.type === 'training' && t.status === 'waiting')
        .sort((a, b) => (a.target_timestamp ?? '').localeCompare(b.target_timestamp ?? ''))
        .slice(0, 3),
    [tasks],
  )
  const overdue = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.type === 'reminder' && t.status === 'waiting' && t.target_timestamp != null && Date.parse(t.target_timestamp) <= now,
      ),
    [tasks, now],
  )
  const readyList = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.type !== 'reminder' && t.status === 'waiting' && t.target_timestamp != null && Date.parse(t.target_timestamp) <= now,
      ),
    [tasks, now],
  )

  const exec = useCallback(
    async (p: ParsedCommand) => {
      const res = (await window.dayflow.todo.execCommand(p, {
        activeTaskId: activeTask?.id ?? null,
        highlightedId: highlightIdx >= 0 && highlightIdx < suggestions.length ? suggestions[highlightIdx].id : null,
        suggestionIds: suggestions.map((s) => s.id),
      })) as { kind: string; draft?: { title: string; time: number; projectId: number | null; sub?: string } }
      if (res.kind === 'need-gpu-pick' && res.draft) {
        setGpuPick(res.draft)
        setGpuIdx(0)
        return
      }
      setInput('')
      refresh()
      window.dayflow.todo.hideSpotlight()
    },
    [activeTask, highlightIdx, suggestions, refresh],
  )

  const requestComplete = useCallback((task: TaskRow) => {
    if (task.type === 'standard' && task.project_id == null) {
      setConfirmTask(task)
      setPickingProject(true)
    } else {
      setConfirmTask(task)
      setPickingProject(false)
    }
  }, [])

  const doComplete = useCallback(
    (projectId?: number) => {
      if (!confirmTask) return
      if (projectId != null) void window.dayflow.todo.updateTask(confirmTask.id, { project_id: projectId })
      window.dayflow.todo.completeTask(confirmTask.id)
      setConfirmTask(null)
      setPickingProject(false)
      refresh()
    },
    [confirmTask, refresh],
  )

  // 结构编辑：Tab 缩进（前一兄弟的子级）；Shift+Tab 反缩进（祖父下、插父的下一兄弟前、sort_order 取中点）
  const indent = (t: TaskRow, prevSibling: TaskRow | undefined) => {
    if (!prevSibling) return
    void window.dayflow.todo.updateTask(t.id, { parent_id: prevSibling.id }).then(refresh)
  }
  const outdent = (t: TaskRow) => {
    const parent = tasks.find((x) => x.id === t.parent_id)
    const grandparent = parent?.parent_id ?? null
    let sortOrder = t.sort_order
    if (parent) {
      // 插到父的下一个兄弟之前 → sort_order 取中点
      const uncles = tasks.filter((x) => x.parent_id === parent.parent_id && x.id !== parent.id)
      const nextUncle = uncles.filter((u) => u.sort_order > parent.sort_order).sort((a, b) => a.sort_order - b.sort_order)[0]
      sortOrder = nextUncle ? Math.round((parent.sort_order + nextUncle.sort_order) / 2) : parent.sort_order + 1
    }
    void window.dayflow.todo.updateTask(t.id, { parent_id: grandparent, sort_order: sortOrder }).then(refresh)
  }

  const onTreeKeyDown = (e: React.KeyboardEvent, node: TaskNode<TaskRow>) => {
    const t = node.task
    const siblings = flatRows.filter((r) => r.task.parent_id === t.parent_id)
    const sibIdx = siblings.findIndex((r) => r.task.id === t.id)
    if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        outdent(t) // 根任务 Shift+Tab 且空标题 = 删除
        if (!t.title.trim() && t.parent_id == null) void window.dayflow.todo.deleteTask(t.id).then(refresh)
      } else if (sibIdx > 0) {
        indent(t, siblings[sibIdx - 1].task)
      }
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && editingId == null) {
      e.preventDefault()
      void window.dayflow.todo.createTask('', { parentId: t.id, skipDedup: true }).then((row) => {
        setEditingId(row.id)
        setEditValue('')
        refresh()
      })
    } else if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      void window.dayflow.todo.createTask('', { parentId: t.parent_id, skipDedup: true }).then((row) => {
        setEditingId(row.id)
        setEditValue('')
        refresh()
      })
    } else if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      window.dayflow.todo.completeTask(t.id)
      refresh()
    } else if (e.ctrlKey && e.key === 'Backspace') {
      e.preventDefault()
      void window.dayflow.todo.deleteTask(t.id).then(refresh)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = flatRows.findIndex((r) => r.task.id === t.id)
      const next = flatRows[idx + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        setCursorId(next.task.id)
        const el = document.querySelector<HTMLElement>(`[data-row-id="${next.task.id}"] input`)
        el?.focus()
      }
    }
  }

  const commitEdit = (id: number) => {
    void window.dayflow.todo.updateTask(id, { title: editValue }).then(() => {
      setEditingId(null)
      refresh()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (pickerFor) {
      if (e.key === 'Escape') setPickerFor(null)
      return
    }
    if (contextFor) {
      if (e.key === 'Escape') setContextFor(null)
      return
    }
    if (gpuPick) {
      if (e.key === 'Escape') {
        setGpuPick(null)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setGpuIdx((i) => (i + 1) % Math.max(1, gpus.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setGpuIdx((i) => (i - 1 + gpus.length) % Math.max(1, gpus.length))
      } else if (e.key === 'Enter' && gpus[gpuIdx]) {
        e.preventDefault()
        void window.dayflow.todo.execGpuPick(gpuPick, gpus[gpuIdx].id).then(() => {
          setGpuPick(null)
          setInput('')
          refresh()
          window.dayflow.todo.hideSpotlight()
        })
      } else if (/^[1-9]$/.test(e.key) && gpus[parseInt(e.key, 10) - 1]) {
        e.preventDefault()
        void window.dayflow.todo.execGpuPick(gpuPick, gpus[parseInt(e.key, 10) - 1].id).then(() => {
          setGpuPick(null)
          setInput('')
          refresh()
          window.dayflow.todo.hideSpotlight()
        })
      }
      return
    }
    if (confirmTask) {
      if (e.key === 'Escape') {
        setConfirmTask(null)
        setPickingProject(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        doComplete()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      window.dayflow.todo.hideSpotlight()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => (suggestions.length === 0 ? -1 : (i + 1) % suggestions.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => (suggestions.length === 0 ? -1 : (i - 1 + suggestions.length) % suggestions.length))
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && editingId == null) {
      e.preventDefault()
      if (parsed.type === 'COMPLETE') {
        const target = highlightIdx >= 0 ? suggestions[highlightIdx] : suggestions[0]
        if (target) requestComplete(target)
      } else {
        void exec(parsed)
      }
    } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1
      if (suggestions[idx]) {
        e.preventDefault()
        if (parsed.type === 'COMPLETE') requestComplete(suggestions[idx])
        else {
          setHighlightIdx(idx)
          void exec(parsed)
        }
      }
    }
  }

  // 点外关闭倒计时面板/右键菜单
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (pickerFor && !(e.target as HTMLElement).closest('.sw-picker')) setPickerFor(null)
      if (contextFor && !(e.target as HTMLElement).closest('.sw-ctx')) setContextFor(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [pickerFor, contextFor])

  const openContextMenu = (e: React.MouseEvent, task: TaskRow) => {
    e.preventDefault()
    e.stopPropagation()
    setContextFor({ task, x: e.clientX, y: e.clientY })
  }

  return (
    <div className="sw-root" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="sw-inputbar">
        <span className="sw-search">🔍</span>
        <input
          ref={inputRef}
          className="sw-input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setHighlightIdx(-1)
          }}
          placeholder="输入任务... (! 切换, @ 挂起, + 提醒, % 训练, > 备注) · 下方可直接编辑任务树"
        />
        {input.trim() && (
          <span className="sw-chip">
            {TYPE_LABEL[parsed.type] ?? parsed.type} <b>↵ Enter</b>
          </span>
        )}
      </div>

      {gpuPick ? (
        <div className="sw-gpupick">
          <div className="sw-section-title">选择 GPU：{gpuPick.title}（{Math.round(gpuPick.time / 60)} 分钟）</div>
          {gpus.map((g, i) => (
            <div key={g.id} className={`sw-gpu-row ${i === gpuIdx ? 'hl' : ''}`}>
              <span>{g.name}</span>
              <span className="sw-dim">{g.activeTaskId != null ? `Busy: 任务 #${g.activeTaskId}` : 'Idle'}</span>
              <span className="sw-dim">^{i + 1}</span>
            </div>
          ))}
        </div>
      ) : confirmTask ? (
        <div className="sw-confirm">
          <div className="sw-section-title">
            {pickingProject ? `选择项目后完成：${confirmTask.title}` : `完成任务：${confirmTask.title}？`}
          </div>
          {pickingProject &&
            projects.map((p, i) => (
              <button key={p.id} className="sw-project-item" onClick={() => doComplete(p.id)}>
                {p.name} <span className="sw-dim">^{i + 1}</span>
              </button>
            ))}
          {!pickingProject && (
            <div className="sw-actions">
              <button className="sw-btn" onClick={() => doComplete()}>
                Complete (Enter)
              </button>
              <button className="sw-btn ghost" onClick={() => setConfirmTask(null)}>
                Cancel (Esc)
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {activeTask && (
            <div className="sw-active">
              <div className="sw-focus-card">
                <span className="sw-badge">FOCUS</span>
                {activeTask.project_id != null && (
                  <span className="sw-project-chip">
                    #{projects.find((p) => p.id === activeTask.project_id)?.name ?? ''}
                  </span>
                )}
                <span className="sw-focus-title">{activeTask.title}</span>
                <span className="sw-timer">{getTimerDisplay(activeTask, now)}</span>
              </div>
              {waitingRows.map((w) => (
                <div key={w.id} className="sw-wait-row" onClick={() => window.dayflow.todo.startFocus(w.id)} onContextMenu={(e) => openContextMenu(e, w)}>
                  <span>⏱ {w.title}</span>
                  <span className="sw-dim">{getTimerDisplay(w, now)}</span>
                </div>
              ))}
            </div>
          )}

          {trainingChips.length > 0 && (
            <div className="sw-train-row">
              {trainingChips.map((t) => (
                <span
                  key={t.id}
                  className="sw-train-chip"
                  title="单击取消倒计时 · 右键更多"
                  onClick={() => window.dayflow.todo.cancelWait(t.id)}
                  onContextMenu={(e) => openContextMenu(e, t)}
                >
                  {t.title} · {getTimerDisplay(t, now)}
                </span>
              ))}
            </div>
          )}

          {overdue.length > 0 && (
            <div className="sw-banner">
              {overdue.map((t) => (
                <div key={t.id} className="sw-banner-row">
                  <span className="sw-banner-title">⏰ {t.title}</span>
                  <span className="sw-actions">
                    <button className="sw-btn" onClick={() => setResetFor(t)}>
                      再提醒
                    </button>
                    <button
                      className="sw-btn"
                      onClick={() => {
                        window.dayflow.todo.startFocus(t.id)
                        refresh()
                      }}
                    >
                      ▶
                    </button>
                    <button
                      className="sw-btn"
                      onClick={() => {
                        void window.dayflow.todo.updateTask(t.id, { status: 'archived' }).then(() => {
                          window.dayflow.todo.cancelWait(t.id)
                          refresh()
                        })
                      }}
                    >
                      ✓
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {cards.length > 0 && (
            <div className="sw-cards">
              {cards.map((c) => (
                <div
                  key={c.id}
                  className="sw-card"
                  onClick={() => c.link && window.dayflow.todo.openExternal(c.link)}
                  style={{ cursor: c.link ? 'pointer' : 'default' }}
                >
                  <span className={`sw-pill st-${c.status}`}>
                    {c.status === 'success' ? '✓' : c.status === 'failure' ? '✕' : c.status === 'needs_input' ? '!' : c.status === 'review' ? '?' : c.status === 'progress' ? '⋯' : 'i'}
                  </span>
                  <span className="sw-card-text">
                    {c.source} · {c.title}
                  </span>
                  <span className="sw-dim">{relativeTime(c.ts, now)}</span>
                  <span className="sw-actions">
                    <button
                      className="sw-btn ghost"
                      title="转为软提醒"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.dayflow.todo.aiPromote(c.source, c.title, c.detail, c.link)
                        window.dayflow.todo.aiDismiss({ source: c.source, title: c.title })
                        setCards((cs) => cs.filter((x) => x.id !== c.id))
                        refresh()
                      }}
                    >
                      🔔
                    </button>
                    <button
                      className="sw-btn ghost"
                      title="忽略"
                      onClick={(e) => {
                        e.stopPropagation()
                        window.dayflow.todo.aiDismiss({ id: c.id })
                        setCards((cs) => cs.filter((x) => x.id !== c.id))
                      }}
                    >
                      ✓
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="sw-tree">
            {flatRows.map((node) => {
              const t = node.task
              const isCursor = cursorId === t.id
              const hasTimer = t.status === 'waiting' || t.target_timestamp != null
              return (
                <div
                  key={t.id}
                  data-row-id={t.id}
                  className={`sw-row ${isCursor ? 'cursor' : ''}`}
                  style={{ paddingLeft: 8 + node.depth * 18 }}
                  onKeyDown={(e) => onTreeKeyDown(e, node)}
                  onClick={() => setCursorId(t.id)}
                  onContextMenu={(e) => openContextMenu(e, t)}
                >
                  <span
                    className="sw-fold"
                    onClick={(e) => {
                      e.stopPropagation()
                      setCollapsed((s) => {
                        const n = new Set(s)
                        if (n.has(t.id)) n.delete(t.id)
                        else n.add(t.id)
                        return n
                      })
                    }}
                  >
                    {node.children.length > 0 ? (collapsed.has(t.id) ? '▸' : '▾') : '·'}
                  </span>
                  <button className="sw-icon" title="设为 Focus" onClick={(e) => { e.stopPropagation(); window.dayflow.todo.startFocus(t.id) }}>
                    ▶
                  </button>
                  <button
                    className={`sw-icon ${t.is_side_focus === 1 ? 'amber' : ''}`}
                    title="设为副 Focus"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.dayflow.todo.setSideFocus(t.id, t.is_side_focus !== 1).then(refresh)
                    }}
                  >
                    {t.is_side_focus === 1 ? '◎' : '○'}
                  </button>
                  {editingId === t.id ? (
                    <input
                      className="sw-edit"
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => editValue.trim() && commitEdit(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitEdit(t.id)
                        } else if (e.key === 'Backspace' && editValue === '') {
                          e.preventDefault()
                          if (t.parent_id != null) {
                            outdent(t) // 空标题 Backspace = 反缩进
                          } else {
                            void window.dayflow.todo.deleteTask(t.id).then(() => {
                              setEditingId(null)
                              refresh()
                            })
                          }
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="sw-title"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(t.id)
                        setEditValue(t.title)
                      }}
                    >
                      {t.title || '（草稿）'}
                    </span>
                  )}
                  {t.status === 'waiting' && <span className="sw-dim" title="倒计时中">⏳</span>}
                  {t.total_duration > 0 && <span className="sw-dim">{Math.round(t.total_duration / 60)}m</span>}
                  <span className="sw-row-ops">
                    <button
                      className={`sw-icon ${hasTimer ? 'amber' : ''}`}
                      title="倒计时"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPickerFor(t)
                        setPickerCustom('')
                      }}
                    >
                      ⏱
                    </button>
                    <button className="sw-icon" title="完成" onClick={(e) => { e.stopPropagation(); window.dayflow.todo.completeTask(t.id) }}>
                      ✓
                    </button>
                    <button
                      className="sw-icon"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.dayflow.todo.deleteTask(t.id).then(refresh)
                      }}
                    >
                      🗑
                    </button>
                  </span>
                  {pickerFor?.id === t.id && (
                    <div className="sw-picker" onClick={(e) => e.stopPropagation()}>
                      {hasTimer && <div className="sw-picker-remain">剩余 {getTimerDisplay(t, now)}</div>}
                      <div className="sw-picker-grid">
                        {PICKER_PRESETS.map(([m, label]) => (
                          <button
                            key={m}
                            className="sw-btn"
                            onClick={() => {
                              window.dayflow.todo.startWait(t.id, m * 60)
                              setPickerFor(null)
                              refresh()
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="sw-picker-custom">
                        <input
                          placeholder="分钟"
                          value={pickerCustom}
                          onChange={(e) => setPickerCustom(e.target.value.replace(/\D/g, ''))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && pickerCustom) {
                              window.dayflow.todo.startWait(t.id, parseInt(pickerCustom, 10) * 60)
                              setPickerFor(null)
                              refresh()
                            }
                          }}
                        />
                        <button
                          className="sw-btn"
                          onClick={() => {
                            if (pickerCustom) {
                              window.dayflow.todo.startWait(t.id, parseInt(pickerCustom, 10) * 60)
                              setPickerFor(null)
                              refresh()
                            }
                          }}
                        >
                          ✓
                        </button>
                        {hasTimer && (
                          <button
                            className="sw-btn danger"
                            onClick={() => {
                              window.dayflow.todo.cancelWait(t.id)
                              setPickerFor(null)
                              refresh()
                            }}
                          >
                            取消倒计时
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {suggestions.length > 0 && input.trim() && (
              <div className="sw-sugg">
                <div className="sw-section-title">建议</div>
                {suggestions.map((s, i) => (
                  <div
                    key={s.id}
                    className={`sw-sugg-row ${i === highlightIdx ? 'hl' : ''}`}
                    onClick={() => {
                      if (parsed.type === 'COMPLETE') requestComplete(s)
                      else {
                        setHighlightIdx(i)
                        void exec(parsed)
                      }
                    }}
                  >
                    <span className="sw-project-chip">
                      #{projects.find((p) => p.id === s.project_id)?.name ?? 'Inbox'}
                    </span>
                    <span>{s.title}</span>
                    {s.tag && <span className="sw-dim">#{s.tag}</span>}
                    {s.total_duration > 0 && <span className="sw-dim">{Math.round(s.total_duration / 60)}m</span>}
                    <span className="sw-dim">^{i + 1}</span>
                  </div>
                ))}
                {suggestions.length === 0 && <div className="sw-dim">无匹配，Enter 创建「{parsed.main}」</div>}
              </div>
            )}
            {input.trim() && suggestions.length === 0 && (
              <div className="sw-dim">No matches. Press Enter to create "{parsed.main}"</div>
            )}
          </div>

          {readyList.length > 0 && (
            <div className="sw-ready">
              {!showReady && (
                <button className="sw-btn" onClick={() => setShowReady(true)}>
                  Tasks Ready ({readyList.length})
                </button>
              )}
              {showReady && (
                <>
                  <div className="sw-section-title">倒计时已到期 · 处理或跳过</div>
                  {readyList.map((t) => (
                    <div key={t.id} className="sw-wait-row">
                      <span>{t.title}</span>
                      <span className="sw-actions">
                        <button
                          className="sw-btn"
                          onClick={() => {
                            if (t.type !== 'training') void window.dayflow.todo.updateTask(t.id, { status: 'archived' })
                            window.dayflow.todo.cancelWait(t.id)
                            refresh()
                          }}
                        >
                          Done
                        </button>
                        <button className="sw-btn ghost" onClick={() => setShowReady(false)}>
                          Skip
                        </button>
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}

      {resetFor && (
        <div className="sw-reset">
          <div className="sw-section-title">重新设定倒计时：{resetFor.title}</div>
          <div className="sw-actions">
            {[5, 20, 40].map((m) => (
              <button
                key={m}
                className="sw-btn"
                onClick={() => {
                  window.dayflow.todo.startWait(resetFor.id, m * 60)
                  setResetFor(null)
                  refresh()
                }}
              >
                +{m}m
              </button>
            ))}
            <input
              className="sw-edit"
              placeholder="30m, 1h, 45s ..."
              value={resetValue}
              onChange={(e) => setResetValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const secs = parseSimpleTime(resetValue)
                  if (secs != null) {
                    window.dayflow.todo.startWait(resetFor.id, secs)
                    setResetFor(null)
                    setResetValue('')
                    refresh()
                  }
                } else if (e.key === 'Escape') setResetFor(null)
              }}
            />
          </div>
        </div>
      )}

      {contextFor && (
        <div className="sw-ctx" style={{ left: contextFor.x, top: contextFor.y }} onClick={() => setContextFor(null)}>
          {contextFor.task.target_timestamp != null && (
            <>
              <button className="sw-ctx-item" onClick={() => { setResetFor(contextFor.task); setContextFor(null) }}>
                重新设定倒计时
              </button>
              <button
                className="sw-ctx-item"
                onClick={() => {
                  window.dayflow.todo.cancelWait(contextFor.task.id)
                  setContextFor(null)
                  refresh()
                }}
              >
                取消倒计时
              </button>
            </>
          )}
          <button
            className="sw-ctx-item"
            onClick={() => {
              window.dayflow.todo.completeTask(contextFor.task.id)
              setContextFor(null)
              refresh()
            }}
          >
            完成任务
          </button>
        </div>
      )}

      <div className="sw-footer">
        <span>Total Focus Today: {(focusToday / 3600).toFixed(1)}h</span>
        <span className="sw-dim">↑↓ Nav · Esc Hide</span>
        <span className="sw-dim">! 切换 / + 提醒 / % 训练 / &gt; 备注 / ↵ 子任务 / ⇧↵ 同级 / ⇥ 缩进 / ⌃↵ 完成 / ▶ Focus</span>
      </div>
    </div>
  )
}
