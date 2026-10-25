import io

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# ---- 1) ActivityTree component (insert before TimingAxis comment) ----
anchor = '/**\n * Timing 式全局时间轴'
idx = s.find(anchor)
assert idx > 0, 'anchor'

tree_component = '''/**
 * Timing 式「活动树」：项目 → 应用 → 文档/URL 三层，
 * 时长列右对齐、彩色圆点/应用徽标、折叠箭头（对齐 Timing All Activities 截图）。
 */
interface ANode {
  key: string
  label: string
  minutes: number
  color: string
  depth: 0 | 1 | 2
  icon: 'dot' | 'app' | 'doc' | 'link' | 'chat' | 'timer'
  letter?: string
  children: ANode[]
}

function fmtDur(min: number): string {
  const m = Math.max(1, Math.round(min))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

function ActivityTree({
  activities,
  tasks,
  projects,
  colorOf
}: {
  activities: AppActivity[]
  tasks: TaskActivity[]
  projects: Project[]
  colorOf: (id: number | null) => string
}): React.ReactElement {
  // key -> explicitly toggled expanded state (default: depth 0/1 open, depth 2 closed)
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())
  const isExpanded = (node: ANode): boolean => overrides.get(node.key) ?? node.depth < 2
  const toggle = (node: ANode): void => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(node.key, !isExpanded(node))
      return next
    })
  }

  const titleGroup = (a: AppActivity): string => {
    if (a.urlOrPath) {
      try {
        return new URL(a.urlOrPath).hostname.replace(/^www\\./, '') + new URL(a.urlOrPath).pathname
      } catch {
        return a.urlOrPath
      }
    }
    return (a.title || '（无标题）').replace(/[|·—–\\-:：]\\s*[^|·—–\\-:：]*$/, '').trim() || '（无标题）'
  }

  // project -> app -> title
  const byProj = new Map<
    string,
    { minutes: number; projId: number | null; byApp: Map<string, { minutes: number; byTitle: Map<string, number> }> }
  >()
  for (const a of activities) {
    const min = (a.endTs - a.startTs) / 60000
    const pkey = String(a.projectId ?? 'null')
    const P = byProj.get(pkey) ?? { minutes: 0, projId: a.projectId, byApp: new Map() }
    P.minutes += min
    const A = P.byApp.get(a.appName) ?? { minutes: 0, byTitle: new Map() }
    A.minutes += min
    const tg = titleGroup(a)
    A.byTitle.set(tg, (A.byTitle.get(tg) ?? 0) + min)
    P.byApp.set(a.appName, A)
    byProj.set(pkey, P)
  }
  for (const t of tasks) {
    const min = ((t.endTs ?? Date.now()) - t.startTs) / 60000
    const pkey = String(t.projectId ?? 'null')
    const P = byProj.get(pkey) ?? { minutes: 0, projId: t.projectId, byApp: new Map() }
    P.minutes += min
    const A = P.byApp.get('__timer__') ?? { minutes: 0, byTitle: new Map() }
    A.minutes += min
    A.byTitle.set(t.title, (A.byTitle.get(t.title) ?? 0) + min)
    P.byApp.set('__timer__', A)
    byProj.set(pkey, P)
  }

  const tree: ANode[] = [...byProj.entries()]
    .sort((a, b) => b[1].minutes - a[1].minutes)
    .map(([pkey, P]) => {
      const proj = projects.find((x) => x.id === P.projId)
      return {
        key: `p${pkey}`,
        label: proj?.title ?? '未归类',
        minutes: P.minutes,
        color: colorOf(P.projId),
        depth: 0 as const,
        icon: 'dot' as const,
        children: [...P.byApp.entries()]
          .sort((a, b) => b[1].minutes - a[1].minutes)
          .map(([app, A]) => ({
            key: `p${pkey}|${app}`,
            label: app === '__timer__' ? '⏱ 手动计时' : app,
            minutes: A.minutes,
            color: colorOf(P.projId),
            depth: 1 as const,
            icon: (app === '__timer__' ? 'timer' : 'app') as ANode['icon'],
            letter: app === '__timer__' ? '⏱' : app.charAt(0).toUpperCase(),
            children: [...A.byTitle.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([title, min]) => ({
                key: `p${pkey}|${app}|${title}`,
                label: title,
                minutes: min,
                color: colorOf(P.projId),
                depth: 2 as const,
                icon: (title.startsWith('http') || title.includes('.') && !title.includes(' ')
                  ? 'link'
                  : title.includes('/') || title.includes('\\\\')
                    ? 'doc'
                    : 'chat') as ANode['icon'],
                children: []
              }))
          }))
      }
    })

  const total = tree.reduce((a, n) => a + n.minutes, 0)

  const Row = ({ node }: { node: ANode }): React.ReactElement => {
    const open = isExpanded(node)
    const hasKids = node.children.length > 0
    return (
      <>
        <div
          className="atr-row"
          style={{ paddingLeft: 10 + node.depth * 26 }}
          onClick={() => hasKids && toggle(node)}
        >
          <span className="atr-dur">{fmtDur(node.minutes)}</span>
          <span className="atr-chev">{hasKids ? (open ? '⌄' : '⮕') : ''}</span>
          <span className="atr-icon">
            {node.icon === 'dot' ? (
              <span className="atr-dot" style={{ background: node.color }} />
            ) : node.icon === 'app' || node.icon === 'timer' ? (
              <span
                className="atr-badge"
                style={{ background: `${node.color}2e`, color: node.color, borderColor: `${node.color}55` }}
              >
                {node.letter}
              </span>
            ) : (
              <span className="atr-glyph">
                {node.icon === 'link' ? '🔗' : node.icon === 'doc' ? '📄' : '💬'}
              </span>
            )}
          </span>
          <span className="atr-name" title={node.label}>
            {node.label}
          </span>
          {node.depth === 0 && node.label === '未归类' && (
            <span className="chip unclassified" style={{ marginLeft: 8 }}>
              去整理
            </span>
          )}
        </div>
        {open && node.children.map((c) => <Row key={c.key} node={c} />)}
      </>
    )
  }

  return (
    <div className="atr-wrap">
      <div
        className="atr-row root"
        onClick={() => {
          const rootKey = '__root__'
          setOverrides((prev) => {
            const next = new Map(prev)
            next.set(rootKey, !(next.get(rootKey) ?? true))
            return next
          })
        }}
      >
        <span className="atr-dur">{fmtDur(total)}</span>
        <span className="atr-chev">{overrides.get('__root__') === false ? '⮕' : '⌄'}</span>
        <span className="atr-icon">
          <span className="atr-dot" style={{ background: 'var(--accent)' }} />
        </span>
        <span className="atr-name" style={{ fontWeight: 700 }}>
          全部活动
        </span>
      </div>
      {overrides.get('__root__') !== false && tree.map((n) => <Row key={n.key} node={n} />)}
    </div>
  )
}

'''
s = s[:idx] + tree_component + s[idx:]

