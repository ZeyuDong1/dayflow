import React, { useCallback, useEffect, useState } from 'react'
import type { AppSettings, DeepPartial, ProviderId, Project, StorageUsage } from '@shared/types'
import { addDays, formatBytes } from '../lib/format'

const PROVIDERS: { id: ProviderId; name: string; desc: string; needsKey: boolean; vision: string }[] = [
  { id: 'none', name: '不使用 AI', desc: '禁用 AI 分析（截图仍会继续）', needsKey: false, vision: '' },
  { id: 'gemini', name: 'Gemini', desc: 'Google AI Studio 的 API Key', needsKey: true, vision: 'gemini-2.5-flash 等' },
  { id: 'openai', name: 'ChatGPT', desc: 'OpenAI API Key', needsKey: true, vision: 'gpt-4o-mini 等' },
  { id: 'anthropic', name: 'Claude', desc: 'Anthropic API Key', needsKey: true, vision: 'claude-sonnet-4-5 等' },
  { id: 'zhipu', name: '智谱 GLM', desc: 'BigModel 平台 · API 按量 或 GLM Coding Plan', needsKey: true, vision: 'glm-4.6v / glm-4.6 等' },
  { id: 'mimo', name: 'MiMo', desc: '小米 MiMo · API 按量 或 Token Plan 订阅', needsKey: true, vision: 'mimo-v2.5-pro 等' },
  { id: 'ollama', name: 'Ollama（本地）', desc: '完全本地，如 qwen2.5vl / llama3.2-vision', needsKey: false, vision: 'ollama pull qwen2.5vl:7b' },
  { id: 'lmstudio', name: 'LM Studio（本地）', desc: '本地服务，默认端口 1234', needsKey: false, vision: '加载一个视觉模型' },
  { id: 'openai-compatible', name: 'OpenAI 兼容', desc: '任意自定义端点（vLLM、OpenRouter 等）', needsKey: false, vision: '任意视觉模型' }
]

const ROLES = [
  'Software Engineer',
  'Founder / Executive',
  'Designer',
  'Product Manager',
  'Data Scientist',
  'Student',
  'Other'
]

type Tab = 'ai' | 'tutor' | 'recording' | 'storage' | 'data' | 'general'

function mergeDeep<T>(base: T, patch: DeepPartial<T> | Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] =
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? mergeDeep(out[k] ?? {}, v as Record<string, unknown>)
        : v
  }
  return out as T
}

