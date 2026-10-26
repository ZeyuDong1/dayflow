import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAncestorChain, fitBreadcrumbLevels } from '@shared/hierarchy'
import { getTimerDisplay } from '@shared/reminder-logic'
import type { TaskRow, TodoEvent } from '@shared/todo-types'

interface OverlaySettingsShape {
  opacity: number
  fontSize: number
  fontWeight?: number
  focusFontScale?: number
  sideFontScale?: number
  color: string
  mouseIgnore: boolean
  focusGlowEnabled: boolean
  focusGlowIntensity: number
  focusGlowSpeed: number
  sideGlowEnabled: boolean
  focusMarqueeEnabled: boolean
  focusMarqueeSpeed: number
  sideMarqueeEnabled: boolean
}

interface AiCardLite {
  id: string
  source: string
  title: string
  status: string
}

interface TrainingRec {
  taskId: number
  gpuName: string
  modelName?: string
  metrics?: Record<string, unknown>
  lastUpdated: number
  stalled: boolean
  source: string
  wandbUrl?: string
}

function bangCount(title: string): number {
  let n = 0
  for (const ch of title) if (ch === '!') n++
  return n
}

function fmtEnd(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => x.toString().padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ChevronRightIco({ size }: { size: number }) {
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
      style={{ flexShrink: 0 }}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** 标题(滚动=双拷贝跑马灯 prefix 随滚 / 静态=line-clamp 截断) */
function MarqueeTitle({
  title, prefix, glow, marquee, titleCls,
}: {
  title: string
  prefix?: React.ReactNode
  glow: boolean
  marquee: boolean
  titleCls: string
}) {
  if (marquee) {
    return (
      <span className="ow-marquee">
        <span className={`ow-marquee-track ${glow ? 'ow-glow' : ''}`}>
          <span>
            {prefix}
            <span className={titleCls}>{title}</span>
          </span>
          <span aria-hidden>
            {prefix}
            <span className={titleCls}>{title}</span>
          </span>
        </span>
      </span>
    )
  }
  return (
    <span className={`${titleCls} ow-static-title`} title={title}>
      {title}
    </span>
  )
}

interface CrumbTitleProps {
  title: string
  ancestors: TaskRow[]
  settings: OverlaySettingsShape | null
  emBase: number
  titleCls: string
  timerNode: React.ReactNode
  glow: boolean
  marquee: boolean
}

/** 焦点行标题+父任务面包屑(EpochToDo BreadcrumbTitle 对齐):
 * 滚动模式整条祖先链随跑马灯滚、不裁剪;静态模式在标题上方独立一行,
 * 隐藏测量层测真实宽度后只显示能完整放下的最近几级(不做半截截断)。 */
function CrumbTitle({ title, ancestors, settings, emBase, titleCls, timerNode, glow, marquee }: CrumbTitleProps) {
  const subRef = useRef<HTMLDivElement>(null)
  const timerMeasureRef = useRef<HTMLSpanElement>(null)
  const titleMeasureRef = useRef<HTMLSpanElement>(null)
  const levelRefs = useRef<(HTMLSpanElement | null)[]>([])
  const [visible, setVisible] = useState(0)
  const ancestorKey = ancestors.map((a) => `${a.id}:${a.title}`).join('|')

  useEffect(() => {
    if (marquee) return
    const sub = subRef.current
    const titleEl = titleMeasureRef.current
    if (!sub || !titleEl) return
    const compute = () => {
      const s = subRef.current
      const t = titleMeasureRef.current
      if (!s || !t) return
      const sepW = Math.ceil(emBase * 0.7) + 4 // ChevronRight + 2×gap
      const timerW = (timerMeasureRef.current?.offsetWidth ?? 0) + 8 // gap
      const levelWs = levelRefs.current.map((el) => el?.offsetWidth ?? Infinity)
      setVisible(fitBreadcrumbLevels(t.offsetWidth, levelWs, sepW, Math.max(0, s.clientWidth - timerW)))
    }
    compute()
    const ro = new ResizeObserver(compute)
    if (sub) ro.observe(sub)
    return () => ro.disconnect()
    // ancestorKey 覆盖祖先变化;ancestors 数组身份每轮渲染都变,不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ancestorKey, marquee, emBase, title])

  // EpochToDo 形态:面包屑与标题同一行(小字+›箭头),只显放得下的最近几级
  const shown = ancestors.slice(ancestors.length - visible)
  const chev = Math.max(8, Math.round(emBase * 0.7))
  const crumbLevels =
    shown.length > 0 ? (
      <span className="ow-crumb-inline">
        {shown.map((p) => (
          <span key={p.id} className="ow-crumblevel">
            <span className="ow-crumbtext">{p.title}</span>
            <ChevronRightIco size={chev} />
          </span>
        ))}
      </span>
    ) : undefined

  return (
    <div ref={subRef} className="ow-crumbsub">
      {!marquee && crumbLevels}
      <MarqueeTitle
        title={title}
        prefix={
          marquee && shown.length > 0 ? (
            <span className="ow-crumb">
              {shown.map((p) => (
                <span key={p.id}>
                  {p.title}
                  <ChevronRightIco size={chev} />
                </span>
              ))}
            </span>
          ) : undefined
        }
        glow={glow}
        marquee={marquee}
        titleCls={titleCls}
      />
      <span ref={timerMeasureRef} className="ow-measure" aria-hidden>
        {timerNode}
      </span>
      {timerNode}
      {!marquee && ancestors.length > 0 && (
        <div className="ow-measure" aria-hidden>
          <span ref={titleMeasureRef} className={titleCls}>
            {title}
          </span>
          {ancestors.map((p, i) => (
            <span
              key={p.id}
              ref={(el) => {
                levelRefs.current[i] = el
              }}
              className="ow-crumbtext"
            >
              {p.title}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function OverlayWindow() {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [cards, setCards] = useState<AiCardLite[]>([])
  const [now, setNow] = useState(Date.now())
  const [settings, setSettings] = useState<OverlaySettingsShape | null>(null)
  const [tsMap, setTsMap] = useState<Record<number, TrainingRec>>({})
  const titleRef = useRef<HTMLSpanElement>(null)

  // 悬浮窗路由：body 必须透明（主应用全局样式给 body 设了奶油底，不重置=整窗不透明）
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  const refresh = useCallback(() => {
    void window.dayflow.todo.getTasks().then(setTasks)
    void window.dayflow.todo.trainingStatus().then((rows) => {
      const map: Record<number, TrainingRec> = {}
      for (const r of rows as TrainingRec[]) map[r.taskId] = r
      setTsMap(map)
    })
  }, [])

  useEffect(() => {
    refresh()
    void window.dayflow.todo.getSettings().then((s) => {
      const q = s as unknown as { overlay_settings: OverlaySettingsShape }
      setSettings(q.overlay_settings ?? null)
    })
  }, [refresh])

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // 设置每 10s 轮询刷新（不逐秒拉）
  useEffect(() => {
    const t = window.setInterval(() => {
      void window.dayflow.todo.getSettings().then((s) => {
        const q = s as unknown as { overlay_settings: OverlaySettingsShape }
        setSettings(q.overlay_settings ?? null)
      })
    }, 10_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(
    () =>
      window.dayflow.todo.onEvent((e: TodoEvent) => {
        if (e.type === 'fetch-tasks' || e.type === 'timer:update' || e.type === 'timer:training-update') refresh()
        if (e.type === 'ai:reminder' && e.reminder) {
          const r = e.reminder
          setCards((c) => [{ id: r.id, source: r.source, title: r.title, status: r.status }, ...c].slice(0, 2))
        }
        if (e.type === 'ai:reminder-dismissed') {
          setCards((c) =>
            c.filter((card) => {
              if (e.source != null && card.source !== e.source) return true
              if (e.title != null && card.title !== e.title) return true
              return e.force === true ? false : card.status === 'needs_input' || card.status === 'review'
            }),
          )
        }
      }),
    [refresh],
  )

  const focusTask = useMemo(
    () =>
      tasks.find((t) => t.status === 'active' && t.type === 'standard') ??
      tasks.find((t) => t.status === 'active' && t.timer_type === 'focus') ??
      null,
    [tasks],
  )
  const sideTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.is_side_focus === 1 && t.status !== 'archived' && t.id !== focusTask?.id)
        .slice(0, 2),
    [tasks, focusTask],
  )
  const suspended = useMemo(
    () =>
      tasks
        .filter((t) => t.type === 'standard' && t.status === 'waiting' && t.id !== focusTask?.id)
        .sort((a, b) => (a.target_timestamp ?? '').localeCompare(b.target_timestamp ?? ''))
        .slice(0, 3),
    [tasks, focusTask],
  )
  const queued = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'queued' && t.type === 'standard')
        .sort((a, b) => {
          const d = bangCount(b.title) - bangCount(a.title)
          if (d !== 0) return d
          return (b.last_focused_at ?? '').localeCompare(a.last_focused_at ?? '')
        })
        .slice(0, 3),
    [tasks],
  )
  const reminders = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            t.type === 'reminder' &&
            t.status === 'waiting' &&
            t.target_timestamp != null &&
            Date.parse(t.target_timestamp) > now,
        )
        .sort((a, b) => (a.target_timestamp ?? '').localeCompare(b.target_timestamp ?? ''))
        .slice(0, 3),
    [tasks, now],
  )
  const overdue = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            t.type === 'reminder' &&
            t.status === 'waiting' &&
            t.target_timestamp != null &&
            Date.parse(t.target_timestamp) <= now,
        )
        .slice(0, 3),
    [tasks, now],
  )
  const training = useMemo(
    () =>
      tasks
        .filter((t) => t.type === 'training' && t.status !== 'archived')
        .map((t) => {
          const rec = tsMap[t.id]
          const etaH = Number(rec?.metrics?.['eta_hours'] ?? rec?.metrics?.['train/eta_hours'] ?? NaN)
          const endTs = Number.isFinite(etaH) ? rec.lastUpdated + etaH * 3_600_000 : Number.POSITIVE_INFINITY
          const cfg =
            (typeof rec?.metrics?.['cfgname'] === 'string' && (rec.metrics['cfgname'] as string)) ||
            rec?.modelName ||
            t.title
          return { t, cfg, endTs }
        })
        .sort((a, b) => a.endTs - b.endTs)
        .slice(0, 3),
    [tasks, tsMap],
  )

  const fontSize = settings?.fontSize ?? 14

  const glowVars = settings
    ? ({
        '--focus-glow-radius': `${settings.focusGlowIntensity}px`,
        '--focus-glow-speed': `${settings.focusGlowSpeed}s`,
        '--marquee-duration': `${Math.max(0.5, 320 / Math.max(1, settings.focusMarqueeSpeed))}s`,
        '--ow-weight': String(settings.fontWeight ?? 400),
        '--ow-focus-em': `${settings.focusFontScale ?? 1.8}em`,
        '--ow-side-em': `${settings.sideFontScale ?? 1.25}em`,
        // v2 样式块把行字号钉在 --ow-base 上,不注入的话设置里的字号滑杆是空调
        '--ow-base': `${settings.fontSize}px`,
        opacity: settings.opacity / 100,
        fontSize: `${settings.fontSize}px`,
        color: settings.color,
        WebkitAppRegion: settings.mouseIgnore ? 'none' : 'drag',
      } as React.CSSProperties)
    : {}

  return (
    <div className={settings && !settings.mouseIgnore ? "ow-root interactive" : "ow-root"} style={glowVars}>
      <div className="ow-row ow-focus">
        <span className="ow-icon">🧠</span>
        {focusTask ? (
          <CrumbTitle
            title={focusTask.title}
            ancestors={getAncestorChain(tasks, focusTask.id)}
            settings={settings}
            emBase={fontSize}
            titleCls="ow-focus-title"
            glow={!!settings?.focusGlowEnabled}
            marquee={!!settings?.focusMarqueeEnabled}
            timerNode={<span className="ow-timer">{getTimerDisplay(focusTask, now)}</span>}
          />
        ) : (
          <span className="ow-dim">No Active Focus</span>
        )}
      </div>

      {sideTasks.map((t) => (
        <div key={t.id} className="ow-row ow-side">
          <span className="ow-icon">◎</span>
          <CrumbTitle
            title={t.title}
            ancestors={getAncestorChain(tasks, t.id)}
            settings={settings}
            emBase={fontSize}
            titleCls="ow-side-title"
            glow={!!settings?.sideGlowEnabled}
            marquee={!!settings?.sideMarqueeEnabled}
            timerNode={<span className="ow-timer">{getTimerDisplay(t, now)}</span>}
          />
        </div>
      ))}

      {suspended.map((t) => (
        <div key={t.id} className="ow-row ow-susp">
          <span className="ow-icon">⏸</span>
          <span className="ow-title">{t.title}</span>
          <span className="ow-timer">{getTimerDisplay(t, now)}</span>
        </div>
      ))}

      {queued.map((t) => (
        <div key={t.id} className="ow-row ow-queued">
          <span className="ow-title">• {t.title}</span>
        </div>
      ))}

      {reminders.map((t) => (
        <div key={t.id} className="ow-row ow-remind">
          <span className="ow-icon">⚡</span>
          <span className="ow-title">{t.title}</span>
          <span className="ow-timer">{getTimerDisplay(t, now)}</span>
        </div>
      ))}

      {cards.map((c) => (
        <div key={c.id} className="ow-row ow-ai">
          <span className="ow-icon">🤖</span>
          <span className="ow-title">
            {c.title}
            {c.status !== 'info' ? ` [${c.status}]` : ''}
          </span>
        </div>
      ))}

      {training.map(({ t, cfg, endTs }) => (
        <div key={t.id} className="ow-row ow-train">
          <span className="ow-icon">📈</span>
          <span className="ow-title">{cfg}</span>
          <span className="ow-timer">{Number.isFinite(endTs) ? `结束 ${fmtEnd(endTs)}` : getTimerDisplay(t, now)}</span>
        </div>
      ))}

      {overdue.map((t) => (
        <div key={t.id} className="ow-row ow-overdue">
          <span className="ow-icon">🔔</span>
          <span className="ow-title">{t.title}</span>
        </div>
      ))}
    </div>
  )
}
