import type { CameraId, TeslaClipGroup } from '../types'

const cameraPatterns: Array<[CameraId, RegExp]> = [
  ['leftPillar', /(?:^|[-_])left[_-]?pillar(?:[-_.]|$)/i],
  ['rightPillar', /(?:^|[-_])right[_-]?pillar(?:[-_.]|$)/i],
  ['left', /(?:^|[-_])left[_-]?repeater(?:[-_.]|$)/i],
  ['right', /(?:^|[-_])right[_-]?repeater(?:[-_.]|$)/i],
  ['front', /(?:^|[-_])front(?:[-_.]|$)/i],
  ['rear', /(?:^|[-_])(?:back|rear)(?:[-_.]|$)/i],
]

function cameraFromName(name: string): CameraId | null {
  return cameraPatterns.find(([, pattern]) => pattern.test(name))?.[0] ?? null
}

function timestampFromName(name: string): { key: string; date: Date | null } {
  const match = name.match(/(20\d{2})-(\d{2})-(\d{2})[_-](\d{2})-(\d{2})-(\d{2})/)
  if (!match) {
    const stem = name.replace(/\.(mp4|mov|m4v)$/i, '').replace(/[-_](front|back|rear|left[_-]?(?:repeater|pillar)|right[_-]?(?:repeater|pillar))$/i, '')
    return { key: stem, date: null }
  }

  const [, year, month, day, hour, minute, second] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return { key: match[0], date }
}

export function folderFromFile(file: File): string {
  const relative = file.webkitRelativePath || file.name
  const parts = relative.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '手动选择'
}

function labelFor(date: Date | null, fallback: string): string {
  if (!date) return fallback
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function parseTeslaClips(input: File[]): TeslaClipGroup[] {
  const groups = new Map<string, TeslaClipGroup>()

  input
    .filter((file) => /\.(mp4|mov|m4v)$/i.test(file.name))
    .forEach((file) => {
      const camera = cameraFromName(file.name)
      if (!camera) return

      const folder = folderFromFile(file)
      const timestamp = timestampFromName(file.name)
      const id = `${folder}::${timestamp.key}`
      const current = groups.get(id) ?? {
        id,
        folder,
        label: labelFor(timestamp.date, timestamp.key),
        timestamp: timestamp.date,
        cameras: {},
      }

      current.cameras[camera] = {
        camera,
        file,
        filename: file.name,
        url: URL.createObjectURL(file),
      }
      groups.set(id, current)
    })

  return [...groups.values()].sort((a, b) => {
    if (a.timestamp && b.timestamp) return a.timestamp.getTime() - b.timestamp.getTime()
    return a.label.localeCompare(b.label)
  })
}

export function revokeClipUrls(groups: TeslaClipGroup[]): void {
  groups.forEach((group) => {
    Object.values(group.cameras).forEach((source) => URL.revokeObjectURL(source.url))
  })
}
