import io

# ---------- 1) JSX: zoom row clean, track height flex ----------
p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

old = """      <div className="ta-zoom">
        <span className="ta-scrollbar-hint">
          悬停看详情 · 放大后显示标题 · 拖拽归类（Alt=建规则）· 双击空白补录
        </span>
        {("""
new = """      <div className="ta-zoom" title="悬停看详情 · 放大后显示标题 · 拖拽归类（Alt=建规则）· 双击空白补录">
        {("""
assert old in s, 'zoom row'
s = s.replace(old, new, 1)

old = """        style={{ height: 'calc(100vh - 250px)', overflowY: 'auto' }}"""
new = """        style={{ overflowY: 'auto' }}"""
assert old in s, 'track height'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('jsx geometry ok')

# ---------- 2) CSS: unified edges, right-side ruler gutter ----------
p = 'src/renderer/src/styles.css'
s = io.open(p, encoding='utf-8').read()

s = s.replace("""  width: 460px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 14px 18px;
  overflow-y: auto;
}""", """  width: 500px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 18px;
  overflow-y: hidden;
}""", 1)

# ta-wrap fills the gantt column
s = s.replace(""".ta-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}""", """.ta-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}""", 1)

# track fills remaining height
s = s.replace(""".ta-track {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-card);
}""", """.ta-track {
  position: relative;
  flex: 1;
  min-height: 320px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-card);
}""", 1)

# canvas: right gutter for the ruler (Timing puts hour numbers on the right)
s = s.replace(""".ta-canvas {
  position: relative;
  margin-left: 64px;
}""", """.ta-canvas {
  position: relative;
  margin-left: 12px;
  margin-right: 52px; /* ruler gutter — hour numbers live here */
}""", 1)

# hour labels move to the right gutter
s = s.replace(""".ta-hour-label {
  position: absolute;
  left: -58px;
  top: -8px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}""", """.ta-hour-label {
  position: absolute;
  right: -46px;
  top: -8px;
  width: 42px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}""", 1)

# hour lines and bands share the exact same edges
s = s.replace(""".ta-hour-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  pointer-events: none;
}""", """.ta-hour-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  pointer-events: none;
}

.ta-now-label-in-gutter {
  right: -46px;
}""", 1)

# bands: flush to canvas edges (alignment), card-like radius
s = s.replace(""".ta-band {
  position: absolute;
  left: 6px;
  right: 12px;
  border-left: 4px solid;
  border-radius: 5px;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s;
}""", """.ta-band {
  position: absolute;
  left: 0;
  right: 0;
  border-left: 4px solid;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s;
}""", 1)

# now line: same extent as bands
s = s.replace(""".ta-now {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--red);
  z-index: 5;
  pointer-events: none;
}

.ta-now-label {
  position: absolute;
  left: -58px;
  top: -9px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  padding: 1px 6px;
}""", """.ta-now {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--red);
  z-index: 5;
  pointer-events: none;
}

.ta-now-label {
  position: absolute;
  right: -46px;
  top: -9px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  padding: 1px 6px;
}""", 1)

# zoom bar: compact, right-aligned, no wrap
s = s.replace(""".ta-zoom {
  display: flex;
  align-items: center;
  gap: 5px;
  justify-content: flex-end;
  margin-bottom: 6px;
}""", """.ta-zoom {
  display: flex;
  align-items: center;
  gap: 5px;
  justify-content: flex-end;
  margin-bottom: 8px;
  flex-wrap: nowrap;
}

.ta-zoom .btn {
  white-space: nowrap;
  padding: 4px 9px;
}""", 1)

# hint line under the axis, right-aligned
s = s.replace(""".ta-scrollbar-hint {
  font-size: 11.5px;
  color: var(--text-faint);
}""", """.ta-scrollbar-hint {
  font-size: 11px;
  color: var(--text-faint);
  text-align: right;
  padding-right: 2px;
}""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('css geometry aligned')
