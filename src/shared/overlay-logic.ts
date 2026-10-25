/**
 * Overlay 纯逻辑：bounds 与显示器校验（审查重点#1）。
 */
export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

/** bounds 与任一显示器 workArea 有交集才有效。 */
export function boundsOnAnyDisplay(b: BoundsRect, displays: DisplayRect[]): boolean {
  return displays.some(
    (d) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y,
  )
}
