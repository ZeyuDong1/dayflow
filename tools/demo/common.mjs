/**
 * Demo 数据/截图管线共用:launchApp 用 playwright-core 以独立数据根启动真实 app。
 * 所有演示数据都是合成的(见 seed.mjs),不碰用户真实 %APPDATA%。
 */
import { _electron as electron } from 'playwright-core'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const demoRoot = path.join(repoRoot, '.demo-data')
export const electronExe = require('electron')

export async function launchApp(headless = true) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAYFLOW_USER_DATA: demoRoot,
      // 演示实例不跑真实抓取/监督由种子数据里的设置控制;端口错开防撞车
      DAYFLOW_TODO_PORT: '41820'
    }
  })
  // firstWindow 可能抢到隐藏的 overlay/spotlight 窗;主窗口以「有 sidebar」为准
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.content()).includes('nav-item')) return { app, win: w }
      } catch {
        // 窗口瞬时不可用,下轮再试
      }
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  await closeApp(app)
  throw new Error('main window (sidebar) not found in 45s')
}

export async function closeApp(app) {
  try {
    await app.close()
  } catch {
    // 已退出忽略
  }
}
