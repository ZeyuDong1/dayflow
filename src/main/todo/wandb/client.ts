/**
 * wandb GraphQL 客户端（语义规格 §9）：Basic auth、字符串转义、running 过滤、
 * config/summaryMetrics JSON 字符串二次解析（失败回退 {}）。fetch 可注入便于测试。
 */
export interface WandbRun {
  /** GraphQL name（run.id） */
  id: string
  /** displayName || name */
  name: string
  displayName?: string
  state: string
  host?: string
  config: Record<string, unknown>
  summaryMetrics: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  url: string
}

export interface WandbClient {
  getRecentProjects(entity: string, limit?: number): Promise<string[]>
  getRunningRuns(entity: string, project: string): Promise<WandbRun[]>
  getRunState(entity: string, project: string, runId: string): Promise<string | null>
}

const ENDPOINT = 'https://api.wandb.ai/graphql'

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function parseMaybeJson(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

export function createWandbClient(opts: { apiKey: string; fetchFn?: typeof fetch }): WandbClient {
  const doFetch = opts.fetchFn ?? fetch
  const auth = 'Basic ' + Buffer.from('api:' + opts.apiKey).toString('base64')

  async function gql(query: string): Promise<Record<string, unknown>> {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) throw new Error(`wandb http ${res.status}`)
    const body = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] }
    if (body.errors && body.errors.length > 0) throw new Error(body.errors[0].message)
    return body.data ?? {}
  }

  return {
    async getRecentProjects(entity: string, limit = 5): Promise<string[]> {
      const data = await gql(
        `{ projects(entityName: "${esc(entity)}", first: ${limit}, order: "-lastActive") { edges { node { name } } } }`,
      )
      const edges = (data.projects as { edges?: { node?: { name?: string } }[] } | undefined)?.edges ?? []
      return edges.map((e) => e.node?.name).filter((n): n is string => Boolean(n))
    },

    async getRunningRuns(entity: string, project: string): Promise<WandbRun[]> {
      const data = await gql(
        `{ project(name: "${esc(project)}", entityName: "${esc(entity)}") { runs(first: 50, order: "-createdAt") { edges { node { name displayName state host config summaryMetrics createdAt updatedAt } } } } }`,
      )
      const edges =
        (
          (data.project as { runs?: { edges?: { node?: Record<string, unknown> }[] } | undefined } | undefined)?.runs
            ?.edges ?? []
        ).map((e) => e.node) ?? []
      return edges
        .filter((n): n is Record<string, unknown> => n != null && (n as Record<string, unknown>).state === 'running')
        .map((n) => {
          const node = n as Record<string, unknown>
          const id = String(node.name)
          const name = String(node.displayName || node.name)
          return {
            id,
            name,
            displayName: node.displayName as string | undefined,
            state: String(node.state),
            host: node.host as string | undefined,
            config: parseMaybeJson(node.config),
            summaryMetrics: parseMaybeJson(node.summaryMetrics),
            createdAt: node.createdAt as string | undefined,
            updatedAt: node.updatedAt as string | undefined,
            url: `https://wandb.ai/${entity}/${project}/runs/${id}`,
          }
        })
    },

    async getRunState(entity: string, project: string, runId: string): Promise<string | null> {
      try {
        const data = await gql(
          `{ project(name: "${esc(project)}", entityName: "${esc(entity)}") { run(name: "${esc(runId)}") { state } } }`,
        )
        const run = (data.project as { run?: { state?: string } } | undefined)?.run
        return run?.state ?? null
      } catch {
        return null // API 瞬时错误 → null（调用方继续跟踪，防误归档）
      }
    },
  }
}
