import { getSettings } from '../settings'
import { db } from '../db'
import type { AppSettings, ProviderId } from '../../shared/types'

export interface LabeledImage {
  base64: string
  label: string // clock time label shown to the model
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

interface ProviderRuntime {
  id: ProviderId
  model: string
  ready: boolean
}

export function resolveProvider(settings: AppSettings = getSettings()): ProviderRuntime {
  const ai = settings.ai
  switch (ai.provider) {
    case 'gemini':
      return { id: 'gemini', model: ai.gemini.model, ready: ai.gemini.apiKey.trim().length > 0 }
    case 'openai':
      return {
        id: 'openai',
        model: ai.openai.model,
        ready: ai.openai.apiKey.trim().length > 0 && ai.openai.baseUrl.trim().length > 0
      }
    case 'anthropic':
      return { id: 'anthropic', model: ai.anthropic.model, ready: ai.anthropic.apiKey.trim().length > 0 }
    case 'zhipu': {
      const cfg = settings.ai.zhipu
      const model = cfg.mode === 'coding' ? cfg.codingModel : cfg.model
      return {
        id: 'zhipu',
        model,
        ready: cfg.apiKey.trim().length > 0 && model.trim().length > 0
      }
    }
    case 'mimo': {
      const cfg = settings.ai.mimo
      const model = cfg.mode === 'coding' ? cfg.codingModel : cfg.model
      return {
        id: 'mimo',
        model,
        ready: cfg.apiKey.trim().length > 0 && model.trim().length > 0
      }
    }
    case 'ollama':
      return {
        id: 'ollama',
        model: ai.ollama.model,
        ready: ai.ollama.baseUrl.trim().length > 0 && ai.ollama.model.trim().length > 0
      }
    case 'lmstudio':
      return {
        id: 'lmstudio',
        model: ai.lmstudio.model,
        ready: ai.lmstudio.model.trim().length > 0
      }
    case 'openai-compatible':
      return {
        id: 'openai-compatible',
        model: ai['openai-compatible'].model,
        ready:
          ai['openai-compatible'].baseUrl.trim().length > 0 &&
          ai['openai-compatible'].model.trim().length > 0
      }
    default:
      return { id: 'none', model: '', ready: false }
  }
}

function logCall(
  provider: string,
  model: string,
  operation: string,
  status: 'success' | 'failure',
  latencyMs: number,
  errorMessage?: string
): void {
  try {
    db.run(
      `INSERT INTO llm_calls (created_at, provider, model, operation, status, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), provider, model, operation, status, latencyMs, errorMessage ?? null]
    )
  } catch {
    // logging must never break the pipeline
  }
}

export class ProviderError extends Error {
  constructor(message: string, public httpStatus?: number) {
    super(message)
  }
}

/** Coding-plan endpoints (GLM Coding Plan, MiMo Token Plan) speak the Anthropic Messages protocol. */
export function isCodingMode(provider: ProviderId, settings: AppSettings = getSettings()): boolean {
  if (provider === 'zhipu') return settings.ai.zhipu.mode === 'coding'
  if (provider === 'mimo') return settings.ai.mimo.mode === 'coding'
  return false
}

function codingEndpoint(
  provider: 'zhipu' | 'mimo',
  settings: AppSettings
): { baseUrl: string; model: string; apiKey: string } {
  const cfg = settings.ai[provider]
  return {
    baseUrl: cleanUrl(cfg.codingBaseUrl).replace(/\/$/, ''),
    model: cfg.codingModel,
    apiKey: cfg.apiKey
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 600_000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new ProviderError(`Invalid JSON response: ${text.slice(0, 300)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Vision completion (timeline analysis). Returns raw model text.
// ---------------------------------------------------------------------------

export async function visionComplete(
  prompt: string,
  images: LabeledImage[],
  operation = 'timeline',
  settings: AppSettings = getSettings()
): Promise<string> {
  const rt = resolveProvider(settings)
  if (!rt.ready) throw new ProviderError(`AI provider "${rt.id}" is not configured`)
  const started = Date.now()
  try {
    const out = await visionRequest(rt.id, settings, prompt, images)
    logCall(rt.id, rt.model, operation, 'success', Date.now() - started)
    return out
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCall(rt.id, rt.model, operation, 'failure', Date.now() - started, msg)
    throw err
  }
}

async function visionRequest(
  provider: ProviderId,
  settings: AppSettings,
  prompt: string,
  images: LabeledImage[]
): Promise<string> {
  switch (provider) {
    case 'gemini':
      return geminiRequest(settings, prompt, images)
    case 'openai':
    case 'lmstudio':
    case 'openai-compatible':
      return openAICompatibleRequest(settings, provider, prompt, images)
    case 'zhipu':
    case 'mimo':
      if (isCodingMode(provider, settings)) {
        const ep = codingEndpoint(provider, settings)
        return anthropicStyleRequest(
          ep.baseUrl,
          ep.apiKey,
          ep.model,
          prompt,
          images,
          {
            // Anthropic-compatible gateways accept both header styles.
            ...(provider === 'mimo' && ep.apiKey ? { 'api-key': ep.apiKey } : {})
          },
          provider === 'zhipu'
        )
      }
      return openAICompatibleRequest(settings, provider, prompt, images)
    case 'anthropic':
      return anthropicRequest(settings, prompt, images)
    case 'ollama':
      return ollamaRequest(settings, prompt, images)
    default:
      throw new ProviderError('No AI provider selected')
  }
}

async function geminiRequest(settings: AppSettings, prompt: string, images: LabeledImage[]): Promise<string> {
  const { apiKey, model } = settings.ai.gemini
  const parts: unknown[] = []
  for (const img of images) {
    parts.push({ text: `Frame at ${img.label}:` })
    parts.push({
      inline_data: { mime_type: 'image/jpeg', data: img.base64 }
    })
  }
  parts.push({ text: prompt })
  const json = (await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16384 }
      })
    }
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new ProviderError('Gemini returned an empty response')
  return text
}

/** Extra auth headers some platforms expect alongside/instead of Bearer. */
function openAIExtraHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === 'mimo' && apiKey) {
    return { 'api-key': apiKey }
  }
  return {}
}

