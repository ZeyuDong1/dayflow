import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import {
  COMPLIANCE_SCHEMA_SQL,
  sampleSession,
  analyzeSession,
  getAnalysis,
  listAnalyses,
  type SessionSample,
  type SessionJudge,
  type SessionJudgeInput,
} from '../../src/main/todo/compliance'

const T0 = Date.parse('2026-10-25T09:00:00.000Z')
const NOW = 1_761_382_800_000

let db: MemDb

beforeEach(async () => {
  db = await createMemDb()
  db.exec(COMPLIANCE_SCHEMA_SQL)
})

function sample(capturedAt: number): SessionSample {
  return { capturedAt, filePath: `shot-${capturedAt}.png` }
}

function samplesBetween(startTs: number, endTs: number, count: number): SessionSample[] {
  const step = (endTs - startTs) / (count - 1)
  return Array.from({ length: count }, (_, i) => sample(startTs + Math.round(i * step)))
}

/** 假 judge：计数断言调用次数，记录入参。 */
function countingJudge(result: { onTaskCount: number; detail?: string }) {
  const calls: SessionJudgeInput[] = []
  const judge: SessionJudge = async (input) => {
    calls.push(input)
    return result
  }
  return { judge, calls }
}

function insertAnalysis(historyId: number, over: Partial<{ analyzedAt: number; sampleCount: number; onTaskCount: number; ratio: number; detail: string | null }> = {}): void {
  db.run(
    'INSERT INTO task_session_analysis (history_id, analyzed_at, sample_count, on_task_count, ratio, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [
      historyId,
      over.analyzedAt ?? NOW,
      over.sampleCount ?? 4,
      over.onTaskCount ?? 2,
      over.ratio ?? 0.5,
      over.detail === undefined ? null : over.detail,
    ],
  )
}

function insertHistory(id: number, startTime: string, endTime: string, title = `任务${id}`): void {
  db.run('INSERT INTO history (id, task_id, title, type, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    1,
    title,
    'focus',
    startTime,
    endTime,
  ])
}

function analysisRowCount(): number {
  return db.all<{ n: number }>('SELECT COUNT(*) AS n FROM task_session_analysis')[0].n
}

describe('sampleSession', () => {
  it('区间外剔除、按时间升序返回区间内样本', () => {
    const out1 = sample(T0 - 5000)
    const in1 = sample(T0 + 5000)
    const in2 = sample(T0)
    const in3 = sample(T0 + 10000)
    const out2 = sample(T0 + 10001)
    // 故意乱序传入
    const picked = sampleSession([out1, in3, in1, out2, in2], T0, T0 + 10000)
    expect(picked).toEqual([in2, in1, in3])
  })

  it('等距抽样含首尾：9 张截 3 张取下标 0/4/8', () => {
    const all = samplesBetween(T0, T0 + 8000, 9)
    const picked = sampleSession(all, T0, T0 + 8000, 3)
    expect(picked).toHaveLength(3)
    expect(picked[0]).toEqual(all[0])
    expect(picked[1]).toEqual(all[4])
    expect(picked[2]).toEqual(all[8])
  })

  it('超上限截断到默认 8 张（含首尾）', () => {
    const all = samplesBetween(T0, T0 + 9000, 10)
    const picked = sampleSession(all, T0, T0 + 9000)
    expect(picked).toHaveLength(8)
    expect(picked[0]).toEqual(all[0])
    expect(picked[7]).toEqual(all[9])
  })

  it('区间内样本不超过上限时全保留；上限为 0 返回空', () => {
    const all = samplesBetween(T0, T0 + 2000, 3)
    expect(sampleSession(all, T0, T0 + 2000)).toEqual(all)
    expect(sampleSession(all, T0, T0 + 2000, 0)).toEqual([])
  })
})

