#!/usr/bin/env node
/**
 * 强力监督锁命令行(仅本机):
 *   node tools/dayflowctl.mjs status             查看锁定状态/剩余时间
 *   node tools/dayflowctl.mjs recover XXXX-XXXX  紧急解锁码解锁(任何时刻可用)
 *
 * 时长内用户无法解锁,只有紧急码能解;到期自动解锁,无需任何操作。
 * 紧急解锁码在开启时生成于
 * %APPDATA%/Dayflow/hardcore-recovery.txt,请交给信得过的人保管。
 * 端点信息来自 %APPDATA%/Dayflow/hardcore-unlock.json(锁定时生成)。
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import readline from 'readline'

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'Dayflow')
const file = path.join(dir, 'hardcore-unlock.json')

const fmtHr = (ms) => {
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: urlPath,
        method,
        headers: payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve({ code: res.statusCode ?? 0, body: JSON.parse(data || '{}') })
          } catch {
            resolve({ code: res.statusCode ?? 0, body: {} })
          }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()) }))
}

const [cmd, arg] = process.argv.slice(2)

let info
try {
  info = JSON.parse(fs.readFileSync(file, 'utf-8'))
} catch {
  console.error('未找到端点信息(应用未开启强力监督)。')
  process.exit(1)
}

if (cmd === 'status') {
  const r = await request('GET', `/status?token=${encodeURIComponent(info.token)}`).catch((e) => {
    console.error('无法连接状态端点:', e.message)
    process.exit(1)
  })
  if (!r.body.locked) {
    console.log('未锁定。')
  } else {
    console.log(`锁定中,剩余 ${fmtHr(Number(r.body.remainingMs) || 0)}。`)
    console.log('到期将自动解锁。紧急情况凭码:node tools/dayflowctl.mjs recover XXXX-XXXX(码在保管人手里)。')
  }
  process.exit(0)
}

if (cmd === 'recover') {
  let code = (arg ?? '').trim()
  if (!code) code = await ask('输入紧急解锁码(XXXX-XXXX): ')
  const r = await request('POST', '/unlock', { token: info.token, code }).catch((e) => {
    console.error('无法连接解锁端点:', e.message)
    process.exit(1)
  })
  if (r.code === 200) {
    console.log('已解锁,现在可以正常退出 Dayflow。')
    process.exit(0)
  }
  if (r.code === 401) {
    console.error('解锁码错误。')
  } else {
    console.error('解锁失败:', r.body.error ?? `HTTP ${r.code}`)
  }
  process.exit(1)
}

console.log('用法: node tools/dayflowctl.mjs [status | recover XXXX-XXXX]')
process.exit(1)
