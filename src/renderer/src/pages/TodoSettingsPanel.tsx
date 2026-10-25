import React, { useEffect, useState } from 'react'

/** 任务域设置面板（EpochToDo 融合，功能清单 §十四：归并到 Dayflow 设置页）。 */
export default function TodoSettingsPanel() {
  const [s, setS] = useState<Record<string, unknown> | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.dayflow.todo.getSettings().then((v) => setS(v as Record<string, unknown>))
  }, [])
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
            <div className="settings-row-help">全局命令栏热键（自定义改键后续版本提供）</div>
          </div>
          <div>Alt + Space</div>
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
            <div className="settings-row-help">10–100 / 10–24</div>
          </div>
          <span>
            <input
              type="number"
              min={10}
              max={100}
              style={{ width: 60 }}
              value={num(ov.opacity, 80)}
              onChange={(e) => save({ overlay_settings: { ...ov, opacity: Number(e.target.value) } })}
            />
            {' / '}
            <input
              type="number"
              min={10}
              max={24}
              style={{ width: 60 }}
              value={num(ov.fontSize, 14)}
              onChange={(e) => save({ overlay_settings: { ...ov, fontSize: Number(e.target.value) } })}
            />
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
              type="number"
              min={2}
              max={14}
              style={{ width: 55 }}
              value={num(ov.focusGlowIntensity, 6)}
              onChange={(e) => save({ overlay_settings: { ...ov, focusGlowIntensity: Number(e.target.value) } })}
            />
            {' / '}
            <input
              type="number"
              min={1}
              max={6}
              step={0.5}
              style={{ width: 55 }}
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
              type="number"
              min={10}
              max={100}
              style={{ width: 60 }}
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
      {msg && <div className="settings-row-help">{msg}</div>}
    </>
  )
}
