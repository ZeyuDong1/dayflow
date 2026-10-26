/** 跨组件拖拽归类共享状态（时间轴块 → 侧边栏项目树）。 */
export interface DragGroup {
  kind: 'band' | 'row'
  ids: number[]
  appName: string
  title: string
}

export const dragState: { current: DragGroup | null } = { current: null }
