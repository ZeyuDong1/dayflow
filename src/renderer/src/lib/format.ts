export function formatDuration(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h >= 8) return `${h}h`
  return rest > 0 ? `${h}h ${rest}m` : `${h}h`
}

export function formatMinutesOfDay(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440
  const h24 = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function dayKeyLabel(dayKey: string): string {
  return parseDayKey(dayKey).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
}

export function dayKeyShort(dayKey: string): string {
  return parseDayKey(dayKey).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

export function addDays(dayKey: string, delta: number): string {
  const d = parseDayKey(dayKey)
  d.setDate(d.getDate() + delta)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

export function clockFromTs(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function isSameDay(a: string, b: string): boolean {
  return a === b
}
