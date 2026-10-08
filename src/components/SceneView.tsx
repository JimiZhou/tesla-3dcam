import { lazy } from 'react'
import type { CameraId, EvidenceSelection, TelemetrySample, ViewerMode, ViewPreset } from '../types'

const BevView = lazy(() => import('./BevView'))
const SurroundView = lazy(() => import('./SurroundView'))

interface SceneViewProps {
  time: number
  preset: ViewPreset
  videoElements: Partial<Record<CameraId, HTMLVideoElement>>
  hasImportedFootage: boolean
  telemetry: TelemetrySample
  mode: ViewerMode
  reconstructionUrl?: string
  bevManifestUrl?: string
  bevTimelineUrl?: string
  reconstructionState?: 'idle' | 'queued' | 'building' | 'ready' | 'error'
  reconstructionMessage?: string
  onSeek?: (time: number) => void
  onInspect?: (evidence: EvidenceSelection) => void
}

export default function SceneView(props: SceneViewProps) {
  if (props.mode === 'mosaic') {
    return <div className="mosaic-underlay" aria-hidden="true" />
  }
  if (props.mode === 'surround') {
    return <SurroundView videos={props.videoElements} hasImportedFootage={props.hasImportedFootage} />
  }
  return (
    <BevView
      time={props.time}
      telemetry={props.telemetry}
      preset={props.preset}
      reconstructionUrl={props.reconstructionUrl}
      bevManifestUrl={props.bevManifestUrl}
      bevTimelineUrl={props.bevTimelineUrl}
      reconstructionState={props.reconstructionState}
      reconstructionMessage={props.reconstructionMessage}
      hasImportedFootage={props.hasImportedFootage}
      onSeek={props.onSeek}
      onInspect={props.onInspect}
    />
  )
}
