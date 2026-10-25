import React, { useCallback, useEffect, useState } from 'react'
import type { Project, Rule, RuleNode, RuleSuggestionItem } from '@shared/types'
import { NodeEditor, nodeLabel, replaceAt } from '../components/RuleEditor'

interface AiGroupView {
  name: string
  reason: string
  projectId: number | null
  projectTitle: string | null
  items: { appName: string; titlePattern: string; totalMinutes: number }[]
  totalMinutes: number
}
import { formatDuration } from '../lib/format'

interface DraftState {
  tree: RuleNode
  projectId: number | null
}

export default function ReviewPage(): React.ReactElement {
  const [groups, setGroups] = useState<RuleSuggestionItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [status, setStatus] = useState('')
  const [aiGroups, setAiGroups] = useState<AiGroupView[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  const load = useCallback(() => {
    void window.dayflow.reviewUnclassified().then(setGroups)
    void window.dayflow.listProjects().then(setProjects)
    void window.dayflow.listRules().then(setRules)
  }, [])

  useEffect(load, [load])

  const startRule = (g: RuleSuggestionItem | null): void => {
    setDraft({
      tree: {
        kind: 'all',
        children: [
          g
            ? { kind: 'cond', field: 'title', op: 'contains', value: g.titlePattern }
            : { kind: 'cond', field: 'app', op: 'contains', value: '' }
        ]
      },
      projectId: (g && g.suggestion ? g.suggestion.projectId : null) ?? projects[0]?.id ?? null
    })
    setStatus('')
  }

  const onTreeChange = (path: number[], next: RuleNode | null): void => {
    setDraft((prev) => (prev ? { ...prev, tree: replaceAt(prev.tree, path, next) } : prev))
  }

  const createRule = (): void => {
    if (!draft || draft.projectId === null) {
      setStatus('请选择目标项目')
      return
    }
    const hasValue = JSON.stringify(draft.tree).includes('"value":"')
    if (!hasValue) {
      setStatus('至少填一个条件')
      return
    }
    void window.dayflow.createRule(draft.projectId, draft.tree).then((res) => {
      setStatus(`规则已创建，并回溯归类了 ${res.appliedCount} 段历史活动`)
      setDraft(null)
      load()
    })
  }

  const runAiGroup = (): void => {
    setAiLoading(true)
    setAiGroups(null)
    void window.dayflow.aiGroupUnclassified(7).then((res) => {
      setAiLoading(false)
      if (res.ok && res.groups) setAiGroups(res.groups)
      else setStatus(`AI 分组失败：${res.error ?? '未知错误'}`)
    })
  }

  const applyGroup = (g: AiGroupView, projectId: number): void => {
    void window.dayflow.applyAiGroup(g, projectId).then((n) => {
      setStatus(
        `「${g.name}」整组归类完成：${n} 段活动归入 ${projects.find((p) => p.id === projectId)?.title ?? ''}`
      )
      setAiGroups((prev) => (prev ? prev.filter((x) => x !== g) : prev))
      load()
    })
  }

  const quickAssign = (g: RuleSuggestionItem, projectId: number): void => {
    void window.dayflow.bulkAssign(g.appName, g.titlePattern, projectId).then((n) => {
      setStatus(`已把 ${n} 段「${g.appName}」活动归入类型`)
      load()
    })
  }

  /** 项目下拉：层级缩进路径。 */
  const flatProjects = (): { p: Project; depth: number }[] => {
    const out: { p: Project; depth: number }[] = []
    const walk = (parentId: number | null, depth: number): void => {
      for (const p of projects.filter((x) => x.parentId === parentId)) {
        out.push({ p, depth })
        walk(p.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  const projectTitle = (id: number): string => {
    const flat = flatProjects()
    const item = flat.find((x) => x.p.id === id)
    return item ? `${'　'.repeat(item.depth)}${item.p.title}` : `#${id}`
  }

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1 className="page-title">整理</h1>
          <div className="page-subtitle">
            未归类时间批量归位；规则支持 AND / OR / NOT 任意嵌套（Timing 谓词树），归入类型树任意层级
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={runAiGroup} disabled={aiLoading}>
            {aiLoading ? 'AI 分组中…' : '✨ AI 智能分组'}
          </button>
          <button className="btn primary" onClick={() => startRule(null)}>
            新建规则
          </button>
        </div>
      </div>

      {aiLoading && (
        <div className="pending-note">
          <span className="spinner" />
          正在把未归类活动聚类成主题组（约 10-30 秒）…
        </div>
      )}

      {aiGroups && aiGroups.length === 0 && (
        <div className="pending-note">最近 7 天没有可分组的未归类活动。</div>
      )}

      {aiGroups && aiGroups.length > 0 && (
        <div className="panel" style={{ borderColor: 'var(--accent)' }}>
          <div className="panel-title">
            AI 主题分组（每组可一键归类）
            <button className="btn small ghost" onClick={() => setAiGroups(null)}>
              收起
            </button>
          </div>
          {aiGroups.map((g, gi) => (
            <div key={gi} className="ai-group-card">
              <div className="ai-group-head">
                <strong>{g.name}</strong>
                <span className="chip">{formatDuration(g.totalMinutes)}</span>
                <span className="field-help" style={{ margin: 0 }}>
                  {g.reason}
                </span>
              </div>
              <div className="ai-group-items">
                {g.items.slice(0, 8).map((it, i) => (
                  <span className="chip" key={i} title={`${it.appName} ${it.totalMinutes} 分钟`}>
                    {it.appName} · {it.titlePattern.slice(0, 18) || '（无标题）'}
                  </span>
                ))}
                {g.items.length > 8 && <span className="field-help">+{g.items.length - 8} 项</span>}
              </div>
              <div className="ai-group-actions">
                {g.projectId !== null ? (
                  <button className="btn small primary" onClick={() => applyGroup(g, g.projectId!)}>
                    按建议归入「{g.projectTitle}」
                  </button>
                ) : (
                  <span className="field-help">AI 未找到匹配项目，请手动选择：</span>
                )}
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== '') applyGroup(g, Number(e.target.value))
                    e.currentTarget.value = ''
                  }}
                  style={{ maxWidth: 170 }}
                >
                  <option value="">归入类型…</option>
                  {flatProjects().map(({ p, depth }) => (
                    <option key={p.id} value={p.id}>
                      {'　'.repeat(depth)}
                      {p.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {status && (
        <div className="pending-note">
          <span style={{ color: 'var(--green)' }}>✓</span>
          {status}
        </div>
      )}

      {draft && (
        <div className="panel" style={{ borderColor: 'var(--accent)' }}>
          <div className="panel-title">
            构建规则（当满足以下条件时 → 归入类型）
            <button className="btn small ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
          <NodeEditor node={draft.tree} path={[]} onChange={onTreeChange} />
          <div className="rule-builder" style={{ marginTop: 12 }}>
            <span className="rule-word">→ 归入</span>
            <select
              value={draft.projectId ?? ''}
              onChange={(e) => setDraft({ ...draft, projectId: Number(e.target.value) })}
              style={{ maxWidth: 220 }}
            >
              {flatProjects().map(({ p, depth }) => (
                <option key={p.id} value={p.id}>
                  {'　'.repeat(depth)}
                  {p.title}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={createRule}>
              创建并回溯归类
            </button>
          </div>
          <div className="field-help">预览：当 {nodeLabel(draft.tree)} 时归入所选项目。</div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">
          未归类活动
          <span style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 400 }}>
            按应用+标题分组，按占用时间排序
          </span>
        </div>
        {groups.length === 0 && <div className="field-help">所有活动都已归类，干得漂亮。</div>}
        {groups.map((g) => (
          <div key={`${g.appName}|${g.titlePattern}`} className="review-row">
            <div className="review-main">
              <div className="review-title">
                <strong>{g.appName}</strong> — {g.titlePattern || '（无标题）'}
              </div>
              <div className="field-help">{formatDuration(g.totalMinutes)} 未归类</div>
            </div>
            {g.suggestion && (
              <button
                className="btn small"
                style={{ borderColor: g.suggestion.projectColor, color: g.suggestion.projectColor }}
                onClick={() => quickAssign(g, g.suggestion!.projectId)}
                title={`根据你过去 ${g.suggestion.hits} 次的手动归类建议`}
              >
                建议：{g.suggestion.projectTitle}
              </button>
            )}
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value !== '') quickAssign(g, Number(e.target.value))
                e.currentTarget.value = ''
              }}
              style={{ maxWidth: 160 }}
            >
              <option value="">归入类型…</option>
              {flatProjects().map(({ p, depth }) => (
                <option key={p.id} value={p.id}>
                  {'　'.repeat(depth)}
                  {p.title}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => startRule(g)}>
              建规则
            </button>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">自动归类规则（按顺序，首个命中生效）</div>
        {rules.length === 0 && (
          <div className="field-help">还没有规则。点右上角「新建规则」或从未归类活动一键生成。</div>
        )}
        {rules.map((r) => (
          <div key={r.id} className="review-row">
            <div className="review-main">
              <code className="rule-view">{nodeLabel(r.conditions)}</code>
            </div>
            <span
              className="chip"
              style={{ color: projects.find((p) => p.id === r.projectId)?.color }}
            >
              → {projectTitle(r.projectId).trim()}
            </span>
            <button
              className="icon-btn"
              title="删除规则"
              onClick={() => void window.dayflow.deleteRule(r.id).then(setRules)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
