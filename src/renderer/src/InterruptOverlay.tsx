import React, { useEffect, useRef, useState } from 'react'

/**
 * 强打断面板(独立小窗口,hash 路由 #/interrupt):
 * 覆盖违规 APP 的内容区(让出标题栏),中间是小舟的话 + 心理反馈输入。
 * 违规窗口被最小化/关闭/切走时,主进程会自动关掉本面板。
 */

interface InterruptState {
  goal?: string
  appName?: string
  title?: string
  devMinutes?: number
  breakMinutes?: number
  soundEnabled?: boolean
  nudge?: string
  done?: boolean
}

function beep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 740
    gain.gain.value = 0.12
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.frequency.setValueAtTime(560, ctx.currentTime + 0.18)
    osc.stop(ctx.currentTime + 0.35)
    osc.onended = () => void ctx.close()
  } catch {
    // 无声环境忽略
  }
}

export default function InterruptOverlay(): React.ReactElement {
  const [state, setState] = useState<InterruptState>({})
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const beeped = useRef(false)

  useEffect(() => {
    document.title = '学习监督'
    void window.dayflow.supervisionInterruptState().then((s) => {
      if (s) setState(s as InterruptState)
    })
    return window.dayflow.onSupervisionInterrupt((payload) => {
      setState((prev) => ({ ...prev, ...(payload as InterruptState) }))
    })
  }, [])

  useEffect(() => {
    if (state.soundEnabled && !beeped.current && !state.done) {
      beeped.current = true
      beep()
    }
  }, [state.soundEnabled, state.done])

  const submit = (): void => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    void window.dayflow.supervisionFeedback(text).then(() => {
      setInput('')
    })
  }

  return (
    <div className="itx-wrap">
      <div className="itx-card">
        <div className="itx-head">
          <span className="itx-badge">学习小舟</span>
          {typeof state.devMinutes === 'number' && (
            <span className="itx-dev">
              {state.devMinutes < 1 ? '刚刚走神' : `已分心 ${state.devMinutes} 分钟`}
              {state.appName ? ` · ${state.appName}` : ''}
            </span>
          )}
        </div>

        <div className="itx-nudge">{state.nudge ?? '……'}</div>

        {!state.done && (
          <>
            <textarea
              className="itx-input"
              rows={3}
              placeholder="说说现在为什么不想学?(会记进导师的记忆,帮你下次更容易回来)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <div className="itx-actions">
              <button className="btn primary small" onClick={submit} disabled={!input.trim() || sending}>
                发送反馈
              </button>
              <button
                className="btn ghost small"
                onClick={() => void window.dayflow.supervisionBreak(state.breakMinutes ?? 10)}
              >
                休息一下({state.breakMinutes ?? 10} 分钟)
              </button>
              <button className="btn ghost small" onClick={() => void window.dayflow.supervisionStopToday()}>
                今天到此为止
              </button>
            </div>
            <div className="itx-hint">把底下的窗口最小化或关闭,这个提示也会自动消失。</div>
          </>
        )}
      </div>
    </div>
  )
}
