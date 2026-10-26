import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseCommand, type ParsedCommand } from '@shared/commands'
import { computeBangPriorities } from '@shared/priority'
import { buildTaskTree, type TaskNode } from '@shared/hierarchy'
import type { TaskRow, TaskProject, TodoEvent } from '@shared/todo-types'

// ===== 内联图标（原版用 lucide-react；这里内置同形 SVG，零依赖） =====
function Ico({
  size = 14,
  filled = false,
  children,
  className,
  style,
}: {
  size?: number
  filled?: boolean
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  )
}
const SearchIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Ico>
)
const ClockIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Ico>
)
const BellIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Ico>
)
const AlarmIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2 2" />
    <path d="M5 3 2 6" />
    <path d="m22 6-3-3" />
  </Ico>
)
const CheckIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Ico>
)
const XIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Ico>
)
const PlayIco = ({ size, filled }: { size: number; filled: boolean }) => (
  <Ico size={size} filled={filled}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </Ico>
)
const TargetIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </Ico>
)
const TrashIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </Ico>
)
const MoreIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </Ico>
)
const ChevRightIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="m9 18 6-6-6-6" />
  </Ico>
)
const ChevDownIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="m6 9 6 6 6-6" />
  </Ico>
)
const TimerIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <line x1="10" x2="14" y1="2" y2="2" />
    <line x1="12" x2="15" y1="14" y2="11" />
    <circle cx="12" cy="14" r="8" />
  </Ico>
)
const BrainIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
  </Ico>
)
const BotIco = ({ size }: { size: number }) => (
  <Ico size={size}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </Ico>
)

// ===== AI 提醒状态徽标 / 相对时间（原版 utils/aiStatus 逐行对齐） =====
function aiStatusPill(status: string): { label: string; cls: string } {
  switch (status) {
    case 'success':
      return { label: '✓', cls: 'st-success' }
    case 'failure':
      return { label: '✕', cls: 'st-failure' }
    case 'needs_input':
      return { label: '!', cls: 'st-needs_input' }
    case 'review':
      return { label: '?', cls: 'st-review' }
    case 'progress':
      return { label: '⋯', cls: 'st-progress' }
    default:
      return { label: 'i', cls: 'st-progress' }
  }
}
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  if (diff < 60_000) return '刚刚'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