describe('analyzeSession', () => {
  const deps = (judge: SessionJudge) => ({ db, judge, now: () => NOW })

  it('会话 <180 秒：ratio=null，不调 judge 不写库', async () => {
    const { judge, calls } = countingJudge({ onTaskCount: 3 })
    const result = await analyzeSession(deps(judge), {
      historyId: 1,
      taskTitle: '短会话',
      startTs: T0,
      endTs: T0 + 179_999,
      samples: samplesBetween(T0, T0 + 179_999, 5),
    })
    expect(result).toEqual({ ratio: null, sampleCount: 0, onTaskCount: 0 })
    expect(calls).toHaveLength(0)
    expect(analysisRowCount()).toBe(0)
  })

  it('恰好 180 秒不跳过，正常分析', async () => {
    const { judge, calls } = countingJudge({ onTaskCount: 2 })
    const result = await analyzeSession(deps(judge), {
      historyId: 1,
      taskTitle: '临界会话',
      startTs: T0,
      endTs: T0 + 180_000,
      samples: samplesBetween(T0, T0 + 180_000, 4),
    })
    expect(calls).toHaveLength(1)
    expect(result.ratio).toBe(0.5)
    expect(result.sampleCount).toBe(4)
    expect(result.onTaskCount).toBe(2)
  })

  it('样本为 0（含区间外样本被全剔除）：ratio=null，不调 judge 不写库', async () => {
    const { judge, calls } = countingJudge({ onTaskCount: 1 })
    const outOfRange = [sample(T0 - 1), sample(T0 + 180_001)]
    for (const samples of [[], outOfRange]) {
      const result = await analyzeSession(deps(judge), {
        historyId: 1,
        taskTitle: '无样本',
        startTs: T0,
        endTs: T0 + 180_000,
        samples,
      })
      expect(result).toEqual({ ratio: null, sampleCount: 0, onTaskCount: 0 })
    }
    expect(calls).toHaveLength(0)
    expect(analysisRowCount()).toBe(0)
  })

  it('命中缓存直接返回缓存值，不重复调 judge', async () => {
    insertAnalysis(7, { sampleCount: 3, onTaskCount: 1, ratio: 1 / 3 })
    const { judge, calls } = countingJudge({ onTaskCount: 3 })
    const result = await analyzeSession(deps(judge), {
      historyId: 7,
      taskTitle: '已分析',
      startTs: T0,
      endTs: T0 + 180_000,
      samples: samplesBetween(T0, T0 + 180_000, 5),
    })
    expect(result).toEqual({ ratio: 1 / 3, sampleCount: 3, onTaskCount: 1 })
    expect(calls).toHaveLength(0)
    expect(analysisRowCount()).toBe(1)
  })

  it('judge 结果 clamp 到 [0, sampleCount]', async () => {
    const samples = samplesBetween(T0, T0 + 180_000, 4)
    const low = await analyzeSession(deps(countingJudge({ onTaskCount: -5 }).judge), {
      historyId: 1,
      taskTitle: 'clamp 下界',
      startTs: T0,
      endTs: T0 + 180_000,
      samples,
    })
    expect(low).toEqual({ ratio: 0, sampleCount: 4, onTaskCount: 0 })

    const high = await analyzeSession(deps(countingJudge({ onTaskCount: 999 }).judge), {
      historyId: 2,
      taskTitle: 'clamp 上界',
      startTs: T0,
      endTs: T0 + 180_000,
      samples,
    })
    expect(high).toEqual({ ratio: 1, sampleCount: 4, onTaskCount: 4 })
  })

  it('ratio = onTaskCount / sampleCount，写库含 detail 与 analyzed_at，judge 收到抽样后样本', async () => {
    const { judge, calls } = countingJudge({ onTaskCount: 4, detail: '证据摘要' })
    const samples = samplesBetween(T0, T0 + 300_000, 6)
    const result = await analyzeSession(deps(judge), {
      historyId: 42,
      taskTitle: '写库会话',
      startTs: T0,
      endTs: T0 + 300_000,
      samples,
    })
    expect(result.sampleCount).toBe(6)
    expect(result.onTaskCount).toBe(4)
    expect(result.ratio).toBeCloseTo(4 / 6)

    expect(calls).toHaveLength(1)
    expect(calls[0].taskTitle).toBe('写库会话')
    expect(calls[0].startTs).toBe(T0)
    expect(calls[0].endTs).toBe(T0 + 300_000)
    expect(calls[0].samples).toEqual(sampleSession(samples, T0, T0 + 300_000))

    const row = db.get<Record<string, unknown>>('SELECT * FROM task_session_analysis WHERE history_id = ?', [42])!
    expect(row.history_id).toBe(42)
    expect(row.analyzed_at).toBe(NOW)
    expect(row.sample_count).toBe(6)
    expect(row.on_task_count).toBe(4)
    expect(row.ratio).toBeCloseTo(4 / 6)
    expect(row.detail).toBe('证据摘要')
  })
})

describe('getAnalysis', () => {
  it('读缓存映射驼峰字段；未分析过返回 undefined', () => {
    expect(getAnalysis(db, 9)).toBeUndefined()
    insertAnalysis(9, { analyzedAt: NOW, sampleCount: 8, onTaskCount: 5, ratio: 0.625, detail: '摘要' })
    expect(getAnalysis(db, 9)).toEqual({
      id: expect.any(Number),
      historyId: 9,
      analyzedAt: NOW,
      sampleCount: 8,
      onTaskCount: 5,
      ratio: 0.625,
      detail: '摘要',
    })
  })
})

describe('listAnalyses', () => {
  it('按 history.start_time 日前缀过滤当日全部，按会话开始时间升序', () => {
    insertHistory(1, '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z', '上午任务')
    insertHistory(2, '2026-10-25T18:30:00.000Z', '2026-10-25T19:00:00.000Z', '晚上任务')
    insertHistory(3, '2026-10-24T23:00:00.000Z', '2026-10-25T00:30:00.000Z', '前一天')
    insertHistory(4, '2026-10-26T00:10:00.000Z', '2026-10-26T01:00:00.000Z', '次日')
    insertHistory(5, '2026-10-25T12:00:00.000Z', '2026-10-25T12:30:00.000Z', '当日未分析')
    for (const id of [1, 2, 3, 4]) insertAnalysis(id, { ratio: id / 10 })

    const rows = listAnalyses(db, '2026-10-25')
    expect(rows.map((r) => r.historyId)).toEqual([1, 2])
    expect(rows[0].title).toBe('上午任务')
    expect(rows[0].startTime).toBe('2026-10-25T01:00:00.000Z')
    expect(rows[0].endTime).toBe('2026-10-25T02:00:00.000Z')
    expect(rows[0].ratio).toBeCloseTo(0.1)
    expect(rows[1].ratio).toBeCloseTo(0.2)

    expect(listAnalyses(db, '2026-10-24').map((r) => r.historyId)).toEqual([3])
    expect(listAnalyses(db, '2026-10-27')).toEqual([])
  })
})
