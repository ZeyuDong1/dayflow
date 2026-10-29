/**
 * 演示数据种子(全部虚构,可公开):
 *   node tools/demo/seed.mjs init  # 首次:用空数据根启动一次 app,让 schema 自建
 *   node tools/demo/seed.mjs seed  # 往 .demo-data/dayflow.db 灌合成数据
 */
import fs from 'fs'
import path from 'path'
import sqlPkg from 'sql.js'
import { demoRoot, launchApp, closeApp } from './common.mjs'

const initSqlJs = sqlPkg.initSqlJs ?? sqlPkg

const dbPath = path.join(demoRoot, 'data', 'dayflow.db')

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (base, h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0).getTime()
const today = new Date()
const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
const TODAY = dayKey(today)
const YESTERDAY = dayKey(yesterday)
const iso = (ts) => new Date(ts).toISOString()

async function init() {
  fs.rmSync(demoRoot, { recursive: true, force: true })
  const { app } = await launchApp()
  // 等 schema 建好(默认设置落库)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (fs.existsSync(dbPath)) break
  }
  await new Promise((r) => setTimeout(r, 2500))
  await closeApp(app)
  if (!fs.existsSync(dbPath)) throw new Error('db 未生成')
  console.log('init ok:', dbPath)
}

async function seed() {
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const one = (sql, params) => {
    const st = db.prepare(sql)
    st.bind(params)
    const row = st.step() ? st.getAsObject() : null
    st.free()
    return row
  }
  const run = (sql, params) => db.run(sql, params)
  const pid = (title) => one('SELECT id FROM projects WHERE title = ?', [title])?.id ?? null

  // ---- 设置:关真实抓取/监督(演示库不录真实桌面),跳过 onboarding ----
  run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('onboarding-done', '1')")
  const srow = one("SELECT value FROM app_settings WHERE key = 'app-settings'")
  if (srow) {
    const s = JSON.parse(srow.value)
    s.capture = { ...s.capture, enabled: false, intervalSec: 30 }
    s.tutor = { ...s.tutor, enabled: false, sessionPromptEnabled: false, soundEnabled: false }
    run('UPDATE app_settings SET value = ? WHERE key = ?', [JSON.stringify(s), 'app-settings'])
  }

  // ---- 规则与记忆 ----
  const obsidianId = pid('文档写作')
  run(
    `INSERT INTO rules (project_id, conditions_json, list_position, is_deleted)
     VALUES (?, '{"kind":"all","children":[{"kind":"cond","field":"app","op":"contains","value":"obsidian"}]}', 1, 0)`,
    [obsidianId]
  )

  // ---- 活动段:昨天 + 今天(虚构应用与标题) ----
  const segs = []
  const add = (day, h1, m1, h2, m2, app, title, proj, idle = 0) =>
    segs.push([at(day, h1, m1), at(day, h2, m2), app, title, proj, idle])
  // 昨天
  add(yesterday, 9, 10, 10, 5, 'Code.exe', '实现甘特图渲染 - dayflow-win', '编码开发')
  add(yesterday, 10, 10, 10, 40, 'Zen.exe', 'React 虚拟化方案对比 - react.dev', '调研学习')
  add(yesterday, 10, 40, 11, 30, 'Code.exe', '重构 capture 管线 - dayflow-win', '编码开发')
  add(yesterday, 11, 30, 12, 5, 'Weixin.exe', '和同学对进度', '沟通交流')
  add(yesterday, 14, 0, 15, 20, 'Obsidian.exe', '读书笔记:卡片写作法 - 知识库', '文档写作')
  add(yesterday, 15, 20, 15, 55, 'Zen.exe', '猫咪视频合集 - video.example.com', '娱乐消遣')
  add(yesterday, 15, 55, 17, 30, 'Code.exe', '修复 worker 竞态 - dayflow-win', '编码开发')
  add(yesterday, 19, 30, 20, 15, 'Obsidian.exe', '周报整理 - 知识库', '文档写作')
  add(yesterday, 20, 15, 21, 0, 'Spotify.exe', 'Lo-fi 学习歌单', '娱乐消遣', 1)
  // 今天
  add(today, 9, 5, 9, 50, 'Code.exe', '复盘昨日构建失败 - dayflow-win', '编码开发')
  add(today, 9, 50, 10, 30, 'Zen.exe', 'TypeScript 泛型教程 - ts.dev', '调研学习')
  add(today, 10, 30, 11, 45, 'Code.exe', '实现演示数据管线 - dayflow-win', '编码开发')
  add(today, 11, 45, 12, 10, 'Weixin.exe', '回复消息', '沟通交流')
  add(today, 14, 0, 14, 40, 'Obsidian.exe', '毕业论文第三章 - 草稿', '文档写作')
  add(today, 14, 40, 15, 10, 'Zen.exe', '游戏版本更新说明 - wiki.example.com', '娱乐消遣')
  add(today, 15, 10, 16, 20, 'Code.exe', '打包与签名脚本 - dayflow-win', '编码开发')
  const insAct = (row) =>
    run(
      `INSERT INTO app_activities (start_ts, end_ts, app_name, title, url_or_path, project_id, is_manual, is_deleted, is_idle)
       VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?)`,
      [row[0], row[1], row[2], row[3], pid(row[4]), row[5]]
    )
  segs.forEach(insAct)

  // ---- AI 卡片(活动页「卡片」视图) ----
  const cards = [
    ['09:00', '10:30', '晨间开工:复盘 + 泛型补课', '先复盘了昨晚构建失败的原因,随后查了 TypeScript 泛型教程补基础。', '工作', '编程'],
    ['10:30', '12:10', '演示数据管线开发', '在 dayflow-win 里实现合成数据管线,中途回了几条消息。', '工作', '编程'],
    ['14:00', '15:10', '论文 + 摸鱼反复横跳', '写了 40 分钟论文第三章,然后去看游戏更新说明,及时拉回。', '混合', '写作/娱乐'],
    ['15:10', '16:20', '打包与签名脚本', '写完 electron-builder 的签名与打包脚本,产出安装包。', '工作', '编程']
  ]
  for (const [start, end, title, summary, category, sub] of cards) {
    const [h1, m1] = start.split(':').map(Number)
    const [h2, m2] = end.split(':').map(Number)
    run(
      `INSERT INTO timeline_cards (start, end, start_ts, end_ts, day, title, summary, category, subcategory, created_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [start, end, at(today, h1, m1), at(today, h2, m2), TODAY, title, summary, category, sub, Date.now()]
    )
  }

  // ---- 任务系统(EpochToDo) ----
  const now = new Date().toISOString()
  const insTask = (title, status, memo, est, proj) =>
    run(
      `INSERT INTO tasks (title, status, type, context_memo, total_duration, estimated_duration, tag,
         project_id, parent_id, is_next_action, is_side_focus, sort_order, gpu_id, created_at, is_webhook)
       VALUES (?, ?, 'standard', ?, 0, ?, NULL, ?, NULL, 1, 0, ?, NULL, ?, 0)`,
      [title, status, memo, est, proj ? pid(proj) : null, Date.now() + Math.random(), now]
    )
  insTask('毕业论文第三章初稿', 'active', ' methodology 部分卡住,先写实验设置', 120, '文档写作')
  insTask('准备组会汇报 PPT', 'queued', '周四组会,15 页以内', 90, '文档写作')
  insTask('复现 baseline 实验', 'queued', '跑通官方仓库,记录环境', 180, '编码开发')
  insTask('读完《卡片笔记写作法》', 'queued', null, null, null)
  insTask('给 Dayflow 提一个 PR', 'queued', '顺手修的小 bug', 30, '编码开发')
  const paper = one('SELECT id FROM tasks WHERE title = ?', ['毕业论文第三章初稿'])
  run('INSERT INTO timers (task_id, started_at, type) VALUES (?, ?, ?)', [
    paper.id,
    new Date(Date.now() - 3600_000).toISOString(),
    'stopwatch'
  ])
  const sessions = [
    [yesterday, 14, 0, 14, 45, '毕业论文第三章初稿'],
    [yesterday, 20, 30, 21, 10, '准备组会汇报 PPT'],
    [today, 9, 10, 9, 55, '复现 baseline 实验'],
    [today, 14, 5, 15, 0, '毕业论文第三章初稿']
  ]
  for (const [d, h1, m1, h2, m2, title] of sessions) {
    run(
      `INSERT INTO history (task_id, title, type, start_time, end_time) VALUES (?, ?, 'focus', ?, ?)`,
      [one('SELECT id FROM tasks WHERE title = ?', [title])?.id ?? null, title, iso(at(d, h1, m1)), iso(at(d, h2, m2))]
    )
  }
  run(
    `INSERT INTO task_activities (start_ts, end_ts, title, project_id, billable, is_deleted)
     VALUES (?, ?, ?, ?, 0, 0)`,
    [at(today, 14, 5), at(today, 15, 0), '毕业论文第三章初稿', pid('文档写作')]
  )

  // ---- 导师对话(合成) ----
  const cid = 'demo-conv-0001'
  run('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    cid,
    '下午总是犯困怎么办',
    Date.now() - 3600_000,
    Date.now() - 3500_000
  ])
  const msgs = [
    ['user', '我下午两三点总是特别困,一困就去刷视频,怎么破?', 0],
    [
      'assistant',
      'MEMO: 用户午后容易出现困倦,触发刷视频逃避。\n这个模式很常见:困意本身不可怕,可怕的是"困→刷→更困"的循环。给你一个 2 分钟台阶:困的时候别对抗,先起身接杯水、开窗站一分钟,回来只做"最小的一步"——比如把论文那段话再读一遍,不做任何修改。多数时候启动了就不困了。',
      1
    ],
    ['user', '有道理,那我把刷视频的网站也归到娱乐类型里,让监督盯着', 2],
    [
      'assistant',
      '好主意,这正是 Dayflow 的用法:把"猫咪视频"这类页面拖进「娱乐消遣」类型,监督就会在你分心时提醒你。记住出口只有一个——回来做最小的一步,而不是要求自己状态满分。',
      3
    ]
  ]
  for (const [role, content, order] of msgs) {
    run(
      'INSERT INTO chat_messages (conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?)',
      [cid, role, content, Date.now() - 3600_000 + order * 60_000, order]
    )
  }

  // ---- 导师日统计(统计页有形) ----
  for (const [d, focus, dev] of [
    [YESTERDAY, 3.5 * 3600_000, 55 * 60_000],
    [TODAY, 2.2 * 3600_000, 30 * 60_000]
  ]) {
    run(
      `INSERT OR REPLACE INTO tutor_daily (day, focus_ms, dev_ms, interrupt_count, updated_at) VALUES (?, ?, ?, 2, ?)`,
      [d, focus, dev, Date.now()]
    )
  }

  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  console.log('seed ok:', segs.length, 'activities,', cards.length, 'cards, 5 tasks, 1 chat')
}

const phase = process.argv[2] ?? 'init'
if (phase === 'init') await init()
else if (phase === 'seed') await seed()
else console.error('unknown phase:', phase)
