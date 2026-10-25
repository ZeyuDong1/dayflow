import koffi from 'koffi'

export interface ForegroundInfo {
  appName: string // executable base name, e.g. "Code"
  windowTitle: string
  exePath?: string // full path, used for app-icon extraction
  hwnd: number // native window handle, for geometry/liveness checks
}

export interface WindowGeom {
  left: number
  top: number
  width: number
  height: number
  titleBarHeight: number // 非客户端顶部(标题栏)高度,用于打断面板"让出标题栏"
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
const GetWindowRect = u32.func('bool GetWindowRect(intptr_t hwnd, int32_t *rect)')
const GetClientRect = u32.func('bool GetClientRect(intptr_t hwnd, int32_t *rect)')
const ClientToScreen = u32.func('bool ClientToScreen(intptr_t hwnd, int32_t *point)')
const IsIconic = u32.func('bool IsIconic(intptr_t hwnd)')
const IsWindow = u32.func('bool IsWindow(intptr_t hwnd)')

/** 窗口几何:外框矩形 + 标题栏高度(客户区顶到窗口顶的距离,随 DPI/应用自适应)。 */
export function getWindowGeom(hwnd: number): WindowGeom | null {
  try {
    const rect = new Int32Array(4)
    if (!GetWindowRect(hwnd, rect)) return null
    const left = rect[0]
    const top = rect[1]
    const width = rect[2] - left
    const height = rect[3] - top
    let titleBarHeight = 36
    const cr = new Int32Array(4)
    const pt = new Int32Array(2)
    if (GetClientRect(hwnd, cr) && ClientToScreen(hwnd, pt)) {
      const h = pt[1] - top
      if (h > 0 && h <= 96) titleBarHeight = h
    }
    return { left, top, width, height, titleBarHeight }
  } catch {
    return null
  }
}

/** 窗口是否还存在(未被关闭)且未最小化。 */
export function isWindowUsable(hwnd: number): boolean {
  try {
    return IsWindow(hwnd) && !IsIconic(hwnd)
  } catch {
    return false
  }
}

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
    return { appName, windowTitle, exePath, hwnd }
  } catch {
    return null
  }
}

/** Async wrapper matching the previous interface. */
export async function getForegroundInfo(): Promise<ForegroundInfo | null> {
  return getForegroundInfoSync()
}
