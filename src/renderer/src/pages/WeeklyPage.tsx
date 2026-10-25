import React, { useEffect, useState } from 'react'
import type { WeeklyReview } from '@shared/types'
import { addDays, formatDuration, formatMinutesOfDay, dayKeyShort } from '../lib/format'

function Donut({ slices }: { slices: { name: string; colorHex: string; minutes: number }[] }): React.ReactElement {
  const total = slices.reduce((a, s) => a + s.minutes, 0)
  const size = 168
  const r = 66
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f2ead9" strokeWidth={20} />
        {total > 0 &&
          slices.map((s) => {
            const frac = s.minutes / total
            const dash = frac * c
            const el = (
              <circle
                key={s.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.colorHex}
                strokeWidth={20}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
              />
            )
            offset += dash
            return el
          })}
      </g>
      <text x="50%" y="47%" textAnchor="middle" fill="#2b2b2b" fontSize="17" fontWeight="700">
        {formatDuration(total)}
      </text>
      <text x="50%" y="58%" textAnchor="middle" fill="#a3988a" fontSize="10.5">
        总记录
      </text>
    </svg>
  )
}

/** 专注度配色：蓝（专注）→ 薰衣草 → 橙红（分心），与原版 Dayflow 一致。 */
function focusColor(ratio: number): string {
  if (ratio < 0) return '#f2ead9'
  if (ratio >= 0.85) return '#4a5fd9'
  if (ratio >= 0.65) return '#7f8fe0'
  if (ratio >= 0.45) return '#c9cef0'
  if (ratio >= 0.25) return '#f0b48f'
  return '#ec7a52'
}