export default function SettingsPage({ onSaved }: { onSaved: () => void }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('ai')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [tutorStatus, setTutorStatus] = useState<Awaited<ReturnType<typeof window.dayflow.tutorStatus>> | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [goalDraft, setGoalDraft] = useState<string | null>(null)
  const [reflectMsg, setReflectMsg] = useState('')
  const [testing, setTesting] = useState(false)
  const [modelFetch, setModelFetch] = useState<
    Record<string, { loading: boolean; models: string[]; message?: string; error?: string; source?: string }>
  >({})
  const [exportStart, setExportStart] = useState('')
  const [exportEnd, setExportEnd] = useState('')
  const [reprocessDay, setReprocessDay] = useState('')
  const [statusMsg, setStatusMsg] = useState('')

  useEffect(() => {
    void window.dayflow.getSettings().then(setSettings)
    void window.dayflow.getStorageUsage().then(setUsage)
    void window.dayflow.tutorStatus().then(setTutorStatus)
    void window.dayflow.listProjects().then(setProjects)
    void window.dayflow.getTodayKey().then((t) => {
      setExportStart(t)
      setExportEnd(t)
      setReprocessDay(t)
    })
  }, [])

  const patch = useCallback(
    (p: DeepPartial<AppSettings>) => {
      setSettings((prev) => (prev ? (mergeDeep(prev, p) as AppSettings) : prev))
      void window.dayflow.setSettings(p).then((saved) => {
        setSettings(saved)
        onSaved()
      })
    },
    [onSaved]
  )

  const doReflect = (): void => {
    setReflectMsg('反思中…')
    void window.dayflow
      .tutorReflectNow()
      .then((ok) => {
        setReflectMsg(ok ? '已沉淀一条反思记忆' : '未生成(检查 AI 提供商与导师开关)')
        return window.dayflow.tutorStatus()
      })
      .then(setTutorStatus)
      .catch(() => setReflectMsg('反思失败'))
  }

  const test = (): void => {
    setTesting(true)
    setTestResult(null)
    void window.dayflow.testConnection().then((res) => {
      setTestResult(res)
      setTesting(false)
    })
  }

  const fetchModels = (provider: ProviderId): void => {
    setModelFetch((prev) => ({ ...prev, [provider]: { loading: true, models: [] } }))
    void window.dayflow
      .listModels(provider)
      .then((res) =>
        setModelFetch((prev) => ({
          ...prev,
          [provider]: { loading: false, models: res.models, message: res.message, source: res.source }
        }))
      )
      .catch((err: unknown) =>
        setModelFetch((prev) => ({
          ...prev,
          [provider]: {
            loading: false,
            models: [],
            error: err instanceof Error ? err.message : String(err)
          }
        }))
      )
  }

  if (!settings) {
    return (
      <div className="page page-narrow">
        <div className="empty-state">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  const ai = settings.ai
  const provider = ai.provider

  const modelField = (
    id: ProviderId,
    value: string,
    onChange: (v: string) => void,
    suggestions: string[] = []
  ): React.ReactElement => {
    const fetchState = modelFetch[id]
    const options = fetchState?.models.length ? fetchState.models : suggestions
    return (
      <div>
        <div className="model-row">
          <label className="field">
            <span className="field-label">模型</span>
            <input list={`models-${id}`} type="text" value={value} onChange={(e) => onChange(e.target.value)} />
            <datalist id={`models-${id}`}>
              {options.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <button className="btn" onClick={() => fetchModels(id)} disabled={fetchState?.loading}>
            {fetchState?.loading ? '拉取中…' : '拉取模型'}
          </button>
        </div>
        <span className="field-help">
          时间线分析需要支持图像（视觉）的模型。
          {suggestions.length > 0 && ` 例如 ${suggestions.slice(0, 3).join('、')}`}
        </span>
        {fetchState && !fetchState.loading && fetchState.error && (
          <div className="test-result err">拉取失败：{fetchState.error}</div>
        )}
        {fetchState && !fetchState.loading && !fetchState.error && fetchState.message && (
          <div className="field-help">{fetchState.message}</div>
        )}
        {fetchState && !fetchState.loading && fetchState.models.length > 0 && (
          <div className="chat-suggestions" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-faint)', alignSelf: 'center' }}>
              共 {fetchState.models.length} 个，点击选用：
            </span>
            {fetchState.models.slice(0, 30).map((m) => (
              <button
                key={m}
                className="suggestion-chip"
                style={m === value ? { borderColor: '#e59a63', color: 'var(--accent-deep)' } : undefined}
                onClick={() => onChange(m)}
              >
                {m}
              </button>
            ))}
            {fetchState.models.length > 30 && (
              <span style={{ fontSize: 12, color: 'var(--text-faint)', alignSelf: 'center' }}>…</span>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page page-narrow">
      <h1 className="page-title" style={{ marginBottom: 14 }}>
        设置
      </h1>

      <div className="settings-tabs">
        {(
          [
            ['ai', 'AI 提供商'],
            ['tutor', '导师'],
            ['recording', '录制'],
                  ['storage', '存储'],
            ['data', '数据'],
            ['general', '通用']
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`settings-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'ai' && (
        <>
          <div className="panel">
            <div className="panel-title">选择 AI 提供商</div>
            <div className="provider-grid">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`provider-card ${provider === p.id ? 'selected' : ''}`}
                  onClick={() => patch({ ai: { provider: p.id } })}
                >
                  <div className="provider-name">{p.name}</div>
                  <div className="provider-desc">{p.desc}</div>
                </button>
              ))}
            </div>

            {provider === 'gemini' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">Gemini API Key</span>
                  <input
                    type="password"
                    value={ai.gemini.apiKey}
                    onChange={(e) => patch({ ai: { gemini: { apiKey: e.target.value } } })}
                    placeholder="AIza…"
                  />
                </label>
                {modelField('gemini', ai.gemini.model, (v) => patch({ ai: { gemini: { model: v } } }), [
                  'gemini-2.5-pro',
                  'gemini-2.5-flash',
                  'gemini-2.0-flash'
                ])}
              </div>
            )}

            {provider === 'openai' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">OpenAI API Key</span>
                  <input
                    type="password"
                    value={ai.openai.apiKey}
                    onChange={(e) => patch({ ai: { openai: { apiKey: e.target.value } } })}
                    placeholder="sk-…"
                  />
                </label>
                {modelField('openai', ai.openai.model, (v) => patch({ ai: { openai: { model: v } } }), [
                  'gpt-4o',
                  'gpt-4o-mini',
                  'gpt-4.1-mini'
                ])}
                <label className="field">
                  <span className="field-label">Base URL</span>
                  <input
                    type="text"
                    value={ai.openai.baseUrl}
                    onChange={(e) => patch({ ai: { openai: { baseUrl: e.target.value } } })}
                  />
                </label>
              </div>
            )}

            {provider === 'anthropic' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">Anthropic API Key</span>
                  <input
                    type="password"
                    value={ai.anthropic.apiKey}
                    onChange={(e) => patch({ ai: { anthropic: { apiKey: e.target.value } } })}
                    placeholder="sk-ant-…"
                  />
                </label>
                {modelField('anthropic', ai.anthropic.model, (v) => patch({ ai: { anthropic: { model: v } } }), [
                  'claude-sonnet-4-5',
                  'claude-haiku-4-5'
                ])}
              </div>
            )}

            {provider === 'zhipu' && (
              <>
                <div className="settings-row" style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: 12 }}>
                  <div>
                    <div className="settings-row-label">接入方式</div>
                    <div className="settings-row-help">
                      API 按量计费走开放平台 OpenAI 兼容接口；GLM Coding Plan 订阅走 Anthropic 兼容网关（open.bigmodel.cn/api/anthropic），Key 通用。
                    </div>
                  </div>
                  <div className="settings-controls">
                    <button
                      className={`btn small ${ai.zhipu.mode !== 'coding' ? 'primary' : ''}`}
                      onClick={() => patch({ ai: { zhipu: { mode: 'api' } } })}
                    >
                      API 按量计费
                    </button>
                    <button
                      className={`btn small ${ai.zhipu.mode === 'coding' ? 'primary' : ''}`}
                      onClick={() => patch({ ai: { zhipu: { mode: 'coding' } } })}
                    >
                      GLM Coding Plan
                    </button>
                  </div>
                </div>
                <div className="provider-config">
                  <label className="field">
                    <span className="field-label">API Key（bigmodel.cn，两种方式通用）</span>
                    <input
                      type="password"
                      value={ai.zhipu.apiKey}
                      onChange={(e) => patch({ ai: { zhipu: { apiKey: e.target.value } } })}
                      placeholder="id.secret"
                    />
                  </label>
                  {ai.zhipu.mode === 'coding' ? (
                    <>
                      {modelField(
                        'zhipu',
                        ai.zhipu.codingModel,
                        (v) => patch({ ai: { zhipu: { codingModel: v } } }),
                        ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-4.6v', 'glm-4.5v']
                      )}
                      <label className="field">
                        <span className="field-label">Anthropic 网关 Base URL</span>
                        <input
                          type="text"
                          value={ai.zhipu.codingBaseUrl}
                          onChange={(e) => patch({ ai: { zhipu: { codingBaseUrl: e.target.value } } })}
                        />
                      </label>
                      <span className="field-help">
                        适用于 GLM Coding Plan 订阅（Lite/Pro/Max）。时间线分析需要视觉模型，若套餐内
                        模型不支持图像，请切换回 API 方式或本地模型。
                      </span>
                    </>
                  ) : (
                    <>
                      {modelField('zhipu', ai.zhipu.model, (v) => patch({ ai: { zhipu: { model: v } } }), [
                        'glm-4.6v',
                        'glm-4.5v',
                        'glm-4.1v-thinking-flash',
                        'glm-4v-flash'
                      ])}
                      <label className="field">
                        <span className="field-label">Base URL</span>
                        <input
                          type="text"
                          value={ai.zhipu.baseUrl}
                          onChange={(e) => patch({ ai: { zhipu: { baseUrl: e.target.value } } })}
                        />
                      </label>
                    </>
                  )}
                </div>
              </>
            )}

            {provider === 'mimo' && (
              <>
                <div className="settings-row" style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: 12 }}>
                  <div>
                    <div className="settings-row-label">接入方式</div>
                    <div className="settings-row-help">
                      API 按量计费走 OpenAI 兼容接口；Token Plan / Coding 订阅走 Anthropic 兼容网关（api.xiaomimimo.com/anthropic），Key 通用。
                    </div>
                  </div>
                  <div className="settings-controls">
                    <button
                      className={`btn small ${ai.mimo.mode !== 'coding' ? 'primary' : ''}`}
                      onClick={() => patch({ ai: { mimo: { mode: 'api' } } })}
                    >
                      API 按量计费
                    </button>
                    <button
                      className={`btn small ${ai.mimo.mode === 'coding' ? 'primary' : ''}`}
                      onClick={() => patch({ ai: { mimo: { mode: 'coding' } } })}
                    >
                      Token Plan 订阅
                    </button>
                  </div>
                </div>
                <div className="provider-config">
                  <label className="field">
                    <span className="field-label">MiMo API Key（两种方式通用）</span>
                    <input
                      type="password"
                      value={ai.mimo.apiKey}
                      onChange={(e) => patch({ ai: { mimo: { apiKey: e.target.value } } })}
                    />
                  </label>
                  {ai.mimo.mode === 'coding' ? (
                    <>
                      {modelField(
                        'mimo',
                        ai.mimo.codingModel,
                        (v) => patch({ ai: { mimo: { codingModel: v } } }),
                        ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash']
                      )}
                      <label className="field">
                        <span className="field-label">Anthropic 网关 Base URL</span>
                        <input
                          type="text"
                          value={ai.mimo.codingBaseUrl}
                          onChange={(e) => patch({ ai: { mimo: { codingBaseUrl: e.target.value } } })}
                        />
                      </label>
                      <span className="field-help">
                        适用于 MiMo Token Plan 订阅。时间线分析需要视觉模型；若所选模型不支持图像，
                        请切换回 API 方式或本地模型。
                      </span>
                    </>
                  ) : (
                    <>
                      {modelField('mimo', ai.mimo.model, (v) => patch({ ai: { mimo: { model: v } } }), [
                        'mimo-v2.5-pro',
                        'mimo-v2.5',
                        'mimo-v2-flash'
                      ])}
                      <label className="field">
                        <span className="field-label">Base URL</span>
                        <input
                          type="text"
                          value={ai.mimo.baseUrl}
                          onChange={(e) => patch({ ai: { mimo: { baseUrl: e.target.value } } })}
                        />
                      </label>
                    </>
                  )}
                </div>
              </>
            )}

            {provider === 'ollama' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">Ollama base URL</span>
                  <input
                    type="text"
                    value={ai.ollama.baseUrl}
                    onChange={(e) => patch({ ai: { ollama: { baseUrl: e.target.value } } })}
                  />
                </label>
                {modelField('ollama', ai.ollama.model, (v) => patch({ ai: { ollama: { model: v } } }), [
                  'qwen2.5vl:7b',
                  'llama3.2-vision',
                  'minicpm-v',
                  'gemma3:12b',
                  'moondream'
                ])}
                <span className="field-help">
                  Pull a vision model first: <code>ollama pull qwen2.5vl:7b</code>. Analysis then
                  never leaves this PC.
                </span>
              </div>
            )}

            {provider === 'lmstudio' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">LM Studio base URL</span>
                  <input
                    type="text"
                    value={ai.lmstudio.baseUrl}
                    onChange={(e) => patch({ ai: { lmstudio: { baseUrl: e.target.value } } })}
                  />
                </label>
                {modelField('lmstudio', ai.lmstudio.model, (v) => patch({ ai: { lmstudio: { model: v } } }), [])}
                <span className="field-help">
                  Start the local server in LM Studio (Developer tab) and load a vision model such as
                  Qwen2.5-VL.
                </span>
              </div>
            )}

            {provider === 'openai-compatible' && (
              <div className="provider-config">
                <label className="field">
                  <span className="field-label">Base URL</span>
                  <input
                    type="text"
                    value={ai['openai-compatible'].baseUrl}
                    onChange={(e) =>
                      patch({ ai: { 'openai-compatible': { baseUrl: e.target.value } } })
                    }
                    placeholder="http://localhost:8000/v1"
                  />
                </label>
                <label className="field">
                  <span className="field-label">API key (optional)</span>
                  <input
                    type="password"
                    value={ai['openai-compatible'].apiKey}
                    onChange={(e) =>
                      patch({ ai: { 'openai-compatible': { apiKey: e.target.value } } })
                    }
                  />
                </label>
                {modelField(
                  'openai-compatible',
                  ai['openai-compatible'].model,
                  (v) => patch({ ai: { 'openai-compatible': { model: v } } }),
                  []
                )}
              </div>
            )}

            {provider !== 'none' && (
              <div style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={test} disabled={testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {testResult && (
                  <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>{testResult.message}</div>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">你的名字（可提升 AI 输出质量）</div>
                <div className="settings-row-help">
                  用于在截图中识别哪些消息/帖子是你本人发的。
                </div>
              </div>
              <input
                type="text"
                value={settings.general.userName}
                onChange={(e) => patch({ general: { userName: e.target.value } })}
                placeholder="e.g. Zeyu"
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">AI 输出语言</div>
                <div className="settings-row-help">
                  例如：中文、English、日本語。留空则自动匹配屏幕内容语言。
                </div>
              </div>
              <input
                type="text"
                value={settings.general.outputLanguage}
                onChange={(e) => patch({ general: { outputLanguage: e.target.value } })}
                placeholder="中文"
              />
            </div>
          </div>
        </>
      )}

      {tab === 'tutor' && (
        <div className="panel">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">学习导师</div>
              <div className="settings-row-help">
                小舟是常驻的学习导师：记得你的目标和进度，随时陪你聊学习、给进入心流的建议，发现分心时主动提醒。对话页就是和它聊天。
              </div>
            </div>
            <button
              className={`switch ${settings.tutor.enabled ? 'on' : ''}`}
              onClick={() => patch({ tutor: { enabled: !settings.tutor.enabled } })}
            />
          </div>

          <div className="settings-row" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="settings-row-label">学习目标</div>
              <div className="settings-row-help">导师围绕这个目标辅导和建议，并写入长期记忆。失焦保存。</div>
            </div>
            <textarea
              rows={2}
              style={{ width: 320, resize: 'vertical' }}
              value={goalDraft ?? settings.tutor.goal}
              onChange={(e) => setGoalDraft(e.target.value)}
              onBlur={() => {
                if (goalDraft !== null && goalDraft !== settings.tutor.goal) patch({ tutor: { goal: goalDraft } })
              }}
              placeholder="例如：本周完成 TypeScript 泛型章节"
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label">导师反思间隔</div>
              <div className="settings-row-help">
                后台把最近的活动和对话沉淀成一条反思记忆的节奏。LLM 只在反思与对话时调用，常驻监测零消耗。
              </div>
            </div>
            <select
              value={settings.tutor.reflectMinutes}
              onChange={(e) => patch({ tutor: { reflectMinutes: Number(e.target.value) } })}
            >
              {[1, 5, 10, 15, 30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>
                  每 {m} 分钟
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label">记忆服务</div>
              <div className="settings-row-help">
                {tutorStatus
                  ? tutorStatus.running
                    ? `ai-memory v${tutorStatus.version} 运行中`
                    : `未运行${tutorStatus.lastError ? ' · ' + tutorStatus.lastError : ''}`
                  : '检查中…'}
                {reflectMsg ? ` · ${reflectMsg}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!tutorStatus?.running && (
                <button
                  className="btn small"
                  onClick={() =>
                    void window.dayflow
                      .tutorStartMemory()
                      .then(() => window.dayflow.tutorStatus())
                      .then(setTutorStatus)
                  }
                >
                  启动记忆服务
                </button>
              )}
              <button className="btn small" onClick={doReflect}>
                立即反思
              </button>
            </div>
          </div>

          <div className="settings-group-title">监督打断 · 分心时主动提醒</div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">轻提醒</div>
              <div className="settings-row-help">
                分心持续超过此时长，桌面通知轻推（可延迟一次）。与强打断时间相同则跳过轻提醒，只做强打断。
              </div>
            </div>
            <select
              value={settings.tutor.gentleSec}
              onChange={(e) => patch({ tutor: { gentleSec: Number(e.target.value) } })}
            >
              {[0, 10, 30, 60, 120, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? '立刻' : s < 60 ? `${s} 秒` : `${s / 60} 分钟`}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">强打断</div>
              <div className="settings-row-help">超过此时长仍未回到学习，置顶弹窗 + 提示音。</div>
            </div>
            <select
              value={settings.tutor.interruptSec}
              onChange={(e) => patch({ tutor: { interruptSec: Number(e.target.value) } })}
            >
              {[0, 10, 30, 60, 120, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? '立刻' : s < 60 ? `${s} 秒` : `${s / 60} 分钟`}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">重复提醒间隔</div>
              <div className="settings-row-help">持续分心时每隔此时长再打断一次；判定为心流状态时不打扰。</div>
            </div>
            <select
              value={settings.tutor.repeatSec / 60}
              onChange={(e) => patch({ tutor: { repeatSec: Number(e.target.value) * 60 } })}
            >
              {[5, 10, 15, 20, 30].map((m) => (
                <option key={m} value={m}>
                  {m} 分钟
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">一键休息时长</div>
              <div className="settings-row-help">被打断后选择“休息一下”的默认时长，期间不打扰。</div>
            </div>
            <select
              value={settings.tutor.breakMinutes}
              onChange={(e) => patch({ tutor: { breakMinutes: Number(e.target.value) } })}
            >
              {[5, 10, 15, 20, 30].map((m) => (
                <option key={m} value={m}>
                  {m} 分钟
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">提醒声音</div>
              <div className="settings-row-help">强打断时播放提示音。</div>
            </div>
            <button
              className={`switch ${settings.tutor.soundEnabled ? 'on' : ''}`}
              onClick={() => patch({ tutor: { soundEnabled: !settings.tutor.soundEnabled } })}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">预览强打断</div>
              <div className="settings-row-help">
                对当前窗口演示打断面板：恰好盖住内容区、让出标题栏；把底下窗口最小化或切走，面板自动消失。
              </div>
            </div>
            <button className="btn small" onClick={() => void window.dayflow.supervisionPreview()}>
              预览
            </button>
          </div>

          <div className="settings-group-title">学习项目白名单</div>
          <div className="settings-row" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="settings-row-label">算作“学习”的项目</div>
              <div className="settings-row-help">
                监督按白名单判定学习/分心。留空则按效率分自动判定（≥6 学习，≤3 分心）。
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 330, justifyContent: 'flex-end' }}>
              {projects.map((p) => {
                const on = settings.tutor.allowedProjectIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    className="suggestion-chip"
                    style={on ? { borderColor: '#e8763a', color: '#e8763a', background: '#fff3ea' } : undefined}
                    onClick={() =>
                      patch({
                        tutor: {
                          allowedProjectIds: on
                            ? settings.tutor.allowedProjectIds.filter((x) => x !== p.id)
                            : [...settings.tutor.allowedProjectIds, p.id]
                        }
                      })
                    }
                  >
                    {p.title}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'recording' && (
        <>
          <div className="panel">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">开启屏幕捕获</div>
                <div className="settings-row-help">
                  关闭后不再截图和分析，应用仍在托盘运行。
                </div>
              </div>
              <button
                className={`switch ${settings.capture.enabled ? 'on' : ''}`}
                onClick={() => patch({ capture: { enabled: !settings.capture.enabled } })}
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">截图间隔</div>
                <div className="settings-row-help">
                  窗口标题（每 2 秒）是行为分析的主要依据；截图仅作视觉补充，默认 30 秒足够。间隔越短细节越丰富，但占用更多磁盘与 AI token。
                </div>
              </div>
              <select
                value={settings.capture.intervalSec}
                onChange={(e) => patch({ capture: { intervalSec: Number(e.target.value) } })}
              >
                {[5, 10, 15, 30, 60, 120].map((s) => (
                  <option key={s} value={s}>
                    每 {s >= 60 ? `${s / 60} 分钟` : `${s} 秒`}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">捕获分辨率</div>
                <div className="settings-row-help">每帧保存前缩放到的目标高度。</div>
              </div>
              <select
                value={settings.capture.captureHeight}
                onChange={(e) => patch({ capture: { captureHeight: Number(e.target.value) } })}
              >
                {[720, 1080].map((h) => (
                  <option key={h} value={h}>
                    {h}p
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">捕获所有显示器</div>
                <div className="settings-row-help">
                  开启后每个显示器都会被捕获，并横向拼接成一张全景图交给 AI 分析（多屏办公时不错过任何屏幕）。关闭则只捕获主显示器。
                </div>
              </div>
              <button
                className={`switch ${settings.capture.captureAllDisplays !== false ? 'on' : ''}`}
                onClick={() =>
                  patch({ capture: { captureAllDisplays: settings.capture.captureAllDisplays === false } })
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">空闲阈值</div>
                <div className="settings-row-help">
                  无键鼠输入超过该时长后暂停捕获，空档记为空闲时间。
                </div>
              </div>
              <select
                value={settings.capture.idleThresholdSec}
                onChange={(e) => patch({ capture: { idleThresholdSec: Number(e.target.value) } })}
              >
                {[60, 120, 300, 600, 900].map((s) => (
                  <option key={s} value={s}>
                    {s / 60} 分钟
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">快速暂停</div>
                <div className="settings-row-help">
                  可从托盘菜单暂停，也可以在这里暂停。
                </div>
              </div>
              <div className="settings-controls">
                <button className="btn small" onClick={() => void window.dayflow.pauseCapture(30)}>
                  30 分钟
                </button>
                <button className="btn small" onClick={() => void window.dayflow.pauseCapture(60)}>
                  1 小时
                </button>
                <button className="btn small" onClick={() => void window.dayflow.pauseCapture(240)}>
                  4 小时
                </button>
                <button className="btn small primary" onClick={() => void window.dayflow.resumeCapture()}>
                  恢复记录
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">隐私应用（永不截图）</div>
            <div className="field-help" style={{ marginBottom: 10 }}>
              当这些应用位于前台时，保存灰色占位图而不是真实截图。逗号分隔，按应用名或窗口标题匹配。
            </div>
            <textarea
              style={{ width: '100%' }}
              value={settings.capture.privateApps.join(', ')}
              onChange={(e) =>
                patch({
                  capture: {
                    privateApps: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  }
                })
              }
            />
          </div>
        </>
      )}

      {tab === 'storage' && (
        <div className="panel">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">快照占用上限</div>
              <div className="settings-row-help">
                超出上限时优先删除最老的快照（活动卡片保留）。
              </div>
            </div>
            <select
              value={settings.storage.recordingsLimitBytes}
              onChange={(e) => patch({ storage: { recordingsLimitBytes: Number(e.target.value) } })}
            >
              {[1, 2, 5, 10, 20, 50].map((gb) => (
                <option key={gb} value={gb * 1_000_000_000}>
                  {gb} GB
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">自动清理</div>
              <div className="settings-row-help">
                自动清除 30 天前的快照、清理孤儿文件、精简数据库。
              </div>
            </div>
            <button
              className={`switch ${settings.storage.autoCleanup ? 'on' : ''}`}
              onClick={() => patch({ storage: { autoCleanup: !settings.storage.autoCleanup } })}
            />
          </div>
          {usage && (
            <div className="settings-row">
              <div>
                <div className="settings-row-label">当前占用</div>
                <div className="settings-row-help">
                  快照： {formatBytes(usage.recordingsBytes)} · 数据库：{' '}
                  {formatBytes(usage.dbBytes)} · {usage.screenshotCount} 张快照 ·{' '}
                  {usage.cardCount} 张活动卡片
                </div>
              </div>
              <button
                className="btn small"
                onClick={() => void window.dayflow.cleanupNow().then(setUsage)}
              >
                立即清理
              </button>
            </div>
          )}
          <div className="settings-row">
            <div>
              <div className="settings-row-label">数据目录</div>
              <div className="settings-row-help">
                所有数据都在 %APPDATA%\Dayflow（recordings/ 与 data/dayflow.db）。
              </div>
            </div>
            <button className="btn small" onClick={() => void window.dayflow.openDataFolder()}>
              打开目录
            </button>
          </div>
        </div>
      )}

      {tab === 'data' && (
        <>
          <div className="panel">
            <div className="panel-title">导出时间线为 Markdown</div>
            <div className="provider-config">
              <label className="field">
                <span className="field-label">开始日期</span>
                <input type="date" value={exportStart} onChange={(e) => setExportStart(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">结束日期</span>
                <input type="date" value={exportEnd} onChange={(e) => setExportEnd(e.target.value)} />
              </label>
              <button
                className="btn primary"
                onClick={() =>
                  void window.dayflow
                    .exportMarkdown(exportStart, exportEnd || exportStart)
                    .then((r) => setStatusMsg(r.message))
                }
              >
                导出
              </button>
            </div>
            {statusMsg && <div className="field-help" style={{ marginTop: 8 }}>{statusMsg}</div>}
          </div>

          <div className="panel">
            <div className="panel-title">重新分析某一天</div>
            <div className="provider-config">
              <label className="field">
                <span className="field-label">日期</span>
                <input type="date" value={reprocessDay} onChange={(e) => setReprocessDay(e.target.value)} />
              </label>
              <button
                className="btn"
                onClick={() => {
                  if (reprocessDay) {
                    void window.dayflow.reprocessDay(reprocessDay).then((n) => {
                      setStatusMsg(`正在重新分析 ${reprocessDay}：已将 ${n} 张快照加入分析队列。`)
                    })
                  }
                }}
              >
                重新分析
              </button>
            </div>
            <div className="field-help" style={{ marginTop: 8 }}>
              该天现有的卡片会被删除，并基于已保存的快照重新生成——切换 AI 提供商或模型后特别有用。
            </div>
          </div>

          <div className="panel" style={{ borderColor: 'rgba(248,113,113,0.35)' }}>
            <div className="panel-title" style={{ color: 'var(--red)' }}>
              危险操作
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">删除全部数据</div>
                <div className="settings-row-help">
                  删除所有快照、时间线卡片、站会记录和对话历史。设置会保留。
                </div>
              </div>
              <button
                className="btn danger"
                onClick={() =>
                  void window.dayflow.deleteAllData().then((r) => {
                    setStatusMsg(r.message)
                    void window.dayflow.getStorageUsage().then(setUsage)
                  })
                }
              >
                全部删除
              </button>
            </div>
          </div>
        </>
      )}

      {tab === 'general' && (
        <div className="panel">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">开机自启动</div>
              <div className="settings-row-help">开机后 Dayflow 最小化到托盘启动。</div>
            </div>
            <button
              className={`switch ${settings.general.launchAtLogin ? 'on' : ''}`}
              onClick={() => void window.dayflow.setLoginItem(!settings.general.launchAtLogin)}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">关闭窗口时</div>
              <div className="settings-row-help">
                关闭窗口后 Dayflow 继续在系统托盘运行以保持记录。完全退出请用 托盘 → 退出 Dayflow。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
