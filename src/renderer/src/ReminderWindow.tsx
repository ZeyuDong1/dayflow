import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  resolveReminderAction,
  defaultSnoozeMinutes,
  getTimerDisplay,
  type ReminderAction,
} from '@shared/reminder-logic'
import type { TaskProject, TodoEvent } from '@shared/todo-types'

interface ReminderItem {
  id: number
  title: string
  taskType: string
  hasProject: boolean
  contextMemo: string | null
  target: string | null
  startedAt: string | null
  totalDuration: number
}

function itemFrom(task: NonNullable<TodoEvent['task']>): ReminderItem {
  const t = task as Record<string, unknown>
  return {
    id: Number(t.id),
    title: String(t.title ?? ''),
    taskType: String(t.type ?? 'standard'),
    hasProject: t.project_id != null,
    contextMemo: (t.context_memo as string | null) ?? null,
    target: (t.target_timestamp as string | null) ?? null,
    startedAt: (t.started_at as string | null) ?? null,
    totalDuration: Number(t.total_duration ?? 0),
  }
}

function displayTask(it: ReminderItem): { target_timestamp: string | null; started_at: string | null; total_duration: number } {
  return {
    target_timestamp: it.target,
    started_at: it.startedAt,
    total_duration: it.totalDuration,
  }
}

/** C5-E5-G5 三音琶音（静音系统通知由本窗负责音效） */
function playArpeggio(): void {
  try {
    const ctx = new AudioContext()
    const freqs = [523.25, 659.25, 783.99]
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      const start = ctx.currentTime + i * 0.12
      gain.gain.setValueAtTime(0.15, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.55)
    })
    window.setTimeout(() => void ctx.close(), 1200)
  } catch {
    // 音频不可用则静默
  }
}

