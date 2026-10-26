import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveReminderAction, defaultSnoozeMinutes, type ReminderAction } from '@shared/reminder-logic'
import type { TaskProject, TodoEvent } from '@shared/todo-types'

/**
 * 强提醒窗（#/reminder）——布局/交互逐段对齐 EpochToDo 原版 Reminder.tsx，
 * 色系统一 Dayflow 设计令牌。结构：当前提醒大卡(图标圆徽+辉光+类型标签+
 * 大按钮带 ENTER 键帽) / Other Pending 滚动区 / 无项目完成时 Assign Project 视图。
 */

interface ReminderItem {
  id: number
  title: string
  taskType: string
  hasProject: boolean
}

function itemFrom(task: NonNullable<TodoEvent['task']>): ReminderItem {
  const t = task as Record<string, unknown>
  return {
    id: Number(t.id),
    title: String(t.title ?? ''),
    taskType: String(t.type ?? 'standard'),
    hasProject: t.project_id != null,
  }
}

// ===== 内联图标（原版用 lucide-react；这里内置同形 SVG，零依赖） =====
function Ico({ size = 14, pulse = false, children }: { size?: number; pulse?: boolean; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={pulse ? 'rw-pulse' : undefined}
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}
const BrainIco = ({ size, pulse }: { size: number; pulse?: boolean }) => (
  <Ico size={size} pulse={pulse}>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
  </Ico>
)
const TimerIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <line x1="10" x2="14" y1="2" y2="2" />
    <line x1="12" x2="15" y1="14" y2="11" />
    <circle cx="12" cy="14" r="8" />
  </Ico>
)
const WebhookIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 16c0-1.16.42-2.06 1-3" />
    <path d="M8.21 13.7 5.4 8.9A4 4 0 0 1 9.5 3a3.9 3.9 0 0 1 3.4 2" />
    <path d="M12 22a4 4 0 0 1-4-4c0-1.16.42-2.06 1-3h6c.58.94 1 1.84 1 3a4 4 0 0 1-4 4z" />
    <path d="M15.79 10.3 18.6 5.5A4 4 0 0 0 14.5 0a3.9 3.9 0 0 0-3.4 2" />
  </Ico>
)
const CheckIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Ico>
)
const PlayIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </Ico>
)
const FolderIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Ico>
)

function typeIcon(t: string, size: number): React.ReactElement {
  if (t === 'training') return <BrainIco size={size} />
  if (t === 'gpu-idle') return <BrainIco size={size} pulse />
  if (t === 'notification') return <WebhookIco size={size} />
  return <TimerIco size={size} />
}

