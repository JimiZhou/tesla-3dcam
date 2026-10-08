import type { TelemetrySample, TelemetryTrack } from '../types'

interface BoxRange {
  start: number
  end: number
}

interface RawSei {
  gearState: number | null
  frameSeq: number | null
  speedMps: number | null
  accelerator: number | null
  steering: number | null
  leftBlinker: boolean
  rightBlinker: boolean
  brake: boolean
  autopilot: number | null
  latitude: number | null
  longitude: number | null
  heading: number | null
  accelerationX: number | null
  accelerationY: number | null
  accelerationZ: number | null
}

function readAscii(view: DataView, start: number, length: number): string {
  let result = ''
  for (let index = 0; index < length; index += 1) result += String.fromCharCode(view.getUint8(start + index))
  return result
}

function findBox(view: DataView, start: number, end: number, name: string): BoxRange {
  for (let cursor = start; cursor + 8 <= end;) {
    let size = view.getUint32(cursor)
    const type = readAscii(view, cursor + 4, 4)
    let header = 8
    if (size === 1 && cursor + 16 <= end) {
      size = view.getUint32(cursor + 8) * 0x100000000 + view.getUint32(cursor + 12)
      header = 16
    } else if (size === 0) {
      size = end - cursor
    }
    if (size < header || cursor + size > end) break
    if (type === name) return { start: cursor + header, end: cursor + size }
    cursor += size
  }
  throw new Error(`MP4 中缺少 ${name} 数据块`)
}

function frameDurations(view: DataView): number[] {
  const moov = findBox(view, 0, view.byteLength, 'moov')
  const trak = findBox(view, moov.start, moov.end, 'trak')
  const mdia = findBox(view, trak.start, trak.end, 'mdia')
  const mdhd = findBox(view, mdia.start, mdia.end, 'mdhd')
  const version = view.getUint8(mdhd.start)
  const timescale = version === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12)
  const minf = findBox(view, mdia.start, mdia.end, 'minf')
  const stbl = findBox(view, minf.start, minf.end, 'stbl')
  const stts = findBox(view, stbl.start, stbl.end, 'stts')
  const entryCount = Math.min(view.getUint32(stts.start + 4), Math.floor((stts.end - stts.start - 8) / 8))
  const result: number[] = []
  let cursor = stts.start + 8
  for (let entry = 0; entry < entryCount; entry += 1) {
    const count = Math.min(view.getUint32(cursor), 1_000_000 - result.length)
    const seconds = view.getUint32(cursor + 4) / timescale
    for (let sample = 0; sample < count; sample += 1) result.push(seconds)
    cursor += 8
  }
  return result
}

function removeEmulationBytes(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length)
  let write = 0
  let zeros = 0
  for (const byte of input) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    output[write++] = byte
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return output.subarray(0, write)
}

function decodeProtobuf(data: Uint8Array): RawSei | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let cursor = 0
  const raw: RawSei = {
    gearState: null,
    frameSeq: null,
    speedMps: null,
    accelerator: null,
    steering: null,
    leftBlinker: false,
    rightBlinker: false,
    brake: false,
    autopilot: null,
    latitude: null,
    longitude: null,
    heading: null,
    accelerationX: null,
    accelerationY: null,
    accelerationZ: null,
  }

  const varint = (): number | null => {
    let result = 0
    let shift = 0
    while (cursor < data.length && shift <= 63) {
      const byte = data[cursor++]
      result += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return result
      shift += 7
    }
    return null
  }

  while (cursor < data.length) {
    const tag = varint()
    if (tag === null) break
    const field = Math.floor(tag / 8)
    const wire = tag & 7
    let value: number | null = null
    if (wire === 0) value = varint()
    else if (wire === 5 && cursor + 4 <= data.length) {
      value = view.getFloat32(cursor, true)
      cursor += 4
    } else if (wire === 1 && cursor + 8 <= data.length) {
      value = view.getFloat64(cursor, true)
      cursor += 8
    } else if (wire === 2) {
      const length = varint()
      if (length === null || cursor + length > data.length) break
      cursor += length
      continue
    } else break
    if (value === null) break
    if (field === 2) raw.gearState = value
    else if (field === 3) raw.frameSeq = value
    else if (field === 4) raw.speedMps = value
    else if (field === 5) raw.accelerator = value
    else if (field === 6) raw.steering = value
    else if (field === 7) raw.leftBlinker = value !== 0
    else if (field === 8) raw.rightBlinker = value !== 0
    else if (field === 9) raw.brake = value !== 0
    else if (field === 10) raw.autopilot = value
    else if (field === 11) raw.latitude = value
    else if (field === 12) raw.longitude = value
    else if (field === 13) raw.heading = value
    else if (field === 14) raw.accelerationX = value
    else if (field === 15) raw.accelerationY = value
    else if (field === 16) raw.accelerationZ = value
  }
  return raw.frameSeq !== null || raw.speedMps !== null ? raw : null
}

function decodeSeiNal(nal: Uint8Array): RawSei | null {
  if (!nal.length || (nal[0] & 0x1f) !== 6) return null
  const bytes = removeEmulationBytes(nal.subarray(1))
  let marker = -1
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0x42 && bytes[index + 1] === 0x42 && bytes[index + 2] === 0x42 && bytes[index + 3] === 0x69) {
      marker = index + 4
      break
    }
  }
  if (marker < 0) return null
  let protobuf = marker
  while (protobuf < bytes.length && bytes[protobuf] !== 0x08) protobuf += 1
  return protobuf < bytes.length ? decodeProtobuf(bytes.subarray(protobuf)) : null
}

function toSample(raw: RawSei, timeSec: number, clip: string): TelemetrySample {
  return {
    timeSec,
    speedKph: raw.speedMps === null ? null : raw.speedMps * 3.6,
    steeringDeg: raw.steering,
    acceleratorPct: raw.accelerator === null ? null : raw.accelerator * 100,
    brakeApplied: raw.brake,
    autopilotState: raw.autopilot,
    blinkerLeft: raw.leftBlinker,
    blinkerRight: raw.rightBlinker,
    gearState: raw.gearState,
    headingDeg: raw.heading,
    latitude: raw.latitude,
    longitude: raw.longitude,
    accelerationX: raw.accelerationX,
    accelerationY: raw.accelerationY,
    accelerationZ: raw.accelerationZ,
    clip,
  }
}

export async function extractTelemetryFromVideo(file: File): Promise<TelemetryTrack> {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const durations = frameDurations(view)
  const mdat = findBox(view, 0, view.byteLength, 'mdat')
  const samples: TelemetrySample[] = []
  let pending: RawSei | null = null
  let frameIndex = 0
  let timeSec = 0
  for (let cursor = mdat.start; cursor + 4 <= mdat.end;) {
    const size = view.getUint32(cursor)
    cursor += 4
    if (size < 1 || cursor + size > mdat.end) break
    const nal = new Uint8Array(buffer, cursor, size)
    const type = nal[0] & 0x1f
    if (type === 6) pending = decodeSeiNal(nal)
    else if (type === 1 || type === 5) {
      if (pending) samples.push(toSample(pending, timeSec, file.name))
      timeSec += durations[frameIndex] ?? 1 / 36
      frameIndex += 1
      pending = null
    }
    cursor += size
  }
  return { source: 'sei', samples, fps: timeSec > 0 ? frameIndex / timeSec : 36 }
}
