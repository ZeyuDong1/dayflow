import { memoryServerInfo, memoryAuthToken, startMemoryServer } from './sidecar'

/**
 * ai-memory 的 MCP(HTTP)客户端。
 * 协议:JSON-RPC over POST /mcp,无状态,root bearer token 鉴权。
 * 读写都走 memory_* 工具;写入带 git checkpoint,可回滚。
 */

const WORKSPACE = 'default'
const PROJECT = 'dayflow'

export interface MemoryHit {
  path: string
  title: string
  snippet: string
  rank: number
}

interface JsonRpcResponse {
  result?: {
    content?: { type: string; text: string }[]
    isError?: boolean
  }
  error?: { code: number; message: string }
}

async function mcpCall<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const info = memoryServerInfo()
  if (!info.running) {
    const ok = await startMemoryServer()
    if (!ok) throw new Error('记忆服务未运行')
  }
  const port = memoryServerInfo().port
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${memoryAuthToken()}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: { workspace: WORKSPACE, project: PROJECT, ...args } }
    }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`记忆服务返回 ${res.status}`)
  const body = (await res.json()) as JsonRpcResponse
  if (body.error) throw new Error(body.error.message)
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? '记忆操作失败')
  const text = body.result?.content?.[0]?.text ?? 'null'
  return JSON.parse(text) as T
}

/** 写入/覆盖一个记忆页(返回 page_id + git checkpoint)。 */
export async function memoryWritePage(path: string, body: string, title?: string): Promise<string> {
  const r = await mcpCall<{ page_id: string }>('memory_write_page', {
    path,
    body,
    ...(title ? { title } : {})
  })
  return r.page_id
}

/** 读取一个记忆页的完整正文。 */
export async function memoryReadPage(path: string): Promise<string | null> {
  try {
    const r = await mcpCall<{ body: string | null }>('memory_read_page', { path })
    return r.body
  } catch {
    return null
  }
}

/** 语义 + 全文检索记忆。 */
export async function memoryQuery(query: string, limit = 8): Promise<MemoryHit[]> {
  try {
    const r = await mcpCall<{ hits: MemoryHit[] }>('memory_query', { query, limit })
    return r.hits ?? []
  } catch {
    return []
  }
}

/** 只在页面未被并发修改时写入(条件写),适合"追加式"更新。 */
export async function memoryWriteIfUnchanged(
  path: string,
  expectedPageId: string | null,
  body: string
): Promise<boolean> {
  try {
    await mcpCall('memory_write_page', {
      path,
      body,
      ...(expectedPageId ? { expected_page_id: expectedPageId } : { create_only: true })
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 导师记忆门面：core 页结构(MemGPT 式记忆块落在 ai-memory 上)
// ---------------------------------------------------------------------------

/** 学习目标页 —— 导师的"当前目标"记忆块。 */
export const MEM_GOAL = 'core/goal.md'
/** 用户画像页 —— 导师对用户的长期了解(节奏/偏好/习惯)。 */
export const MEM_PROFILE = 'core/profile.md'
/** 反思页 —— GA 式反思沉淀,轮询 tick 追加。 */
export const MEM_REFLECTIONS = 'core/reflections.md'

export async function loadMemoryBlock(path: string): Promise<string> {
  return (await memoryReadPage(path)) ?? ''
}

export interface MemoryBlocks {
  goal: string
  profile: string
  reflections: string
  retrieved: MemoryHit[]
}

/** 组装导师 prompt 所需的全部记忆块(检索按问题相关性拉取)。 */
export async function gatherMemory(question: string): Promise<MemoryBlocks> {
  const [goal, profile, reflections, retrieved] = await Promise.all([
    loadMemoryBlock(MEM_GOAL),
    loadMemoryBlock(MEM_PROFILE),
    loadMemoryBlock(MEM_REFLECTIONS),
    memoryQuery(question, 6)
  ])
  return { goal, profile, reflections, retrieved }
}

/**
 * 首次启动时建立记忆 scope 和核心页骨架。
 * ai-memory 的读取在 scope 不存在时会失败(writes create scope, reads fail closed),
 * 所以先写占位页把 scope 建起来,让首次对话即可检索。
 */
export async function bootstrapMemory(goal: string): Promise<void> {
  try {
    if ((await memoryReadPage(MEM_PROFILE)) === null) {
      await memoryWritePage(MEM_PROFILE, '# 用户画像\n', '用户画像')
    }
    if ((await memoryReadPage(MEM_REFLECTIONS)) === null) {
      await memoryWritePage(MEM_REFLECTIONS, '# 导师反思\n', '导师反思')
    }
    if (goal.trim() && (await memoryReadPage(MEM_GOAL)) === null) {
      await memoryWritePage(MEM_GOAL, `# 学习目标\n${goal.trim()}`, '学习目标')
    }
  } catch {
    // 记忆服务不可用时导师降级为无记忆模式,不阻塞启动
  }
}
