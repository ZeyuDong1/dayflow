import React, { useCallback, useEffect, useState } from 'react'
import ActivitiesView from './pages/ActivitiesView'
import DailyPage from './pages/DailyPage'
import WeeklyPage from './pages/WeeklyPage'
import ChatPage from './pages/ChatPage'
import ReviewPage from './pages/ReviewPage'
import ProjectsPage from './pages/ProjectsPage'
import SettingsPage from './pages/SettingsPage'
import TaskPage from './pages/TaskPage'
import { dragState } from './lib/drag'
import { formatDuration } from './lib/format'
import type { AppActivity, AppSettings, Project } from '@shared/types'

type Nav = 'activities' | 'tasks' | 'review' | 'projects' | 'daily' | 'weekly' | 'chat' | 'settings'

const NAV: { id: Nav; label: string; icon: string }[] = [
  { id: 'activities', label: '活动', icon: '⏱' },
  { id: 'tasks', label: '任务', icon: '✅' },
  { id: 'review', label: '整理', icon: '🧹' },
  { id: 'projects', label: '类型树', icon: '🗂' },
  { id: 'daily', label: '站会', icon: '☀' },
  { id: 'weekly', label: '统计', icon: '📊' },
  { id: 'chat', label: '对话', icon: '💬' },
  { id: 'settings', label: '设置', icon: '⚙' }
]

interface ProjRow extends Project {
  depth: number
  minutes: number
}

