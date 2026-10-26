import { describe, it, expect } from 'vitest'
import {
  hashContent,
  parseMdContent,
  buildBulletTree,
  generateMdFromTasks,
  computeTaskRepairs,
  planMdMerge,
  planSubtreeMove,
  type MdTask,
} from '../../src/main/todo/mdsync/pure'

const FP = '/x/epochtodo.md'
function mk(over: Partial<MdTask> & { id: number; title: string }): MdTask {
  return {
    status: 'queued',
    parent_id: null,
    type: 'standard',
    sort_order: over.id,
    is_next_action: 1,
    md_file_path: FP,
    md_line_hash: null,
    ...over,
  }
}
const H = (t: string) => hashContent(t)

describe('hashContent', () => {
  it('trim 后取 md5 前 16 位 hex，确定性', () => {
    const h = hashContent('  写代码  ')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(hashContent('写代码')).toBe(h)
  })
})

describe('parseMdContent', () => {
  it('缩进深度：tab=1 级、空格 0.5 级取整（2/3 空格=1 级，4 空格=2 级）', () => {
    const rows = parseMdContent(['- [ ] a', '\t- [ ] b', '  - [ ] c', '   - [ ] d', '    - [ ] e'].join('\n'))
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 1, 2])
  })

  it('checked x/X；非 checkbox 行忽略；* 与 + 符号识别；CRLF 兼容', () => {
    const rows = parseMdContent('- [x] done\r\n* [X] also\r\n+ [ ] plus\r\n- 纯文本不是任务\r\n标题行\r\n')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ checked: true, text: 'done', depth: 0, lineIndex: 0 })
    expect(rows[1]).toMatchObject({ checked: true, text: 'also' })
    expect(rows[2]).toMatchObject({ checked: false, text: 'plus' })
  })

  it('hash 绑定内容（trim 后）', () => {
    expect(parseMdContent('- [ ] 写代码')[0].hash).toBe(H('写代码'))
  })
})

describe('buildBulletTree', () => {
  it('按缩进组树；同级多个根', () => {
    const tree = buildBulletTree(parseMdContent('- [ ] a\n  - [ ] a1\n  - [ ] a2\n- [ ] b\n    - [ ] b1'))
    expect(tree).toHaveLength(2)
    expect(tree[0].children.map((c) => c.bullet.text)).toEqual(['a1', 'a2'])
    expect(tree[1].children[0].bullet.text).toBe('b1')
  })
})

describe('generateMdFromTasks', () => {
  it('过滤（standard/未指明类型、非 archived、标题非空白）；2 空格缩进；组内 sort_order 升序；末尾换行', () => {
    const md = generateMdFromTasks([
      mk({ id: 1, title: '父', sort_order: 2 }),
      mk({ id: 2, title: '子2', parent_id: 1, sort_order: 9 }),
      mk({ id: 3, title: '子1', parent_id: 1, sort_order: 5 }),
      mk({ id: 4, title: '归档', status: 'archived' }),
      mk({ id: 5, title: '训练', type: 'training' }),
      mk({ id: 6, title: '   ' }),
    ])
    expect(md).toBe('- [ ] 父\n  - [ ] 子1\n  - [ ] 子2\n')
  })
})

describe('computeTaskRepairs（MD 侧获胜）', () => {
  it('改名记 conflict；archived→queued（只此方向）；parent 修正', () => {
    const r = computeTaskRepairs(mk({ id: 1, title: '旧名', status: 'archived' }), '新名', 5, new Set())
    expect(r.updates).toEqual({ title: '新名', status: 'queued', parent_id: 5 })
    expect(r.conflict).toEqual({ taskId: 1, oldTitle: '旧名', newTitle: '新名' })
  })

  it('next_action 修正；active 无计时→queued；active 有计时不动', () => {
    const r1 = computeTaskRepairs(mk({ id: 1, title: 'same', is_next_action: 0 }), 'same', null, new Set())
    expect(r1.updates).toEqual({ is_next_action: 1 })
    const r2 = computeTaskRepairs(mk({ id: 2, title: 'zombie', status: 'active' }), 'zombie', null, new Set())
    expect(r2.updates).toMatchObject({ status: 'queued' })
    const r3 = computeTaskRepairs(mk({ id: 3, title: 'focusing', status: 'active' }), 'focusing', null, new Set([3]))
    expect(r3.updates).toEqual({})
  })
})