/** Base URLs must never contain whitespace (paste accidents break fetch's URL parser). */
function cleanUrl(url: string | undefined): string {
  return (url ?? '').replace(/\s+/g, '')
}

function openAIBaseUrl(provider: ProviderId, settings: AppSettings): string {
  if (provider === 'lmstudio') return cleanUrl(settings.ai.lmstudio.baseUrl).replace(/\/$/, '')
  if (provider === 'openai-compatible') return cleanUrl(settings.ai['openai-compatible'].baseUrl).replace(/\/$/, '')
  if (provider === 'zhipu') return cleanUrl(settings.ai.zhipu.baseUrl).replace(/\/$/, '')
  if (provider === 'mimo') return cleanUrl(settings.ai.mimo.baseUrl).replace(/\/$/, '')
  return cleanUrl(settings.ai.openai.baseUrl).replace(/\/$/, '')
}

function openAIKey(provider: ProviderId, settings: AppSettings): string {
  if (provider === 'lmstudio') return 'lm-studio'
  if (provider === 'openai-compatible') return settings.ai['openai-compatible'].apiKey || 'none'
  if (provider === 'zhipu') return settings.ai.zhipu.apiKey
  if (provider === 'mimo') return settings.ai.mimo.apiKey
  return settings.ai.openai.apiKey
}

function openAIModel(provider: ProviderId, settings: AppSettings): string {
  if (provider === 'lmstudio') return settings.ai.lmstudio.model
  if (provider === 'openai-compatible') return settings.ai['openai-compatible'].model
  if (provider === 'zhipu') return settings.ai.zhipu.model
  if (provider === 'mimo') return settings.ai.mimo.model
  return settings.ai.openai.model
}

