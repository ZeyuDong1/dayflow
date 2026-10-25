import io

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

start = s.find('/**\n * Timing 式智能时间线')
if start < 0:
    start = s.find('/** Timing 式垂直时间轴')
anchor = 'export default function TimelinePage(): React.ReactElement {'
end = s.find(anchor)
assert start > 0 and end > start, f'bounds {start} {end}'

component = '''/**
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
function pastel(hex: string): string {
  try {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const mix = (c: number): number => Math.round(c + (255 - c) * 0.72)
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

interface BandSeg {
  ids: number[]
  appName: string
  title: string
  urlOrPath: string | null
  startTs: number
  endTs: number
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
        endTs: a.endTs
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
    bands.push({
      ids: group.flatMap((g) => g.ids),
      segments: group,
      startTs,
      endTs,
      projectId: proj,
      dominantApp: dom.appName,
      dominantTitle: dom.title,
      urlOrPath: dom.urlOrPath,
      isTask: false
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
          endTs: t.endTs ?? Date.now()
        }
      ],
      startTs: t.startTs,
      endTs: t.endTs ?? Date.now(),
      projectId: t.projectId,
      dominantApp: '⏱ 手动',
      dominantTitle: t.title,
      urlOrPath: null,
      isTask: true,
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
  const [ppm, setPpm] = useState(1.15)
  const [tip, setTip] = useState<TipState | null>(null)
  const nowTs = Date.now()

  const d = parseDayKey(day)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  const totalH = 1440 * ppm
  const yOf = (ts: number): number => ((ts - start) / 60000) * ppm
  const hOf = (ts1: number, ts2: number): number =>
    Math.max(((ts2 - ts1) / 60000) * ppm - 1, 1)
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

  // 自动滚动：今天 → 现在；过去 → 最后活动
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
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
      <div className="ta-zoom">
        <span className="ta-scrollbar-hint">
          悬停看详情 · 放大后显示标题 · 拖拽归类（Alt=建规则）· 双击空白补录
        </span>
        {(
          [
            [0.5, '全天概览'],
            [1.15, '标准'],
            [2.6, '放大'],
            [5, '细节']
          ] as [number, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={`btn small ${Math.abs(ppm - v) < 0.01 ? 'primary' : ''}`}
            onClick={() => setPpm(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={trackRef}
        className="ta-track"
        style={{ height: 'calc(100vh - 250px)', overflowY: 'auto' }}
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
            return (
              <div
                key={`${b.startTs}-${b.ids[0]}`}
                className={`ta-band ${lod} ${isSel ? 'selected' : ''} ${b.isTask ? 'task' : ''}`}
                style={{
                  top: yOf(b.startTs),
                  height: h,
                  borderLeftColor: color,
                  background: b.isTask ? 'rgba(47,164,122,.14)' : pastel(color)
                }}
                draggable={!b.isTask}
                onDragStart={(e) => {
                  dragIdRef = {
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
                }}
              >
                {lod !== 'none' && (
                  <div className="ta-band-row">
                    {lod === 'full' && <span className="win-app">{b.dominantApp}</span>}
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
                  <span className="ta-tip-app">{sg.appName}</span>
                  <span className="ta-tip-title">{sg.title || '（无标题）'}</span>
                  <span className="ta-tip-dur">{formatDuration((sg.endTs - sg.startTs) / 60000)}</span>
                </div>
              ))}
            {tip.band.segments.length > 8 && (
              <div className="ta-tip-row">… 还有 {tip.band.segments.length - 8} 段</div>
            )}
          </div>
          {tip.band.urlOrPath && <div className="ta-tip-url">{tip.band.urlOrPath}</div>}
        </div>
      )}
    </div>
  )
}

'''
s = s[:start] + component + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('TimingAxis v6: global axis + LOD + tooltip')
