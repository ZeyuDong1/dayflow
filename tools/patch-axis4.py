import io, re

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# 1) mergeSegments v2: absorb brief fragments (kills A-B-A-B mud)
pattern = re.compile(r"function mergeSegments\(activities: AppActivity\[\]\): MergedSeg\[\] \{[\s\S]*?\n\}\n", re.M)
m = pattern.search(s)
assert m, 'mergeSegments not found'

new_merge = '''function mergeSegments(activities: AppActivity[]): MergedSeg[] {
  const sorted = [...activities].sort((a, b) => a.startTs - b.startTs)
  const out: MergedSeg[] = []
  for (const a of sorted) {
    const last = out[out.length - 1]
    const dur = a.endTs - a.startTs
    const gap = last ? a.startTs - last.endTs : Infinity
    // Timing's preventTooShortDurations: adjacent fragments fuse when they
    // share the app or the project, OR the fragment itself is brief (<2min).
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
'''
s = s[:m.start()] + new_merge + s[m.end():]

# 2) EXACT proportional heights — no minimums, no overlap, 1px visual gap only
old = """  const hOf = (ts1: number, ts2: number): number => {
    const m = ((ts2 - ts1) / 60000) * ppm
    return Math.max(m - 2, m < 12 ? 5 : 24)
  }"""
new = """  // Strictly proportional: a block is exactly its duration tall, so blocks
  // tile without ever overlapping their neighbours. Minimum 1px so the
  // thinnest sliver stays visible.
  const hOf = (ts1: number, ts2: number): number =>
    Math.max(((ts2 - ts1) / 60000) * ppm - 1, 1)"""
assert old in s, 'hOf'
s = s.replace(old, new, 1)

# 3) compact threshold based on real height
old = """            const h = hOf(seg.startTs, seg.endTs)
            const compact = h < 30"""
new = """            const h = hOf(seg.startTs, seg.endTs)
            const compact = h < 30"""
# unchanged, fine

# 4) coordinate-based hit test on the canvas: clicks on 1px slivers work via time lookup
old = """        <div className="ta-canvas" style={{ height: totalH }}>
          {hours}"""
new = """        <div
          className="ta-canvas"
          style={{ height: totalH }}
          onClick={(e) => {
            // Time-based hit test: works even for 1px slivers.
            const rect = trackRef.current?.getBoundingClientRect()
            if (!rect) return
            const top = e.clientY - rect.top + trackRef.current!.scrollTop
            const t = start + (top / ppm) * 60000
            const seg = merged.find((x) => t >= x.startTs && t < x.endTs)
            if (seg) {
              const rep = activities
                .filter((x) => seg.ids.includes(x.id))
                .sort((a, b) => b.endTs - b.startTs - (a.endTs - a.startTs))[0] ?? null
              onSelect(selected && rep && selected.id === rep.id ? null : rep)
            }
          }}
        >
          {hours}"""
assert old in s, 'canvas hit test'
s = s.replace(old, new, 1)

# 5) blocks: sliver styling exact, no overlapping z-mud
old = """                style={{
                  top: yOf(seg.startTs),
                  height: h,
                  borderLeft: `${h < 14 ? 3 : 4}px solid ${color}`,
                  background: h < 14 ? pastel(color) : `${color}1c`,
                  borderRadius: h < 14 ? 2 : 6
                }}"""
new = """                style={{
                  top: yOf(seg.startTs),
                  height: h,
                  borderLeft: `${h < 14 ? 3 : 4}px solid ${color}`,
                  background: h < 30 ? pastel(color) : `${color}1c`,
                  borderRadius: h < 14 ? 2 : 6
                }}"""
assert old in s, 'block style'
s = s.replace(old, new, 1)

# 6) block onClick keeps working but relies on exact geometry; drop stopPropagation
#    so canvas fallback can't double-fire (block handler runs first with its own data)
old = """                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(rep && selected?.id === rep.id ? null : rep)
                }}"""
new = """                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(rep && selected?.id === rep.id ? null : rep)
                }}
                onMouseDown={(e) => e.stopPropagation()}"""
assert old in s, 'block click'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('axis v4: exact heights + absorb merge + hit test')
