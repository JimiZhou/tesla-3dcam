import type { TelemetrySample, TelemetryTrack } from '../types'

const EMPTY_SAMPLE: TelemetrySample = {
  timeSec: 0,
  speedKph: null,
  steeringDeg: null,
  acceleratorPct: null,
  brakeApplied: false,
  autopilotState: null,
  blinkerLeft: false,
  blinkerRight: false,
  gearState: null,
  headingDeg: null,
  latitude: null,
  longitude: null,
  accelerationX: null,
  accelerationY: null,
  accelerationZ: null,
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function parseTelemetryPayload(payload: unknown): TelemetryTrack {
  const root = payload as { samples?: unknown[]; fps?: number; source?: string }
  const rows = Array.isArray(payload) ? payload : root?.samples
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('遥测文件中没有 samples 数组')
  const fps = numberOrNull(root?.fps) ?? 30

  const samples = rows.map((row, index) => {
    const item = row as Record<string, unknown>
    const speedMps = numberOrNull(item.vehicle_speed_mps)
    const directKph = numberOrNull(item.speedKph ?? item.speed_kph)
    const pedal = numberOrNull(item.accelerator_pedal_position ?? item.acceleratorPct)
    return {
      timeSec: numberOrNull(item.timeSec ?? item.time_sec ?? item.pts_time) ?? (numberOrNull(item.frame_seq_no) ?? index) / fps,
      speedKph: directKph ?? (speedMps === null ? null : speedMps * 3.6),
      steeringDeg: numberOrNull(item.steering_wheel_angle ?? item.steeringDeg),
      acceleratorPct: pedal === null ? null : pedal <= 1 ? pedal * 100 : pedal,
      brakeApplied: bool(item.brake_applied ?? item.brakeApplied),
      autopilotState: numberOrNull(item.autopilot_state ?? item.autopilotState),
      blinkerLeft: bool(item.blinker_on_left ?? item.blinkerLeft),
      blinkerRight: bool(item.blinker_on_right ?? item.blinkerRight),
      gearState: numberOrNull(item.gear_state ?? item.gearState),
      headingDeg: numberOrNull(item.heading_deg ?? item.headingDeg),
      latitude: numberOrNull(item.latitude_deg ?? item.latitude),
      longitude: numberOrNull(item.longitude_deg ?? item.longitude),
      accelerationX: numberOrNull(item.linear_acceleration_mps2_x ?? item.accelerationX),
      accelerationY: numberOrNull(item.linear_acceleration_mps2_y ?? item.accelerationY),
      accelerationZ: numberOrNull(item.linear_acceleration_mps2_z ?? item.accelerationZ),
      clip: typeof item.clip === 'string' ? item.clip : undefined,
    } satisfies TelemetrySample
  }).sort((a, b) => a.timeSec - b.timeSec)

  return { source: root?.source === 'sei' ? 'sei' : 'sidecar', samples, fps }
}

export async function readTelemetryFile(file: File): Promise<TelemetryTrack> {
  return parseTelemetryPayload(JSON.parse(await file.text()))
}

export function createDemoTelemetry(duration = 72): TelemetryTrack {
  const samples: TelemetrySample[] = []
  for (let timeSec = 0; timeSec <= duration; timeSec += 0.1) {
    const braking = (timeSec > 31.5 && timeSec < 35.2) || (timeSec > 60 && timeSec < 62.5)
    const autopilot = timeSec > 8 && timeSec < 49
    const turn = timeSec > 48 && timeSec < 58
    const speedKph = Math.max(7, 46 + Math.sin(timeSec * 0.16) * 9 - (braking ? (timeSec % 3.5) * 7 : 0))
    const steeringDeg = turn ? -16 * Math.sin(((timeSec - 48) / 10) * Math.PI) : Math.sin(timeSec * 0.37) * 2.8
    samples.push({
      timeSec,
      speedKph,
      steeringDeg,
      acceleratorPct: braking ? 0 : 22 + Math.sin(timeSec * 0.4) * 11,
      brakeApplied: braking,
      autopilotState: autopilot ? 2 : 0,
      blinkerLeft: turn && Math.floor(timeSec * 2) % 2 === 0,
      blinkerRight: false,
      gearState: 4,
      headingDeg: 212 + steeringDeg * 0.16,
      latitude: 31.2304 + timeSec * 0.000002,
      longitude: 121.4737 - timeSec * 0.000001,
      accelerationX: braking ? -2.35 : Math.sin(timeSec * 0.52) * 0.18,
      accelerationY: steeringDeg * speedKph * 0.0009,
      accelerationZ: 9.81,
    })
  }
  return { source: 'demo', samples, fps: 10 }
}

export function telemetryAt(track: TelemetryTrack | null, time: number): TelemetrySample {
  if (!track?.samples.length) return { ...EMPTY_SAMPLE, timeSec: time }
  const samples = track.samples
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (samples[mid].timeSec <= time) low = mid
    else high = mid - 1
  }
  return samples[low] ?? { ...EMPTY_SAMPLE, timeSec: time }
}

export function autopilotLabel(state: number | null): string {
  if (state === null) return '无数据'
  if (state === 1) return 'FSD 驾驶中'
  if (state === 2) return '自动辅助转向'
  if (state === 3) return '自适应巡航'
  return '人工驾驶'
}

export function telemetryForClip(track: TelemetryTrack | null, clipName?: string): TelemetryTrack | null {
  if (!track || !clipName) return track
  const matching = track.samples.filter((sample) => sample.clip === clipName)
  if (!matching.length) return track
  const start = matching[0].timeSec
  return { ...track, samples: matching.map((sample) => ({ ...sample, timeSec: sample.timeSec - start })) }
}
