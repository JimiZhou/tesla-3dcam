export type CameraId = 'front' | 'rear' | 'left' | 'right' | 'leftPillar' | 'rightPillar'

export interface CameraSource {
  camera: CameraId
  file: File
  url: string
  filename: string
}

export interface TeslaClipGroup {
  id: string
  label: string
  folder: string
  timestamp: Date | null
  cameras: Partial<Record<CameraId, CameraSource>>
}

export interface SceneLayers {
  splats: boolean
  tracks: boolean
  cameras: boolean
  perception: boolean
}

export interface TelemetrySample {
  timeSec: number
  speedKph: number | null
  steeringDeg: number | null
  acceleratorPct: number | null
  brakeApplied: boolean
  autopilotState: number | null
  blinkerLeft: boolean
  blinkerRight: boolean
  gearState: number | null
  headingDeg: number | null
  latitude: number | null
  longitude: number | null
  accelerationX: number | null
  accelerationY: number | null
  accelerationZ: number | null
  clip?: string
}

export interface EventMetadata {
  timestamp?: string
  city?: string
  street?: string
  est_lat?: string
  est_lon?: string
  reason?: string
}

export interface TelemetryTrack {
  source: 'demo' | 'sei' | 'sidecar'
  samples: TelemetrySample[]
  fps?: number
}

/** A calibrated camera rig is required before pixel measurements become metric. */
export interface CalibrationProfile {
  name: string
  source: 'seed' | 'user' | 'factory'
  cameraCount: number
  calibrated: boolean
  notes: string
}

export type BevObjectKind = 'vehicle' | 'truck' | 'bus' | 'pedestrian' | 'cyclist' | 'motorcycle' | 'unknown'

export interface BevObject {
  id: string
  kind: BevObjectKind
  x: number
  z: number
  /** World velocity expressed in ego axes when SEI is available; never use as relative velocity. */
  vx?: number
  vz?: number
  /** One-sigma position uncertainty reported by the Kalman tracker. */
  positionStdM?: number
  width: number
  length: number
  heading: number
  confidence: number
  source: 'detector' | 'sfm' | 'manual' | 'yolo11'
  camera?: CameraId
  cameras?: CameraId[]
  rangeSource?: 'moge2' | 'ground-ray'
  positionReference?: 'estimated-center'
  dimensionsSource?: 'class-prior'
  lastObservedSec?: number
  observations?: Array<{ camera: CameraId; timeSec: number; imageBox: [number, number, number, number]; imageSize: [number, number]; surfacePosition: [number, number]; rangeSource: string; confidence: number }>
  observationCount?: number
  imageBox?: [number, number, number, number]
  /** True while the tracker is predicting through a missed detection. */
  coasting?: boolean
  /** Frontend-only opacity used while an unmatched track enters or exits. */
  displayOpacity?: number
}

export type BevObservation = NonNullable<BevObject['observations']>[number]
export interface EvidenceSelection { trackId: string; observation: BevObservation }

export interface BevLane {
  id?: string
  points: Array<[number, number]>
  confidence?: number
  source?: string
}

export interface EgoPose { x: number; z: number; yaw: number }

export interface BevLaneState { predicted: boolean; observedRange: [number, number] | null }

export interface BevSceneFrame {
  egoPose?: EgoPose
  velocityFrame?: 'world-in-ego-axes' | 'ego-relative'
  laneIds?: string[]
  laneStates?: BevLaneState[]
  timeSec: number
  objects: BevObject[]
  lanes: Array<Array<[number, number]>>
}

export interface BevSceneManifest {
  schemaVersion: number
  clip: string
  timeSec?: number
  source: string
  calibrated: boolean
  calibration?: string
  texture?: string
  semanticPreview?: string
  objects?: BevObject[]
  lanes?: Array<Array<[number, number]>>
  frames?: BevSceneFrame[]
  stepSec?: number
  rangeBackend?: 'moge2' | 'ground-ray'
  tracker?: 'kalman-global-sei-v1' | 'kalman-road-history-v2'
  pipelineFingerprint?: string
  geometryVerified?: boolean
  egoMotionCompensated?: boolean
  qualityGate?: {
    passed: boolean
    structuralPassed?: boolean
    observationCoverage?: 'available' | 'none'
    geometryVerified?: boolean
    reasons: string[]
    warnings?: string[]
  }
}

export type ViewPreset = 'orbit' | 'top' | 'chase' | 'driver'
export type ViewerMode = 'bev' | 'mosaic' | 'surround'

export const CAMERA_META: Record<CameraId, { label: string; short: string; accent: string }> = {
  front: { label: '前视', short: 'F', accent: '#e3573f' },
  rear: { label: '后视', short: 'B', accent: '#dfa83f' },
  left: { label: '左侧', short: 'L', accent: '#7caa8c' },
  right: { label: '右侧', short: 'R', accent: '#7f9db2' },
  leftPillar: { label: '左柱', short: 'LP', accent: '#9a8ab0' },
  rightPillar: { label: '右柱', short: 'RP', accent: '#ae8b74' },
}

export const CAMERA_ORDER: CameraId[] = ['front', 'rear', 'left', 'right', 'leftPillar', 'rightPillar']
