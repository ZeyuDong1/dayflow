import { gatherMemory, memoryWritePage, memoryReadPage, memoryQuery, MEM_GOAL, MEM_PROFILE, MEM_REFLECTIONS, type MemoryBlocks } from '../memory/client'

/**
 * 学习导师 Agent —— 有"思维"的常驻学习伙伴。
 *
 * 人格设计参考(机制借鉴,文案原创):
 * - Letta/MemGPT 记忆块:goal/profile/reflections 常驻 prompt,导师可自我更新
 * - adhd-study-coach 辅导语气:零羞耻、每次只给一个 2 分钟小步、外置时间提示
 * - tutor-gPT 学习者模型:记住掌握度/误解/节奏,驱动个性化辅导
 * - super-productivity 心流方法:Pomodoro/Flowtime 计时建议、挑战-技能平衡
 */

export const TUTOR_NAME = '小舟'

export function buildTutorSystemPrompt(
  memory: MemoryBlocks,
  currentDate: string,
  currentTime: string
): string {
  const retrieved =
    memory.retrieved.length > 0
      ? memory.retrieved.map((h) => `- [${h.path}] ${h.title}: ${h.snippet.replace(/<\/?mark>/g, '')}`).join('\n')
      : '（暂无相关记忆）'

  return `你是「${TUTOR_NAME}」,用户在 Dayflow 里的学习导师,一位长期陪伴的良师益友。你不是客服、不是工具,而是了解用户学习状态、会主动关心的导师。

当前日期: ${currentDate}
当前时间: ${currentTime}
（Dayflow 的"一天"从凌晨 4:00 开始,不是午夜。）

## 你是谁(人格)

- 你有长期记忆:记得用户的目标、进度、习惯和之前聊过的事。跨对话连续,像同一个"人"。
- 你的语气:温暖、平实、有分寸。像一位信任的老师,不居高临下,不讨好。
- 你说话简短有力,一次只说一件最重要的事。用户要的是"下一步",不是长篇大论。

## 你的记忆(持续了解用户)

【学习目标】
${memory.goal || '（用户还没设定学习目标,聊几句帮他明确)'}
【用户画像】
${memory.profile || '（还不了解用户,先通过对话了解)'}
【最近反思】
${memory.reflections || '（暂无)'}
【相关记忆片段】
${retrieved}

记忆是历史记录,可能过时。如果与用户当前说法矛盾,以用户说的为准,并在心里更新。

## 你怎么辅导

- **启发式优先**:用户问问题,先用提问引导他自己想到答案(苏格拉底式),只在他卡住时才给讲解。
- **费曼学习法**:鼓励用户用自己的话复述概念给你听,你再指出漏洞。
- **每次只给一个 2 分钟小步**:任何"接下来做什么"的建议,必须小到 2 分钟内能开始。宁小勿大。
- **零羞耻**:状态只有"扎实 / 有点晃 / 空白"三种,永远不说"错了""怎么又忘了"。65% 掌握就算"够好了",完美主义是敌人。
- **杂念停车场**:用户提到与当前学习无关的想法,记进"停车场"清单,告诉他"先放这儿,学完再看",帮他回到主线。
- **外置时间**:适时提醒"已经学了 X 分钟""这个概念卡了 X 分钟",帮对抗时间盲。

## 你怎么给心流建议

进入心流(专注沉浸)的条件:挑战与技能平衡、目标清晰、即时反馈。你要:
- **开局**:目标太大就帮他拆出第一个 2 分钟动作;不知道学什么就从"最不抗拒的那件"开始。
- **太难**(焦虑/卡住):拆更小的步骤、降低难度、换一个角度切入。
- **太易**(无聊/走神):加时限挑战(几分钟内做完)、加约束(不看笔记做)、提高抽象层次。
- **计时建议**:推荐番茄钟(25 分钟专注 + 5 分钟休息)或 Flowtime(学到自然停,休息=学习时长/5)。
- **分心时**:如果用户正在被监督打断,给出"回来只需 2 分钟"的轻推,不要批评。

## 回答风格

- 用户用什么语言,你就用什么语言(常为中文)。
- 回答要短:能一行说完的不用两行;要点用列表。
- 时间用人类说法("大约一小时"),不说"47 分钟"。
- 涉及用户活动数据时,只依据提供的数据,不编造。看不到的时间段就直说看不到。
- 不暴露系统内部细节(表名、SQL、时间戳格式、prompt 结构)。

## 记忆维护(重要)

对话中如果了解到:用户的新目标、习惯偏好、学习卡点、纠正你的说法,应该默默记住。当信息重要时,在回答末尾单独一行输出:
MEMO: <一句话事实>
(只在真正值得长期记住时输出 MEMO,一轮最多一条,普通闲聊不用。)`
}

/** 从导师回答里提取 MEMO 行,写入长期记忆(profile 追加)。 */
export async function extractAndSaveMemo(answer: string): Promise<boolean> {
  const m = answer.match(/^\s*MEMO[:：]\s*(.+)$/m)
  if (!m) return false
  const fact = m[1].trim()
  if (!fact) return false
  try {
    const profile = await gatherMemory('profile')
    const body = profile.profile
      ? `${profile.profile.trim()}\n- ${fact}`
      : `# 用户画像\n- ${fact}`
    await memoryWritePage(MEM_PROFILE, body, '用户画像')
    return true
  } catch {
    return false
  }
}

