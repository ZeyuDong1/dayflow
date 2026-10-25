// Mock OpenAI-compatible vision provider for end-to-end pipeline testing.
// Listens on 127.0.0.1:$MOCK_PORT (default 8765). Logs requests to mock-provider-requests.log.
import http from 'node:http'
import fs from 'node:fs'

const LOG = new URL('./mock-provider-requests.log', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = (line) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)

function frameLabels(body) {
  const labels = []
  const collect = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/Frame at (\d{1,2}:\d{2}\s?[AP]M)/gi)) labels.push(m[1].replace(/\s+/g, ' '))
    } else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(body)
  return labels
}

function addOneMinute(label) {
  const m = label.match(/^(\d{1,2}):(\d{2})\s?([AP])M$/i)
  if (!m) return label
  let h = parseInt(m[1], 10)
  let min = parseInt(m[2], 10) + 1
  const pm = m[3].toUpperCase() === 'P'
  if (min >= 60) { min = 0; h += 1 }
  if (h > 12) h = 1
  return `${h}:${String(min).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    log(`${req.method} ${req.url}`)
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-vision' }, { id: 'mock-text' }] }))
      return
    }
    let body = null
    try { body = JSON.parse(raw) } catch {}
    const isAnthropic = req.url.includes('/anthropic')
    const isStream = body?.stream === true
    const labels = body ? frameLabels(body) : []
    const imgCount = (raw.match(/"data"/g) || []).length
    log(`  anthropic=${isAnthropic} stream=${isStream} frames=${labels.length} images=${imgCount} bytes=${raw.length}`)

    let text
    const promptText = JSON.stringify(body ?? {}).slice(0, 4000)
    if (labels.length >= 2) {
      // Timeline analysis: one card covering first..last+1min.
      const start = labels[0]
      const end = addOneMinute(labels[labels.length - 1])
      const cards = [
        {
          startTime: start,
          endTime: end,
          category: 'Work',
          subcategory: 'e2e-test',
          title: 'End-to-end pipeline verification session',
          summary: 'Mock provider analyzed frames and produced this card. Pipeline, batching, parsing and persistence are working.',
          detailedSummary: labels
            .slice(0, 6)
            .map((l, i) => `${l}: viewed the test screen (mock detail line ${i + 1})`)
            .join('\n'),
          distractions: [
            { startTime: labels[1] ?? start, endTime: addOneMinute(labels[1] ?? start), title: 'Brief mock distraction', summary: 'Testing distraction parsing' }
          ],
          appSites: { primary: 'example.com', secondary: null }
        }
      ]
      text = JSON.stringify(cards)
    } else if (/standup/i.test(promptText)) {
      text = JSON.stringify({
        highlights: ['Wired the timeline pipeline end to end', 'Verified card persistence'],
        blockers: ['Mock blocker: waiting on real API key'],
        summary: 'A day of building and verifying the Dayflow Windows port.'
      })
    } else {
      text = 'Mock provider reply: connection successful.'
    }

    if (isStream && isAnthropic) {
      // Anthropic Messages SSE stream
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n')
      const words = text.split(' ')
      let i = 0
      const timer = setInterval(() => {
        if (i >= words.length) {
          clearInterval(timer)
          res.write('data: {"type":"message_stop"}\n\n')
          res.end()
          return
        }
        const delta = { type: 'content_block_delta', delta: { type: 'text_delta', text: words[i] + (i < words.length - 1 ? ' ' : '') } }
        res.write(`data: ${JSON.stringify(delta)}\n\n`)
        i++
      }, 10)
    } else if (isAnthropic) {
      // Anthropic Messages non-stream
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_mock_' + Date.now(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text }],
          model: 'mock',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 }
        })
      )
    } else if (isStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const words = text.split(' ')
      let i = 0
      const timer = setInterval(() => {
        if (i >= words.length) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        const chunk = { choices: [{ delta: { content: words[i] + (i < words.length - 1 ? ' ' : '') } }] }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        i++
      }, 10)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'mock-' + Date.now(),
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { total_tokens: 123 }
        })
      )
    }
  })
})

const PORT = Number(process.env.MOCK_PORT || 8765)
server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(LOG, `mock provider started on :${PORT}\n`)
  console.log(`mock provider listening on http://127.0.0.1:${PORT}/v1`)
})
