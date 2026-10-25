import io

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

start = s.find('/** Timing 式垂直时间轴')
anchor = 'export default function TimelinePage(): React.ReactElement {'
end = s.find(anchor)
assert start > 0 and end > start, 'component bounds'

component = '''/**
 * Timing 式智能时间线：相关片段合并成会话卡，行流式堆叠（最小行高保证
 * 文字完整可读），时长由行内比例色条表达，空档压缩为带标签的间隙行。
 */
const SCALE = 1.15 // px per minute for the duration hint
const MIN_ROW = 44
const MAX_ROW = 150

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

interface StripItem {
  appName: string
  projectId: number | null
  frac: number
}

type Row =
  | { kind: 'act'; seg: MergedSeg; strip: StripItem[]; appCount: number; apps: string[] }
  | { kind: 'gap'; startTs: number; endTs: number }
  | { kind: 'task'; task: TaskActivity }

function absorbMerge(activities: AppActivity[]): MergedSeg[] {
  const sorted = [...activities].sort((a, b) => a.startTs - b.startTs)
  const out: MergedSeg[] = []
  for (const a of sorted) {
    const last = out[out.length - 1]
    const dur = a.endTs - a.startTs
    const gap = last ? a.startTs - last.endTs : Infinity
    const sameEntity =
      last !== undefined &&
      (last.appName === a.appName ||
        (last.projectId !== null && last.projectId === a.projectId) ||
        dur < 120_000)
    if (last && gap < 120_000 && sameEntity) {
      last.ids.push(a.id)
      last.endTs = Math.max(last.endTs, a.endTs)
      if ((a.title ?? '').length > (last.title ?? '').length) last.title = a.title
      if (a.urlOrPath && !last.urlOrPath) last.urlOrPath = a.urlOrPath
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

/** 把相邻段（间隙 <5 分钟）收成一行会话，行内色条保留每段构成。 */
function buildRows(activities: AppActivity[], tasks: TaskActivity[], nowTs: number): Row[] {
  const segs = absorbMerge(activities)
  const rows: Row[] = []
  let i = 0
  while (i < segs.length) {
    const group: MergedSeg[] = [segs[i]]
    let j = i + 1
    while (j < segs.length && segs[j].startTs - group[group.length - 1].endTs < 5 * 60_000) {
      group.push(segs[j])
      j++
    }
    const startTs = group[0].startTs
    const endTs = Math.max(...group.map((g) => g.endTs))
    const byApp = new Map<string, number>()
    const byProj = new Map<number | null, number>()
    let longest = group[0]
    for (const g of group) {
      byApp.set(g.appName, (byApp.get(g.appName) ?? 0) + (g.endTs - g.startTs))
      byProj.set(g.projectId, (byProj.get(g.projectId) ?? 0) + (g.endTs - g.startTs))
      if (g.title.length > longest.title.length) longest = g
    }
    const dominantApp = [...byApp.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const dominantProj = [...byProj.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const mergedSeg: MergedSeg = {
      ids: group.flatMap((g) => g.ids),
      appName: dominantApp,
      title: longest.title,
      urlOrPath: longest.urlOrPath,
      startTs,
      endTs,
      projectId: dominantProj,
      isManual: group.some((g) => g.isManual)
    }
    const total = Math.max(1, endTs - startTs)
    const strip: StripItem[] = group.map((g) => ({
      appName: g.appName,
      projectId: g.projectId,
      frac: (g.endTs - g.startTs) / total
    }))
    rows.push({
      kind: 'act',
      seg: mergedSeg,
      strip,
      appCount: byApp.size,
      apps: [...byApp.keys()].sort((a, b) => (byApp.get(b) ?? 0) - (byApp.get(a) ?? 0))
    })
    // 间隙行
    const next = segs[j]
    if (next && next.startTs - endTs > 5 * 60_000) {
      rows.push({ kind: 'gap', startTs: endTs, endTs: next.startTs })
    }
    i = j
  }
  for (const t of tasks) {
    rows.push({ kind: 'task', task: t })
    rows.sort((a, b) => {
      const ta = a.kind === 'act' ? a.seg.startTs : a.kind === 'gap' ? a.startTs : a.task.startTs
      const tb = b.kind === 'act' ? b.seg.startTs : b.kind === 'gap' ? b.startTs : b.task.startTs
      return ta - tb
    })
  }
  return rows
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
  const nowTs = Date.now()
  const rows = buildRows(activities, tasks, nowTs)
  const isToday = day === today
  const dayStart = (() => {
    const d = parseDayKey(day)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  })()

  const rowHeight = (r: Row): number => {
    if (r.kind === 'gap') return 30
    if (r.kind === 'task') return 48
    return Math.max(MIN_ROW, Math.min(MAX_ROW, ((r.seg.endTs - r.seg.startTs) / 60000) * SCALE))
  }

  // 现在标线插入位置
  const nowIndex = rows.findIndex((r) => {
    const t = r.kind === 'act' ? r.seg.startTs : r.kind === 'gap' ? r.startTs : r.task.startTs
    return t > nowTs
  })

  return (
    <div className="ta-wrap">
      <div className="ta-flow">
        {rows.length === 0 && (
          <div className="empty-state">
            <h3>{isToday ? '还没有窗口记录' : '当天无窗口记录'}</h3>
            <p>Dayflow 每 2 秒记录前台窗口的应用与标题，这是行为分析的主要依据。</p>
          </div>
        )}
        {rows.map((r, idx) => {
          const node =
            r.kind === 'gap' ? (
              <div
                key={`g${idx}`}
                className="ta-gap"
                onDoubleClick={() =>
                  onAddManual(Math.round((r.startTs - dayStart) / 60000))
                }
                title="双击在此补录手动时间"
              >
                <span>
                  空档 · {formatDuration((r.endTs - r.startTs) / 60000)}（双击补录）
                </span>
              </div>
            ) : r.kind === 'task' ? (
              <div
                key={`t${r.task.id}`}
                className="ta-row task"
                style={{ height: rowHeight(r) }}
                title={`手动计时：${r.task.title}`}
              >
                <div className="ta-row-time">
                  {clockFromTs(r.task.startTs)}–{r.task.endTs ? clockFromTs(r.task.endTs) : '…'}
                </div>
                <div className="ta-row-main">
                  <div className="ta-row-head">
                    <span className="win-app" style={{ background: 'rgba(47,164,122,.15)', color: 'var(--green)' }}>
                      ⏱ 手动
                    </span>
                    <span className="ta-row-title">{r.task.title}</span>
                    <span className="ta-dur">
                      {r.task.endTs
                        ? formatDuration((r.task.endTs - r.task.startTs) / 60000)
                        : '进行中'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (() => {
              const seg = r.seg
              const color = colorOf(seg.projectId)
              const proj = projects.find((p) => p.id === seg.projectId)
              const durMin = (seg.endTs - seg.startTs) / 60000
              const rep =
                activities
                  .filter((x) => seg.ids.includes(x.id))
                  .sort((a, b) => b.endTs - b.startTs - (a.endTs - a.startTs))[0] ?? null
              const multi = r.appCount > 1
              return (
                <div
                  key={`a${seg.ids[0]}`}
                  className={`ta-row ${selected && seg.ids.includes(selected.id) ? 'selected' : ''}`}
                  style={{ height: rowHeight(r), borderLeftColor: color }}
                  draggable
                  onDragStart={(e) => {
                    dragIdRef = { ids: seg.ids, appName: seg.appName, title: seg.title }
                    e.dataTransfer?.setData('text/plain', seg.ids.join(','))
                  }}
                  onClick={() =>
                    onSelect(rep && selected?.id === rep.id ? null : rep)
                  }
                  title={`${clockFromTs(seg.startTs)}–${clockFromTs(seg.endTs)} · ${seg.appName} · ${seg.title}\\n${formatDuration(durMin)} · ${seg.ids.length} 段 · 拖到左侧项目归类（Alt = 同时建规则）`}
                >
                  <div className="ta-row-time">
                    {clockFromTs(seg.startTs)}–{clockFromTs(seg.endTs)}
                  </div>
                  <div className="ta-row-main">
                    <div className="ta-row-head">
                      <span className="win-app">{multi ? `${r.apps.slice(0, 3).join(' / ')}` : seg.appName}</span>
                      <span className="ta-row-title">{seg.title || '（无标题）'}</span>
                      <span className="ta-dur">{formatDuration(durMin)}</span>
                    </div>
                    <div className="ta-row-sub">
                      {proj ? (
                        <span className="ta-proj" style={{ color }}>
                          {proj.title}
                        </span>
                      ) : (
                        <span className="chip unclassified">未归类</span>
                      )}
                      {multi && <span className="ta-dur">{seg.ids.length} 段 · {r.appCount} 个应用</span>}
                      {!multi && seg.ids.length > 1 && <span className="ta-dur">{seg.ids.length} 段</span>}
                    </div>
                    {multi && (
                      <div className="ta-strip">
                        {r.strip.map((it, k) => (
                          <div
                            key={k}
                            className="ta-strip-item"
                            style={{
                              flexBasis: `${it.frac * 100}%`,
                              background: pastel(colorOf(it.projectId))
                            }}
                            title={`${it.appName} ${Math.round(it.frac * 100)}%`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          return (
            <React.Fragment key={idx}>
              {node}
              {isToday && idx === nowIndex - 1 && (
                <div className="ta-now-row">
                  <span className="ta-now-label">现在</span>
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
      <div className="ta-scrollbar-hint">
        拖拽块到左侧项目归类（Alt = 同时建规则） · 双击空档补录手动时间 · 短片段已自动合并为会话，文字始终完整显示
      </div>
    </div>
  )
}

'''
s = s[:start] + component + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('TimingAxis v5: flow rows written')
