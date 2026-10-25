/**
 * Spotlight 命令解析（纯函数，无任何依赖）。
 * 文法与解析顺序逐条对齐语义规格 §4.1：
 * MEMO → 类型前缀 → 子任务冒号（仅 FOCUS/CREATE）→ 时间 → 项目 → GPU（升级）→ main/sub → 推断。
 * 时间缺省单位=分钟；@ 时间 token 只删第一个；GPU 使 CREATE/FOCUS 升级为 TRAINING。
 */

export type CommandType = 'EMPTY' | 'MEMO' | 'CREATE' | 'FOCUS' | 'REMINDER' | 'TRAINING' | 'COMPLETE' | 'SUSPEND'

export interface ParsedCommand {
  type: CommandType
  main?: string
  memo?: string
  query?: string
  sub?: string
  time?: number
  project?: string
  gpu?: string
  isSubtask?: boolean
  parentSearch?: string
}

const TIME_RE = /@\s*(\d+)([smh]?)/i
const PROJECT_RE = /\$\s*([^\s!@%>]+)/
const GPU_RE = /`\s*([^\s!@%>$]+)/

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim()
  if (!text) return { type: 'EMPTY' }
  if (text.startsWith('>')) return { type: 'MEMO', memo: text.slice(1).trim() }

  let type: CommandType = 'CREATE'
  let body = text
  const first = body[0]
  if (first === '+') {
    type = 'REMINDER'
    body = body.slice(1)
  } else if (first === '%') {
    type = 'TRAINING'
    body = body.slice(1)
  } else if (first === '#') {
    type = 'COMPLETE'
    body = body.slice(1)
  } else if (first === '!') {
    type = 'FOCUS'
    body = body.slice(1)
  }

  // 子任务语法（仅 FOCUS/CREATE）：第一个冒号劈出 parentSearch
  let isSubtask: boolean | undefined
  let parentSearch: string | undefined
  if (type === 'CREATE' || type === 'FOCUS') {
    const colon = body.indexOf(':')
    if (colon >= 0) {
      isSubtask = true
      const ps = body.slice(colon + 1).trim()
      parentSearch = ps || undefined
      body = body.slice(0, colon)
    }
  }

  // 时间表达式（第一个匹配；h×3600 / s 原值 / 其余×60）
  let time: number | undefined
  const tm = TIME_RE.exec(body)
  if (tm) {
    const n = parseInt(tm[1], 10)
    const unit = tm[2].toLowerCase()
    time = unit === 'h' ? n * 3600 : unit === 's' ? n : n * 60
    body = body.replace(tm[0], ' ')
  }

  // 项目 $name
  let project: string | undefined
  const pm = PROJECT_RE.exec(body)
  if (pm) {
    project = pm[1]
    body = body.replace(pm[0], ' ')
  }

  // GPU `name；CREATE/FOCUS 升级为 TRAINING（显式前缀不升级）
  let gpu: string | undefined
  const gm = GPU_RE.exec(body)
  if (gm) {
    gpu = gm[1]
    body = body.replace(gm[0], ' ')
    if (type === 'CREATE' || type === 'FOCUS') type = 'TRAINING'
  }

  // main/sub：余文按首个 ! 切分（token 删除留下的连续空白归一）
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
  const bang = body.indexOf('!')
  const main = collapse(bang >= 0 ? body.slice(0, bang) : body)
  const sub = bang >= 0 ? collapse(body.slice(bang + 1)) : ''

  // 推断：main 空 + 有时间 → SUSPEND；CREATE + main 非空 + 有时间 → REMINDER
  if ((type === 'CREATE' || type === 'FOCUS') && !main && time !== undefined) {
    type = 'SUSPEND'
  } else if (type === 'CREATE' && main && time !== undefined) {
    type = 'REMINDER'
  }

  const result: ParsedCommand = { type }
  if (type === 'COMPLETE') {
    result.query = main || undefined
  } else if (main) {
    result.main = main
  }
  if (sub) result.sub = sub
  if (time !== undefined) result.time = time
  if (project) result.project = project
  if (gpu) result.gpu = gpu
  if (isSubtask) {
    result.isSubtask = true
    result.parentSearch = parentSearch
  }
  return result
}