/** C5→E5→G5 三音琶音（原版 playChime 逐行对齐；静音系统通知由本窗负责音效） */
function playChime(): void {
  try {
    const audioCtx = new AudioContext()
    const oscillator = audioCtx.createOscillator()
    const gainNode = audioCtx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(523.25, audioCtx.currentTime) // C5
    oscillator.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.15) // E5
    oscillator.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.3) // G5
    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5)
    oscillator.connect(gainNode)
    gainNode.connect(audioCtx.destination)
    oscillator.start()
    oscillator.stop(audioCtx.currentTime + 0.5)
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
  const [projectSelectTaskId, setProjectSelectTaskId] = useState<number | null>(null)
  const [newProject, setNewProject] = useState('')
  const [isVisible, setIsVisible] = useState(!document.hidden)
  const soundIntervalRef = useRef<number | null>(null)
  const hasReceivedReminder = useRef(false)

  // 页面可见性变化（隐藏时静音）
  useEffect(() => {
    const handleVisibilityChange = () => setIsVisible(!document.hidden)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  // 有待处理项且可见：立即响一次，之后每 5 秒循环
  useEffect(() => {
    if (soundIntervalRef.current) {
      window.clearInterval(soundIntervalRef.current)
      soundIntervalRef.current = null
    }
    if (items.length > 0 && isVisible) {
      playChime()
      soundIntervalRef.current = window.setInterval(() => {
        if (items.length > 0 && isVisible) playChime()
      }, 5000)
    }
    return () => {
      if (soundIntervalRef.current) {
        window.clearInterval(soundIntervalRef.current)
        soundIntervalRef.current = null
      }
    }
  }, [items.length, isVisible])

  // 事件订阅（硬提醒在主进程已过滤软路径）；按 id 去重
  useEffect(
    () =>
      window.dayflow.todo.onEvent((e: TodoEvent) => {
        if (e.type === 'timer:ended' && e.task) {
          hasReceivedReminder.current = true
          const reminder = itemFrom(e.task)
          setItems((prev) => (prev.some((r) => r.id === reminder.id) ? prev : [...prev, reminder]))
        }
      }),
    [],
  )

  useEffect(() => {
    void window.dayflow.todo.listTaskProjects().then(setProjects)
  }, [])

  // 空列表自动隐藏（hasReceived 守卫防启动竞态：主进程 timer:ended 稍后送达）
  useEffect(() => {
    if (items.length > 0) {
      hasReceivedReminder.current = true
      return
    }
    if (!hasReceivedReminder.current) return
    const t = window.setTimeout(() => window.dayflow.todo.hideReminder(), 100)
    return () => window.clearTimeout(t)
  }, [items])

  // standard 排末尾为"当前"
  const sorted = useMemo(
    () => [...items].sort((a, b) => Number(a.taskType === 'standard') - Number(b.taskType === 'standard')),
    [items],
  )

  const handleAction = useCallback(
    (taskId: number, action: 'complete' | 'focus' | 'dismiss' | 'snooze', snoozeMinutes?: number) => {
      const task = items.find((r) => r.id === taskId)
      if (!task) return

      if (action === 'complete') {
        if (task.taskType === 'training') {
          void window.dayflow.todo.stopTraining(task.id)
        } else if (task.taskType === 'gpu-idle') {
          // 仅移除
        } else if (task.taskType === 'standard' && !task.hasProject) {
          setProjectSelectTaskId(taskId)
          return
        } else {
          void window.dayflow.todo.updateTask(task.id, { status: 'archived' })
          window.dayflow.todo.cancelWait(task.id)
        }
      } else if (action === 'focus') {
        window.dayflow.todo.startFocus(task.id)
      } else if (action === 'snooze') {
        void window.dayflow.todo.snooze(task.id, snoozeMinutes ?? defaultSnoozeMinutes(task.taskType))
      }

      setItems((prev) => prev.filter((r) => r.id !== taskId))
      if (items.length <= 1) window.dayflow.todo.hideReminder()
    },
    [items],
  )

  // 纯语义 → 具体动作（Enter/Esc 与行内按钮共用一套判定）
  const actFor = useCallback(
    (item: ReminderItem, a: ReminderAction) => {
      if (a.kind === 'select-project') {
        setProjectSelectTaskId(item.id)
        return
      }
      handleAction(item.id, a.kind === 'stop-training' ? 'complete' : a.kind, a.kind === 'snooze' ? a.minutes : undefined)
    },
    [handleAction],
  )

  // 键盘：Enter/Esc 由纯语义函数驱动（审查重点#3/#4）；Esc 优先退出选项目视图
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sorted.length === 0) return
      const current = sorted[sorted.length - 1]
      if (e.key === 'Enter' && projectSelectTaskId === null) {
        e.preventDefault()
        actFor(current, resolveReminderAction({ key: 'enter', taskType: current.taskType, hasProject: current.hasProject }))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (projectSelectTaskId !== null) setProjectSelectTaskId(null)
        else actFor(current, resolveReminderAction({ key: 'esc', taskType: current.taskType, hasProject: current.hasProject }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sorted, actFor, projectSelectTaskId])

  if (items.length === 0) return <div className="rw-root" />

  const currentReminder = sorted[sorted.length - 1]
  const previousReminders = sorted.slice(0, -1).reverse()

  // ===== 无项目完成 → Assign Project 视图 =====
  if (projectSelectTaskId !== null) {
    const task = items.find((r) => r.id === projectSelectTaskId)
    if (!task) {
      setProjectSelectTaskId(null)
      return <div className="rw-root" />
    }
    return (
      <div className="rw-root">
        <div className="rw-card">
          <div className="rw-sel-head">
            <h2 className="rw-sel-label">Assign Project</h2>
            <p className="rw-sel-tasktitle">{task.title}</p>
          </div>
          <div className="rw-sel-list">
            <div className="rw-sel-hint">选择项目后归档任务</div>
            {projects.map((p) => (
              <button
                key={p.id}
                className="rw-sel-item"
                onClick={() => {
                  void window.dayflow.todo.updateTask(task.id, { project_id: p.id, status: 'archived' })
                  window.dayflow.todo.cancelWait(task.id)
                  setItems((prev) => prev.filter((r) => r.id !== projectSelectTaskId))
                  setProjectSelectTaskId(null)
                  if (items.length <= 1) window.dayflow.todo.hideReminder()
                }}
              >
                <span className="rw-sel-name">
                  <span className="rw-sel-dot" style={{ background: p.color || 'var(--text-faint)' }} />
                  {p.name}
                </span>
                <span className="rw-sel-ico">
                  <FolderIco size={14} />
                </span>
              </button>
            ))}
            <div className="rw-sel-new">
              <input
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="或新建项目名…"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const name = newProject.trim()
                  if (!name) return
                  void window.dayflow.todo.createTaskProject(name).then((proj) => {
                    void window.dayflow.todo.updateTask(task.id, { project_id: proj.id, status: 'archived' })
                    window.dayflow.todo.cancelWait(task.id)
                    setItems((prev) => prev.filter((r) => r.id !== projectSelectTaskId))
                    setProjectSelectTaskId(null)
                    setNewProject('')
                    if (items.length <= 1) window.dayflow.todo.hideReminder()
                  })
                }}
              />
              <button
                onClick={() => {
                  const name = newProject.trim()
                  if (!name) return
                  void window.dayflow.todo.createTaskProject(name).then((proj) => {
                    void window.dayflow.todo.updateTask(task.id, { project_id: proj.id, status: 'archived' })
                    window.dayflow.todo.cancelWait(task.id)
                    setItems((prev) => prev.filter((r) => r.id !== projectSelectTaskId))
                    setProjectSelectTaskId(null)
                    setNewProject('')
                    if (items.length <= 1) window.dayflow.todo.hideReminder()
                  })
                }}
              >
                新建并完成
              </button>
            </div>
          </div>
          <div className="rw-sel-foot">
            <button className="rw-sub rw-wide" onClick={() => setProjectSelectTaskId(null)}>
              取消（Esc）
            </button>
          </div>
        </div>
      </div>
    )
  }

  const current = currentReminder
  return (
    <div className="rw-root">
      <div className="rw-card">
        {/* 当前提醒 */}
        <div className="rw-current">
          <div className="rw-glow" />
          <div className="rw-current-inner">
            <div className={`rw-icon rw-tone-${current.taskType}`}>{typeIcon(current.taskType, 24)}</div>
            <div className={`rw-label rw-tone-${current.taskType}`}>
              {current.taskType === 'training'
                ? '训练完成'
                : current.taskType === 'gpu-idle'
                  ? 'GPU 空闲警报'
                  : current.taskType === 'notification'
                    ? '系统通知'
                    : '任务就绪'}
            </div>
            <div className="rw-tasktitle">{current.title}</div>
            <div className="rw-btns">
              {current.taskType === 'gpu-idle' || current.taskType === 'notification' ? (
                <button className="rw-sub rw-wide" onClick={() => handleAction(current.id, 'dismiss')}>
                  {current.taskType === 'notification' ? '知道了' : '忽略（继续等待）'}
                </button>
              ) : (
                <>
                  <button
                    className={`rw-complete rw-${current.taskType === 'training' ? 'green' : 'blue'}`}
                    onClick={() =>
                      handleAction(
                        current.id,
                        'complete',
                      )
                    }
                  >
                    <CheckIco size={16} />
                    {current.taskType === 'training' ? 'TRAINING COMPLETE' : 'COMPLETE'}
                    <span className="rw-keycap">ENTER</span>
                  </button>
                  <div className="rw-subrow">
                    {current.taskType !== 'training' && (
                      <button className="rw-sub" onClick={() => handleAction(current.id, 'focus')}>
                        <PlayIco size={12} />
                        Continue
                      </button>
                    )}
                    <button className="rw-sub" onClick={() => handleAction(current.id, 'snooze', 5)}>
                      +5min
                    </button>
                    <button className="rw-sub" onClick={() => handleAction(current.id, 'snooze', 30)}>
                      +30min
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 其他待处理 */}
        {previousReminders.length > 0 && (
          <div className="rw-pending">
            <div className="rw-pending-head">
              <span className="rw-dot" />
              Other Pending ({previousReminders.length})
            </div>
            <div className="rw-pending-list">
              {previousReminders.map((r) => (
                <div key={r.id} className="rw-prow" onClick={() => handleAction(r.id, 'complete')}>
                  <span className="rw-prow-title">
                    {typeIcon(r.taskType, 14)}
                    {r.title}
                  </span>
                  <button
                    className="rw-prow-done"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleAction(r.id, 'complete')
                    }}
                  >
                    Done
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
