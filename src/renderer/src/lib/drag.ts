/** 跨组件拖拽归类共享状态（时间轴块 → 侧边栏项目树）。 */
export interface DragGroup {
  kind: 'band' | 'row'
  ids: number[]
  appName: string
  title: string
  /** 浏览器活动已解析的页面地址;有值时建规则可走网址匹配 */
  url?: string
}

export const dragState: { current: DragGroup | null } = { current: null }
