import { describe, it, expect } from 'vitest'
import { boundsOnAnyDisplay } from '../../src/shared/overlay-logic'
import { fitBreadcrumbLevels } from '../../src/shared/hierarchy'

describe('boundsOnAnyDisplay（审查重点#1）', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }

  it('相交即有效', () => {
    expect(boundsOnAnyDisplay({ x: 100, y: 100, width: 350, height: 250 }, [display])).toBe(true)
    expect(boundsOnAnyDisplay({ x: -100, y: -50, width: 350, height: 250 }, [display])).toBe(true)
  })

  it('完全在外（拔显示器）无效', () => {
    expect(boundsOnAnyDisplay({ x: 5000, y: 5000, width: 350, height: 250 }, [display])).toBe(false)
    expect(boundsOnAnyDisplay({ x: -5000, y: 100, width: 350, height: 250 }, [display])).toBe(false)
  })

  it('多显示器任一相交即有效', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(boundsOnAnyDisplay({ x: 2000, y: 100, width: 350, height: 250 }, [display, second])).toBe(true)
  })
})

describe('fitBreadcrumbLevels（Overlay 面包屑）', () => {
  it('从最近的父开始加入，放不下即停（全有或全无）', () => {
    // 标题 100px、每级 40px、分隔 10px、可用 200px：先加 10+40=150→再加 10+40=200 不超→2 级
    expect(fitBreadcrumbLevels(100, [40, 40], 10, 200)).toBe(2)
    // 可用 190：150 后再加超 → 只 1 级
    expect(fitBreadcrumbLevels(100, [40, 40], 10, 190)).toBe(1)
    // 可用 110：第一级 150 就放不下 → 0 级
    expect(fitBreadcrumbLevels(100, [40, 40], 10, 110)).toBe(0)
  })

  it('最近的父优先（levelWidths 末尾先算）', () => {
    // 近父窄远父宽：先容纳窄的
    expect(fitBreadcrumbLevels(50, [100, 20], 10, 100)).toBe(1)
  })
})
