import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayPlan, Project, StandupPayload, TimelineCard } from '@shared/types'
import { addDays, dayKeyLabel, formatDuration } from '../lib/format'

/** 4 AM..4 AM 一天切分为 10 分钟格：12 行（每行 2 小时）x 12 格。 */
function DayGrid({ cards, projects, onJump }: { cards: TimelineCard[]; projects: Project[]; onJump?: (minute: number) => void }): React.ReactElement {
  const CELL_MIN = 10
  const CELLS_PER_BAND = 12
  const BANDS = 12
  const cells = BANDS * CELLS_PER_BAND
  const intensity = useMemo(() => {
    const arr = new Array<number>(cells).fill(0)
    const localMinute = (ts: number): number => {
      const d = new Date(ts)
      let min = d.getHours() * 60 + d.getMinutes()
      if (min < 240) min += 1440
      return min - 240 // 0 = 凌晨 4 点
    }
    for (const c of cards) {
      const startMin = Math.max(0, Math.floor(localMinute(c.startTs) / CELL_MIN))
      const endMin = Math.min(cells, Math.ceil(localMinute(c.endTs) / CELL_MIN))
      const proj = projects.find((p) => p.title === c.category)
      const score = proj?.productivityScore ?? 5
      const weight = /idle|空闲/i.test(c.category) ? 0.2 : score <= 3 ? 0.5 : score >= 6 ? 1 : 0.75
      for (let m = startMin; m < endMin; m++) {
        if (m >= 0 && m < cells) arr[m] = Math.max(arr[m], weight)
      }
    }
    return arr
  }, [cards, cells])

  const bandLabel = (band: number): string => {
    const h = (4 + band * 2) % 24
    return `${String(h).padStart(2, '0')}时`
  }

  const cellTitle = (i: number): string => {
    const minutesFrom4 = i * CELL_MIN
    const h24 = Math.floor((minutesFrom4 + 240) / 60) % 24
    const mm = minutesFrom4 % 60
    return `${String(h24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  }

  return (
    <div
      className="day-grid"
      style={{ gridTemplateRows: `repeat(${BANDS}, 1fr)`, gridTemplateColumns: `48px repeat(${CELLS_PER_BAND}, 1fr)` }}
    >
      {Array.from({ length: BANDS }).map((_, band) => (
        <React.Fragment key={band}>
          <div className="dg-hour-label" style={{ gridColumn: 1, gridRow: band + 1 }}>
            {bandLabel(band)}
          </div>
          {Array.from({ length: CELLS_PER_BAND }).map((_, col) => {
            const i = band * CELLS_PER_BAND + col
            const level = intensity[i]
            const bg =
              level >= 1
                ? '#4a5fd9'
                : level >= 0.5
                  ? '#ec7a52'
                  : level > 0
                    ? '#c9cef0'
                    : '#f2ead9'
            return (
              <div
                key={i}
                className="dg-cell"
                style={{ background: bg, gridColumn: col + 2, gridRow: band + 1 }}
                title={cellTitle(i)}
                onClick={() => onJump?.(i * CELL_MIN)}
              />
            )
          })}
        </React.Fragment>
      ))}
    </div>
  )
}

interface Priority {
  id: string
  text: string
  done: boolean
}

export default function DailyPage(): React.ReactElement {
  const [day, setDay] = useState('')
  const [today, setToday] = useState('')
  const [standup, setStandup] = useState<StandupPayload | null>(null)
  const [plan, setPlan] = useState<DayPlan | null>(null)
  const [newPriority, setNewPriority] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')
  const [yesterdayCards, setYesterdayCards] = useState<TimelineCard[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    void window.dayflow.getTodayKey().then((t) => {
      setToday(t)
      setDay(t)
    })
  }, [])

  const load = useCallback(() => {
    if (!day) return
    void window.dayflow.getStandup(day).then(setStandup)
    void window.dayflow.getDayPlan(day).then(setPlan)
    void window.dayflow.getDay(addDays(day, -1)).then((d) =>
      setYesterdayCards(d.cards.filter((c) => !c.isIdle))
    )
    void window.dayflow.listProjects().then(setProjects)
  }, [day])

  useEffect(load, [load])

  const persistPlan = (next: DayPlan): void => {
    setPlan(next)
    void window.dayflow.saveDayPlan(next)
  }

  const togglePriority = (id: string): void => {
    if (!plan) return
    persistPlan({
      ...plan,
      priorities: plan.priorities.map((p) => (p.id === id ? { ...p, done: !p.done } : p))
    })
  }

  const addPriority = (): void => {
    const text = newPriority.trim()
    if (!text || !plan) return
    persistPlan({
      ...plan,
      priorities: [...plan.priorities, { id: `${Date.now()}`, text, done: false }]
    })
    setNewPriority('')
  }

  const removePriority = (id: string): void => {
    if (!plan) return
    persistPlan({ ...plan, priorities: plan.priorities.filter((p) => p.id !== id) })
  }

  const generate = (): void => {
    setGenerating(true)
    setGenError('')
    void window.dayflow.generateStandup(day).then((res) => {
      setGenerating(false)
      if (res.ok && res.payload) setStandup(res.payload)
      else setGenError(res.error ?? '站会生成失败')
    })
  }

  const yesterdayTotal = yesterdayCards.reduce((a, c) => a + (c.endTs - c.startTs), 0) / 60000

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1 className="page-title">每日站会</h1>
          <div className="page-subtitle">{day ? dayKeyLabel(day) : ''}</div>
        </div>
        <div className="header-actions">
          <div className="day-nav">
            <button className="icon-btn" onClick={() => setDay(addDays(day, -1))}>
              ‹
            </button>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 135 }} />
            <button className="icon-btn" onClick={() => setDay(addDays(day, 1))}>
              ›
            </button>
            <button className="btn small" onClick={() => setDay(today)}>
              今天
            </button>
          </div>
          <button className="btn primary" onClick={generate} disabled={generating}>
            {generating ? '生成中…' : standup ? '重新生成站会' : '生成站会'}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          一天活动概览
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            昨天：{formatDuration(yesterdayTotal)} · {yesterdayCards.length} 项活动
          </span>
        </div>
        <DayGrid cards={yesterdayCards} projects={projects} />
        <div className="field-help" style={{ marginTop: 8 }}>
          蓝色 = 专注工作 · 橙红 = 分心 · 灰色 = 空闲。网格从凌晨 4 点到次日 4 点（Dayflow 的日起算边界）。
        </div>
      </div>

      {genError && (
        <div className="panel" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>
          <span style={{ color: 'var(--red)' }}>{genError}</span>
        </div>
      )}

      <div className="standup-grid">
        <div className="panel">
          <div className="panel-title">昨日亮点</div>
          {standup ? (
            <div>
              {standup.summary && (
                <p style={{ color: 'var(--text-dim)', lineHeight: 1.6, marginTop: 0 }}>
                  {standup.summary}
                </p>
              )}
              {standup.highlights.map((h, i) => (
                <div className="highlight-item" key={i}>
                  <span className="highlight-bullet">✓</span>
                  <span>{h}</span>
                </div>
              ))}
              {standup.highlights.length === 0 && (
                <div className="field-help">昨天没有找到值得汇报的亮点。</div>
              )}
            </div>
          ) : (
            <div className="field-help">
              根据昨天的时间线生成站会内容——亮点可以直接贴到团队频道。
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            阻塞项
            {plan && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>自动保存</span>}
          </div>
          {standup && standup.blockers.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {standup.blockers.map((b, i) => (
                <div className="highlight-item blocker" key={i}>
                  <span className="highlight-bullet">!</span>
                  <span>{b}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            placeholder="填写你目前的阻塞项…"
            value={plan?.blockers ?? ''}
            onChange={(e) => plan && persistPlan({ ...plan, blockers: e.target.value })}
            style={{ width: '100%' }}
          />
        </div>

        <div className="panel wide">
          <div className="panel-title">今日要务</div>
          <div className="priority-list">
            {(plan?.priorities ?? []).map((p) => (
              <div key={p.id} className={`priority-item ${p.done ? 'done' : ''}`}>
                <button
                  className={`pr-check ${p.done ? 'done' : ''}`}
                  onClick={() => togglePriority(p.id)}
                >
                  {p.done ? '✓' : ''}
                </button>
                <span className="pr-text">{p.text}</span>
                <button className="pr-remove" onClick={() => removePriority(p.id)}>
                  ×
                </button>
              </div>
            ))}
            {(plan?.priorities.length ?? 0) === 0 && (
              <div className="field-help">添加今天最重要的几件事，它们会进入明天的站会。</div>
            )}
          </div>
          <div className="add-row">
            <input
              type="text"
              placeholder="添加一条要务…"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPriority()}
            />
            <button className="btn" onClick={addPriority}>
              添加
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
