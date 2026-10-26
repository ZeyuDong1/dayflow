import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClassificationEntry, Project, ProjectsOverview, Rule, RuleNode } from '@shared/types'
import { NodeEditor, emptyRuleTree, nodeLabel, replaceAt } from '../components/RuleEditor'
import { formatDuration } from '../lib/format'

const SWATCHES = [
  '#e8763a',
  '#4a5fd9',
  '#7ba8e8',
  '#c79be8',
  '#4fd1b5',
  '#f08a6a',
  '#d4a843',
  '#e05252',
  '#2fa47a',
  '#6f665a'
]

interface Props {
  onDataChanged: () => void
}

interface Draft {
  title: string
  color: string
  productivityScore: number
  billableByDefault: boolean
  parentId: number | null
}

interface RolledStats {
  todayMin: number
  weekMin: number
  monthMin: number
  segments: number
  topApps: { app: string; minutes: number }[]
}

function draftOf(p: Project): Draft {
  return {
    title: p.title,
    color: p.color,
    productivityScore: p.productivityScore,
    billableByDefault: p.billableByDefault,
    parentId: p.parentId
  }
}

export default function ProjectsPage({ onDataChanged }: Props): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([])
  const [overview, setOverview] = useState<ProjectsOverview | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [classifications, setClassifications] = useState<ClassificationEntry[]>([])
  const [selected, setSelected] = useState<number | 'overview'>('overview')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleNode | null>(null)
  const [mergeTarget, setMergeTarget] = useState<number | ''>('')
  const [adding, setAdding] = useState<{ title: string; parentId: number | null } | null>(null)
  const [status, setStatus] = useState('')

  const load = useCallback(() => {
    void window.dayflow.listProjects().then(setProjects)
    void window.dayflow.getProjectsOverview().then(setOverview)
    void window.dayflow.listRules().then(setRules)
    void window.dayflow.listClassifications().then(setClassifications)
  }, [])

  useEffect(load, [load])

  const project = projects.find((p) => p.id === selected) ?? null

  useEffect(() => {
    setDraft(project ? draftOf(project) : null)
    setRuleDraft(null)
    setMergeTarget('')
    setStatus('')
    // 仅在切换选中项时重置草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // ---- 树形与统计 -------------------------------------------------------

  const flat = useMemo(() => {
    const out: { p: Project; depth: number }[] = []
    const sorted = [...projects].sort((a, b) => a.listPosition - b.listPosition)
    const walk = (parentId: number | null, depth: number): void => {
      for (const p of sorted.filter((x) => x.parentId === parentId)) {
        out.push({ p, depth })
        walk(p.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [projects])

  const descendantIds = useCallback(
    (id: number): number[] => {
      const out = [id]
      for (let i = 0; i < out.length; i++) {
        for (const p of projects.filter((x) => x.parentId === out[i])) out.push(p.id)
      }
      return out
    },
    [projects]
  )

  /** 子项目时长滚动到祖先（与侧边栏一致）。 */
  const rolled = useMemo(() => {
    const m = new Map<number, RolledStats>()
    const empty = (): RolledStats => ({ todayMin: 0, weekMin: 0, monthMin: 0, segments: 0, topApps: [] })
    for (const p of projects) {
      const s = overview?.stats.find((x) => x.projectId === p.id)
      m.set(p.id, s ? { ...s, topApps: [...s.topApps] } : empty())
    }
    const sorted = [...projects].sort((a, b) => a.listPosition - b.listPosition)
    for (let pass = 0; pass < 5; pass++) {
      for (const p of sorted) {
        if (p.parentId !== null && m.has(p.parentId)) {
          const parent = m.get(p.parentId)!
          const child = m.get(p.id)
          if (!child) continue
          parent.todayMin += child.todayMin
          parent.weekMin += child.weekMin
          parent.monthMin += child.monthMin
          parent.segments += child.segments
        }
      }
    }
    return m
  }, [projects, overview])

  // ---- 项目操作 ---------------------------------------------------------

  const saveDraft = (): void => {
    if (!project || !draft) return
    const title = draft.title.trim()
    if (!title) {
      setStatus('项目名称不能为空')
      return
    }
    void window.dayflow
      .updateProject(project.id, {
        title,
        color: draft.color,
        productivityScore: draft.productivityScore,
        billableByDefault: draft.billableByDefault,
        parentId: draft.parentId
      })
      .then(() => {
        setStatus('已保存')
        load()
        onDataChanged()
      })
  }

  const dirty =
    !!project &&
    !!draft &&
    (draft.title !== project.title ||
      draft.color !== project.color ||
      draft.productivityScore !== project.productivityScore ||
      draft.billableByDefault !== project.billableByDefault ||
      draft.parentId !== project.parentId)

  const move = (p: Project, dir: -1 | 1): void => {
    const siblings = projects
      .filter((x) => x.parentId === p.parentId)
      .sort((a, b) => a.listPosition - b.listPosition)
    const idx = siblings.findIndex((x) => x.id === p.id)
    const other = siblings[idx + dir]
    if (!other) return
    void window.dayflow.updateProject(p.id, { listPosition: other.listPosition }).then(() =>
      window.dayflow
        .updateProject(other.id, { listPosition: p.listPosition })
        .then(() => {
          load()
          onDataChanged()
        })
    )
  }

  const addChild = (parentId: number | null): void => {
    setAdding({ title: '', parentId })
  }

  const createProject = (): void => {
    if (!adding || !adding.title.trim()) return
    void window.dayflow
      .createProject({
        title: adding.title.trim(),
        parentId: adding.parentId,
        color: SWATCHES[projects.length % SWATCHES.length],
        productivityScore: 5
      })
      .then((p) => {
        setAdding(null)
        setSelected(p.id)
        load()
        onDataChanged()
      })
  }

  const removeProject = (p: Project): void => {
    const kids = projects.filter((x) => x.parentId === p.id).length
    const ok = window.confirm(
      `删除项目「${p.title}」？\n\n其下 ${kids} 个子项目和${rules.filter((r) => r.projectId === p.id).length} 条规则会一并删除，相关活动将变为未归类。`
    )
    if (!ok) return
    void window.dayflow.deleteProject(p.id).then(() => {
      setSelected('overview')
      load()
      onDataChanged()
      setStatus(`已删除「${p.title}」`)
    })
  }

  const mergeInto = (p: Project, targetId: number): void => {
    const target = projects.find((x) => x.id === targetId)
    if (!target) return
    const ok = window.confirm(
      `把「${p.title}」合并到「${target.title}」？\n\n活动、任务、规则、归类映射和子项目都会移入目标项目，源项目将被删除。`
    )
    if (!ok) return
    void window.dayflow.mergeProjects(p.id, targetId).then(() => {
      setSelected(targetId)
      load()
      onDataChanged()
      setStatus(`已把「${p.title}」合并到「${target.title}」`)
    })
  }

  // ---- 规则与归类映射 ----------------------------------------------------

  const createRule = (): void => {
    if (!project || !ruleDraft) return
    const hasValue = JSON.stringify(ruleDraft).includes('"value":"')
    if (!hasValue) {
      setStatus('规则至少要填一个条件值')
      return
    }
    void window.dayflow.createRule(project.id, ruleDraft).then((res) => {
      setRuleDraft(null)
      setStatus(`规则已创建，并回溯归类了 ${res.appliedCount} 段历史活动`)
      load()
      onDataChanged()
    })
  }

  const projRules = rules.filter((r) => r.projectId === selected)
  const projClassifications = classifications.filter((c) => c.projectId === selected)

  const mergeCandidates = flat.filter(({ p }) => !descendantIds(project?.id ?? -1).includes(p.id))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">类型树</h1>
          <div className="page-subtitle">
            无限层级类型树 · 颜色 / 效率分 / 可计费 · 自动归类规则与学习映射 · 合并与统计
          </div>
        </div>
        <div className="header-actions">
          <button className="btn primary" onClick={() => setAdding({ title: '', parentId: null })}>
            ＋ 新建项目
          </button>
        </div>
      </div>

      {adding && (
        <div className="panel pm-add-row">
          <input
            autoFocus
            type="text"
            placeholder="新项目名称…"
            value={adding.title}
            onChange={(e) => setAdding({ ...adding, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createProject()
              if (e.key === 'Escape') setAdding(null)
            }}
            style={{ maxWidth: 260 }}
          />
          <select
            value={adding.parentId ?? ''}
            onChange={(e) =>
              setAdding({ ...adding, parentId: e.target.value === '' ? null : Number(e.target.value) })
            }
            style={{ maxWidth: 220 }}
          >
            <option value="">（顶层项目）</option>
            {flat.map(({ p, depth }) => (
              <option key={p.id} value={p.id}>
                {'　'.repeat(depth)}
                {p.title}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={createProject}>
            创建
          </button>
          <button className="btn ghost" onClick={() => setAdding(null)}>
            取消
          </button>
        </div>
      )}

      {status && (
        <div className="pending-note">
          <span style={{ color: 'var(--green)' }}>✓</span>
          {status}
        </div>
      )}

      <div className="pm-layout">
        {/* ---------- 左：类型树 ---------- */}
        <div className="panel pm-tree">
          <div
            className={`pm-row pm-overview-row ${selected === 'overview' ? 'active' : ''}`}
            onClick={() => setSelected('overview')}
          >
            <span className="atr-dot" style={{ background: 'var(--accent)', width: 9, height: 9 }} />
            <span className="side-name">总览</span>
          </div>
          {flat.map(({ p, depth }) => (
            <div
              key={p.id}
              className={`pm-row ${selected === p.id ? 'active' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => setSelected(p.id)}
            >
              <span className="atr-dot" style={{ background: p.color, width: 9, height: 9 }} />
              <span className="side-name" title={p.title}>
                {p.title}
              </span>
              <span className="pm-row-actions">
                <button
                  className="icon-btn"
                  title="上移"
                  onClick={(e) => {
                    e.stopPropagation()
                    move(p, -1)
                  }}
                >
                  ↑
                </button>
                <button
                  className="icon-btn"
                  title="下移"
                  onClick={(e) => {
                    e.stopPropagation()
                    move(p, 1)
                  }}
                >
                  ↓
                </button>
                <button
                  className="icon-btn"
                  title="添加子项目"
                  onClick={(e) => {
                    e.stopPropagation()
                    addChild(p.id)
                  }}
                >
                  ＋
                </button>
              </span>
              <span className="side-min">
                {(rolled.get(p.id)?.monthMin ?? 0) >= 1 ? formatDuration(rolled.get(p.id)!.monthMin) : ''}
              </span>
            </div>
          ))}
          {projects.length === 0 && <div className="field-help">还没有项目，点右上角新建。</div>}
        </div>

        {/* ---------- 右：详情 ---------- */}
        {selected === 'overview' || !project ? (
          <div className="pm-detail">
            <div className="panel">
              <div className="panel-title">总览（近 30 天）</div>
              <div className="stat-cards">
                <div className="stat-card">
                  <div className="stat-value">{projects.length}</div>
                  <div className="stat-label">项目</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{rules.length}</div>
                  <div className="stat-label">自动归类规则</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{classifications.length}</div>
                  <div className="stat-label">学习到的归类映射</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">
                    {overview?.productivityIndex !== null && overview?.productivityIndex !== undefined
                      ? overview.productivityIndex
                      : '—'}
                  </div>
                  <div className="stat-label">效率指数（0-10）</div>
                </div>
              </div>
              <div className="field-help">
                未归类时长：今天 {formatDuration(overview?.unclassifiedMin.today ?? 0)} · 近 7 天{' '}
                {formatDuration(overview?.unclassifiedMin.week ?? 0)} · 近 30 天{' '}
                {formatDuration(overview?.unclassifiedMin.month ?? 0)}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">项目时长排行（近 30 天，含子项目）</div>
              {flat.map(({ p }) => {
                const month = rolled.get(p.id)?.monthMin ?? 0
                const max = Math.max(1, ...flat.map((x) => rolled.get(x.p.id)?.monthMin ?? 0))
                return (
                  <div key={p.id} className="app-usage-row" onClick={() => setSelected(p.id)}>
                    <span className="app-usage-name">
                      <span className="atr-dot" style={{ background: p.color, width: 8, height: 8 }} />
                      {p.title}
                    </span>
                    <span className="app-usage-bar">
                      <span className="app-usage-fill" style={{ width: `${(month / max) * 100}%`, background: p.color }} />
                    </span>
                    <span className="app-usage-min">{formatDuration(month)}</span>
                  </div>
                )
              })}
              {projects.length === 0 && <div className="field-help">暂无数据。</div>}
            </div>
          </div>
        ) : (
          <div className="pm-detail">
            {/* 基本信息 */}
            <div className="panel">
              <div className="panel-title">
                <span>
                  基本信息
                  <span className="pm-title-dot" style={{ background: draft?.color ?? project.color, marginLeft: 8 }} />
                </span>
                {dirty && (
                  <button className="btn small primary" onClick={saveDraft}>
                    保存修改
                  </button>
                )}
              </div>
              <div className="pm-form-grid">
                <label className="field">
                  <span className="field-label">项目名称</span>
                  <input
                    type="text"
                    value={draft?.title ?? ''}
                    onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                  />
                </label>
                <label className="field">
                  <span className="field-label">父项目（无限层级）</span>
                  <select
                    value={draft?.parentId ?? ''}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, parentId: e.target.value === '' ? null : Number(e.target.value) } : d
                      )
                    }
                  >
                    <option value="">（顶层项目）</option>
                    {flat
                      .filter(({ p }) => !descendantIds(project.id).includes(p.id))
                      .map(({ p, depth }) => (
                        <option key={p.id} value={p.id}>
                          {'　'.repeat(depth)}
                          {p.title}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <div className="field pm-color-row">
                <span className="field-label">颜色</span>
                <div className="pm-swatches">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      className={`pm-swatch ${draft?.color === c ? 'on' : ''}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => setDraft((d) => (d ? { ...d, color: c } : d))}
                    />
                  ))}
                  <input
                    type="color"
                    value={draft?.color ?? '#e8763a'}
                    onChange={(e) => setDraft((d) => (d ? { ...d, color: e.target.value } : d))}
                    title="自定义颜色"
                  />
                </div>
              </div>
              <div className="field">
                <span className="field-label">
                  效率分：{draft?.productivityScore ?? 0}（0 = 纯消遣，10 = 高效专注）
                </span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={draft?.productivityScore ?? 0}
                  onChange={(e) =>
                    setDraft((d) => (d ? { ...d, productivityScore: Number(e.target.value) } : d))
                  }
                />
                <span className="field-help">用于统计页的效率指数加权（0 分的项目不参与计算）。</span>
              </div>
              <label className="field pm-check">
                <input
                  type="checkbox"
                  checked={draft?.billableByDefault ?? false}
                  onChange={(e) =>
                    setDraft((d) => (d ? { ...d, billableByDefault: e.target.checked } : d))
                  }
                />
                <span>默认可计费（计入工时表导出）</span>
              </label>
            </div>

            {/* 时间统计 */}
            <div className="panel">
              <div className="panel-title">时间统计（含子项目）</div>
              <div className="stat-cards">
                <div className="stat-card">
                  <div className="stat-value">{formatDuration(rolled.get(project.id)?.todayMin ?? 0)}</div>
                  <div className="stat-label">今天</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{formatDuration(rolled.get(project.id)?.weekMin ?? 0)}</div>
                  <div className="stat-label">近 7 天</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{formatDuration(rolled.get(project.id)?.monthMin ?? 0)}</div>
                  <div className="stat-label">近 30 天</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{rolled.get(project.id)?.segments ?? 0}</div>
                  <div className="stat-label">活动段数（30 天）</div>
                </div>
              </div>
              {(rolled.get(project.id)?.topApps.length ?? 0) > 0 && (
                <>
                  <div className="field-label" style={{ marginTop: 10 }}>
                    主要应用（近 30 天，本项目）
                  </div>
                  {(overview?.stats.find((x) => x.projectId === project.id)?.topApps ?? []).map((a) => {
                    const apps = overview?.stats.find((x) => x.projectId === project.id)?.topApps ?? []
                    const max = Math.max(1, ...apps.map((x) => x.minutes))
                    return (
                      <div key={a.app} className="app-usage-row">
                        <span className="app-usage-name">{a.app}</span>
                        <span className="app-usage-bar">
                          <span
                            className="app-usage-fill"
                            style={{ width: `${(a.minutes / max) * 100}%`, background: project.color }}
                          />
                        </span>
                        <span className="app-usage-min">{formatDuration(a.minutes)}</span>
                      </div>
                    )
                  })}
                </>
              )}
            </div>

            {/* 规则 */}
            <div className="panel">
              <div className="panel-title">
                自动归类规则
                <button className="btn small" onClick={() => setRuleDraft(ruleDraft ? null : emptyRuleTree())}>
                  {ruleDraft ? '收起' : '＋ 新建规则'}
                </button>
              </div>
              {projRules.length === 0 && !ruleDraft && (
                <div className="field-help">
                  还没有以「{project.title}」为目标的规则。规则命中后活动自动归入本项目（首条命中生效）。
                </div>
              )}
              {projRules.map((r) => (
                <div key={r.id} className="review-row">
                  <div className="review-main">
                    <code className="rule-view">{nodeLabel(r.conditions)}</code>
                  </div>
                  <button
                    className="icon-btn"
                    title="删除规则"
                    onClick={() =>
                      void window.dayflow.deleteRule(r.id).then(() => {
                        load()
                        onDataChanged()
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              {ruleDraft && (
                <div className="pm-rule-draft">
                  <NodeEditor
                    node={ruleDraft}
                    path={[]}
                    onChange={(path, next) =>
                      setRuleDraft((prev) => (prev ? replaceAt(prev, path, next) : prev))
                    }
                  />
                  <div className="rule-builder" style={{ marginTop: 10 }}>
                    <span className="rule-word">→ 归入「{project.title}」</span>
                    <button className="btn primary" onClick={createRule}>
                      创建并回溯归类
                    </button>
                    <button className="btn ghost" onClick={() => setRuleDraft(null)}>
                      取消
                    </button>
                  </div>
                  <div className="field-help">预览：当 {nodeLabel(ruleDraft)} 时归入「{project.title}」。</div>
                </div>
              )}
            </div>

            {/* 学习到的归类映射 */}
            <div className="panel">
              <div className="panel-title">学习到的归类映射</div>
              <div className="field-help">
                手动归类或 AI 判定会记住「应用 / 标题 → 项目」的映射，之后自动套用。删除映射可让它重新学习。
              </div>
              {projClassifications.length === 0 && (
                <div className="field-help">暂无映射。在「整理」页归类或拖拽活动后会自动积累。</div>
              )}
              {projClassifications.map((c) => (
                <div key={`${c.appName}|${c.titlePattern}`} className="review-row">
                  <div className="review-main">
                    <strong>{c.appName}</strong>
                    <span className="chip" style={{ marginLeft: 8 }}>
                      {c.titlePattern === '*' ? '整个应用' : c.titlePattern}
                    </span>
                    <span className="field-help" style={{ marginLeft: 8 }}>
                      命中 {c.hits} 次
                    </span>
                  </div>
                  <button
                    className="icon-btn"
                    title="删除映射"
                    onClick={() =>
                      void window.dayflow.deleteClassification(c.appName, c.titlePattern).then(() => {
                        load()
                        setStatus('已删除映射，该应用/标题将重新归类')
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* 危险操作 */}
            <div className="panel pm-danger">
              <div className="panel-title">合并与删除</div>
              <div className="pm-merge-row">
                <span className="field-help" style={{ margin: 0 }}>
                  合并到其他项目（活动、规则、子项目全部移入）：
                </span>
                <select
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value === '' ? '' : Number(e.target.value))}
                  style={{ maxWidth: 200 }}
                >
                  <option value="">选择目标项目…</option>
                  {mergeCandidates.map(({ p, depth }) => (
                    <option key={p.id} value={p.id}>
                      {'　'.repeat(depth)}
                      {p.title}
                    </option>
                  ))}
                </select>
                <button
                  className="btn small"
                  disabled={mergeTarget === ''}
                  onClick={() => mergeTarget !== '' && mergeInto(project, mergeTarget)}
                >
                  合并
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn small danger" onClick={() => removeProject(project)}>
                  删除此项目
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