export default function ReminderWindow() {
  // 独立小窗路由：body 透明（窗口只显示圆角卡片本体）
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  const [items, setItems] = useState<ReminderItem[]>([])
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [selecting, setSelecting] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [now, setNow] = useState(Date.now())
  const hasReceived = useRef(false)
  const bell = useRef<number | null>(null)

  // 事件订阅（硬提醒在主进程已过滤软路径）
  useEffect(
    () =>
      window.dayflow.todo.onEvent((e: TodoEvent) => {
        if (e.type === 'timer:ended' && e.task) {
          hasReceived.current = true
          setItems((prev) => [...prev, itemFrom(e.task!)])
        }
      }),
    [],
  )

  // 本地秒级刷新（显示用）
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // 音效：有待处理项时先响一次、每 5 秒循环；清空即停
  useEffect(() => {
    if (items.length === 0) {
      if (bell.current != null) {
        window.clearInterval(bell.current)
        bell.current = null
      }
      return
    }
    playArpeggio()
    if (bell.current == null) bell.current = window.setInterval(playArpeggio, 5000)
    return () => {
      if (bell.current != null) {
        window.clearInterval(bell.current)
        bell.current = null
      }
    }
  }, [items.length])

  // 空列表自动隐藏（hasReceived 守卫防启动竞态）
  useEffect(() => {
    if (hasReceived.current && items.length === 0) window.dayflow.todo.hideReminder()
  }, [items.length])

  // standard 排末尾为"当前"
  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => Number(a.taskType === 'standard') - Number(b.taskType === 'standard'),
      ),
    [items],
  )
  const current = sorted.length > 0 ? sorted[sorted.length - 1] : null

  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const act = useCallback(
    (a: ReminderAction) => {
      if (!current) return
      if (a.kind === 'dismiss') {
        removeItem(current.id)
      } else if (a.kind === 'complete') {
        window.dayflow.todo.completeTask(current.id)
        removeItem(current.id)
      } else if (a.kind === 'stop-training') {
        void window.dayflow.todo.stopTraining(current.id)
        removeItem(current.id)
      } else if (a.kind === 'snooze') {
        void window.dayflow.todo.snooze(current.id, a.minutes ?? defaultSnoozeMinutes(current.taskType))
        removeItem(current.id)
      } else if (a.kind === 'select-project') {
        void window.dayflow.todo.listTaskProjects().then(setProjects)
        setSelecting(true)
      }
    },
    [current, removeItem],
  )

  // 键盘：Enter/Esc 由纯语义函数驱动（审查重点#3/#4）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return
      if (e.key === 'Enter' && !selecting) {
        e.preventDefault()
        act(resolveReminderAction({ key: 'enter', taskType: current.taskType, hasProject: current.hasProject }))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (selecting) setSelecting(false)
        else act(resolveReminderAction({ key: 'esc', taskType: current.taskType, hasProject: current.hasProject }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, selecting, act])

  const confirmProject = (projectId: number) => {
    if (!current) return
    void window.dayflow.todo.updateTask(current.id, { project_id: projectId }).then(() => {
      window.dayflow.todo.completeTask(current.id)
      removeItem(current.id)
      setSelecting(false)
    })
  }

  const createAndUseProject = () => {
    const name = newProject.trim()
    if (!name || !current) return
    void window.dayflow.todo.createTaskProject(name).then((p) => confirmProject(p.id))
    setNewProject('')
  }

  return (
    <div className="rw-root">
      {!current ? (
        <div className="rw-empty">没有待处理的提醒</div>
      ) : selecting ? (
        <div className="rw-select">
          <div className="rw-select-title">选择项目后完成：{current.title}</div>
          <div className="rw-select-list">
            {projects.map((p) => (
              <button key={p.id} className="rw-select-item" onClick={() => confirmProject(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="rw-select-new">
            <input
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              placeholder="新建项目名…"
              onKeyDown={(e) => e.key === 'Enter' && createAndUseProject()}
            />
            <button onClick={createAndUseProject}>新建并完成</button>
          </div>
          <button className="rw-btn rw-btn-ghost" onClick={() => setSelecting(false)}>
            取消（Esc）
          </button>
        </div>
      ) : (
        <>
          <div className={`rw-card rw-card-${current.taskType}`}>
            <div className="rw-type">
              {current.taskType === 'training'
                ? '训练完成'
                : current.taskType === 'gpu-idle'
                  ? 'GPU 空闲警报'
                  : current.taskType === 'notification'
                    ? '系统通知'
                    : '任务就绪'}
            </div>
            <div className="rw-title">{current.title}</div>
            {current.contextMemo && <div className="rw-memo">{current.contextMemo}</div>}
            <div className="rw-timer">{getTimerDisplay(displayTask(current), now)}</div>
            <div className="rw-actions">
              {current.taskType === 'gpu-idle' || current.taskType === 'notification' ? (
                <button className="rw-btn" onClick={() => act({ kind: 'dismiss' })}>
                  {current.taskType === 'gpu-idle' ? '忽略（继续等待）' : '知道了'}
                </button>
              ) : (
                <>
                  <button
                    className="rw-btn rw-btn-primary"
                    onClick={() =>
                      act(
                        resolveReminderAction({
                          key: 'enter',
                          taskType: current.taskType,
                          hasProject: current.hasProject,
                        }),
                      )
                    }
                  >
                    {current.taskType === 'training' ? 'TRAINING COMPLETE' : 'COMPLETE'}
                  </button>
                  {current.taskType !== 'training' && (
                    <button
                      className="rw-btn"
                      onClick={() => {
                        window.dayflow.todo.startFocus(current.id)
                        removeItem(current.id)
                      }}
                    >
                      Continue
                    </button>
                  )}
                  <button className="rw-btn rw-btn-ghost" onClick={() => act({ kind: 'snooze', minutes: 5 })}>
                    +5min
                  </button>
                  <button className="rw-btn rw-btn-ghost" onClick={() => act({ kind: 'snooze', minutes: 30 })}>
                    +30min
                  </button>
                </>
              )}
            </div>
          </div>
          {sorted.length > 1 && (
            <div className="rw-pending">
              <div className="rw-pending-title">Other Pending ({sorted.length - 1})</div>
              {sorted.slice(0, -1).map((it) => (
                <button
                  key={it.id}
                  className="rw-pending-row"
                  onClick={() => {
                    window.dayflow.todo.completeTask(it.id)
                    removeItem(it.id)
                  }}
                >
                  {it.title}
                  <span className="rw-pending-timer">{getTimerDisplay(displayTask(it), now)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