function buildProjRows(projects: Project[], activities: AppActivity[]): ProjRow[] {
  const minutes = new Map<number, number>()
  for (const a of activities) {
    if (a.projectId !== null) {
      minutes.set(a.projectId, (minutes.get(a.projectId) ?? 0) + (a.endTs - a.startTs) / 60000)
    }
  }
  const rolled = new Map<number, number>()
  for (const p of projects) rolled.set(p.id, minutes.get(p.id) ?? 0)
  const sorted = [...projects].sort((a, b) => a.listPosition - b.listPosition)
  for (let pass = 0; pass < 5; pass++) {
    for (const p of sorted) {
      if (p.parentId !== null && rolled.has(p.parentId)) {
        rolled.set(p.parentId, (rolled.get(p.parentId) ?? 0) + (rolled.get(p.id) ?? 0))
      }
    }
  }
  const out: ProjRow[] = []
  const walk = (parentId: number | null, depth: number): void => {
    for (const p of sorted.filter((x) => x.parentId === parentId)) {
      out.push({ ...p, depth, minutes: rolled.get(p.id) ?? 0 })
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function Onboarding({ onDone }: { onDone: () => void }): React.ReactElement {
  const [step, setStep] = useState(0)
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="step-dots">
          <div className={`step-dot ${step >= 0 ? 'on' : ''}`} />
          <div className={`step-dot ${step >= 1 ? 'on' : ''}`} />
        </div>
        {step === 0 ? (
          <>
            <h2>欢迎使用 Dayflow</h2>
            <p className="modal-sub">
              自动工作日志：每 2 秒记录前台窗口（行为判定的主要依据），配合屏幕快照做视觉补充，AI
              生成时间线并自动归入类型。左侧是你的类型树（可拖拽活动归类），中间是活动明细，右侧是全局时间轴。
            </p>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setStep(1)}>
                继续
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>选择 AI 提供商</h2>
            <p className="modal-sub">
              请在 设置 → AI 提供商 中选择：Gemini、ChatGPT、Claude、智谱 GLM、小米 MiMo，或
              Ollama / LM Studio 完全本地运行。未配置 AI 也可正常使用规则引擎自动归类。
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                上一步
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  void window.dayflow.completeOnboarding('')
                  onDone()
                }}
              >
                开始使用
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  const [nav, setNav] = useState<Nav>('activities')
  const [day, setDay] = useState('')
  const [today, setToday] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [activities, setActivities] = useState<AppActivity[]>([])
  const [unclassifiedMin, setUnclassifiedMin] = useState(0)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [paused, setPaused] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [addingProj, setAddingProj] = useState(false)
  const [newProjTitle, setNewProjTitle] = useState('')
  const [dropTarget, setDropTarget] = useState<number | null | 'unassigned'>(null)

  useEffect(() => {
    void window.dayflow.getTodayKey().then((t) => {
      setToday(t)
      setDay(t)
    })
    void window.dayflow.isOnboarded().then((done) => setNeedsOnboarding(!done))
  }, [])

  const refresh = useCallback(() => {
    if (!day) return
    void window.dayflow.listProjects().then(setProjects)
    void window.dayflow.getActivities(day).then((acts) => {
      setActivities(acts)
      setUnclassifiedMin(
        acts.filter((a) => a.projectId === null).reduce((acc, a) => acc + (a.endTs - a.startTs), 0) / 60000
      )
    })
  }, [day])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const refreshStatus = useCallback(() => {
    void window.dayflow.getCaptureStatus().then((st) => {
      setPaused(!!st.pausedUntil && Date.now() < st.pausedUntil)
    })
    void window.dayflow.getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 20_000)
    return () => clearInterval(t)
  }, [refreshStatus])

  // 拖拽归类（Alt = 同时建规则，Timing 的 ⌥ 拖拽）
  const dropOnProject = (projectId: number | null, alt: boolean): void => {
    const seg = dragState.current
    dragState.current = null
    setDropTarget(null)
    if (!seg) return
    const assignAll = (): void => {
      seg.ids.forEach((id) => void window.dayflow.assignActivity(id, projectId))
      setTimeout(refresh, 250)
    }
    if (alt && projectId !== null) {
      // 关键词取标题去尾段（如"- www.site.com/"），无分隔符时退回首两个词
      const stripped = seg.title.replace(/[|·—–\-:：]\s*[^|·—–\-:：]*$/, '').trim()
      const kw = stripped || seg.title.split(/\s+/).slice(0, 2).join(' ')
      void window.dayflow
        .createRule(projectId, [
          { field: 'app', op: 'equals', value: seg.appName },
          { field: 'title', op: 'contains', value: kw }
        ])
        .then((res) => {
          assignAll()
          alert(`已归类并创建规则（回溯 ${res.appliedCount} 段）`)
        })
    } else {
      assignAll()
    }
  }

  const projRows = buildProjRows(projects, activities)
  const totalMin = activities.reduce((a, x) => a + (x.endTs - x.startTs), 0) / 60000

  const providerName = settings
    ? (({
        gemini: 'Gemini',
        openai: 'ChatGPT',
        anthropic: 'Claude',
        zhipu: '智谱 GLM',
        mimo: 'MiMo',
        ollama: 'Ollama',
        lmstudio: 'LM Studio',
        'openai-compatible': 'OpenAI 兼容',
        none: '未配置 AI'
      } as Record<string, string>)[settings.ai.provider] ?? '')
    : ''

  return (
    <div className="app">
      {/* ---------- 左侧边栏（Timing 式：导航 + 类型树带时长） ---------- */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">D</div>
          <div className="brand-name">Dayflow</div>
        </div>
        <button
          className="btn small"
          style={{ marginBottom: 10, width: '100%', justifyContent: 'center' }}
          onClick={() => {
            setAddingProj(true)
            setNewProjTitle('')
          }}
        >
          ＋ 新建项目
        </button>
        {addingProj && (
          <div className="add-row" style={{ marginBottom: 8 }}>
            <input
              autoFocus
              type="text"
              placeholder="项目名称…"
              value={newProjTitle}
              onChange={(e) => setNewProjTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newProjTitle.trim()) {
                  void window.dayflow
                    .createProject({ title: newProjTitle.trim(), parentId: null, color: '#e8763a' })
                    .then(() => {
                      setAddingProj(false)
                      refresh()
                    })
                }
              }}
            />
          </div>
        )}
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${nav === item.id ? 'active' : ''}`}
            onClick={() => setNav(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}

        <div className="side-section">
          <div className="side-head">
            项目
            <span className="side-total">{formatDuration(totalMin)}</span>
          </div>
          <div
            className={`side-proj ${dropTarget === 'unassigned' ? 'drop-target' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDropTarget('unassigned')
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault()
              dropOnProject(null, e.altKey)
            }}
            onClick={() => setNav('review')}
          >
            <span className="atr-dot" style={{ background: '#c9bfae', width: 9, height: 9 }} />
            <span className="side-name">未归类</span>
            <span className="side-min">{formatDuration(unclassifiedMin)}</span>
          </div>
          {projRows.map((p) => (
            <div
              key={p.id}
              className={`side-proj ${dropTarget === p.id ? 'drop-target' : ''}`}
              style={{ paddingLeft: 8 + p.depth * 14 }}
              onDragOver={(e) => {
                e.preventDefault()
                setDropTarget(p.id)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault()
                dropOnProject(p.id, e.altKey)
              }}
            >
              <span className="atr-dot" style={{ background: p.color, width: 9, height: 9 }} />
              <span className="side-name" title={p.title}>
                {p.title}
              </span>
              <span className="side-min">{p.minutes >= 1 ? formatDuration(p.minutes) : ''}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="recording-pill">
            <span className={`rec-dot ${paused ? 'paused' : settings?.capture.enabled ? '' : 'off'}`} />
            {paused ? '已暂停' : settings?.capture.enabled ? `记录中 · ${providerName}` : '记录已关闭'}
          </div>
        </div>
      </aside>

      {/* ---------- 主区域 ---------- */}
      <main className="main">
        {nav === 'activities' && (
          <ActivitiesView
            day={day}
            setDay={setDay}
            today={today}
            projects={projects}
            onDataChanged={refresh}
          />
        )}
        {nav === 'tasks' && <TaskPage />}
        {nav === 'review' && <ReviewPage />}
        {nav === 'projects' && <ProjectsPage onDataChanged={refresh} />}
        {nav === 'daily' && <DailyPage />}
        {nav === 'weekly' && <WeeklyPage />}
        {nav === 'chat' && <ChatPage />}
        {nav === 'settings' && <SettingsPage onSaved={refreshStatus} />}
      </main>
      {needsOnboarding && <Onboarding onDone={() => setNeedsOnboarding(false)} />}
    </div>
  )
}
