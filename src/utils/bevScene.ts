import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { BevObject, BevSceneFrame, BevSceneManifest, EgoPose } from '../types'

/** Keep only tracks whose confidence and uncertainty support a visible object. */
export function isDisplayableObject(object: BevObject): boolean {
  const distance = Math.hypot(object.x, object.z)
  const vulnerable = ['pedestrian', 'cyclist', 'motorcycle'].includes(object.kind)
  const minimumConfidence = (vulnerable ? 0.29 : 0.34) + (distance >= 45 ? 0.08 : 0)
  if (distance < 1.4 || distance > 90 || object.confidence < minimumConfidence) return false
  if ((object.positionStdM ?? 0) > 5) return false
  if ((object.displayOpacity ?? 1) < 0.5) return false
  return !object.coasting || object.confidence >= 0.4
}

export function shortestAngleLerp(from: number, to: number, mix: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + difference * mix
}

function interpolateObjects(before: BevSceneFrame, after: BevSceneFrame, time: number): BevObject[] {
  const span = after.timeSec - before.timeSec
  const mix = span <= 1e-6 ? 0 : THREE.MathUtils.clamp((time - before.timeSec) / span, 0, 1)
  const afterById = new Map(after.objects.map((object) => [object.id, object]))
  const objects: BevObject[] = []
  for (const object of before.objects) {
    const next = afterById.get(object.id)
    if (!next) {
      // Do not render outgoing and incoming unmatched IDs at the same time: a
      // fragmented track would otherwise be counted twice between two frames.
      if (mix >= 0.5) continue
      objects.push({
        ...object,
        // Hold the last relative position during the brief fade. vx/vz are
        // world velocity in ego axes, not derivatives of relative position.
        displayOpacity: 1 - mix,
      })
      continue
    }
    objects.push({
      ...object,
      x: THREE.MathUtils.lerp(object.x, next.x, mix),
      z: THREE.MathUtils.lerp(object.z, next.z, mix),
      width: THREE.MathUtils.lerp(object.width, next.width, mix),
      length: THREE.MathUtils.lerp(object.length, next.length, mix),
      heading: shortestAngleLerp(object.heading, next.heading, mix),
      confidence: THREE.MathUtils.lerp(object.confidence, next.confidence, mix),
      coasting: mix < 0.5 ? object.coasting : next.coasting,
      displayOpacity: 1,
    })
  }
  if (mix >= 0.5) {
    const existing = new Set(objects.map((object) => object.id))
    objects.push(...after.objects
      .filter((object) => !existing.has(object.id))
      .map((object) => ({ ...object, displayOpacity: mix })))
  }
  return objects
}

/** Transport a historical ego-frame point into the current ego frame. */
export function reprojectPoint(x: number, z: number, from: EgoPose, to: EgoPose): [number, number] {
  const wx = from.x + Math.cos(from.yaw) * x + Math.sin(from.yaw) * z
  const wz = from.z - Math.sin(from.yaw) * x + Math.cos(from.yaw) * z
  const dx = wx - to.x
  const dz = wz - to.z
  return [Math.cos(to.yaw) * dx - Math.sin(to.yaw) * dz, Math.sin(to.yaw) * dx + Math.cos(to.yaw) * dz]
}

function interpolateLanes(before: BevSceneFrame, after: BevSceneFrame, mix: number): Array<Array<[number, number]>> {
  const source = mix < 0.5 ? before : after
  const other = mix < 0.5 ? after : before
  // Old artifacts have no lane identity; never interpolate unrelated lines by index.
  if (!source.laneIds || !other.laneIds) return source.lanes
  return source.lanes.map((lane, index) => {
    const pairIndex = other.laneIds!.indexOf(source.laneIds![index])
    const pair = other.lanes[pairIndex]
    if (!pair || pair.length !== lane.length) return lane
    const weight = mix < 0.5 ? mix : 1 - mix
    return lane.map((point, pointIndex) => [
      THREE.MathUtils.lerp(point[0], pair[pointIndex][0], weight),
      THREE.MathUtils.lerp(point[1], pair[pointIndex][1], weight),
    ] as [number, number])
  })
}

export function nearestFrame(manifest: BevSceneManifest | null, time: number): BevSceneFrame | null {
  if (!manifest) return null
  if (manifest.frames?.length) {
    const frames = manifest.frames
    if (time < frames[0].timeSec || time > frames[frames.length - 1].timeSec + (manifest.stepSec ?? 1)) return null
    const before = [...frames].reverse().find((frame) => frame.timeSec <= time) ?? frames[0]
    const after = frames.find((frame) => frame.timeSec >= time) ?? frames[frames.length - 1]
    if (before === after || after.timeSec <= before.timeSec) return before
    const mix = THREE.MathUtils.clamp((time - before.timeSec) / (after.timeSec - before.timeSec), 0, 1)
    const pose = before.egoPose && after.egoPose ? {
      x: THREE.MathUtils.lerp(before.egoPose.x, after.egoPose.x, mix),
      z: THREE.MathUtils.lerp(before.egoPose.z, after.egoPose.z, mix),
      yaw: shortestAngleLerp(before.egoPose.yaw, after.egoPose.yaw, mix),
    } : undefined
    const source = mix < 0.5 ? before : after
    return {
      egoPose: pose,
      laneIds: source.laneIds,
      laneStates: source.laneStates,
      velocityFrame: source.velocityFrame,
      timeSec: time,
      objects: interpolateObjects(before, after, time),
      lanes: interpolateLanes(before, after, mix),
    }
  }
  if (manifest.objects || manifest.lanes) {
    return {
      timeSec: manifest.timeSec ?? 0,
      objects: manifest.objects ?? [],
      lanes: manifest.lanes ?? [],
    }
  }
  return null
}

export function assetUrl(manifestUrl: string | undefined, asset: string | undefined): string | undefined {
  if (!manifestUrl || !asset) return undefined
  return new URL(asset, new URL(manifestUrl, window.location.href)).toString()
}

function useManifest(url: string | undefined): BevSceneManifest | null {
  const [loaded, setLoaded] = useState<{ url: string; manifest: BevSceneManifest } | null>(null)
  useEffect(() => {
    let alive = true
    if (!url) {
      setLoaded(null)
      return () => { alive = false }
    }
    void fetch(url)
      .then((response) => response.ok ? response.json() as Promise<BevSceneManifest> : Promise.reject(new Error(`BEV ${response.status}`)))
      .then((result) => { if (alive) setLoaded({ url, manifest: result }) })
      .catch(() => { if (alive) setLoaded(null) })
    return () => { alive = false }
  }, [url])
  return loaded && loaded.url === url ? loaded.manifest : null
}

/**
 * Loads the reconstructed BEV track and resolves it to the playhead. The
 * timeline remains the single source of truth for detected road users and
 * lane geometry.
 */
export function useBevScene(manifestUrl: string | undefined, timelineUrl: string | undefined, time: number) {
  const snapshot = useManifest(manifestUrl)
  const timeline = useManifest(timelineUrl)
  const manifest = timeline ?? snapshot
  const frame = useMemo(() => nearestFrame(manifest, time), [manifest, time])
  return {
    manifest,
    snapshot,
    frame,
    evidenceUrl: assetUrl(manifestUrl, snapshot?.texture),
  }
}
