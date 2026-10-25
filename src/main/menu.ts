import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { exportMarkdown } from './exporter'
import { todayKey } from './paths'

/**
 * 中文应用菜单栏（替换 Electron 默认英文 File/Edit/View/...）。
 * 编辑角色（undo/copy/paste…）保留系统 role 以获得正确的快捷键与输入法行为。
 */
export function installAppMenu(getWin: () => BrowserWindow | null): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '导出当天笔记…',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            const day = todayKey()
            void exportMarkdown(day, day).then((res) => {
              if (!res.ok) {
                const win = getWin()
                if (win && !win.isDestroyed()) {
                  void dialog.showMessageBox(win, { type: 'info', message: '导出', detail: res.message })
                }
              }
            })
          }
        },
        { type: 'separator' },
        {
          label: '打开数据文件夹',
          click: () => {
            void shell.openPath(app.getPath('userData'))
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出 Dayflow' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Dayflow',
          click: () => {
            const win = getWin()
            const opts: Electron.MessageBoxOptions = {
              type: 'info',
              title: '关于 Dayflow',
              message: `Dayflow for Windows ${app.getVersion()}`,
              detail:
                '自动工作日志：基于前台窗口记录 + 屏幕快照，本地生成时间线与回顾。\n数据完全保存在本地 %APPDATA%\\Dayflow。'
            }
            if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts)
            else void dialog.showMessageBox(opts)
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