describe('planMdMerge', () => {
  it('文件不存在：全量生成 + 全部 rebind（diagnostics newRoot=全部）', () => {
    const plan = planMdMerge(null, [mk({ id: 1, title: 'a' }), mk({ id: 2, title: 'b', parent_id: 1 })], FP)
    expect(plan.newContent).toBe('- [ ] a\n  - [ ] b\n')
    expect(plan.rebind.map((r) => r.id)).toEqual([1, 2])
    expect(plan.diagnostics).toEqual({ matched: 0, orphanChildren: 0, newRoot: 2 })
  })

  it('DB 侧改名：旧行保留 + 新标题行追加（源码已知行为；就地改写走 updateTaskInMd）', () => {
    const plan = planMdMerge(
      '- [ ] 旧名\n    - [x] 已完成行\n  - [ ] 无关行',
      [mk({ id: 1, title: '新名', md_line_hash: H('旧名') }), mk({ id: 3, title: '无关行', md_line_hash: H('无关行') })],
      FP,
    )
    expect(plan.newContent.split('\n')).toEqual(['- [ ] 旧名', '    - [x] 已完成行', '  - [ ] 无关行', '- [ ] 新名'])
    expect(plan.diagnostics).toEqual({ matched: 1, orphanChildren: 0, newRoot: 1 })
    expect(plan.rebind).toHaveLength(0) // 绑定完好（路径匹配且 hash 在）不重绑
  })

  it('[x] 行永不删除；无关内容原样保留', () => {
    const plan = planMdMerge(
      '- [x] 已完成行\n  - [ ] 无关行\n',
      [mk({ id: 3, title: '无关行', md_line_hash: H('无关行') })],
      FP,
    )
    const lines = plan.newContent.split('\n')
    expect(lines[0]).toBe('- [x] 已完成行')
    expect(lines[1]).toBe('  - [ ] 无关行')
  })

  it('孤儿子任务插到父子弹群末尾；全新任务追加到最后非空行之后', () => {
    const plan = planMdMerge(
      '- [ ] 父\n- [ ] 老行',
      [
        mk({ id: 1, title: '父', md_line_hash: H('父') }),
        mk({ id: 2, title: '孤儿子', parent_id: 1 }),
        mk({ id: 3, title: '全新' }),
      ],
      FP,
    )
    expect(plan.newContent.split('\n')).toEqual(['- [ ] 父', '  - [ ] 孤儿子', '- [ ] 老行', '- [ ] 全新'])
    expect(plan.diagnostics).toEqual({ matched: 1, orphanChildren: 1, newRoot: 1 })
  })
})

describe('planSubtreeMove（手术式搬移）', () => {
  it('把 bullet+更深注记行整段搬到新父子群末尾并重缩进', () => {
    const content = '- [ ] 父\n- [ ] 要搬\n  - [ ] 它的子\n  注记行\n- [ ] 尾行'
    const tasks = [
      mk({ id: 1, title: '父', md_line_hash: H('父') }),
      mk({ id: 2, title: '要搬', parent_id: 1, md_line_hash: H('要搬') }),
      mk({ id: 3, title: '它的子', parent_id: 2 }),
      mk({ id: 4, title: '尾行', md_line_hash: H('尾行') }),
    ]
    const plan = planSubtreeMove(content, tasks, 2)
    expect(plan).not.toBeNull()
    expect(plan!.moved).toBe(true)
    expect(plan!.newContent.split('\n')).toEqual(['- [ ] 父', '  - [ ] 要搬', '    - [ ] 它的子', '    注记行', '- [ ] 尾行'])
  })

  it('原地不动返回 moved:false；找不到任务返回 null', () => {
    const tasks = [mk({ id: 1, title: 'a', md_line_hash: H('a') })]
    expect(planSubtreeMove('- [ ] a\n', tasks, 1)!.moved).toBe(false)
    expect(planSubtreeMove('- [ ] a\n', tasks, 99)).toBeNull()
  })
})