function InteractionGraph({ nodes, edges }: { nodes: { app: string; minutes: number }[]; edges: { from: string; to: string; count: number }[] }): React.ReactElement {
  const W = 520
  const H = 330
  const cx = W / 2
  const cy = H / 2
  const R = 118
  const positions = new Map<string, { x: number; y: number }>()
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI - Math.PI / 2
    positions.set(n.app, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) })
  })
  const maxCount = Math.max(1, ...edges.map((e) => e.count))
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: 620 }}>
      {edges.map((e, i) => {
        const a = positions.get(e.from)
        const b = positions.get(e.to)
        if (!a || !b) return null
        const mx = (a.x + b.x) / 2 + (cy - (a.y + b.y) / 2) * 0.18
        const my = (a.y + b.y) / 2 + ((a.x + b.x) / 2 - cx) * 0.18
        return (
          <path
            key={i}
            d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
            fill="none"
            stroke="#e59a63"
            strokeOpacity={0.25 + (e.count / maxCount) * 0.55}
            strokeWidth={1 + (e.count / maxCount) * 3.5}
          />
        )
      })}
      {nodes.map((n) => {
        const p = positions.get(n.app)!
        const r = 8 + Math.min(14, (n.minutes / Math.max(1, nodes[0]?.minutes ?? 1)) * 12)
        return (
          <g key={n.app}>
            <circle cx={p.x} cy={p.y} r={r} fill="#fffdf8" stroke="#e8763a" strokeWidth={1.6} />
            <text
              x={p.x}
              y={p.y + r + 12}
              textAnchor="middle"
              fill="#6f665a"
              fontSize="9.5"
            >
              {n.app.length > 18 ? `${n.app.slice(0, 17)}…` : n.app}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function weekStartOf(dayKey: string): string {
  if (!dayKey) return ''
  const [y, m, d] = dayKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dow = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - dow)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

interface ProjectStat {
  projectId: number
  title: string
  color: string
  parentId: number | null
  productivityScore: number
  minutes: number
}

export default function WeeklyPage(): React.ReactElement {
  const [anchorDay, setAnchorDay] = useState('')
  const [today, setToday] = useState('')
  const [review, setReview] = useState<WeeklyReview | null>(null)
  const [projStats, setProjStats] = useState<{
    stats: ProjectStat[]
    unclassifiedMinutes: number
    productivityIndex: number | null
  } | null>(null)

  useEffect(() => {
    void window.dayflow.getTodayKey().then((t) => {
      setToday(t)
      setAnchorDay(t)
    })
  }, [])

  useEffect(() => {
    if (anchorDay) void window.dayflow.getWeekly(anchorDay).then(setReview)
  }, [anchorDay])

  useEffect(() => {
    if (!weekStartOf(anchorDay)) return
    const ws = weekStartOf(anchorDay)
    void window.dayflow.projectStats(ws, anchorDay).then(setProjStats)
  }, [anchorDay])

  const weekStart = review?.weekStart ?? ''
  const weekEnd = review?.weekEnd ?? ''

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1 className="page-title">每周回顾</h1>
          <div className="page-subtitle">
            {weekStart && `${dayKeyShort(weekStart)} – ${dayKeyShort(weekEnd)}`}
          </div>
        </div>
        <div className="header-actions">
          <div className="week-nav">
            <button className="icon-btn" onClick={() => setAnchorDay(addDays(anchorDay, -7))}>
              ‹
            </button>
            <button className="btn small" onClick={() => setAnchorDay(today)}>
              本周
            </button>
            <button className="icon-btn" onClick={() => setAnchorDay(addDays(anchorDay, 7))}>
              ›
            </button>
          </div>
        </div>
      </div>

      {review && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-value">{formatDuration(review.stats.totalMinutes)}</div>
              <div className="stat-label">总记录时长</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--green)' }}>
                {formatDuration(review.stats.focusMinutes)}
              </div>
              <div className="stat-label">专注工作</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--red)' }}>
                {formatDuration(review.stats.distractionMinutes)}
              </div>
              <div className="stat-label">分心时间</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{formatDuration(review.stats.longestFocusStreakMin)}</div>
              <div className="stat-label">最长专注连续段</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{review.stats.activeDays}/7</div>
              <div className="stat-label">活跃天数</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ fontSize: 17 }}>
                {review.stats.avgStartMinute !== null && review.stats.avgEndMinute !== null
                  ? `${formatMinutesOfDay(review.stats.avgStartMinute)} – ${formatMinutesOfDay(review.stats.avgEndMinute)}`
                  : '—'}
              </div>
              <div className="stat-label">典型活跃时段</div>
            </div>
          </div>

          {projStats && projStats.stats.filter((x) => x.minutes > 0).length > 0 && (
            <div className="panel wide" style={{ marginBottom: 16 }}>
              <div className="panel-title">
                项目时间与效率
                <span style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 400 }}>
                  {projStats.productivityIndex !== null
                    ? `效率指数 ${projStats.productivityIndex}（按项目效率分加权）`
                    : '在类型树上设置效率分后可计算效率指数'}
                </span>
                <button
                  className="btn small"
                  onClick={() => void window.dayflow.exportTimesheet(weekStart, weekEnd)}
                >
                  导出工时表 CSV
                </button>
              </div>
              <div className="app-usage-list">
                {projStats.stats
                  .filter((x) => x.minutes > 0)
                  .sort((a, b) => b.minutes - a.minutes)
                  .map((x) => {
                    const max = Math.max(...projStats.stats.map((y) => y.minutes), 1)
                    return (
                      <div className="app-usage-row" key={x.projectId}>
                        <span className="app-usage-name" title={x.title}>
                          {x.title}
                        </span>
                        <div className="app-usage-bar">
                          <div
                            className="app-usage-fill"
                            style={{ width: `${(x.minutes / max) * 100}%`, background: x.color }}
                          />
                        </div>
                        <span className="app-usage-min">{formatDuration(x.minutes)}</span>
                        {x.productivityScore !== 0 && (
                          <span className="chip">效率 {x.productivityScore}</span>
                        )}
                      </div>
                    )
                  })}
                {projStats.unclassifiedMinutes > 0 && (
                  <div className="field-help">
                    另有 {formatDuration(projStats.unclassifiedMinutes)} 未归类活动，去「整理」页分配。
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="weekly-layout">
            <div className="panel">
              <div className="panel-title">时间都去哪了</div>
              <div className="donut-wrap">
                <Donut slices={review.categories} />
                <div className="donut-legend">
                  {review.categories.map((c) => (
                    <div className="legend-row" key={c.name}>
                      <span className="legend-dot" style={{ background: c.colorHex }} />
                      {c.name}
                      <span className="legend-val">{formatDuration(c.minutes)}</span>
                    </div>
                  ))}
                  {review.categories.length === 0 && (
                    <div className="field-help">本周还没有记录。</div>
                  )}
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">应用与网站</div>
              {review.apps.map((a) => {
                const max = review.apps[0]?.minutes ?? 1
                return (
                  <div className="app-usage-row" key={a.app}>
                    <span className="app-usage-name" title={a.app}>
                      {a.app}
                    </span>
                    <div className="app-usage-bar">
                      <div
                        className="app-usage-fill"
                        style={{ width: `${(a.minutes / max) * 100}%`, background: a.colorHex }}
                      />
                    </div>
                    <span className="app-usage-min">{formatDuration(a.minutes)}</span>
                  </div>
                )
              })}
              {review.apps.length === 0 && <div className="field-help">还没有应用数据。</div>}
            </div>

            <div className="panel wide">
              <div className="panel-title">
                工作流网格
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 400 }}>
                  每 30 分钟时段的主导分类（凌晨 4 点 → 次日 4 点）
                </span>
              </div>
              <div className="workflow-grid" style={{ gridTemplateColumns: `48px repeat(48, 1fr)` }}>
                {review.workflow.map((row, rowIdx) => (
                  <React.Fragment key={row.day}>
                    <div className="wf-rowlabel" style={{ gridColumn: 1, gridRow: rowIdx + 2 }}>
                      {DAY_LABELS[rowIdx]}
                    </div>
                    {row.cells.map((cell, i) => (
                      <div
                        key={i}
                        className="wf-cell"
                        title={`${DAY_LABELS[rowIdx]} ${formatMinutesOfDay(cell.minute)} — ${
                          cell.categoryName ? `${cell.categoryName}（${formatDuration(cell.minutes)}）` : '无活动'
                        }`}
                        style={{
                          gridColumn: i + 2,
                          gridRow: rowIdx + 2,
                          background: cell.colorHex ?? '#1c1e2b',
                          opacity: cell.colorHex ? Math.min(1, 0.35 + cell.minutes / 30) : 1
                        }}
                      />
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                专注热力图
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 400 }}>
                  蓝 = 专注 · 红 = 分心
                </span>
              </div>
              <div className="heatmap-grid" style={{ gridTemplateColumns: `48px repeat(24, 1fr)` }}>
                {review.heatmap.map((row, rowIdx) => (
                  <React.Fragment key={row.day}>
                    <div className="hm-rowlabel" style={{ gridColumn: 1, gridRow: rowIdx + 2 }}>
                      {DAY_LABELS[rowIdx]}
                    </div>
                    {row.cells.map((cell) => (
                      <div
                        key={cell.hour}
                        className="hm-cell"
                        title={`${DAY_LABELS[rowIdx]} ${String(cell.hour).padStart(2, '0')}:00 — ${
                          cell.minutes > 0
                            ? `记录 ${formatDuration(cell.minutes)}，专注度 ${Math.round(cell.focusRatio * 100)}%`
                            : '无数据'
                        }`}
                        style={{
                          gridColumn: cell.hour + 2,
                          gridRow: rowIdx + 2,
                          background: focusColor(cell.focusRatio)
                        }}
                      />
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                应用切换图
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 400 }}>
                  你在各应用之间的切换路径
                </span>
              </div>
              {review.interactions.nodes.length > 0 ? (
                <InteractionGraph nodes={review.interactions.nodes} edges={review.interactions.edges} />
              ) : (
                <div className="field-help">活动还不够多，暂无法生成切换图。</div>
              )}
            </div>
          </div>
        </>
      )}

      {!review && (
        <div className="empty-state">
          <span className="spinner" />
        </div>
      )}
    </div>
  )
}
