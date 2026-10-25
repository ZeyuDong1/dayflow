import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import InterruptOverlay from './InterruptOverlay'
import ReminderWindow from './ReminderWindow'
import './styles.css'

// 强打断面板与 Reminder 硬提醒窗复用同一渲染包,按 hash 路由分流。
const isInterrupt = window.location.hash.startsWith('#/interrupt')
const isReminder = window.location.hash.startsWith('#/reminder')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isInterrupt ? <InterruptOverlay /> : isReminder ? <ReminderWindow /> : <App />}
  </React.StrictMode>
)
