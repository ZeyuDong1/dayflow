/**
 * 关键词检索/常识判定:白名单审批的证据前哨。
 * 数据复核(allowances)只看本地历史——没历史或历史未归类时判不了"这是不是个游戏"。
 * 这里补上语义层:zhipu 提供商时用原生 web_search 联网检索(国内可达);
 * 其他提供商退化为模型常识判定。判定 entertainment 即拒绝,判定失败不拦(交给后续闸)。
 */
import { getSettings } from '../settings'
import { extractJsonObject, resolveProvider, textComplete } from './providers'

export interface KeywordVerdict {
  verdict: 'entertainment' | 'study' | 'neutral' | 'unknown'
  kind: string
  evidence: string
}

const cache = new Map<string, KeywordVerdict>()

const JUDGE_PROMPT = (keyword: string): string =>
  `搜索并判断:「${keyword}」主要指什么?只输出一行 JSON(不要其他文字):
{"verdict":"entertainment|study|neutral|unknown","kind":"一句话类别","evidence":"一句话依据"}
verdict 取值:entertainment=游戏/影视/小说/社交娱乐等消遣产品或内容;study=学习/工作/生产力工具或内容;neutral=两者都不沾;unknown=查不到/不确定。`

export async function keywordCheck(keyword: string): Promise<KeywordVerdict> {
  const key = keyword.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit
  const settings = getSettings()
  const rt = resolveProvider(settings)
  if (!rt.ready) return { verdict: 'unknown', kind: '', evidence: '未配置 AI 提供商' }
  let raw = ''
  try {
    if (rt.id === 'zhipu') {
      // 检索增强:zhipu 原生 web_search 工具(国内可达),判定有搜索结果背书
      const base = settings.ai.zhipu.baseUrl.replace(/\/$/, '').replace(/\s+/g, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.ai.zhipu.apiKey}` },
        body: JSON.stringify({
          model: rt.model,
          messages: [{ role: 'user', content: JUDGE_PROMPT(keyword) }],
          tools: [{ type: 'web_search', web_search: { enable: true } }]
        })
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      raw = j?.choices?.[0]?.message?.content ?? ''
    } else {
      raw = await textComplete(JUDGE_PROMPT(keyword), 'keyword-check')
    }
    const parsed = extractJsonObject<{
      verdict?: string
      kind?: string
      evidence?: string
    }>(raw)
    const verdict = (['entertainment', 'study', 'neutral', 'unknown'] as const).includes(
      parsed.verdict as KeywordVerdict['verdict']
    )
      ? (parsed.verdict as KeywordVerdict['verdict'])
      : 'unknown'
    const out: KeywordVerdict = {
      verdict,
      kind: (parsed.kind ?? '').slice(0, 40),
      evidence: (parsed.evidence ?? '').slice(0, 140)
    }
    cache.set(key, out)
    return out
  } catch {
    // 检索失败不拦截:后续仍有本地数据复核与 agent 判断
    return { verdict: 'unknown', kind: '', evidence: '' }
  }
}
