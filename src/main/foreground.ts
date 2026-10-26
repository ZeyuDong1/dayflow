import koffi from 'koffi'

export interface ForegroundInfo {
  appName: string // executable base name, e.g. "Code"
  windowTitle: string
  exePath?: string // full path, used for app-icon extraction
  hwnd: number // native window handle, for geometry/liveness checks
  pid: number // owning process id, to group an app's popups/menus with its window
}

export interface WindowGeom {
  left: number
  top: number
  width: number
  height: number
  titleBarHeight: number // 非客户端顶部(标题栏)高度,用于打断面板"让出标题栏"
  clientX: number // 客户区(内容区)物理矩形 —— 覆盖目标的精确语义
  clientY: number
  clientWidth: number
  clientHeight: number
  frameLeft: number // DWM 可见框(排除隐形边框的真实可见范围,物理像素)
  frameTop: number
  frameRight: number
  frameBottom: number
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
const ShowWindow = u32.func('bool ShowWindow(intptr_t hwnd, int cmd)')
const PostMessageW = u32.func('bool PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)')
const FindWindowExW = u32.func('intptr_t FindWindowExW(intptr_t parent, intptr_t child, str16 cls, str16 title)')
// DWMWA_EXTENDED_FRAME_BOUNDS = 9:真实可见框(不含隐形边框,含可见边框+标题栏)
const dwm = koffi.load('dwmapi.dll')
const DwmGetWindowAttribute = dwm.func(
  'int32 DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, int32_t *out, uint32 cb)'
)

/** 窗口几何:外框矩形 + 客户区矩形(=标题栏以下的内容区)+ 标题栏高度。
 * 客户区是覆盖目标的精确语义;外框含隐形边框(DPI 相关),不能直接换算摆放。 */
export function getWindowGeom(hwnd: number): WindowGeom | null {
  try {
    const rect = new Int32Array(4)
    if (!GetWindowRect(hwnd, rect)) return null
    const left = rect[0]
    const top = rect[1]
    const width = rect[2] - left
    const height = rect[3] - top
    let titleBarHeight = 36
    let clientX = left
    let clientY = top
    let clientWidth = width
    let clientHeight = height
    let frameLeft = left
    let frameTop = top
    let frameRight = left + width
    let frameBottom = top + height
    const cr = new Int32Array(4)
    const pt = new Int32Array(2)
    if (GetClientRect(hwnd, cr) && ClientToScreen(hwnd, pt)) {
      const h = pt[1] - top
      if (h > 0 && h <= 96) titleBarHeight = h
      clientX = pt[0]
      clientY = pt[1]
      clientWidth = cr[2]
      clientHeight = cr[3]
    }
    // 真实可见框(GetWindowRect 含 ~8px×DPI 的隐形边框,肉眼可见范围以 DWM 为准)
    const fb = new Int32Array(4)
    if (DwmGetWindowAttribute(hwnd, 9, fb, 16) === 0) {
      frameLeft = fb[0]
      frameTop = fb[1]
      frameRight = fb[2]
      frameBottom = fb[3]
    }
    return {
      left,
      top,
      width,
      height,
      titleBarHeight,
      clientX,
      clientY,
      clientWidth,
      clientHeight,
      frameLeft,
      frameTop,
      frameRight,
      frameBottom
    }
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

/** 最小化窗口(等价标题栏最小化按钮,SW_MINIMIZE=6)。强打断面板的"放它一马"出口。 */
export function minimizeWindow(hwnd: number): boolean {
  try {
    return !!ShowWindow(hwnd, 6)
  } catch {
    return false
  }
}

/** 温和关闭窗口(等价标题栏关闭按钮,WM_CLOSE=0x0010;应用可弹"未保存"确认)。 */
export function closeWindow(hwnd: number): boolean {
  try {
    return !!PostMessageW(hwnd, 0x0010, 0, 0)
  } catch {
    return false
  }
}

/** 窗口所属进程的 exe 基名(小写,不含路径);失败返回空串。 */
export function getWindowExeName(hwnd: number): string {
  try {
    const pidBuf = new Uint32Array(1)
    GetWindowThreadProcessId(hwnd, pidBuf)
    if (!pidBuf[0]) return ''
    const hProc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pidBuf[0])
    if (!hProc) return ''
    const nameBuf = new Uint16Array(1024)
    const sizeBuf = new Uint32Array([1024])
    let name = ''
    if (QueryFullProcessImageNameW(hProc, 0, nameBuf, sizeBuf)) {
      name = (Buffer.from(nameBuf.buffer).toString('utf16le').replace(/\0.*$/, '').split(/[\\/]/).pop() || '')
    }
    CloseHandle(hProc)
    return name.toLowerCase()
  } catch {
    return ''
  }
}

/** Chromium 系浏览器的标签页宿主子窗口(键盘加速键在这里处理)。 */
export function findChromiumTabHost(hwnd: number): number {
  try {
    return Number(FindWindowExW(hwnd, null, 'Chrome_RenderWidgetHostHWND', ''))
  } catch {
    return 0
  }
}

const BROWSER_EXE_NAMES = new Set([
  'chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium',
  '360se', '360chrome', 'qqbrowser', 'baidubrowser', 'ucbrowser', 'sogouexplorer',
  'maxthon', 'duckduckgo', 'thorium', 'librewolf', 'waterfox', 'arc'
])

/** 是否浏览器窗口:有 Chromium 标签宿主子窗口,或进程名命中已知浏览器表。 */
export function isBrowserWindow(hwnd: number): boolean {
  if (findChromiumTabHost(hwnd)) return true
  const exe = getWindowExeName(hwnd)
  if (!exe) return false
  const base = exe.replace(/\.exe$/i, '')
  if (BROWSER_EXE_NAMES.has(base)) return true
  return /browser$|chrome/.test(base) // 兜底:xx浏览器/chrome 系命名
}

/** 关闭浏览器当前标签页:向窗口投递 Ctrl+W(不抢焦点,不关整只浏览器)。
 * Chromium 系发到 Chrome_RenderWidgetHostHWND 子窗;其余(如 Firefox)发到主窗尽力而为。 */
export function closeTabInWindow(hwnd: number): boolean {
  try {
    const target = findChromiumTabHost(hwnd) || hwnd
    const keyDown = (vk: number, scan: number): boolean =>
      !!PostMessageW(target, 0x0100 /* WM_KEYDOWN */, vk, (scan << 16) | 1)
    const keyUp = (vk: number, scan: number): boolean =>
      !!PostMessageW(target, 0x0101 /* WM_KEYUP */, vk, 0xc0000000 + (scan << 16) + 1)
    keyDown(0x11, 0x1d) // Ctrl
    keyDown(0x57, 0x11) // W
    keyUp(0x57, 0x11)
    keyUp(0x11, 0x1d)
    return true
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
    return { appName, windowTitle, exePath, hwnd, pid: pidBuf[0] }
  } catch {
    return null
  }
}

/** Async wrapper matching the previous interface. */
export async function getForegroundInfo(): Promise<ForegroundInfo | null> {
  return getForegroundInfoSync()
}
