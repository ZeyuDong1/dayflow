import { app, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import koffi from 'koffi'

/**
 * Timing 式应用图标：从 exe 资源提取真实图标（app.getFileIcon）。
 * exe 路径来源：① 采集时记录；② 运行进程枚举兜底（koffi + psapi）。
 * 图标与路径都持久化在 app-icons.json。
 */

const cache = new Map<string, string>() // appName -> data:image/png;base64,...
const exePaths = new Map<string, string>() // appName(lower) -> full exe path
let saveTimer: NodeJS.Timeout | null = null

// ---- 运行进程枚举（psapi.EnumProcesses + QueryFullProcessImageNameW）----
const k32 = koffi.load('kernel32.dll')
const psapi = koffi.load('psapi.dll')
const EnumProcesses = psapi.func('bool EnumProcesses(uint32_t *pids, uint32 cb, uint32_t *needed)')
const OpenProcess = k32.func('intptr_t OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = k32.func(
  'bool QueryFullProcessImageNameW(intptr_t h, uint32 flags, uint16_t *name, uint32_t *size)'
)
const CloseHandle = k32.func('bool CloseHandle(intptr_t h)')

let procMap: Map<string, string> | null = null // exe base(lower) -> full path
let procMapAt = 0

function refreshProcMap(): Map<string, string> {
  const now = Date.now()
  if (procMap && now - procMapAt < 60_000) return procMap
  procMapAt = now
  const map = new Map<string, string>()
  try {
    const pids = new Uint32Array(4096)
    const needed = new Uint32Array(1)
    if (!EnumProcesses(pids, pids.byteLength, needed)) return map
    const count = Math.min(needed[0] / 4, pids.length)
    for (let i = 0; i < count; i++) {
      const h = OpenProcess(0x1000, false, pids[i])
      if (!h) continue
      const nameBuf = new Uint16Array(1024)
      const sizeBuf = new Uint32Array([1024])
      if (QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf)) {
        const full = Buffer.from(nameBuf.buffer).toString('utf16le').replace(/\0.*$/, '')
        const base = (full.split(/[\\/]/).pop() ?? '').toLowerCase()
        if (base) map.set(base, full)
      }
      CloseHandle(h)
    }
  } catch {
    // enumeration is best-effort
  }
  procMap = map
  return map
}

function jsonPath(): string {
  return path.join(app.getPath('userData'), 'app-icons.json')
}

export function loadAppIcons(): void {
  try {
    const raw = fs.readFileSync(jsonPath(), 'utf-8')
    const obj = JSON.parse(raw) as { icons?: Record<string, string>; exePaths?: Record<string, string> }
    for (const [k, v] of Object.entries(obj.icons ?? {})) cache.set(k, v)
    for (const [k, v] of Object.entries(obj.exePaths ?? {})) exePaths.set(k, v)
  } catch {
    // first run
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const icons: Record<string, string> = {}
      for (const [k, v] of cache) icons[k] = v
      const paths: Record<string, string> = {}
      for (const [k, v] of exePaths) paths[k] = v
      fs.writeFileSync(jsonPath(), JSON.stringify({ icons, exePaths }))
    } catch {
      // best effort
    }
  }, 3000)
}

/** 记录应用可执行文件路径（采集时顺带获取），并顺手缓存图标。 */
export function noteExePath(appName: string, exePath: string | undefined | null): void {
  if (!exePath || !appName) return
  const key = appName.toLowerCase()
  if (!exePaths.has(key)) {
    exePaths.set(key, exePath)
    scheduleSave()
    void ensureAppIcon(appName)
  }
}

/** 解析 exe 路径：已知缓存 → 采集记录 → 运行进程枚举。 */
function resolveExePath(appName: string): string | null {
  const key = appName.toLowerCase()
  const known = exePaths.get(key) ?? exePaths.get(key.replace(/\.exe$/, ''))
  if (known) return known
  const procs = refreshProcMap()
  const hit =
    procs.get(key) ??
    procs.get(key.replace(/\.exe$/, '')) ??
    procs.get(key.endsWith('.exe') ? key : `${key}.exe`)
  if (hit) {
    exePaths.set(key, hit)
    scheduleSave()
  }
  return hit ?? null
}

export async function ensureAppIcon(appName: string): Promise<string | null> {
  if (cache.has(appName)) return cache.get(appName) ?? null
  const exe = resolveExePath(appName)
  if (!exe) return null
  try {
    const img = await app.getFileIcon(exe, { size: 'small' })
    const size = img.getSize()
    const scaled = size.width > 64 ? img.resize({ width: 64, height: 64 }) : img
    const dataUrl = `data:image/png;base64,${scaled.toPNG().toString('base64')}`
    cache.set(appName, dataUrl)
    scheduleSave()
    return dataUrl
  } catch {
    return null
  }
}

/** 批量取图标（无图标的应用不出现在结果里，UI 用字母徽标兜底）。 */
export async function getAppIcons(names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of names) {
    if (!name) continue
    const cached = cache.get(name)
    if (cached) {
      out[name] = cached
      continue
    }
    const icon = await ensureAppIcon(name)
    if (icon) out[name] = icon
  }
  return out
}
