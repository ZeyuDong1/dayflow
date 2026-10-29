/**
 * 演示截图:用种子数据启动真实 app,逐页截图到 docs/images/。
 *   node tools/demo/shoot.mjs
 */
import fs from 'fs'
import path from 'path'
import { repoRoot, launchApp, closeApp } from './common.mjs'

const outDir = path.join(repoRoot, 'docs', 'images')
fs.mkdirSync(outDir, { recursive: true })

const pages = [
  ['activities', '活动'],
  ['tasks', '任务'],
  ['review', '整理'],
  ['chat', '对话'],
  ['weekly', '统计']
]

const { app, win } = await launchApp()
await win.waitForSelector('.nav-item', { timeout: 30_000 })
await win.waitForTimeout(1500)

for (const [id, label] of pages) {
  await win.locator('.nav-item', { hasText: label }).first().click()
  await win.waitForTimeout(1600)
  await win.screenshot({ path: path.join(outDir, `${id}.png`) })
  console.log('shot', id)
}

// 活动页切到时间轴视图再补一张(分类视图之外的主要视图)
await win.locator('.nav-item', { hasText: '活动' }).first().click()
await win.waitForTimeout(800)
const chronoBtn = win.locator('button, .seg-btn, [role="button"]', { hasText: '时序' }).first()
try {
  await chronoBtn.click({ timeout: 3000 })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(outDir, 'activities-chrono.png') })
  console.log('shot activities-chrono')
} catch {
  console.log('no chrono toggle, skipped')
}

await closeApp(app)
console.log('done →', outDir)
