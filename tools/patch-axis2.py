import io, re

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# 1) drag ref now carries a merged group
old = "let dragIdRef: number | null = null"
new = """interface DragGroup {
  ids: number[]
  appName: string
  title: string
}
let dragIdRef: DragGroup | null = null"""
assert old in s, 'dragref'
s = s.replace(old, new, 1)

# 2) replace the whole TimingAxis component
pattern = re.compile(r"/\*\* Timing 式垂直时间轴[\s\S]*?\n}\n\n(?=export default function TimelinePage)", re.M)
m = pattern.search(s)
assert m, 'component region not found'

component = '''/** Timing 式垂直时间轴：相关时间块自动合并、高度 ∝ 时长、小时刻度、现在线。 */
const PX_PER_MIN = 1.15

interface MergedSeg {
  ids: number[]
  appName: string
  title: string
  urlOrPath: string | null
  startTs: number
  endTs: number
  projectId: number | null
  isManual: boolean
}

function mergeSegments(activities: AppActivity[]): MergedSeg[] {
  const sorted = [...activities].sort((a, b) => a.startTs - b.startTs)
  const out: MergedSeg[] = []
  for (const a of sorted) {
    const last = out[out.length - 1]
    if (last && last.appName === a.appName && last.projectId === a.projectId && a.startTs - last.endTs < 90_000) {
      last.ids.push(a.id)
      last.endTs = Math.max(last.endTs, a.endTs)
      if ((a.title ?? '').length > (last.title ?? '').length) last.title = a.title
      if (a.urlOrPath && !last.urlOrPath) last.urlOrPath = a.urlOrPath
      last.isManual = last.isManual || a.isManual
    } else {
      out.push({
        ids: [a.id],
        appName: a.appName,
        title: a.title,
        urlOrPath: a.urlOrPath,
        startTs: a.startTs,
        endTs: a.endTs,
        projectId: a.projectId,
        isManual: a.isManual
      })
    }
  }
  return out
}

function TimingAxis({
  activities,
  tasks,
  day,
  today,
  projects,
  colorOf,
  onSelect,
  selected,
  onAddManual
}: {
  activities: AppActivity[]
  tasks: TaskActivity[]
  day: string
  today: string
  projects: Project[]
  colorOf: (id: number | null) => string
  onSelect: (a: AppActivity | null) => void
  selected: AppActivity | null
  onAddManual: (minute: number) => void
}): React.ReactElement {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [nowTs, setNowTs] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const d = parseDayKey(day)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  const totalH = 1440 * PX_PER_MIN
  const yOf = (ts: number): number => ((ts - start) / 60000) * PX_PER_MIN
  const hOf = (ts1: number, ts2: number): number => {
    const m = ((ts2 - ts1) / 60000) * PX_PER_MIN
    return Math.max(m - 2, m < 12 ? 9 : 24)
  }
  const fmtMin = (m: number): string => clockFromTs(start + m * 60000)

  const isToday = day === today
  const nowY = isToday ? yOf(nowTs) : -1

  // Auto-scroll: today -> now; past days -> last activity.
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const lastEnd = activities.length ? Math.max(...activities.map((a) => a.endTs)) : 0
    const target = isToday && nowY >= 0 ? nowY : lastEnd ? yOf(lastEnd) : 0
    el.scrollTop = Math.max(0, target - 360)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, activities.length > 0])

  const merged = mergeSegments(activities)

  const hours: React.ReactElement[] = []
  for (let h = 0; h <= 24; h += 2) {
    hours.push(
      <div className="ta-hour-line" style={{ top: h * 60 * PX_PER_MIN }} key={h}>
        <span className="ta-hour-label">{fmtMin(h * 60)}</span>
      </div>
    )
  }

  return (
    <div className="ta-wrap">
      <div
        ref={trackRef}
        className="ta-track"
        style={{ height: 'calc(100vh - 210px)', overflowY: 'auto' }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('ta-canvas')) {
            const rect = trackRef.current?.getBoundingClientRect()
            const top = rect ? e.clientY - rect.top + trackRef.current!.scrollTop : 0
            onAddManual(Math.max(0, Math.round(top / PX_PER_MIN)))
          }
        }}
      >
        <div className="ta-canvas" style={{ height: totalH }}>
          {hours}
          {merged.map((seg) => {
            const color = colorOf(seg.projectId)
            const proj = projects.find((p) => p.id === seg.projectId)
            const durMin = (seg.endTs - seg.startTs) / 60000
            const h = hOf(seg.startTs, seg.endTs)
            const compact = h < 26
            const rep =
              activities
                .filter((x) => seg.ids.includes(x.id))
                .sort((a, b) => b.endTs - b.startTs - (a.endTs - a.startTs))[0] ?? null
            return (
              <div
                key={seg.ids[0]}
                className={`ta-block ${selected && seg.ids.includes(selected.id) ? 'selected' : ''} ${compact ? 'compact' : ''}`}
                style={{
                  top: yOf(seg.startTs),
                  height: h,
                  borderLeftColor: color,
                  background: `${color}1c`
                }}
                draggable
                onDragStart={(e) => {
                  dragIdRef = { ids: seg.ids, appName: seg.appName, title: seg.title }
                  e.dataTransfer?.setData('text/plain', seg.ids.join(','))
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(rep && selected?.id === rep.id ? null : rep)
                }}
                title={`${clockFromTs(seg.startTs)}–${clockFromTs(seg.endTs)} · ${seg.appName} · ${seg.title}\\n${formatDuration(durMin)} · ${seg.ids.length} 段已合并\\n拖到左侧项目归类（按住 Alt 拖 = 同时建规则）`}
              >
                <div className="ta-block-head">
                  <span className="win-app">{seg.appName}</span>
                  {!compact && <span className="ta-title">{seg.title || '（无标题）'}</span>}
                  <span className="ta-dur">{formatDuration(durMin)}</span>
                </div>
                {!compact && h >= 40 && (
                  <div className="ta-block-sub">
                    {proj ? (
                      <span className="ta-proj" style={{ color }}>
                        {proj.title}
                      </span>
                    ) : (
                      <span className="chip unclassified">未归类</span>
                    )}
                    {seg.ids.length > 1 && <span className="ta-dur">{seg.ids.length} 段</span>}
                  </div>
                )}
              </div>
            )
          })}
          {tasks.map((t) => (
            <div
              key={`task-${t.id}`}
              className="ta-block manual-task"
              style={{ top: yOf(t.startTs), height: hOf(t.startTs, t.endTs ?? nowTs) }}
              title={`手动计时：${t.title}`}
            >
              <div className="ta-block-head">
                <span className="win-app" style={{ background: 'rgba(47,164,122,.15)', color: 'var(--green)' }}>
                  ⏱ 手动
                </span>
                <span className="ta-title">{t.title}</span>
                <span className="ta-dur">{t.endTs ? formatDuration((t.endTs - t.startTs) / 60000) : '进行中'}</span>
              </div>
            </div>
          ))}
          {nowY >= 0 && nowY <= totalH && (
            <div className="ta-now" style={{ top: nowY }}>
              <span className="ta-now-label">现在</span>
            </div>
          )}
        </div>
      </div>
      <div className="ta-scrollbar-hint">双击空白补录手动时间 · 拖拽块到左侧项目归类（Alt = 同时建规则）· 相关段已自动合并</div>
    </div>
  )
}

'''
s = s[:m.start()] + component + s[m.end():]

