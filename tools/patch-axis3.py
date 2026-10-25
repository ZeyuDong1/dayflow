import io, re

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# 1) zoom state inside TimingAxis
old = """  const trackRef = React.useRef<HTMLDivElement>(null)
  const [nowTs, setNowTs] = useState(Date.now())"""
new = """  const trackRef = React.useRef<HTMLDivElement>(null)
  const [ppm, setPpm] = useState(1.15)
  const [nowTs, setNowTs] = useState(Date.now())"""
assert old in s, 'zoom state'
s = s.replace(old, new, 1)

# 2) replace fixed PX_PER_MIN usages within the component body
old = """  const d = parseDayKey(day)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  const totalH = 1440 * PX_PER_MIN
  const yOf = (ts: number): number => ((ts - start) / 60000) * PX_PER_MIN
  const hOf = (ts1: number, ts2: number): number => {
    const m = ((ts2 - ts1) / 60000) * PX_PER_MIN
    return Math.max(m - 2, m < 12 ? 9 : 24)
  }"""
new = """  const d = parseDayKey(day)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime()
  const totalH = 1440 * ppm
  const yOf = (ts: number): number => ((ts - start) / 60000) * ppm
  const hOf = (ts1: number, ts2: number): number => {
    const m = ((ts2 - ts1) / 60000) * ppm
    return Math.max(m - 2, m < 12 ? 5 : 24)
  }"""
assert old in s, 'geometry'
s = s.replace(old, new, 1)

old = """  const merged = mergeSegments(activities)

  const hours: React.ReactElement[] = []
  for (let h = 0; h <= 24; h += 2) {
    hours.push(
      <div className="ta-hour-line" style={{ top: h * 60 * PX_PER_MIN }} key={h}>
        <span className="ta-hour-label">{fmtMin(h * 60)}</span>
      </div>
    )
  }

  return (
    <div className="ta-wrap">"""
new = """  const merged = mergeSegments(activities)

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
        <span className="ta-scrollbar-hint">缩放</span>
        <button className={`btn small ${ppm === 0.5 ? 'primary' : ''}`} onClick={() => setPpm(0.5)}>
          全天概览
        </button>
        <button className={`btn small ${ppm === 1.15 ? 'primary' : ''}`} onClick={() => setPpm(1.15)}>
          标准
        </button>
        <button className={`btn small ${ppm === 2.6 ? 'primary' : ''}`} onClick={() => setPpm(2.6)}>
          放大
        </button>
      </div>"""
assert old in s, 'hours/zoom'
s = s.replace(old, new, 1)

# 3) auto-scroll uses ppm
old = """    const lastEnd = activities.length ? Math.max(...activities.map((a) => a.endTs)) : 0
    const target = isToday && nowY >= 0 ? nowY : lastEnd ? yOf(lastEnd) : 0
    el.scrollTop = Math.max(0, target - 360)"""
new = """    const lastEnd = activities.length ? Math.max(...activities.map((a) => a.endTs)) : 0
    const target = isToday && nowY >= 0 ? nowY : lastEnd ? yOf(lastEnd) : 0
    el.scrollTop = Math.max(0, target - 360)
    // eslint-disable-next-line react-hooks/exhaustive-deps"""
assert old in s
if 'eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [day, activities.length > 0])' in s:
    # avoid double insertion: revert if already present
    s = s.replace(new, old, 1)
    print('scroll deps already ok')

# 4) compact = no text at all (pure sliver), threshold 30px
old = """            const h = hOf(seg.startTs, seg.endTs)
            const compact = h < 26"""
new = """            const h = hOf(seg.startTs, seg.endTs)
            const compact = h < 30"""
assert old in s, 'compact threshold'
s = s.replace(old, new, 1)

# 5) double-click uses ppm
old = """            const top = rect ? e.clientY - rect.top + trackRef.current!.scrollTop : 0
            onAddManual(Math.max(0, Math.round(top / PX_PER_MIN)))"""
new = """            const top = rect ? e.clientY - rect.top + trackRef.current!.scrollTop : 0
            onAddManual(Math.max(0, Math.round(top / ppm)))"""
assert old in s, 'dblclick ppm'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('axis v3 written')
