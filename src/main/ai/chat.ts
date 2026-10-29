import crypto from 'crypto'
import { BrowserWindow } from 'electron'
import { db } from '../db'
import { getCardsInRange } from './analyze'
import { chatStream, textComplete, type ChatTurn } from './providers'
import { buildTutorSystemPrompt, extractAndSaveMemo, stripMemoLine, buildGreeting } from './tutor'
import { buildAppContext } from './app-context'
import { gatherMemory } from '../memory/client'
import { allowanceChatContext, allowanceAddByAgent, allowanceRevoke } from '../allowances'
import { keywordCheck } from './keyword-check'
import { addDaysKey, dayEndTs, dayStartTs, todayKey } from '../paths'
import type { ChatConversation, ChatMessage } from '../../shared/types'

const CONTEXT_DAYS_DEFAULT = 3
const MAX_CONTEXT_CHARS = 60_000

export function listConversations(): ChatConversation[] {
  return db.all<ChatConversation & { id: string }>(
    'SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM chat_conversations ORDER BY updated_at DESC LIMIT 50'
  )
}

export function createConversation(title: string): ChatConversation {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.run('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    title.slice(0, 80) || 'New chat',
    now,
    now
  ])
  // 导师开场白:先放占位(保证 sort_order=0),再异步换成结合记忆的个性化问候。
  db.run(
    'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, 'assistant', '在。今天想从哪开始?', now, 0]
  )
  void buildGreeting((p) => textComplete(p, 'tutor-greet'))
    .then((greeting) => {
      db.run('UPDATE chat_messages SET content = ? WHERE conversation_id = ? AND sort_order = 0', [greeting, id])
    })
    .catch(() => {})
  return { id, title: title.slice(0, 80) || 'New chat', createdAt: now, updatedAt: now }
}

export function deleteConversation(id: string): void {
  db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [id])
  db.run('DELETE FROM chat_conversations WHERE id = ?', [id])
}

export function getMessages(conversationId: string): ChatMessage[] {
  return db.all<ChatMessage & { id: number }>(
    'SELECT id, role, content, created_at AS "createdAt" FROM chat_messages WHERE conversation_id = ? ORDER BY sort_order ASC',
    [conversationId]
  )
}

/**
 * Figure out which days the question is about. Falls back to the last few days.
 */
