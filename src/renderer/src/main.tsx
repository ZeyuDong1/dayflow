import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import InterruptOverlay from './InterruptOverlay'
import './styles.css'

// 强打断面板复用同一渲染包,按 hash 路由分流(#/interrupt = 打断小窗)。
const isInterrupt = window.location.hash.startsWith('#/interrupt')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isInterrupt ? <InterruptOverlay /> : <App />}
  </React.StrictMode>
)
