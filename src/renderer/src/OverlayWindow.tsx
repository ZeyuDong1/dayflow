import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAncestorChain, fitBreadcrumbLevels } from '@shared/hierarchy'
import { getTimerDisplay } from '@shared/reminder-logic'
import type { TaskRow, TodoEvent } from '@shared/todo-types'

interface OverlaySettingsShape {
  opacity: number
  fontSize: number
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
  const titleRef = useRef<HTMLSpanElement>(null)

  const refresh = useCallback(() => {
    void window.dayflow.todo.getTasks().then(setTasks)
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
        if (e.type === 'fetch-tasks' || e.type === 'timer:update') refresh()
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
          const etaH = Number((t.context_memo ?? '').match(/eta_hours"?[:\s]+([\d.]+)/)?.[1] ?? NaN)
          const etaTs = Number.isFinite(etaH) ? now + etaH * 3600_000 : Number.POSITIVE_INFINITY
          return { t, etaTs }
        })
        .sort((a, b) => a.etaTs - b.etaTs)
        .slice(0, 3),
    [tasks, now],
  )

  const ancestors = focusTask ? getAncestorChain(tasks, focusTask.id) : []
  const crumb = ancestors.map((a) => a.title).join(' / ')

  const glowVars = settings
    ? ({
        '--focus-glow-radius': `${settings.focusGlowIntensity}px`,
        '--focus-glow-speed': `${settings.focusGlowSpeed}s`,
        '--marquee-duration': `${Math.max(0.5, 320 / Math.max(1, settings.focusMarqueeSpeed))}s`,
        opacity: settings.opacity / 100,
        fontSize: `${settings.fontSize}px`,
        color: settings.color,
      } as React.CSSProperties)
    : {}

  return (
    <div className="ow-root" style={glowVars}>
      <div className="ow-row ow-focus">
        <span className="ow-icon">🧠</span>
        {focusTask ? (
          <span className="ow-focus-body">
            {crumb && (
              <span className="ow-crumb">
                {settings?.focusMarqueeEnabled ? (
                  <span className="ow-marquee">
                    <span className="ow-marquee-track">
                      <span>{crumb} / {focusTask.title}</span>
                      <span aria-hidden>{crumb} / {focusTask.title}</span>
                    </span>
                  </span>
                ) : (
                  <span className={settings?.focusGlowEnabled ? 'ow-glow' : ''}>{crumb} / {focusTask.title}</span>
                )}
              </span>
            )}
            {!crumb && (
              <span className={settings?.focusGlowEnabled ? 'ow-glow ow-title' : 'ow-title'} ref={titleRef}>
                {focusTask.title}
              </span>
            )}
            <span className="ow-timer">{getTimerDisplay(focusTask, now)}</span>
          </span>
        ) : (
          <span className="ow-dim">No Active Focus</span>
        )}
      </div>

      {sideTasks.map((t) => (
        <div key={t.id} className="ow-row ow-side">
          <span className="ow-icon">◎</span>
          <span className={settings?.sideGlowEnabled ? 'ow-glow ow-title' : 'ow-title'}>{t.title}</span>
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

      {training.map(({ t, etaTs }) => (
        <div key={t.id} className="ow-row ow-train">
          <span className="ow-icon">📈</span>
          <span className="ow-title">{t.title}</span>
          <span className="ow-timer">{Number.isFinite(etaTs) ? `结束 ${fmtEnd(etaTs)}` : getTimerDisplay(t, now)}</span>
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