function openAIHeaders(provider: ProviderId, settings: AppSettings): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${openAIKey(provider, settings)}`,
    ...openAIExtraHeaders(provider, openAIKey(provider, settings))
  }
}

/** Static model suggestions used when a provider's /models listing is unavailable. */
export const PROVIDER_MODEL_SUGGESTIONS: Partial<Record<ProviderId, string[]>> = {
  zhipu: [
    'glm-5.3-flash',
    'glm-5.3-flashx',
    'glm-5.3',
    'glm-5v-turbo',
    'glm-4.6v',
    'glm-4.6v-flash',
    'glm-4.1v-thinking-flash',
    'glm-4v-flash',
    'glm-5',
    'glm-4.7'
  ],
  mimo: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash', 'MiMo-VL-7B-RL']
}

/** Coding-plan subscriptions have no /models endpoint; these are their typical models. */
export const CODING_MODEL_SUGGESTIONS: Partial<Record<ProviderId, string[]>> = {
  zhipu: ['glm-5.3', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-5v-turbo'],
  mimo: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash']
}

async function openAICompatibleRequest(
  settings: AppSettings,
  provider: ProviderId,
  prompt: string,
  images: LabeledImage[]
): Promise<string> {
  const base = openAIBaseUrl(provider, settings)
  const content: unknown[] = [{ type: 'text', text: prompt }]
  for (const img of images) {
    content.push({ type: 'text', text: `Frame at ${img.label}:` })
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${img.base64}` }
    })
  }
  const json = (await fetchJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: openAIHeaders(provider, settings),
    body: JSON.stringify({
      model: openAIModel(provider, settings),
      messages: [{ role: 'user', content }],
      max_tokens: 32768,
      stream: false,
      // Zhipu GLM-5.x are thinking models; disable reasoning for snappy
      // structured output (timeline analysis doesn't need it).
      ...(provider === 'zhipu' ? { thinking: { type: 'disabled' } } : {})
    })
  })) as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content ?? ''
  if (!text) throw new ProviderError('Model returned an empty response')
  return text
}

/** Anthropic Messages protocol against an arbitrary endpoint (Claude direct, GLM Coding Plan, MiMo Token Plan). */
async function anthropicStyleRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  images: LabeledImage[],
  extraHeaders: Record<string, string> = {},
  disableThinking = false
): Promise<string> {
  const content: unknown[] = []
  for (const img of images) {
    content.push({ type: 'text', text: `Frame at ${img.label}:` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 }
    })
  }
  content.push({ type: 'text', text: prompt })
  const json = (await fetchJson(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      // GLM-5.x thinking models burn a small budget on reasoning blocks and
      // return no text block at all — give room and let callers disable it.
      max_tokens: 32768,
      ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: 'user', content }]
    })
  })) as { content?: { type: string; text?: string }[] }
  const text = json.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? ''
  if (!text) throw new ProviderError('Model returned an empty response')
  return text
}

async function anthropicRequest(settings: AppSettings, prompt: string, images: LabeledImage[]): Promise<string> {
  const { apiKey, model } = settings.ai.anthropic
  return anthropicStyleRequest('https://api.anthropic.com', apiKey, model, prompt, images)
}

async function ollamaRequest(settings: AppSettings, prompt: string, images: LabeledImage[]): Promise<string> {
  const { baseUrl, model } = settings.ai.ollama
  const json = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: images.map((i) => i.base64)
        }
      ],
      stream: false,
      options: { temperature: 0.4, num_ctx: 16384 }
    })
  })) as { message?: { content?: string } }
  const text = json.message?.content ?? ''
  if (!text) throw new ProviderError('Ollama returned an empty response')
  return text
}

// ---------------------------------------------------------------------------
// Text completion (standup, weekly summaries)
// ---------------------------------------------------------------------------