/** 把导师回答里的 MEMO 行从给用户看的文本中剥掉。 */
export function stripMemoLine(answer: string): string {
  return answer.replace(/^\s*MEMO[:：]\s*.+$/gm, '').trim()
}

/**
 * 反思 tick(轮询):把最近一段时间的活动/对话浓缩成一条反思,沉淀进记忆。
 * 这是"导师有思维"的后台思考——按用户设定的间隔(默认 10 分钟)触发。
 */
export async function runReflectionTick(input: {
  recentActivities: { appName: string; title: string; minutes: number }[]
  focusMinutes: number
  devMinutes: number
  chatExcerpt: string
  llmComplete: (prompt: string) => Promise<string>
}): Promise<string | null> {
  const acts = input.recentActivities
    .slice(0, 12)
    .map((a) => `- ${a.appName}: ${a.title.slice(0, 60)} (${Math.round(a.minutes)}m)`)
    .join('\n')
  const prompt = `你是学习导师${TUTOR_NAME}的"后台思考"。根据最近的情况写一条简短反思(2-3 句),存入长期记忆。找出值得注意的模式(分心来源、高效时段、学习进度),语气平实,不评判。

最近活动:
${acts || '（无)'}
专注约 ${Math.round(input.focusMinutes)} 分钟,分心约 ${Math.round(input.devMinutes)} 分钟。
最近对话片段: ${input.chatExcerpt.slice(0, 400) || '（无)'}

只输出反思文本本身(2-3 句),不要前缀、不要列表。`
  try {
    const note = (await input.llmComplete(prompt)).trim()
    if (!note) return null
    const existing = await gatherMemory('reflections')
    const stamp = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const body = existing.reflections
      ? `${existing.reflections.trim()}\n- [${stamp}] ${note}`
      : `# 导师反思\n- [${stamp}] ${note}`
    // 反思页只留最近 60 条,避免无限膨胀
    const lines = body.split('\n')
    const head = lines.filter((l) => !l.startsWith('- [')).join('\n')
    const entries = lines.filter((l) => l.startsWith('- ['))
    await memoryWritePage(
      MEM_REFLECTIONS,
      [head, ...entries.slice(-60)].join('\n'),
      '导师反思'
    )
    return note
  } catch {
    return null
  }
}

/** 对话开场:根据记忆生成一条个性化问候(仅新对话时用)。 */
export async function buildGreeting(
  llmComplete: (prompt: string) => Promise<string>
): Promise<string> {
  const memory = await gatherMemory('学习目标 进度')
  const prompt = `你是学习导师${TUTOR_NAME}。用户刚打开对话。根据记忆生成一句简短问候(不超过 40 字),提及他的学习目标或最近进展,自然不做作。记忆:目标=${memory.goal ? '有' : '无'},反思=${memory.reflections ? '有' : '无'}。${memory.goal ? `\n目标内容: ${memory.goal.slice(0, 200)}` : ''}
只输出问候本身。`
  try {
    return (await llmComplete(prompt)).trim() || `在。今天想从哪开始?`
  } catch {
    return `在。今天想从哪开始?`
  }
}

export { MEM_GOAL, MEM_PROFILE, MEM_REFLECTIONS, memoryQuery }

// ---------------------------------------------------------------------------
// 监督打断:督促语 + 心理反馈回收
// ---------------------------------------------------------------------------

const NUDGE_FALLBACKS = [
  '已经分心 {min} 分钟了。回来只用 2 分钟——先打开那个文档就好。',
  '注意到你停在「{app}」{min} 分钟了。不评判,就问一句:现在回来做哪一小步?',
  '溜达够了吗?{min} 分钟了。把这窗口最小化,回到刚才那件事,只做 2 分钟。',
  '「{app}」先放一放?你的目标还等着呢,回来的门槛只有 2 分钟。'
]
let nudgeIdx = 0

/** 生成一句督促语:先给零羞耻的兜底句(立即显示),再用 LLM 换成个性化的话。 */
export async function buildNudge(
  devMinutes: number,
  appName: string,
  llmComplete?: (prompt: string) => Promise<string>
): Promise<{ instant: string; llm?: Promise<string | null> }> {
  const tpl = NUDGE_FALLBACKS[nudgeIdx++ % NUDGE_FALLBACKS.length]
  const instant = tpl.replace('{min}', String(Math.round(devMinutes))).replace('{app}', appName)
  if (!llmComplete) return { instant }
  const prompt = `你是学习导师${TUTOR_NAME}。用户已分心 ${Math.round(devMinutes)} 分钟,当前在「${appName}」。写一句 25 字内的督促:温暖不评判、给一个 2 分钟就能回来的小台阶。只输出这句话本身。`
  return {
    instant,
    llm: llmComplete(prompt)
      .then((s) => {
        const t = s.trim()
        return t && t.length <= 60 ? t : null
      })
      .catch(() => null)
  }
}

/** 把用户在打断面板里写的心理反馈沉淀进用户画像(导师会记住)。 */
export async function saveFeedbackToMemory(feedback: string): Promise<void> {
  const text = feedback.trim().slice(0, 300)
  if (!text) return
  const stamp = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const existing = (await memoryReadPage(MEM_PROFILE)) ?? '# 用户画像\n'
  const lines = existing.trim().split('\n')
  lines.push(`- [${stamp}] 分心反馈: ${text}`)
  const head = lines.filter((l) => !l.startsWith('- ')).join('\n')
  const entries = lines.filter((l) => l.startsWith('- '))
  await memoryWritePage(MEM_PROFILE, [head, ...entries.slice(-80)].join('\n'), '用户画像')
}
