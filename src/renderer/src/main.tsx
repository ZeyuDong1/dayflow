import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import InterruptOverlay from './InterruptOverlay'
import ReminderWindow from './ReminderWindow'
import SpotlightWindow from './SpotlightWindow'
import OverlayWindow from './OverlayWindow'
import './styles.css'

// 强打断面板 / Reminder / Spotlight / Overlay 共用同一渲染包,按 hash 路由分流。
const isInterrupt = window.location.hash.startsWith('#/interrupt')
const isReminder = window.location.hash.startsWith('#/reminder')
const isSpotlight = window.location.hash.startsWith('#/spotlight')
const isOverlay = window.location.hash.startsWith('#/overlay')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isInterrupt ? (
      <InterruptOverlay />
    ) : isReminder ? (
      <ReminderWindow />
    ) : isSpotlight ? (
      <SpotlightWindow />
    ) : isOverlay ? (
      <OverlayWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>
)
