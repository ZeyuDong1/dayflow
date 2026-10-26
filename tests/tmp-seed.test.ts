import { describe, it } from 'vitest'
import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { TODO_SCHEMA_SQL } from '../src/main/todo/schema'

// 一次性工具:生成悬浮窗截图用的种子库(焦点/挂起/过期提醒/队列任务+计时器)
describe('seed overlay db', () => {
  it('writes seed db', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
    db.exec(TODO_SCHEMA_SQL)
    const run = (sql: string, params: unknown[] = []) => {
      const st = db.prepare(sql)
      st.bind(params as never)
      st.step()
      st.free()
    }
    const now = Date.now()
    const iso = (t: number) => new Date(t).toISOString()
    let id = 0
    const addTask = (title: string, extra: { status: string; type?: string; side?: boolean }) => {
      id += 1
      run(
        `INSERT INTO tasks (title, status, type, context_memo, total_duration, estimated_duration, tag,
           project_id, parent_id, is_next_action, is_side_focus, sort_order, gpu_id, created_at, is_webhook)
         VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, 1, ?, ?, NULL, ?, 0)`,
        [title, extra.status, extra.type ?? 'standard', extra.side ? 1 : 0, id * 1000, iso(now - id * 60000)],
      )
      return id
    }
    const addTimer = (taskId: number, type: string, target: number | null, started: number | null) => {
      run(`INSERT INTO timers (task_id, type, target_timestamp, original_duration, started_at) VALUES (?, ?, ?, NULL, ?)`, [
        taskId,
        type,
        target != null ? iso(target) : null,
        started != null ? iso(started) : null,
      ])
    }

    const f = addTask('主 Focus 标题示例 —— 一个相当长相当长的任务标题用来观察滚动与面包屑', { status: 'active' })
    addTimer(f, 'focus', null, now - 5 * 60_000)
    const s = addTask('副 Focus 标题示例 —— 副标题也应该滚动观察', { status: 'active', side: true })
    addTimer(s, 'focus', null, now - 3 * 60_000)
    const w = addTask('挂起中的任务 —— 倒计时进行中', { status: 'waiting' })
    addTimer(w, 'wait', now + 15 * 60_000, null)
    const r = addTask('过期的提醒 —— 该去买牛奶了', { status: 'waiting', type: 'reminder' })
    addTimer(r, 'wait', now - 6 * 60_000, null)
    addTask('排队任务 Queued —— 等待安排', { status: 'queued' })

    const overlaySettings = {
      opacity: 80, fontSize: 24, fontWeight: 400, focusFontScale: 1.8, sideFontScale: 1.25,
      color: '#ffffff', mouseIgnore: true, focusGlowEnabled: true, focusGlowIntensity: 14,
      focusGlowSpeed: 3, sideGlowEnabled: true, focusMarqueeEnabled: false, focusMarqueeSpeed: 30,
      sideMarqueeEnabled: true,
    }
    run('INSERT INTO app_settings (key, value) VALUES (?, ?)', [
      'todo-settings',
      JSON.stringify({
        reminder_nag_interval: 15, gpu_quiet_hours: { start: 23, end: 8 }, gpu_idle_interval: 15,
        webhook_stalled_threshold: 5, webhook_stalled_interval: 10,
        overlay_settings: overlaySettings,
        overlay_bounds: { x: 100, y: 100, width: 562, height: 251 },
        wandb_api_key: '', wandb_entity: '', md_sync_enabled: false, md_sync_folder: '',
        global_shortcut: 'Alt+Space',
      }),
    ])

    const dir = 'C:/Users/Zeyu/AppData/Local/Temp/overlay-shot/data'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'dayflow.db'), Buffer.from(db.export()))
    console.log('[seed] written', path.join(dir, 'dayflow.db'))
  })
})