export async function textComplete(
  prompt: string,
  operation = 'text',
  settings: AppSettings = getSettings()
): Promise<string> {
  return visionComplete(prompt, [], operation, settings)
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

export async function chatStream(
  system: string,
  history: ChatTurn[],
  onDelta: (delta: string) => void,
  settings: AppSettings = getSettings(),
  signal?: AbortSignal
): Promise<void> {
  const rt = resolveProvider(settings)
  if (!rt.ready) throw new ProviderError(`AI provider "${rt.id}" is not configured`)
  const started = Date.now()
  try {
    await chatStreamRequest(rt.id, settings, system, history, onDelta, signal)
    logCall(rt.id, rt.model, 'chat', 'success', Date.now() - started)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCall(rt.id, rt.model, 'chat', 'failure', Date.now() - started, msg)
    throw err
  }
}

async function sseLines(
  url: string,
  init: RequestInit,
  onEvent: (data: string) => void,
  timeoutMs = 600_000,
  externalSignal?: AbortSignal
): Promise<void> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  if (externalSignal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 400)}`, res.status)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data && data !== '[DONE]') onEvent(data)
        } else if (line.length > 0 && !line.startsWith(':') && !line.startsWith('event:')) {
          // NDJSON (Ollama) lines arrive without the data: prefix
          if (line.startsWith('{')) onEvent(line)
        }
      }
    }
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** Anthropic Messages SSE stream against an arbitrary endpoint. */
async function anthropicStyleStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  history: ChatTurn[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  disableThinking = false
): Promise<void> {
  const messages = history.map((t) => ({ role: t.role, content: t.content }))
  await sseLines(
    `${baseUrl.replace(/\/$/, '')}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        ...extraHeaders
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        stream: true,
        max_tokens: 16384,
        ...(disableThinking ? { thinking: { type: 'disabled' } } : {})
      })
    },
    (data) => {
      try {
        const chunk = JSON.parse(data) as {
          type?: string
          delta?: { text?: string }
        }
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          onDelta(chunk.delta.text)
        }
      } catch {
        // skip
      }
    },
    600_000,
    signal
  )
}

