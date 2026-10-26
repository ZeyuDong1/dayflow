import React, { useEffect, useState } from 'react'

/**
 * 会话开始询问窗（#/session）：AFK 后回到电脑时弹出。
 * 「什么时候开始学习?」——现在开始 / N 分钟后开始 / 跳过(X 分钟后再问)。
 * Enter=现在开始；Esc=跳过。
 */
export default function SessionPromptWindow(): React.ReactElement {
  const [snoozeMin, setSnoozeMin] = useState(5)
  const [goal, setGoal] = useState('')

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    void window.dayflow.supervisionSessionSnoozeMin().then(setSnoozeMin)
    void window.dayflow.getSettings().then((s) => {
      setGoal((s as unknown as { tutor: { goal: string } }).tutor?.goal ?? '')
    })
  }, [])

  const startNow = (): void => {
    void window.dayflow.supervisionStartSessionNow()
  }
  const startIn = (m: number): void => {
    void window.dayflow.supervisionStartSessionIn(m)
  }
  const skip = (): void => {
    void window.dayflow.supervisionSnoozeSession()
  }

  return (
    <div
      className="sp-root"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          startNow()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          skip()
        }
      }}
      tabIndex={-1}
      ref={(el) => el?.focus()}
    >
      <div className="sp-card">
        <div className="sp-badge">学习小舟</div>
        <div className="sp-question">什么时候开始学习?</div>
        {goal && <div className="sp-goal">目标:{goal}</div>}
        <div className="sp-actions">
          <button className="sp-btn primary" onClick={startNow}>
            现在就开始
            <span className="sp-keycap">ENTER</span>
          </button>
        </div>
        <div className="sp-actions">
          {[5, 10, 15].map((m) => (
            <button key={m} className="sp-btn" onClick={() => startIn(m)}>
              {m} 分钟后开始
            </button>
          ))}
        </div>
        <div className="sp-actions">
          <button className="sp-btn ghost" onClick={skip} title={`跳过后 ${snoozeMin} 分钟会再次询问`}>
            跳过({snoozeMin} 分钟后再问)
          </button>
        </div>
        <div className="sp-hint">跳过期间不会有任何提醒；到点后会再次询问</div>
      </div>
    </div>
  )
}
