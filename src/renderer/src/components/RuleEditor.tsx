import React from 'react'
import type { RuleField, RuleNode, RuleOp } from '@shared/types'

export const FIELD_LABEL: Record<string, string> = { app: '应用名', title: '窗口标题', urlOrPath: '网址/路径' }
export const OP_LABEL: Record<string, string> = {
  contains: '包含',
  equals: '等于',
  startsWith: '开头是',
  regex: '正则'
}

/** 把嵌套规则树渲染成一行中文描述。 */
export function nodeLabel(node: RuleNode): string {
  if (node.kind === 'cond') {
    return `${FIELD_LABEL[node.field] ?? node.field} ${OP_LABEL[node.op] ?? node.op}「${node.value}」`
  }
  if (node.kind === 'not') return `非(${nodeLabel(node.child)})`
  const joiner = node.kind === 'all' ? ' 且 ' : ' 或 '
  const inner = node.children.map(nodeLabel).join(joiner)
  return node.children.length > 1 ? `(${inner})` : inner || '（空规则）'
}

/** 递归克隆并替换树中路径指向的节点。路径是 children 下标序列。 */
export function replaceAt(node: RuleNode, path: number[], next: RuleNode | null): RuleNode {
  if (path.length === 0) return next ?? node
  if (node.kind === 'not') return { ...node, child: replaceAt(node.child, path.slice(1), next) }
  if (node.kind === 'cond') return node
  const children = [...node.children]
  const idx = path[0]
  if (path.length === 1) {
    if (next === null) children.splice(idx, 1)
    else children[idx] = next
  } else {
    children[idx] = replaceAt(children[idx], path.slice(1), next)
  }
  return { ...node, children }
}

/** 空条件「全部满足」组，新建规则的初始树。 */
export function emptyRuleTree(): RuleNode {
  return { kind: 'all', children: [{ kind: 'cond', field: 'title', op: 'contains', value: '' }] }
}

export function NodeEditor({
  node,
  path,
  onChange
}: {
  node: RuleNode
  path: number[]
  onChange: (path: number[], next: RuleNode | null) => void
}): React.ReactElement {
  const isRoot = path.length === 0

  if (node.kind === 'cond') {
    return (
      <div className="rule-node cond">
        <select
          value={node.field}
          onChange={(e) => onChange(path, { ...node, field: e.target.value as RuleField })}
        >
          <option value="app">应用名</option>
          <option value="title">窗口标题</option>
          <option value="urlOrPath">网址/路径</option>
        </select>
        <select
          value={node.op}
          onChange={(e) => onChange(path, { ...node, op: e.target.value as RuleOp })}
        >
          <option value="contains">包含</option>
          <option value="equals">等于</option>
          <option value="startsWith">开头是</option>
          <option value="regex">正则</option>
        </select>
        <input
          type="text"
          placeholder="匹配值…"
          value={node.value}
          onChange={(e) => onChange(path, { ...node, value: e.target.value })}
          style={{ flex: 1, minWidth: 130 }}
        />
        <button className="icon-btn" title="删除条件" onClick={() => onChange(path, null)}>
          ×
        </button>
      </div>
    )
  }

  if (node.kind === 'not') {
    return (
      <div className="rule-node group">
        <div className="rule-group-head">
          <span className="rule-word">非（取反）</span>
          {!isRoot && (
            <button className="icon-btn" title="删除组" onClick={() => onChange(path, null)}>
              ×
            </button>
          )}
        </div>
        <NodeEditor node={node.child} path={[...path, -1]} onChange={onChange} />
      </div>
    )
  }

  return (
    <div className="rule-node group" style={isRoot ? undefined : { marginLeft: 12 }}>
      <div className="rule-group-head">
        {node.kind === 'all' ? '满足全部（AND）' : '满足任一（OR）'}
        <button
          className="btn small ghost"
          onClick={() => onChange(path, { kind: node.kind === 'all' ? 'any' : 'all', children: node.children })}
        >
          切换为{node.kind === 'all' ? '任一 OR' : '全部 AND'}
        </button>
        {!isRoot && (
          <button className="icon-btn" title="删除组" onClick={() => onChange(path, null)}>
            ×
          </button>
        )}
      </div>
      {node.children.map((c, i) => (
        <NodeEditor key={i} node={c} path={[...path, i]} onChange={onChange} />
      ))}
      <div className="rule-add-row">
        <button
          className="btn small"
          onClick={() =>
            onChange([...path, node.children.length], {
              kind: 'cond',
              field: 'title',
              op: 'contains',
              value: ''
            })
          }
        >
          + 条件
        </button>
        <button
          className="btn small"
          onClick={() => onChange([...path, node.children.length], { kind: 'all', children: [] })}
        >
          + 子组(AND)
        </button>
        <button
          className="btn small"
          onClick={() => onChange([...path, node.children.length], { kind: 'any', children: [] })}
        >
          + 子组(OR)
        </button>
        <button
          className="btn small"
          onClick={() => onChange([...path, node.children.length], { kind: 'not', child: { kind: 'cond', field: 'app', op: 'contains', value: '' } })}
        >
          + 取反(NOT)
        </button>
      </div>
    </div>
  )
}