async function chatStreamRequest(
  provider: ProviderId,
  settings: AppSettings,
  system: string,
  history: ChatTurn[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<void> {
  switch (provider) {
    case 'gemini': {
      const { apiKey, model } = settings.ai.gemini
      const contents = history.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }]
      }))
      await sseLines(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: system }] },
            generationConfig: { maxOutputTokens: 8192 }
          })
        },
        (data) => {
          try {
            const chunk = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
            const text = chunk.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
            if (text) onDelta(text)
          } catch {
            // skip malformed chunk
          }
        }
      , 600_000, signal)
      return
    }
    case 'openai':
    case 'lmstudio':
    case 'openai-compatible':
    case 'zhipu':
    case 'mimo': {
      if (isCodingMode(provider, settings)) {
        const ep = codingEndpoint(provider as 'zhipu' | 'mimo', settings)
        await anthropicStyleStream(
          ep.baseUrl,
          ep.apiKey,
          ep.model,
          system,
          history,
          onDelta,
          signal,
          provider === 'mimo' && ep.apiKey ? { 'api-key': ep.apiKey } : {},
          provider === 'zhipu'
        )
        return
      }
      const base = openAIBaseUrl(provider, settings)
      const messages = [
        { role: 'system', content: system },
        ...history.map((t) => ({ role: t.role, content: t.content }))
      ]
      await sseLines(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: openAIHeaders(provider, settings),
          body: JSON.stringify({
            model: openAIModel(provider, settings),
            messages,
            stream: true,
            max_tokens: 8192
          })
        },
        (data) => {
          try {
            const chunk = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[]
            }
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) onDelta(delta)
          } catch {
            // skip
          }
        }
      , 600_000, signal)
      return
    }
    case 'anthropic': {
      const { apiKey, model } = settings.ai.anthropic
      await anthropicStyleStream('https://api.anthropic.com', apiKey, model, system, history, onDelta, signal)
      return
    }
    case 'ollama': {
      const { baseUrl, model } = settings.ai.ollama
      await sseLines(
        `${baseUrl.replace(/\/$/, '')}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              ...history.map((t) => ({ role: t.role, content: t.content }))
            ],
            stream: true
          })
        },
        (data) => {
          try {
            const chunk = JSON.parse(data) as { message?: { content?: string }; done?: boolean }
            const text = chunk.message?.content
            if (text) onDelta(text)
          } catch {
            // skip
          }
        }
      , 600_000, signal)
      return
    }
    default:
      throw new ProviderError('No AI provider selected')
  }
}

// ---------------------------------------------------------------------------
// Model listing & connection test
// ---------------------------------------------------------------------------

export interface ModelListResult {
  models: string[]
  source: 'api' | 'fallback' | 'builtin'
  message?: string
}

/** Non-chat models that are useless as a timeline-analysis model. */
const NON_CHAT_MODEL = /^(embedding|rerank|cogview|cogvideo|vidu|codegeex|whisper)/i
const NON_CHAT_SUFFIX = /-(tts|asr|ocr|voice|realtime|image|embed)(-[a-z0-9.]*)?$/i

/** Version-aware sort so glm-5.3-flash outranks glm-4.1v (plain alphabetical puts old first). */
function versionKey(id: string): number[] {
  const m = id.match(/(\d+(?:\.\d+)*)/)
  return m ? m[1].split('.').map(Number) : [0]
}

function smartModelCompare(a: string, b: string): number {
  const va = versionKey(a)
  const vb = versionKey(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0)
    if (d !== 0) return d
  }
  // Same version: prefer the shorter/base id, then alphabetical.
  if (a.length !== b.length) return a.length - b.length
  return a.localeCompare(b)
}

function finishModels(raw: string[]): string[] {
  return raw
    .filter((id) => id.length > 0 && !NON_CHAT_MODEL.test(id) && !NON_CHAT_SUFFIX.test(id))
    .sort(smartModelCompare)
}

export async function listModels(provider: ProviderId): Promise<ModelListResult> {
  const settings = getSettings()
  const builtin = PROVIDER_MODEL_SUGGESTIONS[provider] ?? []
  try {
    switch (provider) {
      case 'gemini': {
        const json = (await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(settings.ai.gemini.apiKey)}`,
          { method: 'GET' },
          30_000
        )) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
        const models = finishModels(
          (json.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m) => (m.name ?? '').replace(/^models\//, ''))
        )
        return { models, source: 'api' }
      }
      case 'anthropic': {
        const json = (await fetchJson(
          'https://api.anthropic.com/v1/models?limit=100',
          {
            method: 'GET',
            headers: {
              'x-api-key': settings.ai.anthropic.apiKey,
              Authorization: `Bearer ${settings.ai.anthropic.apiKey}`,
              'anthropic-version': '2023-06-01'
            }
          },
          30_000
        )) as { data?: { id?: string }[] }
        const models = finishModels((json.data ?? []).map((m) => m.id ?? ''))
        return { models, source: 'api' }
      }
      case 'openai': {
        const json = (await fetchJson(
          `${cleanUrl(settings.ai.openai.baseUrl).replace(/\/$/, '')}/models`,
          { method: 'GET', headers: { Authorization: `Bearer ${settings.ai.openai.apiKey}` } },
          30_000
        )) as { data?: { id?: string }[] }
        const models = finishModels((json.data ?? []).map((m) => m.id ?? ''))
        return { models, source: 'api' }
      }
      case 'zhipu':
      case 'mimo': {
        // Coding-plan gateways (Anthropic protocol) expose no /models listing.
        if (isCodingMode(provider, settings)) {
          return {
            models: CODING_MODEL_SUGGESTIONS[provider] ?? [],
            source: 'builtin',
            message: '订阅网关不提供模型列表，已显示该套餐常用模型'
          }
        }
        try {
          const base = openAIBaseUrl(provider, settings)
          const json = (await fetchJson(
            `${base}/models`,
            { method: 'GET', headers: openAIHeaders(provider, settings) },
            30_000
          )) as { data?: { id?: string }[] }
          const models = finishModels((json.data ?? []).map((m) => m.id ?? ''))
          return { models, source: 'api' }
        } catch {
          // BigModel/MiMo don't always expose an OpenAI-style /models endpoint.
          return {
            models: builtin,
            source: 'fallback',
            message: '接口未返回模型列表，已显示常用模型（可直接输入任意模型名）'
          }
        }
      }
      case 'lmstudio':
      case 'openai-compatible': {
        const base =
          provider === 'lmstudio'
            ? cleanUrl(settings.ai.lmstudio.baseUrl).replace(/\/$/, '')
            : cleanUrl(settings.ai['openai-compatible'].baseUrl).replace(/\/$/, '')
        const key =
          provider === 'lmstudio' ? 'lm-studio' : settings.ai['openai-compatible'].apiKey || 'none'
        const json = (await fetchJson(
          `${base}/models`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${key}` }
          },
          30_000
        )) as { data?: { id?: string }[] }
        const models = (json.data ?? [])
          .map((m) => m.id ?? '')
          .filter((id) => id.length > 0)
          .sort()
        return { models, source: 'api' }
      }
      case 'ollama': {
        const json = (await fetchJson(
          `${cleanUrl(settings.ai.ollama.baseUrl).replace(/\/$/, '')}/api/tags`,
          { method: 'GET' },
          15_000
        )) as { models?: { name?: string }[] }
        const models = finishModels((json.models ?? []).map((m) => m.name ?? ''))
        return { models, source: 'api' }
      }
      default:
        return { models: [], source: 'builtin', message: '该提供商不支持拉取模型列表' }
    }
  } catch (err) {
    throw new ProviderError(err instanceof Error ? err.message : String(err))
  }
}

export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  const settings = getSettings()
  const rt = resolveProvider(settings)
  if (!rt.ready) return { ok: false, message: '提供商未配置完成（缺少 API Key、模型或接口地址）。' }
  try {
    const out = await textComplete(
      'Reply with exactly: ok',
      'connection-test',
      settings
    )
    return { ok: true, message: `连接成功。模型回复：${out.trim().slice(0, 120)}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Robust JSON extraction from model text
// ---------------------------------------------------------------------------

export function extractJsonArray<T = unknown>(text: string): T[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const candidates: string[] = []
  const firstArr = cleaned.indexOf('[')
  const lastArr = cleaned.lastIndexOf(']')
  if (firstArr >= 0 && lastArr > firstArr) {
    candidates.push(cleaned.slice(firstArr, lastArr + 1))
  }
  const firstObj = cleaned.indexOf('{')
  const lastObj = cleaned.lastIndexOf('}')
  if (firstObj >= 0 && lastObj > firstObj) {
    candidates.push(cleaned.slice(firstObj, lastObj + 1))
  }
  candidates.push(cleaned)
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed)) return parsed as T[]
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cards?: T[] }).cards)) {
        return (parsed as { cards: T[] }).cards
      }
    } catch {
      // try next candidate
    }
  }
  throw new ProviderError(`Could not parse JSON from model output: ${text.slice(0, 200)}`)
}

export function extractJsonObject<T = unknown>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const firstObj = cleaned.indexOf('{')
  const lastObj = cleaned.lastIndexOf('}')
  const slice = firstObj >= 0 && lastObj > firstObj ? cleaned.slice(firstObj, lastObj + 1) : cleaned
  return JSON.parse(slice) as T
}
