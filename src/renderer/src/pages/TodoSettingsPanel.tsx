import React, { useEffect, useState } from 'react'

/** 任务域设置面板（EpochToDo 融合，功能清单 §十四：归并到 Dayflow 设置页）。 */
export default function TodoSettingsPanel() {
  const [s, setS] = useState<Record<string, unknown> | null>(null)
  const [msg, setMsg] = useState('')
  const [recording, setRecording] = useState(false)
  const [clearValue, setClearValue] = useState('')
  const [mdStatus, setMdStatus] = useState<{
    enabled: boolean
    folder: string
    filePath: string
    watching: boolean
    lastSyncTime: number | null
  } | null>(null)
  useEffect(() => {
    void window.dayflow.todo.getSettings().then((v) => setS(v as Record<string, unknown>))
    void window.dayflow.todo.mdSync.getStatus().then(setMdStatus)
  }, [])
  const loadMd = () => void window.dayflow.todo.mdSync.getStatus().then(setMdStatus)
  const [mdPreview, setMdPreview] = useState<string | null>(null)
  const pickFolder = async () => {
    const folder = await window.dayflow.todo.mdSync.selectFolder()
    if (!folder) return
    const info = await window.dayflow.todo.mdSync.checkFile(folder)
    if (info.exists && info.titles.length > 0) {
      const dups = await window.dayflow.todo.mdSync.checkDuplicates(info.titles)
      if (dups.length > 0 && !window.confirm(`发现 ${dups.length} 个同名任务（${dups.slice(0, 3).join('、')}…），启用后这些行将按重名跳过。继续启用吗？`)) {
        return
      }
    }
    await window.dayflow.todo.mdSync.setConfig(true, folder)
    setMsg('已启用 MD 同步')
    loadMd()
    setTimeout(() => setMsg(''), 1500)
  }
  const togglePreview = async () => {
    if (mdPreview != null) {
      setMdPreview(null)
      return
    }
    const st = await window.dayflow.todo.mdSync.getStatus()
    setMdPreview(st.filePath ? await window.dayflow.todo.mdSync.readFile(st.filePath) : '')
  }
  const toggleMd = async () => {
    if (!mdStatus) return
    await window.dayflow.todo.mdSync.setConfig(!mdStatus.enabled, mdStatus.folder)
    setMsg(mdStatus.enabled ? '已关闭 MD 同步' : '已开启 MD 同步')
    loadMd()
    setTimeout(() => setMsg(''), 1500)
  }
  const syncNow = async () => {
    if (!mdStatus?.folder) return
    const r = await window.dayflow.todo.mdSync.syncNow(mdStatus.folder)
    setMsg(`已同步：新建 ${r.created} · 更新 ${r.updated} · 删除 ${r.deleted}`)
    loadMd()
    setTimeout(() => setMsg(''), 2500)
  }
  const save = (patch: Record<string, unknown>) => {
    void window.dayflow.todo.updateSettings(patch).then((v) => {
      setS(v as Record<string, unknown>)
      setMsg('已保存')
      setTimeout(() => setMsg(''), 1500)
    })
  }
  if (!s) return <div className="panel"><div className="panel-title">任务</div></div>
  const ov = (s.overlay_settings ?? {}) as Record<string, unknown>
  const qh = (s.gpu_quiet_hours ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  return (
    <>
      <div className="panel">
        <div className="panel-title">通用</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Spotlight 激活键</div>
            <div className="settings-row-help">全局命令栏热键，点击录制后按下新组合键（Esc 取消）</div>
          </div>
          {recording ? (
            <input
              autoFocus
              readOnly
              className="tp-mini"
              placeholder="按下组合键…"
              onKeyDown={(e) => {
                e.preventDefault()
                if (e.key === 'Escape') {
                  setRecording(false)
                  return
                }
                if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
                const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
                if (mods.length === 0) return // 必须带修饰键
                const acc = [...mods, e.key === ' ' ? 'Space' : e.key].join('+')
                void window.dayflow.todo.setShortcut(acc).then((ok) => {
                  setMsg(ok ? `热键已设置为 ${acc}` : '注册失败（可能被其他软件占用）')
                  setRecording(false)
                  setTimeout(() => setMsg(''), 2500)
                })
              }}
            />
          ) : (
            <button className="btn small" onClick={() => setRecording(true)}>
              录制
            </button>
          )}
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">通用任务提醒间隔</div>
            <div className="settings-row-help">逾期后每隔 X 分钟重复提醒（1–1440）</div>
          </div>
          <input
            type="number"
            min={1}
            max={1440}
            value={num(s.reminder_nag_interval, 15)}
            onChange={(e) => save({ reminder_nag_interval: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">GPU 与训练</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">空闲提醒间隔（分钟）</div>
            <div className="settings-row-help">有排队训练任务时空闲 GPU 的提醒节流（1–120）</div>
          </div>
          <input
            type="number"
            min={1}
            max={120}
            value={num(s.gpu_idle_interval, 15)}
            onChange={(e) => save({ gpu_idle_interval: Number(e.target.value) })}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">免打扰时段</div>
            <div className="settings-row-help">该时段内 GPU 健康检查整体静默（0–23，可跨零点）</div>
          </div>
          <span>
            <input
              type="number"
              min={0}
              max={23}
              style={{ width: 60 }}
              value={num(qh.start, 23)}
              onChange={(e) => save({ gpu_quiet_hours: { ...qh, start: Number(e.target.value) } })}
            />
            {' → '}
            <input
              type="number"
              min={0}
              max={23}
              style={{ width: 60 }}
              value={num(qh.end, 8)}
              onChange={(e) => save({ gpu_quiet_hours: { ...qh, end: Number(e.target.value) } })}
            />
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">训练停滞告警</div>
            <div className="settings-row-help">N 分钟无更新判停滞，每隔 M 分钟重提醒</div>
          </div>
          <span>
            <input
              type="number"
              min={1}
              max={120}
              style={{ width: 60 }}
              value={num(s.webhook_stalled_threshold, 5)}
              onChange={(e) => save({ webhook_stalled_threshold: Number(e.target.value) })}
            />
            {' / '}
            <input
              type="number"
              min={1}
              max={120}
              style={{ width: 60 }}
              value={num(s.webhook_stalled_interval, 10)}
              onChange={(e) => save({ webhook_stalled_interval: Number(e.target.value) })}
            />
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">wandb Entity</div>
            <div className="settings-row-help">自动发现训练运行（与 API Key 一起保存）</div>
          </div>
          <input value={String(s.wandb_entity ?? '')} onChange={(e) => save({ wandb_entity: e.target.value })} />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">wandb API Key</div>
            <div className="settings-row-help">仅存本地设置库</div>
          </div>
          <input
            type="password"
            value={String(s.wandb_api_key ?? '')}
            onChange={(e) => save({ wandb_api_key: e.target.value })}
          />
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">悬浮窗（Overlay）</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">鼠标穿透</div>
            <div className="settings-row-help">开启后点击穿过悬浮窗；关闭后可拖动</div>
          </div>
          <button
            className="btn small"
            onClick={() => {
              const next = !(ov.mouseIgnore as boolean)
              window.dayflow.todo.setOverlayIgnoreMouse(next)
              save({ overlay_settings: { ...ov, mouseIgnore: next } })
            }}
          >
            {(ov.mouseIgnore as boolean) ? '已开启' : '已关闭'}
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">重置位置</div>
            <div className="settings-row-help">移到主屏中央 350×250</div>
          </div>
          <button className="btn small" onClick={() => window.dayflow.todo.resetOverlayPosition()}>
            重置
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">不透明度（%）/ 字号（px）</div>
            <div className="settings-row-help">10–100 / 10–40</div>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              style={{ width: 120 }}
              value={num(ov.opacity, 80)}
              onChange={(e) => save({ overlay_settings: { ...ov, opacity: Number(e.target.value) } })}
            />
            <span className="settings-row-help">{num(ov.opacity, 80)}%</span>
            <input
              type="range"
              min={10}
              max={40}
              step={2}
              style={{ width: 120 }}
              value={num(ov.fontSize, 14)}
              onChange={(e) => save({ overlay_settings: { ...ov, fontSize: Number(e.target.value) } })}
            />
            <span className="settings-row-help">{num(ov.fontSize, 14)}px</span>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">字体粗细</div>
            <div className="settings-row-help">
              300 细 · 400 常规 · 500/600/700 中等偏粗 · 900 特粗；Focus/提醒行不细于原层级
            </div>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={300}
              max={900}
              step={100}
              style={{ width: 200 }}
              value={num(ov.fontWeight, 400)}
              onChange={(e) => save({ overlay_settings: { ...ov, fontWeight: Number(e.target.value) } })}
            />
            <span className="settings-row-help">{num(ov.fontWeight, 400)}</span>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">主 Focus 字号倍数</div>
            <div className="settings-row-help">相对悬浮窗基准字号的倍数</div>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              style={{ width: 160 }}
              value={num(ov.focusFontScale, 1.8)}
              onChange={(e) => save({ overlay_settings: { ...ov, focusFontScale: Number(e.target.value) } })}
            />
            <span className="settings-row-help">{num(ov.focusFontScale, 1.8)}×</span>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">副 Focus 字号倍数</div>
            <div className="settings-row-help">副 Focus 标题相对基准字号的倍数</div>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              style={{ width: 160 }}
              value={num(ov.sideFontScale, 1.25)}
              onChange={(e) => save({ overlay_settings: { ...ov, sideFontScale: Number(e.target.value) } })}
            />
            <span className="settings-row-help">{num(ov.sideFontScale, 1.25)}×</span>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">文字颜色</div>
          </div>
          <span style={{ display: 'flex', gap: 6 }}>
            {['#ffffff', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6'].map((c) => (
              <button
                key={c}
                onClick={() => save({ overlay_settings: { ...ov, color: c } })}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: c,
                  border: ov.color === c ? '2px solid #2b2b2b' : '1px solid #ccc',
                  cursor: 'pointer',
                }}
              />
            ))}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Focus 呼吸高亮</div>
            <div className="settings-row-help">开关 / 强度 2–14px / 周期 1–6s；副 Focus 同呼吸</div>
          </div>
          <span>
            <button
              className="btn small"
              onClick={() => save({ overlay_settings: { ...ov, focusGlowEnabled: !ov.focusGlowEnabled } })}
            >
              {ov.focusGlowEnabled ? '开' : '关'}
            </button>
            {' '}
            <input
              type="range"
              min={2}
              max={14}
              style={{ width: 90 }}
              value={num(ov.focusGlowIntensity, 6)}
              onChange={(e) => save({ overlay_settings: { ...ov, focusGlowIntensity: Number(e.target.value) } })}
            />
            <input
              type="range"
              min={1}
              max={6}
              step={0.5}
              style={{ width: 90 }}
              value={num(ov.focusGlowSpeed, 3)}
              onChange={(e) => save({ overlay_settings: { ...ov, focusGlowSpeed: Number(e.target.value) } })}
            />
            {' '}
            <button
              className="btn small"
              onClick={() => save({ overlay_settings: { ...ov, sideGlowEnabled: !ov.sideGlowEnabled } })}
            >
              副{ov.sideGlowEnabled ? '开' : '关'}
            </button>
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Focus 文字滚动</div>
            <div className="settings-row-help">开关 / 速度 10–100px/s；副 Focus 标题同滚</div>
          </div>
          <span>
            <button
              className="btn small"
              onClick={() => save({ overlay_settings: { ...ov, focusMarqueeEnabled: !ov.focusMarqueeEnabled } })}
            >
              {ov.focusMarqueeEnabled ? '开' : '关'}
            </button>
            {' '}
            <input
              type="range"
              min={10}
              max={100}
              style={{ width: 120 }}
              value={num(ov.focusMarqueeSpeed, 30)}
              onChange={(e) => save({ overlay_settings: { ...ov, focusMarqueeSpeed: Number(e.target.value) } })}
            />
            {' '}
            <button
              className="btn small"
              onClick={() => save({ overlay_settings: { ...ov, sideMarqueeEnabled: !ov.sideMarqueeEnabled } })}
            >
              副{ov.sideMarqueeEnabled ? '开' : '关'}
            </button>
          </span>
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">MD 同步</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Markdown 双向同步</div>
            <div className="settings-row-help">任务列表保存为所选文件夹内的 epochtodo.md，Obsidian/VS Code 可直接编辑（勾选=完成删除，[x] 行永不删除）</div>
          </div>
          <button className="btn small" onClick={() => void toggleMd()} disabled={!mdStatus?.folder}>
            {mdStatus?.enabled ? '已开启' : '已关闭'}
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">同步目录</div>
            <div className="settings-row-help">{mdStatus?.filePath || '未选择（选择后自动启用）'}</div>
          </div>
          <button className="btn small" onClick={() => void pickFolder()}>
            选择目录并启用
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">上次同步</div>
            <div className="settings-row-help">
              {mdStatus?.lastSyncTime ? new Date(mdStatus.lastSyncTime).toLocaleTimeString() : '尚未同步'}
            </div>
          </div>
          <button className="btn small" onClick={() => void syncNow()} disabled={!mdStatus?.folder}>
            立即同步
          </button>
          <button className="btn small ghost" onClick={() => void togglePreview()}>
            {mdPreview == null ? '预览文件' : '收起预览'}
          </button>
        </div>
        {mdPreview != null && (
          <pre style={{ maxHeight: 180, overflow: 'auto', background: 'var(--inset)', padding: 8, borderRadius: 8, fontSize: 12 }}>{mdPreview || '（空文件）'}</pre>
        )}
      </div>
      <div className="panel">
        <div className="panel-title">数据（任务域）</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">导出数据</div>
            <div className="settings-row-help">任务域数据库另存为 .db 备份</div>
          </div>
          <button
            className="btn small"
            onClick={() =>
              void window.dayflow.todo.exportData().then((r) => {
                setMsg(r ? `已导出到 ${r.path}` : '已取消')
                setTimeout(() => setMsg(''), 3000)
              })
            }
          >
            导出
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">导入数据</div>
            <div className="settings-row-help">选择 .db 覆盖（导入前自动备份旧库，需重启生效）</div>
          </div>
          <button
            className="btn small"
            onClick={() =>
              void window.dayflow.todo.importData().then((r) => {
                setMsg(r ? '已导入，请重启应用生效' : '已取消')
                setTimeout(() => setMsg(''), 4000)
              })
            }
          >
            导入
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">清空任务数据</div>
            <div className="settings-row-help">删除全部任务/计时/历史，不可恢复（输入 strict 确认）</div>
          </div>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              style={{ width: 90 }}
              placeholder="strict"
              value={clearValue}
              onChange={(e) => setClearValue(e.target.value)}
            />
            <button
              className="btn small danger"
              disabled={clearValue !== 'strict'}
              onClick={() => {
                void window.dayflow.todo.clearData().then(() => {
                  setClearValue('')
                  setMsg('任务数据已清空')
                  setTimeout(() => setMsg(''), 2000)
                })
              }}
            >
              清空
            </button>
          </span>
        </div>
      </div>
      {msg && <div className="settings-row-help">{msg}</div>}
    </>
  )
}
