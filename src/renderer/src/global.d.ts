import type { DayflowApi } from '../../preload/index'

declare global {
  interface Window {
    dayflow: DayflowApi
  }
}

export {}
