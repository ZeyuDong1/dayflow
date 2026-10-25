import io

p = 'src/renderer/src/pages/TimelinePage.tsx'
s = io.open(p, encoding='utf-8').read()

# module-scoped drag ref
old2 = "const PX_PER_MIN = 1.15"
new2 = "const PX_PER_MIN = 1.15\nlet dragIdRef: number | null = null"
assert old2 in s, 'anchor2'
s = s.replace(old2, new2, 1)

# TimingAxis dragStart uses the ref
old3 = """                onDragStart={(e) => {
                  setDragId(a.id)
                  ;(e as unknown as { dataTransfer: DataTransfer }).dataTransfer?.setData('text/plain', String(a.id))
                }}"""
new3 = """                onDragStart={(e) => {
                  dragIdRef = a.id
                  e.dataTransfer?.setData('text/plain', String(a.id))
                }}"""
assert old3 in s, 'anchor3'
s = s.replace(old3, new3, 1)

# TimelinePage new state
old4 = """  const [runningTask, setRunningTask] = useState<TaskActivity | null>(null)
  const [taskTitle, setTaskTitle] = useState('')"""
new4 = """  const [runningTask, setRunningTask] = useState<TaskActivity | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [dayTasks, setDayTasks] = useState<TaskActivity[]>([])
  const [selectedActivity, setSelectedActivity] = useState<AppActivity | null>(null)
  const [manualDraft, setManualDraft] = useState<{ minute: number; title: string; dur: number } | null>(null)"""
assert old4 in s, 'anchor4'
s = s.replace(old4, new4, 1)

# load day tasks
old5 = """    void window.dayflow.getActivities(day).then(setActivities)
    void window.dayflow.listProjects().then(setProjects)"""
new5 = """    void window.dayflow.getActivities(day).then(setActivities)
    void window.dayflow.listProjects().then(setProjects)
    const [py, pm, pdd] = day.split('-').map(Number)
    const ds = new Date(py, pm - 1, pdd, 4, 0, 0, 0).getTime()
    void window.dayflow.listTasks(ds, ds + 86400_000).then(setDayTasks)"""
assert old5 in s, 'anchor5'
s = s.replace(old5, new5, 1)

# ProjectTree drop passes altKey
old6 = """          onDrop={(e) => {
            e.preventDefault()
            e.currentTarget.classList.remove('drop-target')
            onAssign(p.id)
          }}"""
new6 = """          onDrop={(e) => {
            e.preventDefault()
            e.currentTarget.classList.remove('drop-target')
            onAssign(p.id, e.altKey)
          }}"""
assert old6 in s, 'anchor6'
s = s.replace(old6, new6, 1)

old7 = "  onAssign: (projectId: number) => void"
new7 = "  onAssign: (projectId: number, alt: boolean) => void"
assert old7 in s, 'anchor7'
s = s.replace(old7, new7, 1)

# onAssign implementation: alt = assign + rule (Timing option-drag)
old8 = """          onAssign={(pid) => {
            if (dragId !== null) assign(dragId, pid)
            setDragId(null)
          }}"""
new8 = """          onAssign={(pid, alt) => {
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
assert old8 in s, 'anchor8'
s = s.replace(old8, new8, 1)

# TimingAxis invocation + detail + manual draft panels
old9 = """          <TimingAxis
            activities={filteredActivities}
            tasks={dayTasks}
            day={day}
            today={today}
            projects={projects}
            colorOf={projectColor}
            onSelect={setSelectedActivity}
            selected={selectedActivity}
          />"""
new9 = """          <TimingAxis
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
                <span className="ac-duration">
                  {clockFromTs(selectedActivity.startTs)} – {clockFromTs(selectedActivity.endTs)} ·{' '}
                  {formatDuration((selectedActivity.endTs - selectedActivity.startTs) / 60000)}
                </span>
                <button className="btn small ghost" onClick={() => setSelectedActivity(null)}>
                  关闭
                </button>
              </div>
              {selectedActivity.urlOrPath && (
                <div className="field-help">URL：{selectedActivity.urlOrPath}</div>
              )}
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
                  style={{ maxWidth: 170 }}
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
              <div className="panel-title">
                补录手动时间（
                {clockFromTs(
                  new Date(
                    parseDayKey(day).getFullYear(),
                    parseDayKey(day).getMonth(),
                    parseDayKey(day).getDate(),
                    4,
                    0,
                    0,
                    0
                  ).getTime() + manualDraft.minute * 60000
                )}{' '}
                起）
              </div>
              <div className="ai-group-actions">
                <input
                  autoFocus
                  type="text"
                  placeholder="做了什么…"
                  value={manualDraft.title}
                  onChange={(e) => setManualDraft({ ...manualDraft, title: e.target.value })}
                  style={{ flex: 1, minWidth: 150 }}
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
                    const st = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime() + manualDraft.minute * 60000
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
          )}"""
assert old9 in s, 'anchor9'
s = s.replace(old9, new9, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('timeline upgraded')
