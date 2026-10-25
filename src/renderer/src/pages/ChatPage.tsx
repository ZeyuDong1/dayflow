import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatConversation, ChatMessage } from '@shared/types'
import { Markdown } from '../lib/markdown'

const STARTERS = [
  '我昨天做了什么？',
  '帮我写今日站会',
  '这周我在编码上花了多少时间？',
  '我今天算高效吗？',
  '这周是什么让我分心？'
]

interface LiveMessage extends ChatMessage {
  streaming?: boolean
}

export default function ChatPage(): React.ReactElement {
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LiveMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadConversations = useCallback(() => {
    void window.dayflow.listConversations().then((list) => {
      setConversations(list)
      setActiveId((prev) => prev ?? list[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (activeId) {
      void window.dayflow.getMessages(activeId).then(setMessages)
    } else {
      setMessages([])
    }
  }, [activeId])

  useEffect(() => {
    return window.dayflow.onChatEvent((event) => {
      if (event.conversationId !== activeId) return
      if (event.type === 'token') {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + (event.delta ?? '') }
          } else {
            next.push({
              id: -Date.now(),
              role: 'assistant',
              content: event.delta ?? '',
              createdAt: Date.now(),
              streaming: true
            })
          }
          return next
        })
      } else if (event.type === 'done') {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.streaming) next[next.length - 1] = { ...last, streaming: false, content: event.full ?? last.content }
          return next
        })
        setBusy(false)
      } else if (event.type === 'error') {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.streaming) next[next.length - 1] = { ...last, streaming: false }
          next.push({
            id: -Date.now(),
            role: 'assistant',
            content: `⚠ ${event.message ?? '请求失败'}`,
            createdAt: Date.now()
          })
          return next
        })
        setBusy(false)
      }
    })
  }, [activeId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = (text?: string): void => {
    const question = (text ?? input).trim()
    if (!question || busy) return
    setInput('')
    setBusy(true)
    if (!activeId) {
      void window.dayflow
        .newConversation(question)
        .then((conv) => {
          setActiveId(conv.id)
          loadConversations()
          return window.dayflow.sendMessage(conv.id, question)
        })
        .then(() => setBusy(false))
        .catch(() => setBusy(false))
      setMessages([{ id: -1, role: 'user', content: question, createdAt: Date.now() }])
      return
    }
    setMessages((prev) => [...prev, { id: -Date.now(), role: 'user', content: question, createdAt: Date.now() }])
    void window.dayflow
      .sendMessage(activeId, question)
      .then(() => setBusy(false))
      .catch(() => setBusy(false))
  }

  const newChat = (): void => {
    setActiveId(null)
    setMessages([])
    setInput('')
  }

  return (
    <div className="page" style={{ padding: 0, display: 'flex' }}>
      <div className="chat-layout" style={{ flex: 1 }}>
        <div className="chat-sidebar">
          <button className="btn primary" style={{ marginBottom: 10 }} onClick={newChat}>
            + 新对话
          </button>
          {conversations.map((conv) => (
            <div key={conv.id} className={`conv-item ${activeId === conv.id ? 'active' : ''}`}>
              <button className="conv-item" style={{ flex: 1, padding: 0 }} onClick={() => setActiveId(conv.id)}>
                {conv.title || '未命名对话'}
              </button>
              <button
                className="conv-del"
                title="删除对话"
                onClick={() => {
                  void window.dayflow.deleteConversation(conv.id).then(() => {
                    if (activeId === conv.id) newChat()
                    loadConversations()
                  })
                }}
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 10px' }}>
              还没有对话
            </div>
          )}
        </div>

        <div className="chat-main">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="empty-state">
                <h3>和工作日志对话</h3>
                <p>问问你的一天、一周或一年的情况——回答都基于你的真实时间线。</p>
                <div className="chat-suggestions" style={{ justifyContent: 'center' }}>
                  {STARTERS.map((s) => (
                    <button key={s} className="suggestion-chip" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={m.id} className={`chat-bubble ${m.role}`}>
                <div className="bubble-role">{m.role === 'user' ? '我' : 'Dayflow'}</div>
                <div className="bubble-content">
                  {m.role === 'assistant' ? (
                    <>
                      <Markdown text={m.content} />
                      {m.streaming && <span className="streaming-cursor" />}
                    </>
                  ) : (
                    m.content
                  )}
                </div>
                {m.role === 'assistant' && !m.streaming && i === messages.length - 1 && (
                  <div className="chat-suggestions">
                    {STARTERS.slice(0, 3).map((s) => (
                      <button key={s} className="suggestion-chip" onClick={() => send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="chat-composer">
            <div className="composer-row">
              <textarea
                placeholder="问问你的工作情况…（Enter 发送，Shift+Enter 换行）"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              {busy ? (
                <button className="btn" onClick={() => activeId && window.dayflow.abortChat(activeId)}>
                  停止
                </button>
              ) : (
                <button className="btn primary" onClick={() => send()} disabled={!input.trim()}>
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