// ===== 倒计时（原版 CountDown 组件逐行对齐） =====
const pad2 = (n: number) => n.toString().padStart(2, '0')
function CountDown({ target }: { target?: string | null }) {
  const [display, setDisplay] = useState('--:--')
  useEffect(() => {
    if (!target) return
    const tick = () => {
      const diff = new Date(target).getTime() - Date.now()
      if (diff <= 0) {
        setDisplay('DONE')
        return
      }
      const days = Math.floor(diff / 86400000)
      const hours = Math.floor((diff % 86400000) / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      if (days > 0) setDisplay(`${days}:${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`)
      else setDisplay(`${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`)
    }
    tick()
    const iv = window.setInterval(tick, 1000)
    return () => window.clearInterval(iv)
  }, [target])
  return <span>{display}</span>
}

// ===== 专注秒表格式（原版 formatTime） =====
function formatTime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}:${pad2(h)}:${pad2(m)}:${pad2(sec)}`
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

function parseSimpleTime(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*([smh]?)$/i)
  if (!match) return null
  const value = parseInt(match[1], 10)
  const unit = (match[2] || 'm').toLowerCase()
  if (unit === 'h') return value * 3600
  if (unit === 's') return value
  return value * 60
}

/** 标题里的 URL 渲染为可点击分段（http(s) 起、空白/CJK 标点终止，剥尾部标点） */
function linkifySegments(title: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = []
  const re = /https?:\/\/[^\s"'）】」»]+/g
  let last = 0
  for (const m of title.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ text: title.slice(last, idx) })
    let url = m[0]
    while (/[)\].,!?;:]$/.test(url)) url = url.slice(0, -1)
    if (url.length > 8) out.push({ text: url, url })
    else out.push({ text: m[0] })
    last = idx + m[0].length
  }
  if (last < title.length) out.push({ text: title.slice(last) })
  return out
}

// ===== 树工具（原版 utils/buildTaskTree 的 findNode / countDescendants） =====
function findNode(nodes: TaskNode<TaskRow>[], id: number): TaskNode<TaskRow> | null {
  for (const n of nodes) {
    if (n.task.id === id) return n
    const found = findNode(n.children, id)
    if (found) return found
  }
  return null
}
const countDescendants = (n: TaskNode<TaskRow>): number =>
  n.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0)

// ===== Bullet 编辑器行为接口（原版 useOutlinerKeyboard.OutlinerActions；Dispatch 已按用户裁决剔除） =====
interface OutlinerActions {
  createChild: (parentId: number, title: string) => Promise<void>
  createSibling: (siblingId: number, title: string) => Promise<void>
  updateTitle: (id: number, title: string) => Promise<void>
  indent: (id: number, title: string) => Promise<void>
  dedent: (id: number, title: string) => Promise<void>
  deleteTask: (id: number) => Promise<void>
  completeTask: (id: number) => Promise<void>
  startFocus: (id: number) => Promise<void>
  toggleSideFocus: (id: number) => Promise<void>
  setCountdown: (id: number, seconds: number) => Promise<void>
  clearCountdown: (id: number) => Promise<void>
  moveCursor: (direction: 'up' | 'down') => void
  exitEditor: () => void
}

// ===== BulletRow：单行递归组件（原版逐行对齐） =====
interface BulletRowProps {
  node: TaskNode<TaskRow>
  projects: TaskProject[]
  activeNodeId: number | null
  editingNodeId: number | null
  collapsed: Set<number>
  rowRefs: React.RefObject<Map<number, HTMLInputElement>>
  onToggleCollapse: (id: number) => void
  onStartEdit: (id: number) => void
  onStopEdit: () => void
  onFocusRow: (id: number | null) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, taskId: number, title: string) => void
  actions: OutlinerActions
}

function BulletRow({
  node,
  projects,
  activeNodeId,
  editingNodeId,
  collapsed,
  rowRefs,
  onToggleCollapse,
  onStartEdit,
  onStopEdit,
  onFocusRow,
  onKeyDown,
  actions,
}: BulletRowProps) {
  const { task, children, depth } = node
  const project = projects.find((p) => p.id === task.project_id)
  const projectColor = project?.color || '#b9a58c'
  const isActive = task.id === activeNodeId
  const isEditing = task.id === editingNodeId
  const isFocused = task.status === 'active' && task.timer_type === 'focus'
  const isSideFocus = task.is_side_focus === 1
  const isCollapsed = collapsed.has(task.id)
  const hasCountdown = task.status === 'waiting' && !!task.target_timestamp
  const [title, setTitle] = useState(task.title)
  const [showMenu, setShowMenu] = useState(false)
  const [showTimerPicker, setShowTimerPicker] = useState(false)
  const [customMin, setCustomMin] = useState('')
  // 行内两步删除确认:这个无边框置顶小窗里 window.confirm 的原生对话框
  // 弹不出来(被面板压住/被吞),点击垃圾桶会变成死按钮——绝不能用原生 confirm
  const [confirmingDel, setConfirmingDel] = useState(false)

  // 标题里含网址时，非编辑态用可点击的分段视图代替 input 展示；
  // input 仍在 DOM（透明、不可交互）以保持键盘导航 / focus 链路。
  const linkSegments = useMemo(() => linkifySegments(task.title), [task.title])
  const hasLinks = linkSegments.some((s) => s.url)
  const inputSuspended = !isEditing && hasLinks

  // 已提交但 props 尚未跟上的标题:期间禁止 effect 用旧 props 回写本地值,
  // 否则 blur 瞬间(isEditing 翻 false、task.title 还是旧值)标题会闪回旧文,
  // 等下一轮 refetch 才跳回来——加"!"后行还会在新旧 bang 排序间来回跳。
  const pendingCommitRef = useRef<string | null>(null)
  useEffect(() => {
    if (pendingCommitRef.current !== null) {
      if (task.title === pendingCommitRef.current) pendingCommitRef.current = null
      return
    }
    if (!isEditing) setTitle(task.title)
  }, [task.title, isEditing])

  const commitTitle = () => {
    if (title !== task.title) {
      pendingCommitRef.current = title
      actions.updateTitle(task.id, title)
      // 更新失败/丢失时的兜底:3s 后放弃等待,恢复 props 同步
      window.setTimeout(() => {
        if (pendingCommitRef.current === title) pendingCommitRef.current = null
      }, 3000)
    }
    onStopEdit()
  }

  const hasChildren = children.length > 0

  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const timerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showTimerPicker) return
    const handler = (e: MouseEvent) => {
      if (timerRef.current && !timerRef.current.contains(e.target as Node)) setShowTimerPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showTimerPicker])

  return (
    <li className="sw-brow">
      <div
        className={`sw-brow-inner${isActive ? ' bgactive' : ''}${isFocused ? ' bgfocus' : ''}`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* 缩进连接线 */}
        {depth > 0 && <div className="sw-line" style={{ left: `${(depth - 1) * 20 + 14}px` }} />}

        {/* 展开/折叠 或 占位 */}
        {hasChildren ? (
          <button className="sw-fold" onClick={() => onToggleCollapse(task.id)}>
            {isCollapsed ? <ChevRightIco size={12} /> : <ChevDownIco size={12} />}
          </button>
        ) : (
          <div className="sw-fold-spacer" />
        )}

        {/* Focus 按钮 */}
        <button
          className={`sw-play${isFocused ? ' on' : ''}`}
          onClick={() => actions.startFocus(task.id)}
          title="设为 Focus"
        >
          <PlayIco size={14} filled={isFocused} />
        </button>

        {/* 副 Focus 按钮 */}
        <button
          className={`sw-side${isSideFocus ? ' on' : ''}`}
          onClick={() => actions.toggleSideFocus(task.id)}
          title={isSideFocus ? '取消副 Focus' : '设为副 Focus（最多 2 个）'}
        >
          <TargetIco size={14} />
        </button>

        {/* 项目色点 */}
        <div className="sw-dot" style={{ backgroundColor: projectColor }} title={project?.name || 'Inbox'} />

        {/* 标题（原地编辑） */}
        <input
          ref={(el) => {
            if (el) rowRefs.current.set(task.id, el)
            else rowRefs.current.delete(task.id)
          }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => {
            onFocusRow(task.id)
            onStartEdit(task.id)
          }}
          onBlur={commitTitle}
          onKeyDown={(e) => onKeyDown(e, task.id, title)}
          className={`sw-binput${isFocused ? ' fw' : ''}${inputSuspended ? ' suspended' : ''}`}
          placeholder="任务名…"
        />
        {inputSuspended && (
          <div className={`sw-blinkview${isFocused ? ' fw' : ''}`} onClick={() => rowRefs.current.get(task.id)?.focus()}>
            {linkSegments.map((seg, i) =>
              seg.url ? (
                <a
                  key={i}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    window.dayflow.todo.openExternal(seg.url!)
                  }}
                  title={`打开 ${seg.url}`}
                >
                  {seg.text}
                </a>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </div>
        )}

        {/* waiting 倒计时占位 */}
        {task.status === 'waiting' && task.target_timestamp && (
          <span className="sw-hourglass">⏳</span>
        )}

        {/* 悬停操作 */}
        <div className={`sw-ops${confirmingDel ? ' keep' : ''}`}>
          <button
            className={`sw-op${hasCountdown ? ' amber' : ''}`}
            onClick={() => {
              setShowTimerPicker((s) => !s)
              setShowMenu(false)
            }}
            title="倒计时"
          >
            <TimerIco size={13} />
          </button>
          <button className="sw-op" onClick={() => actions.completeTask(task.id)} title="完成 (Ctrl+Enter)">
            <CheckIco size={13} />
          </button>
          <button
            className="sw-op"
            onClick={() => {
              const descCount = countDescendants(node)
              // 有子任务先行内确认;原生 window.confirm 在置顶无边框窗里弹不出来
              if (descCount > 0) setConfirmingDel(true)
              else void actions.deleteTask(task.id)
            }}
            title="删除 (Ctrl+Backspace)"
          >
            <TrashIco size={13} />
          </button>
          <button
            className="sw-op"
            onClick={() => {
              setShowMenu((s) => !s)
              setShowTimerPicker(false)
            }}
            title="更多"
          >
            <MoreIco size={13} />
          </button>
          {confirmingDel && (
            <>
              <span className="sw-delsure">连子任务共 {countDescendants(node) + 1} 项</span>
              <button
                className="sw-op danger"
                onClick={() => {
                  setConfirmingDel(false)
                  void actions.deleteTask(task.id)
                }}
              >
                确认删除
              </button>
              <button className="sw-op" onClick={() => setConfirmingDel(false)}>
                取消
              </button>
            </>
          )}
        </div>
      </div>

      {/* 倒计时面板 */}
      {showTimerPicker && (
        <div ref={timerRef} className="sw-menu sw-timerpicker">
          {(() => {
            let remaining: string | null = null
            if (hasCountdown && task.target_timestamp) {
              const diff = new Date(task.target_timestamp).getTime() - Date.now()
              if (diff > 0) {
                const m = Math.floor(diff / 60000)
                const s = Math.floor((diff % 60000) / 1000)
                remaining = `${m}:${s.toString().padStart(2, '0')}`
              }
            }
            return remaining ? <div className="sw-remain">剩余 {remaining}</div> : null
          })()}
          <div className="sw-timergrid">
            {[5, 15, 25, 45, 60, 120].map((m) => (
              <button
                key={m}
                className="sw-timerbtn"
                onClick={() => {
                  actions.setCountdown(task.id, m * 60)
                  setShowTimerPicker(false)
                }}
              >
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
          <div className="sw-timer-custom">
            <input
              value={customMin}
              onChange={(e) => setCustomMin(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customMin && Number(customMin) > 0) {
                  actions.setCountdown(task.id, Number(customMin) * 60)
                  setShowTimerPicker(false)
                  setCustomMin('')
                }
                e.stopPropagation()
              }}
              placeholder="自定义(分钟)"
            />
            <button
              onClick={() => {
                if (customMin && Number(customMin) > 0) actions.setCountdown(task.id, Number(customMin) * 60)
                setShowTimerPicker(false)
                setCustomMin('')
              }}
            >
              ✓
            </button>
          </div>
          {hasCountdown && (
            <button
              className="sw-cancel-btn"
              onClick={() => {
                actions.clearCountdown(task.id)
                setShowTimerPicker(false)
              }}
            >
              取消倒计时
            </button>
          )}
        </div>
      )}

      {/* 更多菜单 */}
      {showMenu && (
        <div ref={menuRef} className="sw-menu sw-moremenu">
          <button
            onClick={() => {
              actions.completeTask(task.id)
              setShowMenu(false)
            }}
          >
            完成
          </button>
          <button
            onClick={() => {
              actions.startFocus(task.id)
              setShowMenu(false)
            }}
          >
            设为 Focus
          </button>
          <button
            onClick={() => {
              actions.toggleSideFocus(task.id)
              setShowMenu(false)
            }}
          >
            {isSideFocus ? '取消副 Focus' : '设为副 Focus'}
          </button>
          <button
            onClick={() => {
              setShowMenu(false)
              onStartEdit(task.id)
            }}
          >
            重命名
          </button>
        </div>
      )}

      {/* 递归子任务 */}
      {hasChildren && !isCollapsed && (
        <ul>
          {children.map((child) => (
            <BulletRow
              key={child.task.id}
              node={child}
              projects={projects}
              activeNodeId={activeNodeId}
              editingNodeId={editingNodeId}
              collapsed={collapsed}
              rowRefs={rowRefs}
              onToggleCollapse={onToggleCollapse}
              onStartEdit={onStartEdit}
              onStopEdit={onStopEdit}
              onFocusRow={onFocusRow}
              onKeyDown={onKeyDown}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// ===== SpotlightBulletEditor：主组件（原版逐行对齐） =====
interface EditorProps {
  tasks: TaskRow[]
  projects: TaskProject[]
  onRefetch: () => void
  onExit: () => void
}

function SpotlightBulletEditor({ tasks, projects, onRefetch, onExit }: EditorProps) {
  const tree = useMemo(() => {
    const std = tasks.filter((t) => t.type !== 'reminder' && t.type !== 'training')
    // 同级按 subtree-max bang 优先级（"!" 数）优先
    return buildTaskTree(std, computeBangPriorities(std))
  }, [tasks])

  const [activeNodeId, setActiveNodeId] = useState<number | null>(
    tasks.find((t) => t.status === 'active' && t.timer_type === 'focus')?.id ?? tree[0]?.task.id ?? null,
  )
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const rowRefs = useRef<Map<number, HTMLInputElement>>(new Map())

  const focusRow = (id: number | null) => {
    setActiveNodeId(id)
    if (id !== null) {
      requestAnimationFrame(() => rowRefs.current.get(id)?.focus())
    }
  }

  const [pendingFocusId, setPendingFocusId] = useState<number | null>(null)
  const [sideFocusNotice, setSideFocusNotice] = useState<string | null>(null)

  // 新任务创建 / 缩进移动后，等树重建完毕再聚焦它的 input。
  // 快照守卫：设置标记时 effect 会先在【旧树】上触发一次，此时目标 input
  // 还是旧的（或尚不存在），必须等到 tree 引用换成重建后的新树才真正聚焦。
  const pendingFocusTreeRef = useRef<TaskNode<TaskRow>[] | null>(null)
  useEffect(() => {
    if (pendingFocusId === null) return
    if (tree === pendingFocusTreeRef.current) return
    const el = rowRefs.current.get(pendingFocusId)
    if (el) {
      el.focus()
      setActiveNodeId(pendingFocusId)
      setEditingNodeId(pendingFocusId)
      setPendingFocusId(null)
      pendingFocusTreeRef.current = null
    }
  }, [pendingFocusId, tree])

  // 展开 active 节点的祖先链
  useEffect(() => {
    if (activeNodeId === null || collapsed.size === 0) return
    const ancestorIds: number[] = []
    const findPath = (nodes: TaskNode<TaskRow>[], target: number, path: number[]): boolean => {
      for (const n of nodes) {
        if (n.task.id === target) {
          ancestorIds.push(...path)
          return true
        }
        if (findPath(n.children, target, [...path, n.task.id])) return true
      }
      return false
    }
    findPath(tree, activeNodeId, [])
    if (ancestorIds.some((id) => collapsed.has(id))) {
      setCollapsed((prev) => {
        const next = new Set(prev)
        ancestorIds.forEach((id) => next.delete(id))
        return next
      })
    }
  }, [activeNodeId, tree, collapsed])

  // ===== OutlinerActions 实现 =====
  const actions: OutlinerActions = {
    createChild: async (parentId, title) => {
      const parent = findNode(tree, parentId)
      // 结构操作前先落盘未提交的标题改动(与 indent/dedent 行为一致)
      if (parent && title !== parent.task.title) {
        await window.dayflow.todo.updateTask(parentId, { title })
      }
      const projectId = parent?.task.project_id ?? undefined
      const newTask = await window.dayflow.todo.createTask('', {
        type: 'standard',
        projectId,
        parentId,
        skipDedup: true,
      })
      onRefetch()
      pendingFocusTreeRef.current = tree
      setPendingFocusId(newTask.id)
    },
    createSibling: async (siblingId, title) => {
      const sibling = findNode(tree, siblingId)
      if (sibling && title !== sibling.task.title) {
        await window.dayflow.todo.updateTask(siblingId, { title })
      }
      const parentId = sibling?.task.parent_id ?? undefined
      const projectId = sibling?.task.project_id ?? undefined
      const newTask = await window.dayflow.todo.createTask('', {
        type: 'standard',
        projectId,
        parentId,
        skipDedup: true,
      })
      onRefetch()
      pendingFocusTreeRef.current = tree
      setPendingFocusId(newTask.id)
    },
    updateTitle: async (id, title) => {
      await window.dayflow.todo.updateTask(id, { title })
      onRefetch()
    },
    indent: async (id, title) => {
      const node = findNode(tree, id)
      if (!node) return
      const parentChildren = node.task.parent_id
        ? (findNode(tree, node.task.parent_id)?.children ?? [])
        : tree
      const idx = parentChildren.findIndex((n) => n.task.id === id)
      if (idx <= 0) return
      const newParent = parentChildren[idx - 1]
      await window.dayflow.todo.updateTask(id, { title, parent_id: newParent.task.id })
      onRefetch()
      pendingFocusTreeRef.current = tree
      setPendingFocusId(id)
    },
    dedent: async (id, title) => {
      const node = findNode(tree, id)
      if (!node) return
      if (!node.task.parent_id) {
        if (title === '') await actions.deleteTask(id)
        return
      }
      const parent = findNode(tree, node.task.parent_id)
      const newParentId = parent?.task.parent_id ?? null
      const formerParentId = node.task.parent_id
      const formerParentSort = parent?.task.sort_order ?? 0

      const grandparentChildren = parent?.task.parent_id
        ? (findNode(tree, parent.task.parent_id)?.children ?? [])
        : tree
      const parentIdx = grandparentChildren.findIndex((n) => n.task.id === formerParentId)
      const nextSibling =
        parentIdx >= 0 && parentIdx < grandparentChildren.length - 1 ? grandparentChildren[parentIdx + 1] : null

      const newSortOrder = nextSibling
        ? Math.floor((formerParentSort + (nextSibling.task.sort_order ?? Date.now())) / 2)
        : formerParentSort + 1

      await window.dayflow.todo.updateTask(id, { title, parent_id: newParentId, sort_order: newSortOrder })
      onRefetch()
      pendingFocusTreeRef.current = tree
      setPendingFocusId(id)
    },
    deleteTask: async (id) => {
      await window.dayflow.todo.deleteTask(id)
      onRefetch()
    },
    completeTask: async (id) => {
      window.dayflow.todo.completeTask(id)
      onRefetch()
    },
    startFocus: async (id) => {
      window.dayflow.todo.startFocus(id)
      onRefetch()
    },
    toggleSideFocus: async (id) => {
      const node = findNode(tree, id)
      const next = !(node?.task.is_side_focus === 1)
      const ok = await window.dayflow.todo.setSideFocus(id, next)
      if (!ok) {
        setSideFocusNotice('副 Focus 已满（最多 2 个）')
        setTimeout(() => setSideFocusNotice(null), 2000)
        return
      }
      onRefetch()
    },
    setCountdown: async (id, seconds) => {
      window.dayflow.todo.startWait(id, seconds)
      onRefetch()
    },
    clearCountdown: async (id) => {
      window.dayflow.todo.cancelWait(id)
      onRefetch()
    },
    moveCursor: (direction) => {
      const flat: number[] = []
      const walk = (nodes: TaskNode<TaskRow>[]) => {
        for (const n of nodes) {
          flat.push(n.task.id)
          if (!collapsed.has(n.task.id)) walk(n.children)
        }
      }
      walk(tree)
      if (flat.length === 0) return
      const curIdx = activeNodeId ? flat.indexOf(activeNodeId) : -1
      let nextIdx: number
      if (direction === 'down') nextIdx = curIdx < flat.length - 1 ? curIdx + 1 : 0
      else nextIdx = curIdx > 0 ? curIdx - 1 : flat.length - 1
      focusRow(flat[nextIdx])
    },
    exitEditor: onExit,
  }

  // ===== 键盘模型（原版 useOutlinerKeyboard 逐行对齐） =====
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, taskId: number, currentTitle: string) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'Enter') {
          e.preventDefault()
          actions.completeTask(taskId)
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          actions.deleteTask(taskId)
          return
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        actions.exitEditor()
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        const original = findNode(tree, taskId)?.task.title ?? ''
        if (e.shiftKey) {
          actions.createSibling(taskId, currentTitle)
          return
        }
        // 标题有改动时 Enter = 确认编辑(不再顺带新建空草稿——那正是"重复行"的来源);
        // 无改动才按原语义新建子任务
        if (currentTitle !== original) {
          actions.updateTitle(taskId, currentTitle)
          return
        }
        actions.createChild(taskId, currentTitle)
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) actions.dedent(taskId, currentTitle)
        else actions.indent(taskId, currentTitle)
        return
      }

      if (e.key === 'Backspace' && currentTitle === '') {
        e.preventDefault()
        actions.dedent(taskId, currentTitle)
        return
      }

      if (!editingNodeId && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        actions.moveCursor(e.key === 'ArrowUp' ? 'up' : 'down')
        return
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingNodeId, tree, collapsed, activeNodeId],
  )

  if (tree.length === 0) return null

  return (
    <div className="sw-tree">
      {sideFocusNotice && <div className="sw-toast">{sideFocusNotice}</div>}
      <div className="sw-zhead">
        <span>任务树 · Bullet 编辑器</span>
        <span className="sw-zhead-count">{tasks.filter((t) => t.status !== 'archived').length}</span>
      </div>
      <ul className="sw-tree-list">
        {tree.map((node) => (
          <BulletRow
            key={node.task.id}
            node={node}
            projects={projects}
            activeNodeId={activeNodeId}
            editingNodeId={editingNodeId}
            collapsed={collapsed}
            rowRefs={rowRefs}
            onToggleCollapse={(id) =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
            onStartEdit={(id) => setEditingNodeId(id)}
            onStopEdit={() => setEditingNodeId(null)}
            onFocusRow={focusRow}
            onKeyDown={handleKeyDown}
            actions={actions}
          />
        ))}
      </ul>
    </div>
  )
}

// ===== AI 软提醒卡片数据 =====
interface AiCard {
  id: string
  source: string
  title: string
  status: string
  detail?: string
  link?: string
  ts: number
}
interface PendingReady {
  id: number
  title: string
  type: string
}
interface GpuLite {
  id: number
  name: string
  activeTaskId: number | null
}

// ===== 主组件：Spotlight（原版 Spotlight.tsx 布局/功能逐段对齐） =====
export default function SpotlightWindow() {
  // 独立小窗路由：body 透明（窗口只显示圆角卡片本体）
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  const [input, setInput] = useState('')
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [gpus, setGpus] = useState<GpuLite[]>([])
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [aiCards, setAiCards] = useState<AiCard[]>([])
  const [activeDuration, setActiveDuration] = useState(0)
  const [pendingReminders, setPendingReminders] = useState<PendingReady[]>([])
  const [showReminders, setShowReminders] = useState(true)
  const [confirmCompleteTask, setConfirmCompleteTask] = useState<TaskRow | null>(null)
  const [projectHighlightIdx, setProjectHighlightIdx] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: TaskRow } | null>(null)
  const [resetTimer, setResetTimer] = useState<{ task: TaskRow; input: string } | null>(null)
  const [focusToday, setFocusToday] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const fetchSeq = useRef(0)
  useEffect(() => {
    if (confirmCompleteTask) setProjectHighlightIdx(0)
  }, [confirmCompleteTask])

  // GPU 选择模式
  const [selectGpuMode, setSelectGpuMode] = useState(false)
  const [pendingTrainingData, setPendingTrainingData] = useState<{
    title: string
    time: number
    projectId?: number | null
    sub?: string
  } | null>(null)

  const parsed: ParsedCommand = useMemo(() => parseCommand(input), [input])

  const fetchData = useCallback(async () => {
    // 乱序防护:每秒 timer:update 和操作后 refetch 并发,旧响应后到会用过期
    // 数据覆盖新数据(标题闪回旧值/行位置翻转)——只采纳最新一次的结果
    const seq = ++fetchSeq.current
    try {
      const [t, pr, g, focus] = await Promise.all([
        window.dayflow.todo.getTasks(),
        window.dayflow.todo.listTaskProjects(),
        window.dayflow.todo.getGpus(),
        window.dayflow.todo.focusToday(),
      ])
      if (seq !== fetchSeq.current) return
      // 按创建时间排序（新的在前）
      t.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      setTasks(t)
      setProjects(pr)
      setGpus(g)
      setFocusToday(focus)
    } catch (err) {
      console.error(err)
    }
  }, [])

  useEffect(() => {
    void fetchData()
    inputRef.current?.focus()
  }, [fetchData])

  useEffect(() => {
    setHighlightIdx(-1)
  }, [input])

  // 用 ref 避免 IPC 监听器闭包过期
  const fetchDataRef = useRef(fetchData)
  useEffect(() => {
    fetchDataRef.current = fetchData
  }, [fetchData])

  useEffect(() => {
    const off = window.dayflow.todo.onEvent((e: TodoEvent) => {
      if (e.type === 'timer:update' || e.type === 'fetch-tasks') fetchDataRef.current()
      if (e.type === 'timer:ended') {
        // reminder 任务走软提醒路径（下方卡片）；其余进全屏 Tasks Ready 遮罩
        const task = e.task as { id: number; title: string; type: string } | null
        if (task && task.type !== 'reminder') {
          setPendingReminders((prev) => {
            if (prev.some((r) => r.id === task.id)) return prev
            return [...prev, task]
          })
          setShowReminders(true)
        }
        fetchDataRef.current()
      }
      if (e.type === 'ai:reminder' && e.reminder) {
        const r = e.reminder
        setAiCards((c) =>
          [{ id: r.id, source: r.source, title: r.title, status: r.status, detail: r.detail, link: r.link, ts: r.timestamp || Date.now() }, ...c].slice(0, 20),
        )
      }
      if (e.type === 'ai:reminder-dismissed') {
        setAiCards((c) =>
          c.filter((card) => {
            if (e.id != null) return card.id !== e.id
            if (e.source != null && card.source !== e.source) return true
            if (e.title != null && card.title !== e.title) return true
            return e.force === true ? false : card.status === 'needs_input' || card.status === 'review'
          }),
        )
      }
    })

    // 窗口重获焦点时刷新数据并聚焦输入框（重开 Spotlight 后焦点不丢）
    const handleFocus = () => {
      fetchDataRef.current()
      inputRef.current?.focus()
    }
    window.addEventListener('focus', handleFocus)

    return () => {
      off()
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  // pendingReminders 与最新 tasks 同步（在 Reminder 窗口处理过的 here 去重）
  useEffect(() => {
    if (pendingReminders.length === 0) return
    setPendingReminders((prev) =>
      prev.filter((r) => {
        const currentTask = tasks.find((t) => t.id === r.id)
        if (!currentTask) return false
        if (currentTask.status === 'archived') return false
        if (currentTask.target_timestamp) {
          const target = Date.parse(currentTask.target_timestamp)
          if (target > Date.now() + 5000) return false
        }
        return true
      }),
    )
  }, [tasks, pendingReminders.length])

  const activeTask = tasks.find((t) => t.status === 'active' && t.timer_type === 'focus')
  const waitingTasks = tasks.filter((t) => t.status === 'waiting' && t.type === 'standard')
  // '#' 命令 = 完成模式；':' = 子任务父搜索
  const isCompleteMode = input.trim().startsWith('#')
  const isSubtaskParentSearch = parsed.isSubtask && parsed.parentSearch

  const suggestions = useMemo(() => {
    if (!input) return []
    return tasks.filter((t) => {
      if (t.status === 'archived') return false
      if (isCompleteMode) {
        const query = input.substring(1).trim().toLowerCase()
        return t.type !== 'reminder' && t.type !== 'training' && t.title.toLowerCase().includes(query)
      }
      if (isSubtaskParentSearch) {
        const searchTerm = parsed.parentSearch!.toLowerCase()
        return t.type === 'standard' && t.title.toLowerCase().includes(searchTerm)
      }
      return (
        t.type !== 'reminder' &&
        t.type !== 'training' &&
        (t.title.toLowerCase().includes((parsed.main ?? '').toLowerCase()) ||
          (parsed.project
            ? (projects.find((pr) => pr.id === t.project_id)?.name.toLowerCase().includes(parsed.project.toLowerCase()) ??
              false)
            : false))
      )
    })
  }, [input, isCompleteMode, isSubtaskParentSearch, parsed, tasks, projects])
  // bang 优先级（"!" 数，subtree-max）优先——多于 1 条时稳定排序
  const bangPriorities = useMemo(() => computeBangPriorities(tasks), [tasks])
  const sortedSuggestions =
    suggestions.length > 1
      ? [...suggestions].sort((a, b) => (bangPriorities.get(b.id) ?? 0) - (bangPriorities.get(a.id) ?? 0))
      : suggestions
  // 训练任务按到期时间升序取前 3
  const recentTraining = tasks
    .filter((t) => t.type === 'training' && t.status === 'waiting')
    .sort((a, b) => {
      const timeA = a.target_timestamp ? Date.parse(a.target_timestamp) : Infinity
      const timeB = b.target_timestamp ? Date.parse(b.target_timestamp) : Infinity
      return timeA - timeB
    })
    .slice(0, 3)

  // 软提醒：reminder 任务倒计时已过期（不弹硬提醒窗，只在 Spotlight 出卡片）
  const nowMs = Date.now()
  const softReminders = tasks.filter(
    (t) =>
      t.type === 'reminder' &&
      t.status === 'waiting' &&
      t.target_timestamp != null &&
      Date.parse(t.target_timestamp) <= nowMs,
  )

  useEffect(() => {
    if (activeTask) {
      const update = () => {
        if (!activeTask.started_at) {
          setActiveDuration(activeTask.total_duration)
          return
        }
        const start = Date.parse(activeTask.started_at)
        const elapsed = Math.floor((Date.now() - start) / 1000)
        setActiveDuration(activeTask.total_duration + elapsed)
      }
      update()
      const timer = window.setInterval(update, 1000)
      return () => window.clearInterval(timer)
    }
    setActiveDuration(0)
  }, [activeTask])

  const confirmGpuSelection = async (selectedGpu: GpuLite) => {
    if (!pendingTrainingData) return
    const targetTask = await window.dayflow.todo.createTask(pendingTrainingData.title, {
      type: 'training',
      projectId: pendingTrainingData.projectId,
    })
    if (pendingTrainingData.sub) {
      window.dayflow.todo.addMemo(targetTask.id, `Context: ${pendingTrainingData.sub}`)
    }
    // p.time 是秒 → 向上取整为分钟
    const durationMins = Math.ceil(pendingTrainingData.time / 60)
    window.dayflow.todo.assignGpu(targetTask.id, selectedGpu.id, durationMins)
    setSelectGpuMode(false)
    setPendingTrainingData(null)
    setInput('')
    window.dayflow.todo.hideSpotlight()
    void fetchData()
  }

  const completeTaskAction = async (task: TaskRow) => {
    void window.dayflow.todo.updateTask(task.id, { status: 'archived' })
    window.dayflow.todo.cancelWait(task.id)
    setContextMenu(null)
    void fetchData()
  }

  const cancelWaitAction = async (task: TaskRow) => {
    window.dayflow.todo.cancelWait(task.id)
    setContextMenu(null)
    void fetchData()
  }

  const exec = useCallback(
    async (p: ParsedCommand) => {
      const res = (await window.dayflow.todo.execCommand(p, {
        activeTaskId: activeTask?.id ?? null,
        highlightedId:
          highlightIdx >= 0 && highlightIdx < sortedSuggestions.length ? sortedSuggestions[highlightIdx].id : null,
        suggestionIds: sortedSuggestions.map((s) => s.id),
      })) as { kind: string; draft?: { title: string; time: number; projectId: number | null; sub?: string } }
      if (res.kind === 'need-gpu-pick' && res.draft) {
        setPendingTrainingData(res.draft)
        setSelectGpuMode(true)
        setHighlightIdx(0) // 默认选第一个 GPU
        return
      }
      setInput('')
      // 稍等 50ms 再隐藏，让广播先被处理（与原版一致）
      setTimeout(() => window.dayflow.todo.hideSpotlight(), 50)
    },
    [activeTask, highlightIdx, sortedSuggestions],
  )

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (confirmCompleteTask) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirmCompleteTask(null)
        return
      }
      const needsProject = confirmCompleteTask.type === 'standard' && !confirmCompleteTask.project_id
      if (needsProject) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (projects.length) setProjectHighlightIdx((prev) => (prev + 1) % projects.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (projects.length) setProjectHighlightIdx((prev) => (prev - 1 + projects.length) % projects.length)
        } else if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
          e.preventDefault()
          const idx = parseInt(e.key, 10) - 1
          if (idx < projects.length) {
            const selectedProj = projects[idx]
            void window.dayflow.todo.updateTask(confirmCompleteTask.id, { project_id: selectedProj.id })
            window.dayflow.todo.completeTask(confirmCompleteTask.id)
            setConfirmCompleteTask(null)
            setInput('')
            window.dayflow.todo.hideSpotlight()
            void fetchData()
          }
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (projects.length > 0) {
            const idx = projectHighlightIdx < 0 ? 0 : projectHighlightIdx
            const selectedProj = projects[idx]
            void window.dayflow.todo.updateTask(confirmCompleteTask.id, { project_id: selectedProj.id })
            window.dayflow.todo.completeTask(confirmCompleteTask.id)
            setConfirmCompleteTask(null)
            setInput('')
            window.dayflow.todo.hideSpotlight()
            void fetchData()
          }
        }
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        window.dayflow.todo.completeTask(confirmCompleteTask.id)
        setConfirmCompleteTask(null)
        setInput('')
        window.dayflow.todo.hideSpotlight()
        void fetchData()
      }
      return
    }

    if (selectGpuMode && pendingTrainingData) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectGpuMode(false)
        setPendingTrainingData(null)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (gpus.length) setHighlightIdx((s) => (s + 1) % gpus.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (gpus.length) setHighlightIdx((s) => (s === -1 ? gpus.length - 1 : (s - 1 + gpus.length) % gpus.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (highlightIdx !== -1 && highlightIdx < gpus.length) await confirmGpuSelection(gpus[highlightIdx])
      } else if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key, 10) - 1
        if (idx < gpus.length) await confirmGpuSelection(gpus[idx])
      }
      return
    }

    if (e.key === 'Escape') {
      window.dayflow.todo.hideSpotlight()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (sortedSuggestions.length) setHighlightIdx((s) => (s + 1) % sortedSuggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (sortedSuggestions.length)
        setHighlightIdx((s) => (s === -1 ? sortedSuggestions.length - 1 : (s - 1 + sortedSuggestions.length) % sortedSuggestions.length))
    } else if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault()
      const idx = parseInt(e.key, 10) - 1
      if (idx < sortedSuggestions.length) {
        const selected = sortedSuggestions[idx]
        if (isCompleteMode) {
          setConfirmCompleteTask(selected)
          return
        }
        window.dayflow.todo.startFocus(selected.id)
        setInput('')
        window.dayflow.todo.hideSpotlight()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isCompleteMode) {
        if (highlightIdx !== -1 && highlightIdx < sortedSuggestions.length) {
          setConfirmCompleteTask(sortedSuggestions[highlightIdx])
        } else if (sortedSuggestions.length > 0) {
          setConfirmCompleteTask(sortedSuggestions[0])
        }
        return
      }
      try {
        await exec(parsed)
      } catch (err) {
        console.error(err)
      }
    }
  }

  return (
    <div className="sw-root">
      {/* 1. 输入栏 */}
      <div className="sw-inputbar">
        <div className="flex items-center gap-3">
          <span style={{ color: input ? 'var(--accent)' : 'var(--text-faint)', transition: 'color .15s', display: 'flex' }}>
            <SearchIco size={20} />
          </span>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            type="text"
            className="sw-input"
            placeholder="输入任务... (! 切换, @ 挂起, + 提醒, % 训练, > 备注) · 下方可直接编辑任务树"
          />
        </div>
        {input && (
          <div className="sw-typepill">
            <span className="type">{parsed.type}</span>
            <span className="enter">↵ Enter</span>
          </div>
        )}
      </div>

      <div className="sw-scroll">
        {/* 2. 活动区 */}
        {(activeTask || (!selectGpuMode && waitingTasks.length > 0)) && (
          <div className="sw-activezone">
            {activeTask && (
              <div
                className="sw-focus-card"
                style={{ borderLeft: `4px solid ${projects.find((p) => p.id === activeTask.project_id)?.color || 'var(--accent)'}` }}
              >
                <div>
                  <div className="sw-focus-meta">
                    <span className="sw-badge">FOCUS</span>
                    {(() => {
                      const pr = projects.find((p) => p.id === activeTask.project_id)
                      return (
                        <span
                          className="sw-project-chip"
                          style={{
                            backgroundColor: `${pr?.color || '#b9a58c'}22`,
                            color: pr?.color || '#8a7e6c',
                            border: `1px solid ${pr?.color || '#b9a58c'}44`,
                          }}
                        >
                          #{pr?.name || 'Inbox'}
                        </span>
                      )
                    })()}
                  </div>
                  <div className="sw-focus-title">{activeTask.title}</div>
                </div>
                <div className="sw-focus-timer">+ {formatTime(activeDuration)}</div>
              </div>
            )}

            {/* 等待任务 */}
            {!selectGpuMode && waitingTasks.length > 0 && (
              <div className="sw-waitzone">
                {waitingTasks.map((t) => {
                  const pr = projects.find((p) => p.id === t.project_id)
                  return (
                    <div
                      key={t.id}
                      className="sw-wait-row"
                      style={{ borderLeft: `4px solid ${pr?.color || '#d97706'}` }}
                      onClick={() => window.dayflow.todo.startFocus(t.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setContextMenu({ x: e.clientX, y: e.clientY, task: t })
                      }}
                    >
                      <div className="sw-wait-left">
                        <span style={{ color: pr?.color || '#d97706', display: 'flex' }}>
                          <ClockIco size={16} />
                        </span>
                        <div>
                          <div className="sw-wait-title">{t.title}</div>
                          <div className="sw-wait-proj">{pr?.name || 'Inbox'}</div>
                        </div>
                      </div>
                      <div className="sw-wait-timer" style={{ color: pr?.color || '#d97706' }}>
                        - <CountDown target={t.target_timestamp} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 2.5 训练条 */}
        {!selectGpuMode && recentTraining.length > 0 && (
          <div className="sw-trainzone">
            <div className="sw-train-inner">
              <span className="sw-train-label">
                <BrainIco size={12} />
                Training
              </span>
              <div className="sw-train-chips">
                {recentTraining.map((t) => (
                  <div
                    key={t.id}
                    className="sw-train-chip"
                    onClick={async () => {
                      window.dayflow.todo.cancelWait(t.id)
                      void fetchData()
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setContextMenu({ x: e.clientX, y: e.clientY, task: t })
                    }}
                  >
                    <span className="sw-train-title" title={t.title}>
                      {t.title}
                    </span>
                    <span className="sw-train-timer">
                      <CountDown target={t.target_timestamp} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 3. Bullet 编辑器（或 GPU 选择） */}
        {selectGpuMode ? (
          <div className="sw-gpuzone">
            <div className="sw-zhead">
              <span>Select GPU for Training</span>
              <span className="sw-zhead-count">{gpus.length}</span>
            </div>
            <ul className="sw-gpul">
              {gpus.map((gpu, idx) => {
                const busyTask = tasks.find((t) => t.gpu_id === gpu.id && t.status === 'active')
                return (
                  <li
                    key={gpu.id}
                    className={`sw-gpu-row${idx === highlightIdx ? ' hl' : ''}`}
                    onClick={() => confirmGpuSelection(gpu)}
                  >
                    <div className="sw-gpu-left">
                      <div className="sw-gpu-dot" style={{ backgroundColor: busyTask ? 'var(--green)' : 'var(--text-faint)' }} />
                      <span className="sw-gpu-name">{gpu.name}</span>
                      {busyTask && <span className="sw-gpu-busy">Busy: {busyTask.title}</span>}
                    </div>
                    <div className="sw-gpu-right">
                      {idx < 9 && <span className="sw-keychip">^{idx + 1}</span>}
                      {idx === highlightIdx ? 'Press Enter' : ''}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <SpotlightBulletEditor tasks={tasks} projects={projects} onRefetch={fetchData} onExit={() => window.dayflow.todo.hideSpotlight()} />
        )}

        {/* 3.5 过期提醒卡片 */}
        {!selectGpuMode && softReminders.length > 0 && (
          <div className="sw-scard amber">
            <div className="sw-scard-head">
              <span className="sw-ping">
                <span className="ping" />
                <span className="dot" />
              </span>
              <BellIco size={11} />
              过期提醒
              <span className="sw-scard-count">{softReminders.length}</span>
            </div>
            <div className="sw-scard-body">
              {softReminders.map((t) => (
                <div key={t.id} className="sw-srow">
                  <div className="sw-srow-left">
                    <span className="sw-srow-icon">
                      <BellIco size={14} />
                    </span>
                    <span className="sw-srow-title">{t.title || '提醒'}</span>
                  </div>
                  <div className="sw-srow-ops">
                    <button className="amber-btn" title="再提醒" onClick={() => setResetTimer({ task: t, input: '' })}>
                      <AlarmIco size={13} />
                    </button>
                    <button
                      className="amber-btn play"
                      title="开始专注"
                      onClick={() => {
                        window.dayflow.todo.startFocus(t.id)
                        setInput('')
                        window.dayflow.todo.hideSpotlight()
                      }}
                    >
                      ▶
                    </button>
                    <button
                      className="amber-btn done"
                      title="完成 / 忽略"
                      onClick={async () => {
                        void window.dayflow.todo.updateTask(t.id, { status: 'archived' })
                        window.dayflow.todo.cancelWait(t.id)
                        void fetchData()
                      }}
                    >
                      ✓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3.6 AI 提醒卡片 */}
        {!selectGpuMode && aiCards.length > 0 && (
          <div className="sw-scard cyan">
            <div className="sw-scard-head">
              <BotIco size={11} />
              AI 提醒
              <span className="sw-scard-count">{aiCards.length}</span>
            </div>
            <div className="sw-scard-body">
              {aiCards.map((r) => {
                const pill = aiStatusPill(r.status)
                return (
                  <div
                    key={r.id}
                    onClick={() => r.link && window.dayflow.todo.openExternal(r.link)}
                    className={`sw-airow${r.link ? ' clickable' : ''}`}
                  >
                    <span className={`sw-aipill ${pill.cls}`}>{pill.label}</span>
                    <div className="sw-airow-text">
                      <span className="sw-airow-title">
                        <b>{r.source}</b> · {r.title}
                      </span>
                    </div>
                    <div className="sw-airow-ops">
                      <button
                        className="cyan-btn promote"
                        title="转为软提醒"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.dayflow.todo.aiPromote(r.source, r.title, r.detail, r.link)
                          window.dayflow.todo.aiDismiss({ source: r.source, title: r.title })
                        }}
                      >
                        <BellIco size={13} />
                      </button>
                      <button
                        className="cyan-btn dismiss"
                        title="完成 / 忽略"
                        onClick={(e) => {
                          e.stopPropagation()
                          window.dayflow.todo.aiDismiss({ id: r.id })
                        }}
                      >
                        <CheckIco size={13} />
                      </button>
                    </div>
                    <span className="sw-airow-time">{formatRelativeTime(r.ts)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 4. 页脚与提示 */}
      <div className="sw-footer">
        <div className="sw-footer-row1">
          <span>
            Total Focus Today: <b>{(focusToday / 3600).toFixed(1)}h</b>
          </span>
          <div className="sw-footer-keys">
            <span className="sw-key">↑↓ Nav</span>
            <span className="sw-key">Esc Hide</span>
          </div>
        </div>
        <div className="sw-footer-row2">
          <span>
            <b className="c-green">!</b> 切换
          </span>
          <span>
            <b className="c-amber">+</b> 提醒
          </span>
          <span>
            <b className="c-green2">%</b> 训练
          </span>
          <span>
            <b className="c-blue">&gt;</b> 备注
          </span>
          <span className="c-sep">|</span>
          <span>
            <b className="c-green">↵</b> 子任务
          </span>
          <span>
            <b className="c-green">⇧↵</b> 同级
          </span>
          <span>
            <b className="c-blue">⇥</b> 缩进
          </span>
          <span>
            <b className="c-emerald">⌃↵</b> 完成
          </span>
          <span>
            <b className="c-purple">▶</b> Focus
          </span>
        </div>
      </div>

      {/* Tasks Ready 全屏遮罩 */}
      {showReminders && pendingReminders.length > 0 && (
        <div className="sw-overlay">
          <div className="sw-ready-body">
            <div className="sw-ready-head">
              <div className="sw-ready-icon">
                <ClockIco size={24} />
              </div>
              <h2>Tasks Ready</h2>
              <p>These tasks have finished their countdown</p>
            </div>
            <div className="sw-ready-list">
              {pendingReminders.map((task, idx) => (
                <div key={task.id} className="sw-ready-row">
                  <div className="sw-ready-left">
                    {task.type === 'training' ? (
                      <span className="c-green2">
                        <BrainIco size={18} />
                      </span>
                    ) : (
                      <span className="c-amber">
                        <ClockIco size={18} />
                      </span>
                    )}
                    <div>
                      <div className="sw-ready-title">{task.title}</div>
                      <div className="sw-ready-type">{task.type}</div>
                    </div>
                  </div>
                  <button
                    className="sw-done-btn"
                    onClick={async () => {
                      if (task.type === 'training') {
                        window.dayflow.todo.cancelWait(task.id)
                      } else {
                        void window.dayflow.todo.updateTask(task.id, { status: 'archived' })
                        window.dayflow.todo.cancelWait(task.id)
                      }
                      setPendingReminders((prev) => prev.filter((_, i) => i !== idx))
                      void fetchData()
                    }}
                  >
                    <CheckIco size={14} />
                    Done
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="sw-ready-foot">
            <button onClick={() => setShowReminders(false)}>
              <XIco size={16} />
              Skip and continue to Spotlight
            </button>
          </div>
        </div>
      )}

      {/* 完成确认弹窗 */}
      {confirmCompleteTask && (
        <div className="sw-overlay z100">
          <div className="sw-confirm-card">
            <h3>
              {confirmCompleteTask.type === 'standard' && !confirmCompleteTask.project_id
                ? 'Select Project & Complete'
                : 'Complete this task?'}
            </h3>
            <div className="sw-confirm-title">{confirmCompleteTask.title}</div>
            {confirmCompleteTask.type === 'standard' && !confirmCompleteTask.project_id ? (
              <div className="sw-project-list">
                {projects.map((p, idx) => (
                  <div
                    key={p.id}
                    className={`sw-project-item${idx === projectHighlightIdx ? ' hl' : ''}`}
                    onClick={async () => {
                      void window.dayflow.todo.updateTask(confirmCompleteTask.id, {
                        project_id: p.id,
                        status: 'archived',
                      })
                      window.dayflow.todo.cancelWait(confirmCompleteTask.id)
                      setConfirmCompleteTask(null)
                      setInput('')
                      window.dayflow.todo.hideSpotlight()
                      void fetchData()
                    }}
                  >
                    {idx < 9 && <span className="sw-keychip">^{idx + 1}</span>}
                    <div className="sw-dot" style={{ backgroundColor: p.color || '#b9a58c' }} />
                    <span className="sw-project-name">{p.name}</span>
                    {idx === projectHighlightIdx && <span className="sw-enter-chip">↵</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="sw-confirm-btns">
                <button className="ghost" onClick={(e) => { e.preventDefault(); setConfirmCompleteTask(null) }}>
                  Cancel (Esc)
                </button>
                <button
                  className="primary"
                  onClick={async () => {
                    void window.dayflow.todo.updateTask(confirmCompleteTask.id, { status: 'archived' })
                    window.dayflow.todo.cancelWait(confirmCompleteTask.id)
                    setConfirmCompleteTask(null)
                    setInput('')
                    window.dayflow.todo.hideSpotlight()
                    void fetchData()
                  }}
                >
                  Complete (Enter)
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <>
          <div
            className="sw-ctx-backdrop"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu(null)
            }}
          />
          <div
            className="sw-ctx"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 180),
              top: Math.min(contextMenu.y, window.innerHeight - 160),
            }}
          >
            {(contextMenu.task.status === 'waiting' || contextMenu.task.target_timestamp) && (
              <>
                <button
                  onClick={() => {
                    setResetTimer({ task: contextMenu.task, input: '' })
                    setContextMenu(null)
                  }}
                >
                  重新设定倒计时
                </button>
                <button onClick={() => cancelWaitAction(contextMenu.task)}>取消倒计时</button>
                <div className="sw-ctx-div" />
              </>
            )}
            <button className="danger" onClick={() => completeTaskAction(contextMenu.task)}>
              完成任务
            </button>
          </div>
        </>
      )}

      {/* 重设倒计时弹窗 */}
      {resetTimer && (
        <div className="sw-reset-backdrop" onClick={() => setResetTimer(null)}>
          <div className="sw-reset-card" onClick={(e) => e.stopPropagation()}>
            <div className="sw-reset-label">重新设定倒计时</div>
            <div className="sw-reset-title">{resetTimer.task.title}</div>
            <div className="sw-reset-quick">
              {[5, 20, 40].map((m) => (
                <button
                  key={m}
                  onClick={async () => {
                    window.dayflow.todo.startWait(resetTimer.task.id, m * 60)
                    setResetTimer(null)
                    void fetchData()
                  }}
                >
                  +{m}m
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={resetTimer.input}
              onChange={(e) => setResetTimer({ ...resetTimer, input: e.target.value })}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  const seconds = parseSimpleTime(resetTimer.input)
                  if (seconds) {
                    window.dayflow.todo.startWait(resetTimer.task.id, seconds)
                    setResetTimer(null)
                    void fetchData()
                  }
                } else if (e.key === 'Escape') {
                  setResetTimer(null)
                }
              }}
              placeholder="30m, 1h, 45s ..."
            />
            <div className="sw-reset-hint">Enter 确认 · Esc 取消</div>
          </div>
        </div>
      )}
    </div>
  )
}
