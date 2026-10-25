/**
 * 合规分析的 LLM 判定适配（功能清单 §九：AI 截图分析）。
 * 复用 Dayflow 的 visionComplete（providers.ts）：对会话截图批量判定
 * "用户是否在执行该任务"，返回判定为在做任务的样本序号。
 */
import fs from 'fs'
import { visionComplete, extractJsonObject, type LabeledImage } from '../ai/providers'
import type { SessionJudge, SessionSample } from './compliance'

export function createLlmJudge(): SessionJudge {
  return async (input) => {
    const images: LabeledImage[] = []
    const refs: string[] = []
    input.samples.forEach((s: SessionSample, i: number) => {
      try {
        images.push({ base64: fs.readFileSync(s.filePath).toString('base64'), label: `样本${i + 1}` })
        refs.push(`样本${i + 1}`)
      } catch {
        // 截图文件缺失则跳过该样本
      }
    })
    if (images.length === 0) return { onTaskCount: 0, detail: '无可读截图' }
    const prompt = [
      `用户在时间段 ${new Date(input.startTs).toISOString()} ~ ${new Date(input.endTs).toISOString()} 计划执行任务：「${input.taskTitle}」。`,
      `下面是该时段的屏幕截图样本（依次标注：${refs.join('、')}）。`,
      '请逐张判断用户当时是否正在执行该任务（同一工作流就算在做；明显转去娱乐/无关事务算没在做）。',
      '只输出 JSON：{"onTask":[在做任务的样本编号数组，如[1,3]], "note":"一句话依据"}',
    ].join('\n')
    const raw = await visionComplete(prompt, images, 'timeline')
    const obj = extractJsonObject<{ onTask?: unknown[]; note?: string }>(raw)
    const onTask = Array.isArray(obj.onTask) ? obj.onTask.filter((x) => Number.isInteger(x)).map(Number) : []
    return {
      onTaskCount: new Set(onTask.filter((n) => n >= 1 && n <= images.length)).size,
      detail: typeof obj.note === 'string' ? obj.note : undefined,
    }
  }
}
