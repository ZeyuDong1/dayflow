import koffi from 'koffi'

export interface ForegroundInfo {
  appName: string // executable base name, e.g. "Code"
  windowTitle: string
  exePath?: string // full path, used for app-icon extraction
}

/**
 * Foreground window via user32 (koffi FFI, prebuilt NAPI — reliable inside
 * Electron; active-win's promise hangs forever in the Electron main process).
 */
const u32 = koffi.load('user32.dll')
const k32 = koffi.load('kernel32.dll')
const GetForegroundWindow = u32.func('intptr_t GetForegroundWindow()')
const GetWindowTextW = u32.func('int GetWindowTextW(intptr_t hwnd, uint16_t *str, int max)')
const GetWindowThreadProcessId = u32.func('uint32 GetWindowThreadProcessId(intptr_t hwnd, uint32_t *pid)')
const OpenProcess = k32.func('intptr_t OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = k32.func(
  'bool QueryFullProcessImageNameW(intptr_t h, uint32 flags, uint16_t *name, uint32_t *size)'
)
const CloseHandle = k32.func('bool CloseHandle(intptr_t h)')

export function getForegroundInfoSync(): ForegroundInfo | null {
  try {
    const hwnd = GetForegroundWindow()
    if (!hwnd) return null
    const titleBuf = new Uint16Array(512)
    GetWindowTextW(hwnd, titleBuf, 512)
    const windowTitle = Buffer.from(titleBuf.buffer).toString('utf16le').replace(/\0.*$/, '')
    const pidBuf = new Uint32Array(1)
    GetWindowThreadProcessId(hwnd, pidBuf)
    let appName = 'Unknown'
    let exePath: string | undefined
    const hProc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pidBuf[0])
    if (hProc) {
      const nameBuf = new Uint16Array(1024)
      const sizeBuf = new Uint32Array([1024])
      if (QueryFullProcessImageNameW(hProc, 0, nameBuf, sizeBuf)) {
        const exe = Buffer.from(nameBuf.buffer).toString('utf16le').replace(/\0.*$/, '')
        exePath = exe
        appName = exe.split(/[\\/]/).pop() || 'Unknown'
      }
      CloseHandle(hProc)
    }
    return { appName, windowTitle, exePath }
  } catch {
    return null
  }
}

/** Async wrapper matching the previous interface. */
export async function getForegroundInfo(): Promise<ForegroundInfo | null> {
  return getForegroundInfoSync()
}
