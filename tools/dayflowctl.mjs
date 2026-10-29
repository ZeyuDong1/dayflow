#!/usr/bin/env node
/**
 * 强力监督锁状态查询(仅本机):
 *   node tools/dayflowctl.mjs status     查看锁定状态/剩余时间
 * 解锁没有命令行——解锁权在导师小舟手里:到时间后去对话页找她聊天,她同意才解锁。
 * 端点信息来自 %APPDATA%/Dayflow/hardcore-unlock.json(锁定时生成)。
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

const file = path.join(os.homedir(), 'AppData', 'Roaming', 'Dayflow', 'hardcore-unlock.json')

let info
try {
  info = JSON.parse(fs.readFileSync(file, 'utf-8'))
} catch {
  console.error('未找到解锁端点信息(应用未开启强力监督)。')
  process.exit(1)
}

const url = `http://127.0.0.1:${info.port}/status?token=${encodeURIComponent(info.token)}`
http
  .get(url, (res) => {
    let data = ''
    res.on('data', (c) => (data += c))
    res.on('end', () => {
      let b = {}
      try {
        b = JSON.parse(data || '{}')
      } catch {}
      if (!b.locked) {
        console.log('未锁定。')
        return
      }
      const ms = Math.max(0, Number(b.remainingMs) || 0)
      const h = Math.floor(ms / 3600_000)
      const m = Math.floor((ms % 3600_000) / 60_000)
      console.log(`锁定中,剩余 ${h > 0 ? h + ' 小时 ' : ''}${m} 分钟。`)
      console.log('解锁请到 Dayflow 对话页找小舟聊天(时间到了她同意才会解锁)。')
    })
  })
  .on('error', (e) => {
    console.error('无法连接状态端点:', e.message)
    process.exit(1)
  })
