import { describe, it, expect, vi } from 'vitest'
import { createWandbClient, type WandbRun } from '../../src/main/todo/wandb/client'
import { WandbPoller, type WandbPollerDeps } from '../../src/main/todo/wandb/poller'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 })
}

function captureFetch(handler: (query: string) => unknown): { fn: typeof fetch; queries: string[]; headers: string[] } {
  const queries: string[] = []
  const headers: string[] = []
  const fn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
    const query = body.query ?? ''
    queries.push(query)
    headers.push(
      String(init?.headers && typeof init.headers === 'object' ? (init.headers as Record<string, string>).Authorization : ''),
    )
    return jsonResponse(handler(query))
  }) as typeof fetch
  return { fn, queries, headers }
}

function runNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'run1',
    displayName: 'display1',
    state: 'running',
    host: 'h1',
    config: '{"a":1}',
    summaryMetrics: '{"cfgname":"bert"}',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    ...over,
  }
}

describe('createWandbClient', () => {
  it('Basic auth = base64("api:key")；查询串做反斜杠/引号转义', async () => {
    const { fn, queries, headers } = captureFetch(() => ({ projects: { edges: [] } }))
    const client = createWandbClient({ apiKey: 'k1', fetchFn: fn })
    await client.getRecentProjects('en"t\\ity')
    expect(headers[0]).toBe('Basic ' + Buffer.from('api:k1').toString('base64'))
    expect(queries[0]).toContain('entityName: "en\\"t\\\\ity"')
  })

  it('getRunningRuns：过滤 state==="running"；config/summaryMetrics 二次解析；url 拼接', async () => {
    const { fn } = captureFetch(() => ({
      project: {
        runs: {
          edges: [
            { node: runNode() },
            { node: runNode({ name: 'r2', state: 'finished' }) },
            { node: runNode({ name: 'r3', summaryMetrics: 'not-json' }) },
          ],
        },
      },
    }))
    const client = createWandbClient({ apiKey: 'k', fetchFn: fn })
    const runs = await client.getRunningRuns('ent', 'proj')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ id: 'run1', name: 'display1', config: { a: 1 } })
    expect(runs[0].summaryMetrics).toEqual({ cfgname: 'bert' })
    expect(runs[0].url).toBe('https://wandb.ai/ent/proj/runs/run1')
    expect(runs[1].summaryMetrics).toEqual({}) // 解析失败回退 {}
  })

  it('getRunState：正常返回 state；异常返回 null', async () => {
    const ok = captureFetch(() => ({ project: { run: { state: 'finished' } } }))
    const client = createWandbClient({ apiKey: 'k', fetchFn: ok.fn })
    expect(await client.getRunState('e', 'p', 'r')).toBe('finished')

    const bad = captureFetch(() => {
      throw new Error('boom')
    })
    const client2 = createWandbClient({ apiKey: 'k', fetchFn: bad.fn })
    expect(await client2.getRunState('e', 'p', 'r')).toBeNull()
  })
})

describe('WandbPoller', () => {
  // 可变 client：测试直接操纵闭包变量（探针验证过 poller 行为正确）
  function makePoller(over: { runs: WandbRun[]; stateImpl: (id: string) => string | null; onPoll?: WandbPollerDeps['onPoll'] }) {
    const events: { active: { project: string; run: WandbRun }[]; finished: { project: string; run: WandbRun; state: string }[] }[] = []
    const client = {
      getRecentProjects: async () => ['p1'],
      getRunningRuns: async () => over.runs,
      getRunState: async (_e: string, _p: string, id: string) => over.stateImpl(id),
    }
    const poller = new WandbPoller({ client, entity: 'ent', intervalMs: 60_000, onPoll: over.onPoll ?? ((r) => events.push(r)) })
    return { poller, events }
  }

  const run = { id: 'run1', name: 'display1', state: 'running', config: {}, summaryMetrics: {} } as unknown as WandbRun

  it('start 立即轮询：running 进 active + tracked；空轮不回调', async () => {
    const { poller, events } = makePoller({ runs: [run], stateImpl: () => null })
    await poller.poll()
    expect(events).toHaveLength(1)
    expect(events[0].active).toHaveLength(1)
    expect(poller.trackedRuns.has('run1')).toBe(true)
    const { poller: p2, events: e2 } = makePoller({ runs: [], stateImpl: () => null })
    await p2.poll()
    expect(e2).toHaveLength(0)
  })

  it('消失 run：state=null（瞬时错误）继续跟踪；有 state → finished 并移出', async () => {
    let stateImpl = (id: string): string | null => (id === 'run1' ? null : 'finished')
    const bag: { runs: WandbRun[] } = { runs: [run] }
    const { poller, events } = makePoller({
      get runs(): WandbRun[] {
        return bag.runs
      },
      set runs(v: WandbRun[]) {
        bag.runs = v
      },
      stateImpl: (id) => stateImpl(id),
    })
    await poller.poll()
    expect(events[0].active).toHaveLength(1)
    bag.runs = [] // 消失
    await poller.poll()
    expect(events).toHaveLength(1) // null → 不判 finished
    expect(poller.trackedRuns.has('run1')).toBe(true)
    stateImpl = () => 'finished'
    await poller.poll()
    expect(events).toHaveLength(2)
    expect(events[1].finished).toHaveLength(1)
    expect(poller.trackedRuns.has('run1')).toBe(false)
  })

  it('防重入：polling 中再次 poll 直接返回', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const client = {
      getRecentProjects: async () => {
        calls++
        await gate
        return []
      },
      getRunningRuns: async () => [] as WandbRun[],
      getRunState: async () => null,
    }
    const poller = new WandbPoller({ client, entity: 'e', intervalMs: 60_000, onPoll: () => {} })
    const first = poller.poll()
    await poller.poll() // 防重入
    release?.()
    await first
    expect(calls).toBe(1)
  })
})
