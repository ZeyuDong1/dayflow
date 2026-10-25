import React from 'react'

/**
 * Tiny markdown renderer for chat replies: headings, bold/italic, inline code,
 * fenced code, bullet/numbered lists, links. Deliberately dependency-free.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyPrefix}-${i++}`
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        nodes.push(
          <a key={key} href={linkMatch[2]} onClick={(e) => e.preventDefault()}>
            {linkMatch[1]}
          </a>
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let listItems: string[] = []
  let listOrdered = false
  let codeLines: string[] | null = null
  let key = 0

  const flushList = (): void => {
    if (listItems.length > 0) {
      const items = listItems.map((item, i) => <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>)
      blocks.push(
        listOrdered ? <ol key={`l-${key++}`}>{items}</ol> : <ul key={`l-${key++}`}>{items}</ul>
      )
      listItems = []
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (codeLines !== null) {
      if (line.trim().startsWith('```')) {
        blocks.push(
          <pre key={`c-${key++}`}>
            <code>{codeLines.join('\n')}</code>
          </pre>
        )
        codeLines = null
      } else {
        codeLines.push(raw)
      }
      continue
    }
    if (line.trim().startsWith('```')) {
      flushList()
      codeLines = []
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = heading[1].length
      const Tag = (`h${Math.min(level + 2, 6)}` as unknown) as 'h4'
      blocks.push(<Tag key={`h-${key++}`}>{renderInline(heading[2], `h-${key}`)}</Tag>)
      continue
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    if (bullet) {
      if (listOrdered) flushList()
      listOrdered = false
      listItems.push(bullet[1])
      continue
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numbered) {
      if (!listOrdered) flushList()
      listOrdered = true
      listItems.push(numbered[1])
      continue
    }
    if (line.trim() === '') {
      flushList()
      continue
    }
    flushList()
    blocks.push(<p key={`p-${key++}`}>{renderInline(line, `p-${key}`)}</p>)
  }
  flushList()
  if (codeLines !== null) {
    blocks.push(
      <pre key={`c-${key++}`}>
        <code>{codeLines.join('\n')}</code>
      </pre>
    )
  }
  return <div className="md">{blocks}</div>
}
