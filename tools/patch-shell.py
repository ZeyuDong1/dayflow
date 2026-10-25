import io

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# ---- 1) share drag state with the sidebar (App reads dragState.current) ----
s = s.replace("import { addDays, clockFromTs, dayKeyLabel, formatDuration, parseDayKey } from '../lib/format'",
              "import { addDays, clockFromTs, dayKeyLabel, formatDuration, parseDayKey } from '../lib/format'\nimport { dragState } from '../lib/drag'", 1)
s = s.replace("""                onDragStart={(e) => {
                  dragIdRef = {
                    ids: b.ids,
                    appName: b.dominantApp,
                    title: b.dominantTitle
                  }
                  e.dataTransfer?.setData('text/plain', b.ids.join(','))
                }}""",
"""                onDragStart={(e) => {
                  dragState.current = {
                    ids: b.ids,
                    appName: b.dominantApp,
                    title: b.dominantTitle
                  }
                  e.dataTransfer?.setData('text/plain', b.ids.join(','))
                }}""", 1)

# ---- 2) replace the old default export (to EOF) with the Timing-style ActivitiesView ----
anchor = 'export default function TimelinePage'
idx = s.find(anchor)
assert idx > 0, 'default export anchor'

new_default = '''export default function ActivitiesView({
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
  }, [day])

  useEffect(() => {
    load()
    return window.dayflow.onTimelineChanged(() => {
      load()
      onDataChanged()
    })
  }, [load, onDataChanged])

  const assign = (activityId: number, projectId: number | null): void => {
    void window.dayflow.assignActivity(activityId, projectId).then(() => {
      load()
      onDataChanged()
    })
  }

  const matchQuery = (app: string, title: string): boolean => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return app.toLowerCase().includes(q) || title.toLowerCase().includes(q)
  }

  const filteredActivities = activities.filter((a) => matchQuery(a.appName, a.title))
  const filteredCards = cards.filter(
    (c) =>
      !query.trim() ||
      c.title.toLowerCase().includes(query.toLowerCase()) ||
      c.summary.toLowerCase().includes(query.toLowerCase())
  )

  const totalMin = activities.reduce((a, x) => a + (x.endTs - x.startTs), 0) / 60000

  // ---- 统一视图：时间相近的段融合成会话行 ----
  const sessions = (() => {
    const sorted = [...filteredActivities].sort((a, b) => a.startTs - b.startTs)
    const out: { startTs: number; endTs: number; apps: string[]; title: string; minutes: number }[] = []
    for (const a of sorted) {
      const last = out[out.length - 1]
      if (last && a.startTs - last.endTs < 5 * 60_000) {
        last.endTs = Math.max(last.endTs, a.endTs)
        if (!last.apps.includes(a.appName)) last.apps.push(a.appName)
        if ((a.title ?? '').length > (last.title ?? '').length) last.title = a.title
      } else {
        out.push({
          startTs: a.startTs,
          endTs: a.endTs,
          apps: [a.appName],
          title: a.title,
          minutes: 0
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
          <input
            type="text"
            placeholder="搜索活动…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 170 }}
          />
          <div className="task-chip">
            <input
              type="text"
              placeholder="手动计时…"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              style={{ width: 110, padding: '4px 9px' }}
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

        <div className="act-content">
          {view === 'category' && (
            <ActivityTree activities={filteredActivities} tasks={dayTasks} projects={projects} colorOf={projectColor} />
          )}

          {view === 'unified' && (
            <div className="atr-wrap">
              {sessions.map((sn) => (
                <div className="atr-row" key={sn.startTs} style={{ paddingLeft: 12 }}>
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

      {/* ================= 右栏：全局时间轴（LOD） ================= */}
      <div className="act-gantt">
        <TimingAxis
          activities={filteredActivities}
          tasks={dayTasks}
          day={day}
          today={today}
          projects={projects}
          colorOf={projectColor}
          onSelect={setSelectedActivity}
          selected={selectedActivity}
          onAddManual={(minute) => setManualDraft({ minute, title: '', dur: 30 })}
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
'''
s = s[:idx] + new_default
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ActivitiesView default written')

# ---- 3) ActivitiesView.tsx re-export (App imports './pages/ActivitiesView') ----
io.open('src/renderer/src/pages/ActivitiesView.tsx', 'w', encoding='utf-8', newline='').write(
    "export { default } from './TimelinePage'\n"
)
print('ActivitiesView re-export written')
