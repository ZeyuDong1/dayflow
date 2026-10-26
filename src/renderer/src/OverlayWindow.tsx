import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAncestorChain, fitBreadcrumbLevels } from '@shared/hierarchy'
import { getTimerDisplay } from '@shared/reminder-logic'
import type { TaskRow, TodoEvent } from '@shared/todo-types'

interface OverlaySettingsShape {
  opacity: number
  fontSize: number
  fontWeight?: number
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

  const bodyRef = useRef<HTMLSpanElement | null>(null)
  const [focusBoxW, setFocusBoxW] = useState(0)
  const fontSize = settings?.fontSize ?? 14
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFocusBoxW(el.clientWidth))
    ro.observe(el)
    setFocusBoxW(el.clientWidth)
    return () => ro.disconnect()
  }, [focusTask?.id])

  const measureCtx = useMemo(() => document.createElement('canvas').getContext('2d'), [])
  const measure = useCallback(
    (text: string, px: number, weight = 400): number => {
      if (!measureCtx) return text.length * px * 0.9
      measureCtx.font = `${weight} ${px}px 'LXGW WenKai', sans-serif`
      return measureCtx.measureText(text).width
    },
    [measureCtx],
  )

  const ancestors = focusTask ? getAncestorChain(tasks, focusTask.id) : []
  // 面包屑宽度自适应(原版语义):按真实渲染宽度判断还能显示几级父任务,
  // 不再用车估常数——Focus 标题 1.8em/700,面包屑 0.7em/400,余量 12px
  const FOCUS_EM = 1.8
  const CRUMB_EM = 0.7
  const fitCount = useMemo(() => {
    if (!focusTask) return 0
    const titleW = measure(focusTask.title, fontSize * FOCUS_EM, Math.max(700, settings?.fontWeight ?? 400))
    const sepW = measure(' / ', fontSize * CRUMB_EM)
    const levelWs = ancestors.map((a) => measure(a.title, fontSize * CRUMB_EM))
    const budget = Math.max(0, focusBoxW - 12)
    return fitBreadcrumbLevels(titleW, levelWs, sepW, budget)
  }, [focusTask, ancestors, fontSize, focusBoxW, measure, settings?.fontWeight])
  const crumb = ancestors.slice(ancestors.length - fitCount).map((a) => a.title).join(' / ')

  const glowVars = settings
    ? ({
        '--focus-glow-radius': `${settings.focusGlowIntensity}px`,
        '--focus-glow-speed': `${settings.focusGlowSpeed}s`,
        '--marquee-duration': `${Math.max(0.5, 320 / Math.max(1, settings.focusMarqueeSpeed))}s`,
        '--ow-weight': String(settings.fontWeight ?? 400),
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
          <span className="ow-focus-body">
            <span
              ref={bodyRef}
              className={settings?.focusMarqueeEnabled ? 'ow-marquee' : 'ow-static'}
              title={settings?.focusMarqueeEnabled ? undefined : focusTask.title}
            >
              <span className={`ow-marquee-track ${settings?.focusGlowEnabled ? 'ow-glow' : ''}`}>
                <span>
                  {crumb && <span className="ow-crumb">{crumb} / </span>}
                  <span className="ow-focus-title">{focusTask.title}</span>
                </span>
                {settings?.focusMarqueeEnabled && (
                  <span aria-hidden>
                    {crumb && <span className="ow-crumb">{crumb} / </span>}
                    <span className="ow-focus-title">{focusTask.title}</span>
                  </span>
                )}
              </span>
            </span>
            <span className="ow-timer">{getTimerDisplay(focusTask, now)}</span>
          </span>
        ) : (
          <span className="ow-dim">No Active Focus</span>
        )}
      </div>

      {sideTasks.map((t) => (
        <div key={t.id} className="ow-row ow-side">
          <span className="ow-icon">◎</span>
          {settings?.sideMarqueeEnabled ? (
            <span className="ow-marquee">
              <span className={`ow-marquee-track ${settings?.sideGlowEnabled ? 'ow-glow' : ''}`}>
                <span>{t.title}</span>
                <span aria-hidden>{t.title}</span>
              </span>
            </span>
          ) : (
            <span className={settings?.sideGlowEnabled ? 'ow-glow ow-title' : 'ow-title'}>{t.title}</span>
          )}
          <span className="ow-timer">{getTimerDisplay(t, now)}</span>
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
