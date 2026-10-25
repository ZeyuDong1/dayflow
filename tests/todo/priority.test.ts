import { describe, it, expect } from 'vitest'
import { countBangs, computeBangPriorities } from '../../src/main/todo/priority'

describe('countBangs', () => {
  it('统计标题任意位置的 ! 个数', () => {
    expect(countBangs('a!b!!')).toBe(3)
    expect(countBangs('no bangs')).toBe(0)
    expect(countBangs('!!前置')).toBe(2)
    expect(countBangs('任务!!')).toBe(2)
  })
})

describe('computeBangPriorities', () => {
  it('subtree-max：父继承最响子级，只向上传播', () => {
    const map = computeBangPriorities([
      { id: 1, title: 'parent', parent_id: null },
      { id: 2, title: 'x!!', parent_id: 1 },
      { id: 3, title: 'y!!!', parent_id: 2 },
      { id: 4, title: 'solo', parent_id: null },
    ])
    expect(map.get(1)).toBe(3)
    expect(map.get(2)).toBe(3)
    expect(map.get(3)).toBe(3)
    expect(map.get(4)).toBe(0)
  })

  it('父的 !! 不抬子（不向下传播）', () => {
    const map = computeBangPriorities([
      { id: 1, title: 'loud!!', parent_id: null },
      { id: 2, title: 'quiet', parent_id: 1 },
    ])
    expect(map.get(1)).toBe(2)
    expect(map.get(2)).toBe(0)
  })

  it('parent_id 成环不死循环，回边按 0 计（源码语义）', () => {
    const map = computeBangPriorities([
      { id: 1, title: 'a!', parent_id: 2 },
      { id: 2, title: 'b!!', parent_id: 1 },
    ])
    expect(map.get(2)).toBe(2)
    expect(map.get(1)).toBe(2)
    expect(map.size).toBe(2)
  })
})