# 3) onAssign uses merged group
old = """          onAssign={(pid, alt) => {
            const id = dragIdRef
            dragIdRef = null
            if (id === null) return
            if (alt) {
              const act = activities.find((a) => a.id === id)
              if (act) {
                const kw = act.title.split(/[\\s]+/).slice(0, 2).join(' ')
                void window.dayflow
                  .createRule(pid, [
                    { field: 'app', op: 'equals', value: act.appName },
                    { field: 'title', op: 'contains', value: kw }
                  ])
                  .then((res) => {
                    assign(id, pid)
                    load()
                    alert('已归类并创建规则（回溯 ' + res.appliedCount + ' 段）')
                  })
              }
            } else {
              assign(id, pid)
            }
          }}"""
new = """          onAssign={(pid, alt) => {
            const seg = dragIdRef
            dragIdRef = null
            if (!seg) return
            const assignAll = (): void => {
              seg.ids.forEach((id) => assign(id, pid))
              load()
            }
            if (alt) {
              const kw = seg.title.split(/[\\s]+/).slice(0, 2).join(' ')
              void window.dayflow
                .createRule(pid, [
                  { field: 'app', op: 'equals', value: seg.appName },
                  { field: 'title', op: 'contains', value: kw }
                ])
                .then((res) => {
                  assignAll()
                  alert('已归类并创建规则（回溯 ' + res.appliedCount + ' 段）')
                })
            } else {
              assignAll()
            }
          }}"""
assert old in s, 'onAssign'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('TimingAxis v2 written')
