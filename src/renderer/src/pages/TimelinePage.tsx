import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppActivity, Project, TaskActivity, TimelineCard } from '@shared/types'
import type { CardScreenshot, DayData } from '../../../preload/index'
import { addDays, clockFromTs, dayKeyLabel, formatDuration, parseDayKey } from '../lib/format'
import { dragState } from '../lib/drag'

interface Expanded extends Record<number, CardScreenshot[]> {}

const PROJECT_COLORS = ['#e8763a', '#4a5fd9', '#2fa47a', '#c79be8', '#f08a6a', '#7ba8e8', '#4fd1b5', '#d4a843', '#e05252', '#6f665a']

/** 类型树（Timing：无限层级 + 颜色 + 拖放目标）。 */
function ProjectTree({
  projects,
  activities,
  onAssign,
  onCreate,
  onDelete,
  onColor,
  onFilter,
  filterId,
  expanded,
  toggleExpand
}: {
  projects: Project[]
  activities: AppActivity[]
  onAssign: (projectId: number, alt: boolean) => void
  onCreate: (title: string, parentId: number | null) => void
  onDelete: (id: number) => void
  onColor: (id: number, color: string) => void
  onFilter: (id: number | null) => void
  filterId: number | null
  expanded: Set<number>
  toggleExpand: (id: number) => void
}): React.ReactElement {
  const [newTitle, setNewTitle] = useState('')
  const [addingUnder, setAddingUnder] = useState<number | null | 'root'>(null)

  const minutesOf = (id: number): number =>
    activities.filter((a) => a.projectId === id).reduce((acc, a) => acc + (a.endTs - a.startTs), 0) / 60000

  const renderNode = (p: Project, depth: number): React.ReactElement => {
    const children = projects.filter((x) => x.parentId === p.id)
    const min = minutesOf(p.id)
    return (
      <div key={p.id}>
        <div
          className={`project-row${filterId === p.id ? ' filter-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onDragOver={(e) => {
            e.preventDefault()
            e.currentTarget.classList.add('drop-target')
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
          onDrop={(e) => {
            e.preventDefault()
            e.currentTarget.classList.remove('drop-target')
            onAssign(p.id, e.altKey)
          }}
        >
          {children.length > 0 ? (
            <button className="icon-btn tree-toggle" onClick={() => toggleExpand(p.id)}>
              {expanded.has(p.id) ? '−' : '+'}
            </button>
          ) : (
            <span className="tree-toggle" />
          )}
          <input
            type="color"
            className="color-input mini"
            value={p.color}
            onChange={(e) => onColor(p.id, e.target.value)}
            title="项目颜色"
          />
          <span
            className="project-title"
            title={`${p.title} · 点击过滤该类型活动`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation()
              onFilter(filterId === p.id ? null : p.id)
            }}
          >
            {p.title}
          </span>
          {min >= 1 && <span className="project-min">{formatDuration(min)}</span>}
          <button
            className="icon-btn tree-add"
            title="新建子项目"
            onClick={() => {
              setAddingUnder(p.id)
              setNewTitle('')
            }}
          >
            +
          </button>
          <button className="icon-btn tree-del" title="删除项目" onClick={() => onDelete(p.id)}>
            ×
          </button>
        </div>
        {addingUnder === p.id && (
          <div className="add-row" style={{ paddingLeft: 20 + depth * 14 }}>
            <input
              autoFocus
              type="text"
              placeholder="子项目名称…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTitle.trim()) {
                  onCreate(newTitle.trim(), p.id)
                  setAddingUnder(null)
                }
              }}
            />
            <button
              className="btn small"
              onClick={() => {
                if (newTitle.trim()) onCreate(newTitle.trim(), p.id)
                setAddingUnder(null)
              }}
            >
              建
            </button>
          </div>
        )}
        {expanded.has(p.id) && children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const roots = projects.filter((p) => p.parentId === null)
  return (
    <div className="panel project-tree">
      <div className="panel-title">
        项目
        <button
          className="btn small"
          onClick={() => {
            setAddingUnder('root')
            setNewTitle('')
          }}
        >
          + 新建
        </button>
      </div>
      {addingUnder === 'root' && (
        <div className="add-row">
          <input
            autoFocus
            type="text"
            placeholder="项目名称…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTitle.trim()) {
                onCreate(newTitle.trim(), null)
                setAddingUnder(null)
              }
            }}
          />
          <button
            className="btn small"
            onClick={() => {
              if (newTitle.trim()) onCreate(newTitle.trim(), null)
              setAddingUnder(null)
            }}
          >
            建
          </button>
        </div>
      )}
      {roots.map((p) => renderNode(p, 0))}
      {roots.length === 0 && (
        <div className="field-help">还没有项目。新建一个，然后把右侧活动拖进来归类。</div>
      )}
    </div>
  )
}

/**
 * Timing 式「活动树」：项目 → 应用 → 文档/URL 三层，
 * 时长列右对齐、彩色圆点/应用徽标、折叠箭头（对齐 Timing All Activities 截图）。
 */
interface ANode {
  key: string
  label: string
  minutes: number
  color: string
  depth: 0 | 1 | 2
  icon: 'dot' | 'app' | 'doc' | 'link' | 'chat' | 'timer'
  letter?: string
  children: ANode[]
  /** 拖拽归类:该节点覆盖的活动 id 与 app/title 语义 */
  ids: number[]
  app?: string
  title?: string
}

function fmtDur(min: number): string {
  const m = Math.max(1, Math.round(min))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

function ActivityTree({
  activities,
  tasks,
  projects,
  colorOf,
  icons
}: {
  activities: AppActivity[]
  tasks: TaskActivity[]
  projects: Project[]
  colorOf: (id: number | null) => string
  icons: Record<string, string>
}): React.ReactElement {
  // key -> explicitly toggled expanded state (default: depth 0/1 open, depth 2 closed)
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())
  const isExpanded = (node: ANode): boolean => overrides.get(node.key) ?? node.depth < 2
  const toggle = (node: ANode): void => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(node.key, !isExpanded(node))
      return next
    })
  }

  const titleGroup = (a: AppActivity): string => {
    if (a.urlOrPath) {
      try {
        return new URL(a.urlOrPath).hostname.replace(/^www\./, '') + new URL(a.urlOrPath).pathname
      } catch {
        return a.urlOrPath
      }
    }
    return (a.title || '（无标题）').replace(/[|·—–\-:：]\s*[^|·—–\-:：]*$/, '').trim() || '（无标题）'
  }

  // project -> app -> title（各层积累活动 ids 供拖拽归类）
  const byProj = new Map<
    string,
    {
      minutes: number
      projId: number | null
      ids: number[]
      byApp: Map<string, { minutes: number; ids: number[]; byTitle: Map<string, { minutes: number; ids: number[] }> }>
    }
  >()
  for (const a of activities) {
    if (a.isIdle) continue // AFK 段不计入学习时间(用户定)
    const min = (a.endTs - a.startTs) / 60000
    const pkey = String(a.projectId ?? 'null')
    const P = byProj.get(pkey) ?? { minutes: 0, projId: a.projectId, ids: [] as number[], byApp: new Map() }
    P.minutes += min
    P.ids.push(a.id)
    const A = P.byApp.get(a.appName) ?? { minutes: 0, ids: [] as number[], byTitle: new Map() }
    A.minutes += min
    A.ids.push(a.id)
    const tg = titleGroup(a)
    const T = A.byTitle.get(tg) ?? { minutes: 0, ids: [] }
    T.minutes += min
    T.ids.push(a.id)
    A.byTitle.set(tg, T)
    P.byApp.set(a.appName, A)
    byProj.set(pkey, P)
  }
  for (const t of tasks) {
    const min = ((t.endTs ?? Date.now()) - t.startTs) / 60000
    const pkey = String(t.projectId ?? 'null')
    const P = byProj.get(pkey) ?? { minutes: 0, projId: t.projectId, ids: [] as number[], byApp: new Map() }
    P.minutes += min
    const A = P.byApp.get('__timer__') ?? { minutes: 0, ids: [] as number[], byTitle: new Map() }
    A.minutes += min
    A.byTitle.set(t.title, (A.byTitle.get(t.title) ?? 0) + min)
    P.byApp.set('__timer__', A)
    byProj.set(pkey, P)
  }

  const tree: ANode[] = [...byProj.entries()]
    .sort((a, b) => b[1].minutes - a[1].minutes)
    .map(([pkey, P]) => {
      const proj = projects.find((x) => x.id === P.projId)
      return {
        key: `p${pkey}`,
        label: proj?.title ?? '未归类',
        minutes: P.minutes,
        color: colorOf(P.projId),
        depth: 0 as const,
        icon: 'dot' as const,
        ids: P.ids,
        children: [...P.byApp.entries()]
          .sort((a, b) => b[1].minutes - a[1].minutes)
          .map(([app, A]) => ({
            key: `p${pkey}|${app}`,
            label: app === '__timer__' ? '⏱ 手动计时' : app,
            minutes: A.minutes,
            color: colorOf(P.projId),
            depth: 1 as const,
            icon: (app === '__timer__' ? 'timer' : 'app') as ANode['icon'],
            letter: app === '__timer__' ? '⏱' : app.charAt(0).toUpperCase(),
            ids: A.ids,
            app,
            children: [...A.byTitle.entries()]
              .sort((a, b) => b[1].minutes - a[1].minutes)
              .map(([title, T]) => ({
                key: `p${pkey}|${app}|${title}`,
                label: title,
                minutes: T.minutes,
                color: colorOf(P.projId),
                depth: 2 as const,
                icon: (title.startsWith('http') || title.includes('.') && !title.includes(' ')
                  ? 'link'
                  : title.includes('/') || title.includes('\\')
                    ? 'doc'
                    : 'chat') as ANode['icon'],
                ids: T.ids,
                app,
                title,
                children: []
              }))
          }))
      }
    })

  const total = tree.reduce((a, n) => a + n.minutes, 0)

  const Row = ({ node }: { node: ANode }): React.ReactElement => {
    const open = isExpanded(node)
    const hasKids = node.children.length > 0
    return (
      <>
      <div
        className="atr-row"
        style={{ paddingLeft: 10 + node.depth * 26 }}
        onClick={() => hasKids && toggle(node)}
        draggable={node.depth > 0}
                onDragStart={(e) => {
                  dragState.current = {
                    kind: node.depth === 2 ? 'row' : 'band',
                    ids: node.ids,
                    appName: node.depth >= 1 ? (node.app ?? node.label) : node.label,
                    title: node.depth === 2 ? node.label : '',
                    url: activities.find((a) => a.urlOrPath && node.ids.includes(a.id))?.urlOrPath ?? undefined
                  }
                  e.dataTransfer?.setData('text/plain', node.ids.join(','))
                }}
      >
          <span className="atr-dur">{fmtDur(node.minutes)}</span>
          <span className="atr-chev">{hasKids ? (open ? '⌄' : '⮕') : ''}</span>
          <span className="atr-icon">
            {node.icon === 'dot' ? (
              <span className="atr-dot" style={{ background: node.color }} />
            ) : node.icon === 'app' || node.icon === 'timer' ? (
              icons[node.label] ? (
                <img className="atr-appicon" src={icons[node.label]} alt="" />
              ) : (
                <span
                  className="atr-badge"
                  style={{ background: `${node.color}2e`, color: node.color, borderColor: `${node.color}55` }}
                >
                  {node.letter}
                </span>
              )
            ) : (
              <span className="atr-glyph">
                {node.icon === 'link' ? '🔗' : node.icon === 'doc' ? '📄' : '💬'}
              </span>
            )}
          </span>
          <span className="atr-name" title={node.label}>
            {node.label}
          </span>
          {node.depth === 0 && node.label === '未归类' && (
            <span className="chip unclassified" style={{ marginLeft: 8 }}>
              去整理
            </span>
          )}
        </div>
        {open && node.children.map((c) => <Row key={c.key} node={c} />)}
      </>
    )
  }

  return (
    <div className="atr-wrap">
      <div
        className="atr-row root"
        onClick={() => {
          const rootKey = '__root__'
          setOverrides((prev) => {
            const next = new Map(prev)
            next.set(rootKey, !(next.get(rootKey) ?? true))
            return next
          })
        }}
      >
        <span className="atr-dur">{fmtDur(total)}</span>
        <span className="atr-chev">{overrides.get('__root__') === false ? '⮕' : '⌄'}</span>
        <span className="atr-icon">
          <span className="atr-dot" style={{ background: 'var(--accent)' }} />
        </span>
        <span className="atr-name" style={{ fontWeight: 700 }}>
          全部活动
        </span>
      </div>
      {overrides.get('__root__') !== false && tree.map((n) => <Row key={n.key} node={n} />)}
    </div>
  )
}

/**
 * Timing 式全局时间轴 + 语义缩放（LOD）。
 * 默认显示规则（对齐 Timing）：
 *   (a) 同一大类的连续时段合并为一条色带，内部细节不显示，只显长度；
 *   (b) 时段大 → 显示所属类别名（不显示具体应用/标题）；
 *   (c) 时段小 → 什么都不显示。
 * 交互显示规则：
 *   (a) 放大后，时段足够大才显示具体标题（app + title）；
 *   (b) 鼠标悬停任意块（哪怕 1px）→ 浮窗显示完整信息。
 */

/** 混白 72% 的不透明粉彩——密集区堆叠时保持干净的马赛克。 */
/** hex → rgba(带透明度);非 hex 原样返回。 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color)
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`
}

function pastel(hex: string): string {
  try {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const mix = (c: number): number => Math.round(c + (255 - c) * 0.84)
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`
  } catch {
    return hex
  }
}

interface DragGroup {
  ids: number[]
  appName: string
  title: string
}
let dragIdRef: DragGroup | null = null

/** 应用名哈希 → 稳定色相（图标方块底色，Timing 式彩色方块）。 */
function appHue(app: string): string {
  let hash = 0
  for (let i = 0; i < app.length; i++) hash = (hash * 31 + app.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 73%)`
}

interface BandSeg {
  ids: number[]
  appName: string
  title: string
  urlOrPath: string | null
  startTs: number
  endTs: number
  isIdle: boolean
}

interface Band {
  ids: number[]
  segments: BandSeg[]
  startTs: number
  endTs: number
  projectId: number | null
  dominantApp: string
  dominantTitle: string
  urlOrPath: string | null
  isTask: boolean
  isIdle: boolean // 段内大部分时间无键鼠输入（半透明显示，不留空白）
  taskTitle?: string
  running?: boolean
}

/** 吸收式合并：<2 分钟碎片 / 同应用 / 同项目 邻段融合。 */
function absorbMerge(activities: AppActivity[]): BandSeg[] {
  const sorted = [...activities].sort((a, b) => a.startTs - b.startTs)
  const out: BandSeg[] = []
  for (const a of sorted) {
    const last = out[out.length - 1]
    const dur = a.endTs - a.startTs
    const gap = last ? a.startTs - last.endTs : Infinity
    const sameEntity =
      last !== undefined &&
      (last.appName === a.appName || dur < 120_000)
    if (last && gap < 120_000 && sameEntity) {
      last.ids.push(a.id)
      last.endTs = Math.max(last.endTs, a.endTs)
      last.isIdle = last.isIdle && (a.isIdle ?? false)
      if (a.title && (!last.title || a.endTs - a.startTs > 0)) {
        if ((a.title ?? '').length > (last.title ?? '').length) last.title = a.title
      }
      if (a.urlOrPath && !last.urlOrPath) last.urlOrPath = a.urlOrPath
    } else {
      out.push({
        ids: [a.id],
        appName: a.appName,
        title: a.title,
        urlOrPath: a.urlOrPath,
        startTs: a.startTs,
        endTs: a.endTs,
        isIdle: a.isIdle ?? false
      })
    }
  }
  return out
}

/** 同项目连续段（间隙 <5 分钟）合并为一条大类色带（ProjectSlice 语义）。 */
function buildBands(activities: AppActivity[], tasks: TaskActivity[]): Band[] {
  const segs = absorbMerge(activities)
  const bands: Band[] = []
  let i = 0
  while (i < segs.length) {
    const group: BandSeg[] = [segs[i]]
    const proj = activities.find((a) => segs[i].ids.includes(a.id))?.projectId ?? null
    let j = i + 1
    while (
      j < segs.length &&
      segs[j].startTs - group[group.length - 1].endTs < 5 * 60_000 &&
      (activities.find((a) => segs[j].ids.includes(a.id))?.projectId ?? null) === proj
    ) {
      group.push(segs[j])
      j++
    }
    const startTs = group[0].startTs
    const endTs = Math.max(...group.map((g) => g.endTs))
    let dom = group[0]
    for (const g of group) {
      if (g.endTs - g.startTs > dom.endTs - dom.startTs) dom = g
    }
    const idleMs = group.reduce((acc, g) => acc + (g.isIdle ? g.endTs - g.startTs : 0), 0)
    const totalMs = Math.max(1, endTs - startTs)
    bands.push({
      ids: group.flatMap((g) => g.ids),
      segments: group,
      startTs,
      endTs,
      projectId: proj,
      dominantApp: dom.appName,
      dominantTitle: dom.title,
      urlOrPath: dom.urlOrPath,
      isTask: false,
      isIdle: idleMs > totalMs * 0.6
    })
    i = j
  }
  for (const t of tasks) {
    bands.push({
      ids: [t.id],
      segments: [
        {
          ids: [t.id],
          appName: 'manual',
          title: t.title,
          urlOrPath: null,
          startTs: t.startTs,
          endTs: t.endTs ?? Date.now(),
          isIdle: false
        }
      ],
      startTs: t.startTs,
      endTs: t.endTs ?? Date.now(),
      projectId: t.projectId,
      dominantApp: '⏱ 手动',
      dominantTitle: t.title,
      urlOrPath: null,
      isTask: true,
      isIdle: false,
      taskTitle: t.title,
      running: !t.endTs
    })
  }
  return bands.sort((a, b) => a.startTs - b.startTs)
}

interface TipState {
  x: number
  y: number
  band: Band
}

function TimingAxis({
  activities,
  tasks,
  day,
  today,
  projects,
  colorOf,
  onSelect,
  onTimePick,
  selected,
  onAddManual,
  icons,
  sessions,
  ratios,
  segments
}: {
  activities: AppActivity[]
  tasks: TaskActivity[]
  day: string
  today: string
  projects: Project[]
  colorOf: (id: number | null) => string
  onSelect: (a: AppActivity | null) => void
  onTimePick?: (start: number, end: number) => void
  segments: Record<number, { segStart: number; segEnd: number; score: number }[]>
  selected: AppActivity | null
  onAddManual: (minute: number) => void
  icons?: Record<string, string>
  sessions: { id: number; taskId: number | null; title: string; startTs: number; endTs: number; color: string }[]
  ratios: Record<number, number | null>
}): React.ReactElement {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [ppm, setPpm] = useState(1.15)
  // Ctrl+滚轮缩放:以光标下的时刻为锚点缩放,缩放后把该时刻滚回光标处
  const pendingScrollRef = React.useRef<number | null>(null)
  const lastWheelZoomRef = React.useRef(0)
  React.useLayoutEffect(() => {
    const el = trackRef.current
    if (!el || pendingScrollRef.current == null) return
    el.scrollTop = Math.max(0, pendingScrollRef.current)
    pendingScrollRef.current = null
  }, [ppm])
  React.useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const offsetY = e.clientY - rect.top
      const minAtCursor = (el.scrollTop + offsetY) / ppm
      const next = Math.min(12, Math.max(0.2, ppm * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      pendingScrollRef.current = minAtCursor * next - offsetY
      lastWheelZoomRef.current = Date.now()
      setPpm(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ppm])
  const [tip, setTip] = useState<TipState | null>(null)
  const [sessionTip, setSessionTip] = useState<{ s: { id: number; title: string; startTs: number; endTs: number }; x: number; y: number } | null>(null)
  const nowTs = Date.now()

  const d = parseDayKey(day)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  const totalH = 1440 * ppm
  const yOf = (ts: number): number => ((ts - start) / 60000) * ppm
  const hOf = (ts1: number, ts2: number): number =>
    Math.max(((ts2 - ts1) / 60000) * ppm - 3, 2)
  const fmtMin = (m: number): string => clockFromTs(start + m * 60000)

  const bands = buildBands(activities, tasks)
  const isToday = day === today
  const nowY = isToday ? yOf(nowTs) : -1

  // LOD 文字规则（px 高度 + 缩放双闸门）
  const lodOf = (h: number): 'none' | 'category' | 'full' => {
    if (h < 30) return 'none'
    if (ppm >= 2.2 && h >= 72) return 'full'
    return 'category'
  }

  // 自动滚动：今天 → 现在；过去 → 最后活动。
  // Ctrl+滚轮缩放后 1.5s 内跳过——ppm 变化会触发本 effect,把鼠标锚定的视口抢回"现在"
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    if (Date.now() - lastWheelZoomRef.current < 1500) return
    const lastEnd = bands.length ? Math.max(...bands.map((b) => b.endTs)) : 0
    const target = isToday && nowY >= 0 ? nowY : lastEnd ? yOf(lastEnd) : 0
    el.scrollTop = Math.max(0, target - 380)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, activities.length > 0, ppm])

  const hours: React.ReactElement[] = []
  for (let h = 0; h <= 24; h += 2) {
    hours.push(
      <div className="ta-hour-line" style={{ top: h * 60 * ppm }} key={h}>
        <span className="ta-hour-label">{fmtMin(h * 60)}</span>
      </div>
    )
  }

  return (
    <div className="ta-wrap">
      <div className="ta-zoom" title="悬停看详情 · 放大后显示标题 · 拖拽归类（Alt=建规则）· 双击空白补录">
        <button className="btn small" title="回到整日视野（也可 Ctrl+滚轮缩放）" onClick={() => setPpm(0.5)}>
          全天概览
        </button>
      </div>
      <div
        ref={trackRef}
        className="ta-track"
        style={{ overflowY: 'auto' }}
        onDoubleClick={(e) => {
          const el = trackRef.current
          if (!el) return
          if ((e.target as HTMLElement).closest('.ta-band')) return
          const rect = el.getBoundingClientRect()
          const top = e.clientY - rect.top + el.scrollTop
          onAddManual(Math.max(0, Math.round(top / ppm)))
        }}
        onMouseLeave={() => setTip(null)}
      >
        <div className="ta-canvas" style={{ height: totalH }}>
          {hours}
          {/* 任务窄条（用户裁决）：右侧窄列，色块=专注会话，填充高度=合规比例，点击看详情 */}
          <div className="ta-task-strip" title="任务窄条：点击色块看会话详情">
            {sessions.map((sess) => {
              const top = yOf(sess.startTs)
              const hh = Math.max(((sess.endTs - sess.startTs) / 60000) * ppm - 3, 2)
              const ratio = ratios[sess.id]
              const segs = segments[sess.id]
              const block = (t: number, h: number, bg: string, key: React.Key, segScore?: number) => (
                <div
                  key={key}
                  className="ta-task-block"
                  style={{ top: t, height: h, background: bg }}
                  title={segScore != null ? `专注度 ${segScore}% · 点击看详情` : '点击看会话详情'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSessionTip({ s: sess, x: e.clientX, y: e.clientY })
                  }}
                >
                  {segScore == null && ratio != null && ratio > 0 && (
                    <div className="ta-task-fill" style={{ height: Math.round(ratio * 100) + '%' }} />
                  )}
                </div>
              )
              // 分段专注度:AI 按截图时段给出的百分制评分 → 颜色深浅
              if (segs && segs.length > 0) {
                return segs.map((sg, i) => {
                  const segTop = yOf(Math.max(sg.segStart, sess.startTs))
                  const segEnd = Math.min(sg.segEnd, sess.endTs)
                  const segH = Math.max(((segEnd - Math.max(sg.segStart, sess.startTs)) / 60000) * ppm - 2, 2)
                  return block(segTop, segH, withAlpha(sess.color, 0.18 + 0.82 * (sg.score / 100)), `${sess.id}-${i}`, sg.score)
                })
              }
              return block(top, hh, sess.color, sess.id)
            })}
          </div>
          {sessionTip && (
            <div className="ta-session-pop" style={{ left: sessionTip.x + 12, top: sessionTip.y }} onClick={() => setSessionTip(null)}>
              <div className="ta-session-title">{sessionTip.s.title}</div>
              <div>
                {clockFromTs(sessionTip.s.startTs)} – {clockFromTs(sessionTip.s.endTs)}（
                {Math.round((sessionTip.s.endTs - sessionTip.s.startTs) / 60000)} 分钟）
              </div>
              <div>
                合规比例：
                {ratios[sessionTip.s.id] == null
                  ? '未分析'
                  : Math.round((ratios[sessionTip.s.id] as number) * 100) + '%（截图判定在做任务）'}
              </div>
              <div className="ta-session-hint">点击关闭</div>
            </div>
          )}
          {bands.map((b) => {
            const color = colorOf(b.projectId)
            const proj = projects.find((p) => p.id === b.projectId)
            const h = hOf(b.startTs, b.endTs)
            const lod = lodOf(h)
            const durMin = (b.endTs - b.startTs) / 60000
            const rep =
              activities
                .filter((x) => b.ids.includes(x.id))
                .sort((a, c) => c.endTs - c.startTs - (a.endTs - a.startTs))[0] ?? null
            const isSel = selected && b.ids.includes(selected.id)
            // Timing 式左侧图标栏：按应用时长堆叠彩色图标方块（≥4 个收敛为 +N）
            const appBreakdown = new Map<string, number>()
            for (const sg of b.segments) {
              appBreakdown.set(sg.appName, (appBreakdown.get(sg.appName) ?? 0) + (sg.endTs - sg.startTs))
            }
            const topApps = [...appBreakdown.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4)
            const extraApps = appBreakdown.size - topApps.length
            const showIcons = h >= 26
            return (
              <div
                key={`${b.startTs}-${b.ids[0]}`}
                className={`ta-band ${lod} ${isSel ? 'selected' : ''} ${b.isTask ? 'task' : ''} ${b.isIdle ? 'idle' : ''}`}
                style={{
                  top: yOf(b.startTs),
                  height: h,
                  background: b.isTask ? 'rgba(47,164,122,.14)' : pastel(color)
                }}
                draggable={!b.isTask}
                onDragStart={(e) => {
                  dragState.current = {
                    kind: 'band',
                    ids: b.ids,
                    appName: b.dominantApp,
                    title: b.dominantTitle
                  }
                  e.dataTransfer?.setData('text/plain', b.ids.join(','))
                }}
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, band: b })}
                onMouseLeave={() => setTip(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(rep && selected?.id === rep.id ? null : rep)
                  onTimePick?.(rep.startTs, rep.endTs)
                }}
              >
                {showIcons && (
                  <div className="ta-icon-col">
                    {topApps.map(([app, ms]) => (
                      <div className="ta-icon-sq" key={app} style={{ flexGrow: ms, background: appHue(app) }} title={app}>
                        {icons?.[app] ? (
                          <img src={icons[app]} alt="" />
                        ) : (
                          <span>{b.isTask ? '⏱' : app.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                    ))}
                    {extraApps > 0 && (
                      <div className="ta-icon-sq more" style={{ flexGrow: 1 }} title={`还有 ${extraApps} 个应用`}>
                        <span>+{extraApps}</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="ta-strip-col" style={{ background: color }} />
                {lod !== 'none' && (
                  <div className="ta-band-row">
                    {lod === 'full' &&
                      (icons?.[b.dominantApp] ? (
                        <img className="atr-appicon" src={icons[b.dominantApp]} alt="" />
                      ) : (
                        <span className="win-app">{b.dominantApp}</span>
                      ))}
                    {lod === 'full' ? (
                      <span className="ta-band-title">{b.dominantTitle || '（无标题）'}</span>
                    ) : (
                      <span className="ta-band-cat" style={{ color }}>
                        {proj?.title ?? (b.isTask ? '手动计时' : '未归类')}
                      </span>
                    )}
                    <span className="ta-dur">{formatDuration(durMin)}</span>
                    {lod === 'category' && b.segments.length > 1 && (
                      <span className="ta-dur">{b.segments.length} 段</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {nowY >= 0 && nowY <= totalH && (
            <div className="ta-now" style={{ top: nowY }}>
              <span className="ta-now-label">现在</span>
            </div>
          )}
        </div>
      </div>

      {tip && (
        <div className="ta-tip" style={{ left: Math.min(tip.x + 16, window.innerWidth - 360), top: tip.y + 14 }}>
          <div className="ta-tip-head">
            {clockFromTs(tip.band.startTs)} – {clockFromTs(tip.band.endTs)} ·{' '}
            {formatDuration((tip.band.endTs - tip.band.startTs) / 60000)}
          </div>
          <div className="ta-tip-cat">
            <span
              className="dot"
              style={{ background: colorOf(tip.band.projectId), display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6 }}
            />
            {projects.find((p) => p.id === tip.band.projectId)?.title ?? '未归类'}
            {tip.band.segments.length > 1 && ` · ${tip.band.segments.length} 段`}
            {new Set(tip.band.segments.map((x) => x.appName)).size > 1 &&
              ` · ${new Set(tip.band.segments.map((x) => x.appName)).size} 个应用`}
          </div>
          <div className="ta-tip-list">
            {tip.band.segments
              .slice()
              .sort((a, b) => b.endTs - b.startTs - (a.endTs - a.startTs))
              .slice(0, 8)
              .map((sg, k) => (
                <div key={k} className="ta-tip-row">
                  {icons?.[sg.appName] ? (
                    <img className="atr-appicon tiny" src={icons[sg.appName]} alt="" />
                  ) : null}
                  <span className="ta-tip-app">{sg.appName}</span>
                  <span className="ta-tip-title">{sg.title || '（无标题）'}</span>
                  <span className="ta-tip-dur">{formatDuration((sg.endTs - sg.startTs) / 60000)}</span>
                </div>
              ))}
            {tip.band.segments.length > 8 && (
              <div className="ta-tip-row">… 还有 {tip.band.segments.length - 8} 段</div>
            )}
            {tip.band.isIdle && (
              <div className="ta-tip-row" style={{ color: 'var(--text-faint)' }}>
                此段大部分时间无键鼠输入（无输入 ≠ 离开，仍记录屏幕活动）
              </div>
            )}
          </div>
          {tip.band.urlOrPath && <div className="ta-tip-url">{tip.band.urlOrPath}</div>}
        </div>
      )}
    </div>
  )
}

export default function ActivitiesView({
  day,
  setDay,
  today,
  projects,
  onDataChanged
}: {
  day: string
  setDay: (d: string) => void
  today: string
  projects: Project[]
  onDataChanged: () => void
}): React.ReactElement {
  const [view, setView] = useState<'unified' | 'category' | 'chrono' | 'cards'>('category')
  const [query, setQuery] = useState('')
  const [activities, setActivities] = useState<AppActivity[]>([])
  const [dayTasks, setDayTasks] = useState<TaskActivity[]>([])
  const [cards, setCards] = useState<TimelineCard[]>([])
  const [pending, setPending] = useState(0)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [selectedActivity, setSelectedActivity] = useState<AppActivity | null>(null)
  const [manualDraft, setManualDraft] = useState<{ minute: number; title: string; dur: number } | null>(null)
  const [expanded, setExpanded] = useState<Record<number, CardScreenshot[]>>({})
  const [loadingShots, setLoadingShots] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [appIcons, setAppIcons] = useState<Record<string, string>>({})
  const [focusSessions, setFocusSessions] = useState<{ id: number; taskId: number | null; title: string; startTs: number; endTs: number; color: string }[]>([])
  const [sessionRatios, setSessionRatios] = useState<Record<number, number | null>>({})
  const [segByHistory, setSegByHistory] = useState<Record<number, { segStart: number; segEnd: number; score: number }[]>>({})
  // 过滤器:左侧类型列表点击=按类型过滤;右栏时间块点击=按时间段过滤
  const [typeFilterId, setTypeFilterId] = useState<number | null>(null)
  const [timeFilter, setTimeFilter] = useState<{ start: number; end: number } | null>(null)
  const [treeExpanded, setTreeExpanded] = useState<Set<number>>(new Set())
  const [ruleDraft, setRuleDraft] = useState<{
    projectId: number
    projectName: string
    field: 'app' | 'title' | 'urlOrPath'
    value: string
    ids: number[]
  } | null>(null)

  const projectColor = (id: number | null): string =>
    projects.find((p) => p.id === id)?.color ?? '#b0a794'

  const load = useCallback(() => {
    if (!day) return
    void window.dayflow.getActivities(day).then(setActivities)
    void window.dayflow.getDay(day).then((d) => {
      setCards(d.cards)
      setPending(d.pending)
      setPipelineError(d.pipelineError)
    })
    const [y, m, dd] = day.split('-').map(Number)
    const ds = new Date(y, m - 1, dd, 4, 0, 0, 0).getTime()
    void window.dayflow.listTasks(ds, ds + 86400_000).then(setDayTasks)
    void window.dayflow.todo
      .focusSessions(day)
      .then((rows) => {
        setFocusSessions(rows as never)
        return window.dayflow.todo.sessionAnalyses(day)
      })
      .then((rows) => {
        const map: Record<number, number | null> = {}
        for (const r of rows as { historyId: number; ratio: number | null }[]) map[r.historyId] = r.ratio
        setSessionRatios(map)
      })
    void window.dayflow.todo.sessionSegments(day).then((rows) => {
      const map: Record<number, { segStart: number; segEnd: number; score: number }[]> = {}
      for (const r of rows as unknown as { historyId: number; segStart: number; segEnd: number; score: number }[]) {
        ;(map[r.historyId] ??= []).push({ segStart: r.segStart, segEnd: r.segEnd, score: r.score })
      }
      setSegByHistory(map)
    })
  }, [day])

  useEffect(() => {
    load()
    return window.dayflow.onTimelineChanged(() => {
      load()
      onDataChanged()
    })
  }, [load, onDataChanged])

  // 任务窄条合规比例：进入当日惰性分析一次（结果缓存入库，judge 失败静默）
  useEffect(() => {
    if (!day) return
    void window.dayflow.todo
      .analyzeDay(day)
      .then(() => window.dayflow.todo.sessionAnalyses(day))
      .then((rows) => {
        const map: Record<number, number | null> = {}
        for (const r of rows as { historyId: number; ratio: number | null }[]) map[r.historyId] = r.ratio
        setSessionRatios(map)
      })
      .catch(() => {})
  }, [day])

  // 应用真实图标（exe 提取，主进程缓存）
  useEffect(() => {
    const names = [...new Set(activities.map((a) => a.appName))]
    if (names.length === 0) return
    void window.dayflow.getAppIcons(names).then((icons) =>
      setAppIcons((prev) => ({ ...prev, ...icons }))
    )
  }, [activities])

  const assign = (activityId: number, projectId: number | null): void => {
    void window.dayflow.assignActivity(activityId, projectId).then(() => {
      load()
      onDataChanged()
    })
  }

  const toggleTreeExpand = (id: number): void =>
    setTreeExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const assignIds = (ids: number[], projectId: number): void => {
    void Promise.all(ids.map((id) => window.dayflow.assignActivity(id, projectId))).then(() => {
      load()
      onDataChanged()
    })
  }

  // 类型树投放:列表行(title 拖动)= 弹窗建规则;时间轴块 = 直接归类,Alt = 建规则。
  // 浏览器活动带已解析网址时,预填「网址包含 域名」——标题分不清的站内页面靠网址分。
  const onTreeAssign = (projectId: number, alt: boolean): void => {
    const d = dragState.current
    if (!d) return
    if (alt || d.kind === 'row') {
      let field: 'app' | 'title' | 'urlOrPath' = d.kind === 'row' ? 'title' : 'app'
      let value = d.kind === 'row' ? d.title : d.appName
      if (d.url) {
        try {
          const host = new URL(d.url).hostname.replace(/^www\./, '')
          if (host) {
            field = 'urlOrPath'
            value = host
          }
        } catch {
          // 非法 URL(如文件路径)保持 title 预填
        }
      }
      setRuleDraft({
        projectId,
        projectName: projects.find((p) => p.id === projectId)?.title ?? '',
        field,
        value,
        ids: d.ids,
      })
      dragState.current = null
      return
    }
    assignIds(d.ids, projectId)
    dragState.current = null
  }

  const createRuleNow = (): void => {
    if (!ruleDraft) return
    const value = ruleDraft.value.trim()
    if (!value) return
    void window.dayflow
      .createRule(ruleDraft.projectId, [{ field: ruleDraft.field, op: 'contains', value }])
      .then(() => {
        if (ruleDraft.ids.length > 0) assignIds(ruleDraft.ids, ruleDraft.projectId)
        setRuleDraft(null)
        load()
        onDataChanged()
      })
  }

  const matchQuery = (app: string, title: string): boolean => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return app.toLowerCase().includes(q) || title.toLowerCase().includes(q)
  }

  // 类型过滤含子类型;时间过滤=活动与时段有交集
  const typeFilterIds = useMemo(() => {
    if (typeFilterId == null) return null
    const ids = new Set<number>([typeFilterId])
    let grew = true
    while (grew) {
      grew = false
      for (const p of projects) {
        if (p.parentId != null && ids.has(p.parentId) && !ids.has(p.id)) {
          ids.add(p.id)
          grew = true
        }
      }
    }
    return ids
  }, [typeFilterId, projects])
  const filteredActivities = activities.filter(
    (a) =>
      matchQuery(a.appName, a.title) &&
      (typeFilterIds == null || typeFilterIds.has(a.projectId ?? -1)) &&
      (timeFilter == null || (a.startTs < timeFilter.end && a.endTs > timeFilter.start))
  )
  const filteredCards = cards.filter((c) => {
    if (query.trim()) {
      if (
        !c.title.toLowerCase().includes(query.toLowerCase()) &&
        !c.summary.toLowerCase().includes(query.toLowerCase())
      )
        return false
    }
    if (typeFilterIds != null) {
      const catId = projects.find((p) => p.title === c.category)?.id ?? -1
      if (!typeFilterIds.has(catId)) return false
    }
    if (timeFilter != null && !(c.startTs < timeFilter.end && c.endTs > timeFilter.start)) return false
    return true
  })

  const totalMin = activities.reduce((a, x) => a + (x.endTs - x.startTs), 0) / 60000

  // ---- 统一视图：时间相近的段融合成会话行 ----
  const sessions = (() => {
    const sorted = [...filteredActivities].sort((a, b) => a.startTs - b.startTs)
    const out: { startTs: number; endTs: number; apps: string[]; title: string; minutes: number; ids: number[] }[] = []
    for (const a of sorted) {
      const last = out[out.length - 1]
      if (last && a.startTs - last.endTs < 5 * 60_000) {
        last.endTs = Math.max(last.endTs, a.endTs)
        if (!last.apps.includes(a.appName)) last.apps.push(a.appName)
        if ((a.title ?? '').length > (last.title ?? '').length) last.title = a.title
        last.ids.push(a.id)
      } else {
        out.push({
          startTs: a.startTs,
          endTs: a.endTs,
          apps: [a.appName],
          title: a.title,
          minutes: 0,
          ids: [a.id]
        })
      }
    }
    for (const x of out) x.minutes = (x.endTs - x.startTs) / 60000
    return out.sort((a, b) => b.minutes - a.minutes)
  })()

  const toggleCardShots = (card: TimelineCard): void => {
    if (expanded[card.id]) {
      const next = { ...expanded }
      delete next[card.id]
      setExpanded(next)
      return
    }
    setExpanded({ ...expanded, [card.id]: [] })
    setLoadingShots(card.id)
    void window.dayflow.getScreenshotsForCard(card, 8).then((shots) => {
      setExpanded((prev) => ({ ...prev, [card.id]: shots }))
      setLoadingShots(null)
    })
  }

  return (
    <div className="act-shell">
      {/* ================= 中栏：活动树 / 会话 / 时间序 / 卡片 ================= */}
      <div className="act-center">
        <div className="act-toolbar">
          <div className="day-nav">
            <button className="icon-btn" onClick={() => setDay(addDays(day, -1))} title="前一天">
              ‹
            </button>
            <button className="btn small" onClick={() => setDay(today)}>
              {day === today ? '今天' : dayKeyLabel(day)}
            </button>
            <button className="icon-btn" onClick={() => setDay(addDays(day, 1))} title="后一天">
              ›
            </button>
          </div>
          <span className="tb-divider" />
          <input
            type="text"
            placeholder="搜索活动…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 170 }}
          />
          <span className="tb-divider" />
          <div className="task-chip">
            <input
              type="text"
              placeholder="手动计时…"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              style={{ width: 110 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && taskTitle.trim()) {
                  void window.dayflow.startTask(taskTitle.trim(), null, false).then(() => {
                    setTaskTitle('')
                    load()
                  })
                }
              }}
            />
            <button
              className="btn small primary"
              disabled={!taskTitle.trim()}
              onClick={() => {
                void window.dayflow.startTask(taskTitle.trim(), null, false).then(() => {
                  setTaskTitle('')
                  load()
                })
              }}
            >
              开始
            </button>
          </div>
          <button
            className="btn small ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => void window.dayflow.exportMarkdown(day, day)}
          >
            导出当天
          </button>
        </div>

        <div className="act-head">
          <h2 className="act-title">
            全部活动: <strong>{formatDuration(totalMin)}</strong>
          </h2>
          <div className="view-toggle">
            {(
              [
                ['unified', '统一'],
                ['category', '按类别'],
                ['chrono', '按时间'],
                ['cards', 'AI 卡片']
              ] as ['unified' | 'category' | 'chrono' | 'cards', string][]
            ).map(([v, label]) => (
              <button
                key={v}
                className={`btn small ${view === v ? 'primary' : ''}`}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {pending > 0 && (
          <div className="pending-note" style={{ margin: '8px 0' }}>
            <span className="spinner" />
            正在分析 {pending} 张快照…
            <button className="btn small" onClick={() => void window.dayflow.forceFlush()}>
              立即分析
            </button>
          </div>
        )}
        {pipelineError && (
          <div className="pending-note" style={{ margin: '8px 0', borderColor: 'rgba(248,113,113,0.4)' }}>
            <span style={{ color: 'var(--red)' }}>⚠</span>
            上次 AI 分析失败：{pipelineError}
          </div>
        )}

        <div className="act-body">
        <div className="act-content">
        {(typeFilterId != null || timeFilter != null) && (
          <div className="act-filterbar">
            <span className="act-filterhint">过滤中：</span>
            {typeFilterId != null && (
              <span className="act-filterchip">
                类型 {projects.find((p) => p.id === typeFilterId)?.title ?? typeFilterId}
                <button onClick={() => setTypeFilterId(null)}>✕</button>
              </span>
            )}
            {timeFilter != null && (
              <span className="act-filterchip">
                时间 {clockFromTs(timeFilter.start)}–{clockFromTs(timeFilter.end)}
                <button onClick={() => setTimeFilter(null)}>✕</button>
              </span>
            )}
            <button className="act-filterclear" onClick={() => { setTypeFilterId(null); setTimeFilter(null) }}>
              清除
            </button>
          </div>
        )}
          {view === 'category' && (
            <ActivityTree activities={filteredActivities} tasks={dayTasks} projects={projects} colorOf={projectColor} icons={appIcons} />
          )}

          {view === 'unified' && (
            <div className="atr-wrap">
              {sessions.map((sn) => (
                <div
                  className="atr-row"
                  key={sn.startTs}
                  style={{ paddingLeft: 12 }}
                  draggable
                  onDragStart={(e) => {
                    dragState.current = { kind: 'row', ids: sn.ids, appName: sn.apps[0], title: sn.title }
                    e.dataTransfer?.setData('text/plain', sn.ids.join(','))
                  }}
                >
                  <span className="atr-dur">{formatDuration(sn.minutes)}</span>
                  <span className="atr-chev" />
                  <span className="atr-icon">
                    <span className="atr-badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)', borderColor: '#e59a6355' }}>
                      {sn.apps[0].charAt(0).toUpperCase()}
                    </span>
                  </span>
                  <span className="atr-name">
                    {sn.apps.slice(0, 3).join(' / ')} — {sn.title || '（无标题）'}
                  </span>
                  <span className="ac-time" style={{ flexShrink: 0 }}>
                    {clockFromTs(sn.startTs)}–{clockFromTs(sn.endTs)}
                  </span>
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="empty-state">
                  <h3>没有活动记录</h3>
                </div>
              )}
            </div>
          )}

          {view === 'chrono' && (
            <div className="atr-wrap">
              {filteredActivities.map((a) => (
                <div
                  className="atr-row"
                  key={a.id}
                  style={{ paddingLeft: 12 }}
                  draggable
                  onDragStart={(e) => {
                    dragState.current = { kind: 'row', ids: [a.id], appName: a.appName, title: a.title, url: a.urlOrPath ?? undefined }
                    e.dataTransfer?.setData('text/plain', String(a.id))
                  }}
                  onClick={() => setSelectedActivity(a)}
                >
                  <span className="atr-dur">{formatDuration((a.endTs - a.startTs) / 60000)}</span>
                  <span className="atr-chev" />
                  <span className="atr-icon">
                    <span className="atr-dot" style={{ background: projectColor(a.projectId) }} />
                  </span>
                  <span className="atr-name">
                    {a.appName} — {a.title || '（无标题）'}
                  </span>
                  <span className="ac-time" style={{ flexShrink: 0 }}>
                    {clockFromTs(a.startTs)}–{clockFromTs(a.endTs)}
                  </span>
                </div>
              ))}
              {filteredActivities.length === 0 && (
                <div className="empty-state">
                  <h3>没有活动记录</h3>
                </div>
              )}
            </div>
          )}

          {view === 'cards' && (
            <div className="timeline-list">
              {filteredCards.map((card) => {
                const proj = projects.find((p) => p.title === card.category)
                const color = proj?.color ?? '#b0a794'
                const isOpen = expanded[card.id] !== undefined
                return (
                  <div key={card.id} className={`activity-card ${card.isIdle ? 'idle' : ''}`}>
                    <div className="accent-rail" style={{ background: color }} />
                    <div className="ac-body" onClick={() => toggleCardShots(card)}>
                      <div className="ac-head">
                        <span className="ac-time">
                          {card.start} – {card.end}
                        </span>
                        <span className="ac-title">{card.title}</span>
                        <span className="chip">
                          <span className="dot" style={{ background: color }} />
                          {card.category}
                        </span>
                        <span className="ac-duration">{formatDuration((card.endTs - card.startTs) / 60000)}</span>
                      </div>
                      {card.summary && <div className="ac-summary">{card.summary}</div>}
                      {isOpen && (
                        <div className="ac-expanded" onClick={(e) => e.stopPropagation()}>
                          {card.detailedSummary && <div className="detail-lines">{card.detailedSummary}</div>}
                          {loadingShots === card.id && <span className="spinner" />}
                          {(expanded[card.id] ?? []).length > 0 && (
                            <div className="shots-row">
                              {(expanded[card.id] ?? []).map((shot) => (
                                <img
                                  key={shot.id}
                                  className="shot-thumb"
                                  src={shot.dataUrl}
                                  alt={clockFromTs(shot.capturedAt)}
                                  onClick={() => setLightbox(shot.dataUrl)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {filteredCards.length === 0 && (
                <div className="empty-state">
                  <h3>还没有 AI 卡片</h3>
                  <p>AI 卡片由窗口时间轴（主）+ 屏幕截图（补充）融合生成，约 15 分钟一批。</p>
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {ruleDraft && (
        <div className="modal-backdrop" onClick={() => setRuleDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>创建归类规则</h2>
            <p className="modal-sub">
              把「{ruleDraft.field === 'app' ? ruleDraft.value : ruleDraft.value.slice(0, 40)}」归到类别「
              {ruleDraft.projectName}」——之后匹配的活动自动归类
            </p>
            <div className="settings-row">
              <div className="settings-row-label">匹配字段</div>
              <select
                value={ruleDraft.field}
                onChange={(e) => setRuleDraft({ ...ruleDraft, field: e.target.value as 'app' | 'title' | 'urlOrPath' })}
              >
                <option value="app">应用名包含</option>
                <option value="title">窗口标题包含</option>
                <option value="urlOrPath">网址包含</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">关键词</div>
              <input
                style={{ flex: 1, marginLeft: 12, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-strong)' }}
                value={ruleDraft.value}
                onChange={(e) => setRuleDraft({ ...ruleDraft, value: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => void createRuleNow()}>
                创建规则并回溯应用
              </button>
              {ruleDraft.ids.length > 0 && (
                <button
                  className="btn"
                  onClick={() => {
                    assignIds(ruleDraft.ids, ruleDraft.projectId)
                    setRuleDraft(null)
                  }}
                >
                  仅归类选中活动
                </button>
              )}
              <button className="btn ghost" onClick={() => setRuleDraft(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 右栏：全局时间轴（LOD） ================= */}
      <div className="act-gantt">
        <TimingAxis
          activities={activities}
          tasks={dayTasks}
          day={day}
          today={today}
          projects={projects}
          colorOf={projectColor}
          icons={appIcons}
          onSelect={setSelectedActivity}
          onTimePick={(start, end) =>
            setTimeFilter((prev) => (prev && prev.start === start && prev.end === end ? null : { start, end }))
          }
          selected={selectedActivity}
          onAddManual={(minute) => setManualDraft({ minute, title: '', dur: 30 })}
          sessions={focusSessions}
          ratios={sessionRatios}
          segments={segByHistory}
        />
        {selectedActivity && (
          <div className="panel ta-detail">
            <div className="panel-title">
              <span className="win-app">{selectedActivity.appName}</span>
              {selectedActivity.title || '（无标题）'}
              <button className="btn small ghost" onClick={() => setSelectedActivity(null)}>
                关闭
              </button>
            </div>
            {selectedActivity.urlOrPath && <div className="field-help">URL：{selectedActivity.urlOrPath}</div>}
            <div className="ai-group-actions">
              <span className="field-help" style={{ margin: 0 }}>
                归属：{projects.find((p) => p.id === selectedActivity.projectId)?.title ?? '未归类'}
              </span>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value !== '') {
                    assign(selectedActivity.id, Number(e.target.value))
                    setSelectedActivity(null)
                  }
                }}
                style={{ maxWidth: 150 }}
              >
                <option value="">改归项目…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {manualDraft && (
          <div className="panel ta-detail" style={{ borderColor: 'var(--green)' }}>
            <div className="panel-title">补录手动时间</div>
            <div className="ai-group-actions">
              <input
                autoFocus
                type="text"
                placeholder="做了什么…"
                value={manualDraft.title}
                onChange={(e) => setManualDraft({ ...manualDraft, title: e.target.value })}
                style={{ flex: 1, minWidth: 130 }}
              />
              <select
                value={manualDraft.dur}
                onChange={(e) => setManualDraft({ ...manualDraft, dur: Number(e.target.value) })}
              >
                {[15, 30, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} 分钟
                  </option>
                ))}
              </select>
              <button
                className="btn primary"
                disabled={!manualDraft.title.trim()}
                onClick={() => {
                  const d = parseDayKey(day)
                  const st =
                    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime() +
                    manualDraft.minute * 60000
                  void window.dayflow
                    .createManualTask(st, st + manualDraft.dur * 60000, manualDraft.title.trim(), null, false)
                    .then(() => {
                      setManualDraft(null)
                      load()
                    })
                }}
              >
                补录
              </button>
              <button className="btn ghost" onClick={() => setManualDraft(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="屏幕快照" />
        </div>
      )}
    </div>
  )
}
