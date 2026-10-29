#!/usr/bin/env node
/**
 * 强力监督锁的命令行出口(仅本机):
 *   node tools/dayflowctl.mjs status          查看锁定状态/剩余时间
 *   node tools/dayflowctl.mjs unlock          交互输入密码解锁(需已过最短时长)
 *   node tools/dayflowctl.mjs unlock <密码>   直接带密码解锁
 * 端点信息来自 %APPDATA%/Dayflow/hardcore-unlock.json(app 锁定时生成)。
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import readline from 'readline'

const file = path.join(os.homedir(), 'AppData', 'Roaming', 'Dayflow', 'hardcore-unlock.json')

function post(port, token, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token, password })
    const req = http.request(
      { host: '127.0.0.1', port, path: '/unlock', method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body) } },
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
    req.write(body)
    req.end()
  })
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  // 尽量隐藏输入(readline 没有原生 silent,退而求其次直接可见输入)
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

const fmtHr = (ms) => {
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}

const [cmd, pwArg] = process.argv.slice(2)
let info
try {
  info = JSON.parse(fs.readFileSync(file, 'utf-8'))
} catch {
  console.error('未找到解锁端点信息(应用未开启强力监督,或尚未重启过)。')
  process.exit(1)
}

if (cmd === 'status') {
  const r = await post(info.port, info.token, '__probe__').catch((e) => {
    console.error('无法连接解锁端点:', e.message)
    process.exit(1)
  })
  if (r.code === 403 && r.body.error === 'too-early') {
    console.log('锁定中,最短时长未到,剩余', fmtHr(r.body.remainingMs))
  } else if (r.code === 401) {
    console.log('锁定中,最短时长已到——可以解锁了:node tools/dayflowctl.mjs unlock')
  } else {
    console.log('未锁定。')
  }
  process.exit(0)
}

if (cmd === 'unlock') {
  const password = pwArg ?? (await ask('输入解锁密码: '))
  const r = await post(info.port, info.token, password).catch((e) => {
    console.error('无法连接解锁端点:', e.message)
    process.exit(1)
  })
  if (r.code === 200) {
    console.log('已解锁,现在可以正常退出 Dayflow。')
    process.exit(0)
  }
  if (r.code === 403 && r.body.error === 'too-early') {
    console.error('最短时长未到,剩余', fmtHr(r.body.remainingMs))
    process.exit(1)
  }
  console.error('解锁失败:密码错误。')
  process.exit(1)
}

console.log('用法: node tools/dayflowctl.mjs [status|unlock [密码]]')
process.exit(1)
