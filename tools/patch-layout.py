import io

# ---------- 1) softer pastel + band gaps ----------
p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()
s = s.replace("const mix = (c: number): number => Math.round(c + (255 - c) * 0.72)",
              "const mix = (c: number): number => Math.round(c + (255 - c) * 0.84)", 1)
s = s.replace("""  const hOf = (ts1: number, ts2: number): number =>
    Math.max(((ts2 - ts1) / 60000) * ppm - 1, 1)""",
"""  const hOf = (ts1: number, ts2: number): number =>
    Math.max(((ts2 - ts1) / 60000) * ppm - 3, 2)""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('bands softened')

# ---------- 2) layout: two clean cards, compact toolbar ----------
p = 'src/renderer/src/styles.css'
s = io.open(p, encoding='utf-8').read()

def rep(old, new):
    global s
    assert old in s, 'missing: ' + old[:50]
    s = s.replace(old, new, 1)

# shell: uniform gutters on the cream background
rep(""".act-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: 0;
}""",
""".act-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: 14px;
  padding: 14px;
}""")

# center becomes ONE card
rep(""".act-center {
  flex: 1.25;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-soft);
  overflow: hidden;
}""",
""".act-center {
  flex: 1.25;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}""")

# toolbar: compact pill row
rep(""".act-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border-soft);
  flex-wrap: wrap;
}""",
""".act-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex-wrap: wrap;
}

.act-toolbar .day-nav {
  background: var(--card-soft);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  padding: 2px 4px;
  gap: 2px;
}

.act-toolbar .icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
}

.act-toolbar input,
.act-toolbar .btn {
  height: 32px;
}""")

rep(""".act-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px 8px;
  flex-wrap: wrap;
}""",
""".act-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-soft);
  flex-wrap: wrap;
}""")

rep(""".act-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 18px 30px;
}""",
""".act-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 26px;
}""")

# gantt becomes ONE card too
rep(""".act-gantt {
  width: 500px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 18px;
  overflow-y: hidden;
}""",
""".act-gantt {
  width: 500px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 10px 12px 12px;
  overflow-y: auto;
}""")

# track: no own card chrome (it lives inside the gantt card)
rep(""".ta-track {
  position: relative;
  flex: 1;
  min-height: 320px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-card);
}""",
""".ta-track {
  position: relative;
  flex: 1 1 auto;
  min-height: 360px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--card-soft);
}""")

# zoom row inside the card
rep(""".ta-zoom {
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
}""",
""".ta-zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  flex-wrap: nowrap;
  padding-bottom: 2px;
}

.ta-zoom .btn {
  white-space: nowrap;
  padding: 3px 9px;
  font-size: 11.5px;
  border-radius: 999px;
}""")

# bands: calm card look
rep(""".ta-band {
  position: absolute;
  left: 0;
  right: 0;
  border-left: 4px solid;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s;
}""",
""".ta-band {
  position: absolute;
  left: 2px;
  right: 2px;
  border-left: 3px solid;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s;
  box-shadow: 0 1px 2px rgba(160, 120, 70, 0.08);
}""")

# tree rows: quieter glyphs, tighter rhythm
rep(""".atr-glyph {
  font-size: 13px;
  line-height: 1;
}""",
""".atr-glyph {
  font-size: 11px;
  line-height: 1;
  opacity: 0.75;
}""")

rep(""".atr-wrap {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}""",
""".atr-wrap {
  background: transparent;
  overflow: hidden;
}""")

rep(""".atr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding-right: 16px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  transition: background 0.12s;
  min-width: 0;
}""",
""".atr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  padding-right: 10px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  transition: background 0.12s;
  min-width: 0;
  border-radius: 6px;
}""")

# pending banner -> inline pill
rep(""".pending-note {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--card);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 13px 18px;
  color: var(--text-dim);
  font-size: 13px;
  box-shadow: var(--shadow-card);
  margin-bottom: 12px;
}""",
""".pending-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: var(--card-soft);
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  padding: 5px 13px;
  color: var(--text-dim);
  font-size: 12px;
}""")

# hint text tidy
rep(""".ta-scrollbar-hint {
  font-size: 11px;
  color: var(--text-faint);
  text-align: right;
  padding-right: 2px;
}""",
""".ta-scrollbar-hint {
  font-size: 10.5px;
  color: var(--text-faint);
  text-align: center;
  padding: 2px 0 0;
}""")

# hour labels + now chip: tighter to the gutter
rep("""  right: -46px;
  top: -8px;
  width: 42px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}""",
"""  right: -42px;
  top: -8px;
  width: 40px;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('layout css unified')