# ---- 2) view toggle: add 活动树 ----
old = """              <button className={`btn small ${view === 'windows' ? 'primary' : ''}`} onClick={() => setView('windows')}>
                窗口活动
              </button>
              <button className={`btn small ${view === 'cards' ? 'primary' : ''}`} onClick={() => setView('cards')}>
                AI 卡片
              </button>"""
new = """              <button className={`btn small ${view === 'windows' ? 'primary' : ''}`} onClick={() => setView('windows')}>
                窗口活动
              </button>
              <button className={`btn small ${view === 'tree' ? 'primary' : ''}`} onClick={() => setView('tree')}>
                活动树
              </button>
              <button className={`btn small ${view === 'cards' ? 'primary' : ''}`} onClick={() => setView('cards')}>
                AI 卡片
              </button>"""
assert old in s, 'view toggle'
s = s.replace(old, new, 1)

old = "  const [view, setView] = useState<'windows' | 'cards'>('windows')"
new = "  const [view, setView] = useState<'windows' | 'tree' | 'cards'>('windows')"
assert old in s, 'view state'
s = s.replace(old, new, 1)

# ---- 3) render tree view before the cards view ----
old = "        {view === 'cards' && ("
new = """        {view === 'tree' && (
          <ActivityTree
            activities={filteredActivities}
            tasks={dayTasks}
            projects={projects}
            colorOf={projectColor}
          />
        )}

        {view === 'cards' && ("""
assert old in s, 'tree render'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ActivityTree wired')