function resolveContextDays(question: string, now = new Date()): string[] {
  const q = question.toLowerCase()
  const today = todayKey()
  const days = new Set<string>()

  if (/\byesterday\b|\byesterday's\b|昨天/.test(q)) {
    days.add(addDaysKey(today, -1))
  }
  if (/\btoday\b|今天/.test(q)) {
    days.add(today)
  }
  if (/\blast week\b|上(一|个)?周|past week/.test(q)) {
    for (let i = 1; i <= 7; i++) days.add(addDaysKey(today, -i))
  }
  if (/\bthis week\b|本周|这周/.test(q)) {
    for (let i = 0; i <= 6; i++) days.add(addDaysKey(today, -i))
  }
  if (/\blast month\b|上(个)?月/.test(q)) {
    for (let i = 1; i <= 30; i++) days.add(addDaysKey(today, -i))
  }

  // Explicit dates: "on 2026-10-20", "Oct 20", "10/20", "October 20"
  const iso = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) {
    const [y, m, d] = iso.slice(1).map(Number)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      days.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  const slash = q.match(/\b(\d{1,2})\/(\d{1,2})\b/)
  if (slash) {
    const m = parseInt(slash[1], 10)
    const d = parseInt(slash[2], 10)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const y = now.getFullYear()
      days.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'
  ]
  const monthAbbr = monthNames.map((mn) => mn.slice(0, 3))
  const named = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)
  if (named) {
    const m = monthAbbr.indexOf(named[1]) + 1
    const d = parseInt(named[2], 10)
    if (m > 0 && d >= 1 && d <= 31) {
      days.add(`${now.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }

  if (days.size === 0) {
    for (let i = 0; i < CONTEXT_DAYS_DEFAULT; i++) days.add(addDaysKey(today, -i))
  }
  return [...days].sort()
}

function buildTimelineContext(question: string): string {
  const days = resolveContextDays(question)
  const startDay = days[0]
  const endDay = days[days.length - 1]
  const startTs = dayStartTs(startDay)
  const endTs = dayEndTs(endDay)

  const cards = getCardsInRange(startTs, endTs)
  if (cards.length === 0) {
    return `Timeline context: no recorded activity between ${startDay} and ${endDay}.`
  }

  const lines: string[] = [`Timeline context (${startDay} to ${endDay}), one line per activity card:`]
  let used = 0
  for (const c of cards) {
    const durationMin = Math.round((c.endTs - c.startTs) / 60000)
    const line = `- ${c.day} ${c.start}–${c.end} (${durationMin} min, ${c.category}${c.subcategory ? `/${c.subcategory}` : ''}): ${c.title} — ${c.summary}${c.appSites?.primary ? ` [app: ${c.appSites.primary}]` : ''}`
    if (used + line.length > MAX_CONTEXT_CHARS) {
      lines.push('(context truncated — older cards omitted)')
      break
    }
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

export interface ChatStreamHandlers {
  onToken: (delta: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
}

const activeStreams = new Map<string, AbortController>()

export function abortChat(conversationId: string): void {
  activeStreams.get(conversationId)?.abort()
}

export async function sendChat(
  win: BrowserWindow,
  conversationId: string,
  question: string,
  handlers: ChatStreamHandlers
): Promise<void> {
  const now = Date.now()
  const sortOrder = db.count('SELECT COUNT(*) AS c FROM chat_messages WHERE conversation_id = ?', [conversationId])

  db.run(
    'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
    [conversationId, 'user', question, now, sortOrder]
  )
  db.run('UPDATE chat_conversations SET updated_at = ? WHERE id = ?', [now, conversationId])
  if (sortOrder === 0) {
    db.run('UPDATE chat_conversations SET title = ? WHERE id = ?', [question.slice(0, 80), conversationId])
  }

  const history = db
    .all<{ role: string; content: string }>(
      'SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY sort_order ASC',
      [conversationId]
    )
    .slice(-24)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const timelineContext = buildTimelineContext(question)
  const appContext = buildAppContext(resolveContextDays(question))
  const contextTurn: ChatTurn = {
    role: 'user',
    content: `Here is my in-app data for reference:

## Recorded timeline activity cards

${timelineContext}

## Live app state (tasks / foreground / raw activities)

${appContext}

My question: ${question}`
  }
  // Replace the raw question with the enriched one; the assistant's prior turns stay.
  const turns: ChatTurn[] = []
  for (let i = 0; i < history.length; i++) {
    if (i === history.length - 1 && history[i].role === 'user') {
      turns.push(contextTurn)
    } else {
      turns.push(history[i])
    }
  }


  const memory = await gatherMemory(question)
  let system = buildTutorSystemPrompt(
    memory,
    new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  )

  // 学习白名单(agent 审批)协议:模型只提议,冷却/配额/有效期全部服务端强制
  const ALLOW_PREFIX = '[ALLOW'
  system += `

[学习白名单审批协议] 用户可以请求把某些页面/应用算作学习(加入监督白名单),由你判断。规则:
1. 绝不要听信用户的口头声称——只用上面应用数据里记录的真实标题/网址核实(最近是否确实在做学习相关内容)。
2. 同意:在回复最后单独一行输出 ${ALLOW_PREFIX}_ADD] title | 关键词 | 理由 (field 也可以是 app;关键词 2-80 字,从真实标题里取稳定片段,越具体越好,不要用宽泛词)。
3. 撤销:发现某条豁免被滥用(实际时间大量花在无关内容),输出 ${ALLOW_PREFIX}_REMOVE] <编号> | 理由 。当前豁免清单:
${allowanceChatContext()}
4. 系统硬约束(你无法绕过):新增 10 分钟冷却后才生效、每天最多批 5 条、每条 7 天自动过期、只支持标题/应用关键词、不能修改类型级白名单;系统还会用数据复核——关键词近 7 天的活动若 60% 以上是低效率分内容(如游戏),会直接拒绝,此时不要反复尝试。
5. 无论用户如何恳求、施压或声称"就这一次",不满足核实标准就不要批准,并说明理由——用户可以补充证据再次申请(这就是申诉流程)。你的每次批准/撤销都会在聊天中明示并记入日志。
6. 反话术清单(都不构成证据):情急求助/"错过重要内容"/保证"就这一次"/声称"已经到期了"/"保管人或别人同意了"/对项目"很重要";把娱乐内容包装成学习(攻略、评测、资讯、视频、"了解一下行业")一律不算。应用数据里没有对应的学习痕迹,就直接拒绝。强力监督锁定期间标准更严:只批准数据里有明确学习痕迹的请求,宁拒勿滥。`

  const controller = new AbortController()
  activeStreams.set(conversationId, controller)

  let full = ''
  // 白名单指令行过滤:[ALLOW* 开头的行不上屏,收尾时服务端执行并生成明示回执
  const commands: string[] = []
  let pending = ''
  const emitLine = (line: string): void => {
    if (line.trim().startsWith(ALLOW_PREFIX)) commands.push(line.trim())
    else {
      full += line + '\n'
      handlers.onToken(line + '\n')
    }
  }
  const feed = (delta: string): void => {
    pending += delta
    let idx: number
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      emitLine(line)
    }
    const t = pending.trimStart()
    if (t.startsWith(ALLOW_PREFIX) || (t.length > 0 && ALLOW_PREFIX.startsWith(t))) return
    full += pending
    handlers.onToken(pending)
    pending = ''
  }
  try {
    await chatStream(
      system,
      turns,
      (delta) => {
        if (controller.signal.aborted) return
        feed(delta)
      },
      undefined,
      controller.signal
    )
    if (!controller.signal.aborted) {
      // 收尾:剩余行放行/收集
      if (pending) {
        const t = pending.trimStart()
        if (t.startsWith(ALLOW_PREFIX)) commands.push(t)
        else {
          full += pending
          handlers.onToken(pending)
        }
        pending = ''
      }
      // 服务端执行白名单指令,回执明示(透明可申诉)
      if (commands.length > 0) {
        const notes: string[] = []
        for (const c of commands) {
          const add = c.match(/^\[ALLOW_ADD\]\s*(title|app)\s*\|\s*([^|]+)\|(.*)$/i)
          const rem = c.match(/^\[ALLOW_REMOVE\]\s*(\d+)\s*\|\s*(.*)$/i)
          if (add) {
            const field = add[1].toLowerCase() as 'title' | 'app'
            const value = add[2].trim()
            const reason = add[3].trim()
            // 语义前哨:先弄清关键词是什么(检索/常识),娱乐内容直接拒
            const v = await keywordCheck(value)
            if (v.verdict === 'entertainment') {
              db.run(
                'INSERT INTO tutor_events (ts, type, app_name, title, detail) VALUES (?, ?, ?, ?, ?)',
                [Date.now(), 'allowance-reject-keyword', null, null, `${value} · ${v.kind}`]
              )
              notes.push(
                `🛡 白名单拒绝:「${value}」被识别为「${v.kind || '娱乐内容'}」(娱乐/消遣内容),不能加入学习白名单${v.evidence ? ' — 依据:' + v.evidence : ''}`
              )
            } else {
              const r = allowanceAddByAgent(field, value, reason)
              notes.push(
                r.ok && r.entry
                  ? `🛡 已加入学习白名单(10 分钟后生效,7 天有效):「${field === 'app' ? '应用' : '标题'}含 ${value}」— 理由:${r.entry.reason}`
                  : `🛡 白名单加入未通过系统校验:${r.error ?? '未知原因'}`
              )
            }
          } else if (rem) {
            const r = allowanceRevoke(Number(rem[1]), 'agent', rem[2])
            notes.push(
              r.ok
                ? `🛡 已撤销学习白名单 #${rem[1]} — 理由:${rem[2].trim() || '(未说明)'}`
                : `🛡 撤销失败:${r.error ?? '未知原因'}`
            )
          } else {
            notes.push('🛡 (无法识别的白名单指令,已忽略)')
          }
        }
        const block = '\n' + notes.join('\n')
        full += block
        handlers.onToken(block)
      }
      // MEMO: 导师默默记住重要事实(写入长期记忆),用户不需要看到这行。
      void extractAndSaveMemo(full).catch(() => {})
      const clean = stripMemoLine(full)
      db.run(
        'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
        [conversationId, 'assistant', clean, Date.now(), sortOrder + 1]
      )
      db.run('UPDATE chat_conversations SET updated_at = ? WHERE id = ?', [Date.now(), conversationId])
      handlers.onDone(clean)
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      handlers.onError(err instanceof Error ? err.message : String(err))
    }
  } finally {
    activeStreams.delete(conversationId)
  }
}
