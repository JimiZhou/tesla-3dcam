import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Grid, Html, Line, OrbitControls, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import type { BevObject, BevSceneFrame, BevLaneState, EvidenceSelection, TelemetrySample, ViewPreset } from '../types'
import { isDisplayableObject, reprojectPoint, useBevScene } from '../utils/bevScene'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import ThreeCanvasA11y from './ThreeCanvasA11y'
import { GenericRoadVehicle, TeslaEgoModel } from './VehicleModels'

interface BevViewProps {
  time: number
  telemetry: TelemetrySample
  preset: ViewPreset
  reconstructionUrl?: string
  bevManifestUrl?: string
  bevTimelineUrl?: string
  reconstructionState?: 'idle' | 'queued' | 'building' | 'ready' | 'error'
  reconstructionMessage?: string
  hasImportedFootage: boolean
  onSeek?: (time: number) => void
  onInspect?: (evidence: EvidenceSelection) => void
}

interface PointCloudProps {
  url: string
}

interface BevLayerFlags {
  lanes: boolean
  objects: boolean
  trails: boolean
  labels: boolean
  uncertainty: boolean
  grid: boolean
}

type ObjectTrails = Record<string, Array<[number, number, number]>>

const BEV_SCENE_COLORS = {
  background: '#eceeec',
  roadSurface: '#d0d4d3',
  laneLine: '#ffffff',
  pathNear: '#4a9bf5',
  pathFar: '#1f62c9',
  object: '#718f91',
  tracked: '#688e82',
  coasting: '#d98954',
  selected: '#db553a',
  warning: '#d95036',
  gridCell: '#c9ceca',
  gridSection: '#aeb6b0',
  evidence: '#c6a88d',
  trail: '#608f82',
  light: '#ffffff',
} as const
const BACKGROUND = BEV_SCENE_COLORS.background
const ROAD_SURFACE = BEV_SCENE_COLORS.roadSurface
const LANE_LINE = BEV_SCENE_COLORS.laneLine
const KIND_LABEL: Record<BevObject['kind'], string> = {
  vehicle: '车辆',
  truck: '卡车',
  bus: '巴士',
  pedestrian: '行人',
  cyclist: '骑行者',
  motorcycle: '摩托车',
  unknown: '待分类',
}

function parsePly(text: string): THREE.BufferGeometry | null {
  const headerEnd = text.indexOf('end_header')
  if (headerEnd < 0) return null
  const header = text.slice(0, headerEnd).split(/\r?\n/)
  const vertexLine = header.find((line) => line.startsWith('element vertex '))
  const count = vertexLine ? Number(vertexLine.split(' ')[2]) : 0
  if (!Number.isFinite(count) || count <= 0) return null

  const positions: number[] = []
  const colors: number[] = []
  const rows = text.slice(headerEnd + 'end_header'.length).trim().split(/\r?\n/)
  for (const row of rows.slice(0, count)) {
    const values = row.trim().split(/\s+/).map(Number)
    if (values.length < 6 || values.slice(0, 6).some((value) => !Number.isFinite(value))) continue
    // The reconstruction script writes vehicle-frame x/y/z. BEV keeps x/z and
    // flattens the height so sparse geometry can be read from a top-down view.
    positions.push(values[0], 0.08, values[2])
    colors.push(values[3] / 255, values[4] / 255, values[5] / 255)
  }
  if (!positions.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}

function SparseBevPoints({ url }: PointCloudProps) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)

  useEffect(() => {
    let alive = true
    let created: THREE.BufferGeometry | null = null
    setGeometry(null)
    void fetch(url)
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(`PLY ${response.status}`)))
      .then((text) => {
        created = parsePly(text)
        if (alive) setGeometry(created)
      })
      .catch(() => {
        if (alive) setGeometry(null)
      })
    return () => {
      alive = false
      created?.dispose()
    }
  }, [url])

  if (!geometry) return null
  return (
    <points geometry={geometry} renderOrder={3}>
      <pointsMaterial vertexColors size={0.18} sizeAttenuation transparent opacity={0.82} depthWrite={false} />
    </points>
  )
}

/** Blue gradient driving-path ribbon in the Tesla visualization style. */

function laneXAt(lane: Array<[number, number]>, z: number): number | null {
  if (lane.length < 2) return null
  const first = lane[0]
  const last = lane[lane.length - 1]
  if (z <= first[1]) return first[0]
  if (z >= last[1]) return last[0]
  for (let index = 1; index < lane.length; index += 1) {
    const [x0, z0] = lane[index - 1]
    const [x1, z1] = lane[index]
    if (z >= z0 && z <= z1) {
      const mix = z1 - z0 < 1e-6 ? 0 : (z - z0) / (z1 - z0)
      return THREE.MathUtils.lerp(x0, x1, mix)
    }
  }
  return last[0]
}

/**
 * Road surface derived from the detected lane polylines: a slightly darker
 * band spanning the outermost lanes, so the scene reads as pavement instead of
 * an infinite grid.
 */
function DetectedRoad({ lanes }: { lanes: Array<Array<[number, number]>> }) {
  const surface = useMemo(() => {
    const sorted = [...lanes].filter((lane) => lane.length >= 2)
    if (sorted.length < 2) return null
    const traced = Math.min(...sorted.map((lane) => lane[0][1]))
    const zMax = Math.min(...sorted.map((lane) => lane[lane.length - 1][1]))
    if (zMax - traced < 4) return null
    // Shade only the shared observed support of the boundary lines.
    const zMin = Math.max(...sorted.map((lane) => lane[0][1]))
    const positions: number[] = []
    const indices: number[] = []
    const steps = 26
    for (let index = 0; index <= steps; index += 1) {
      const z = zMin + ((zMax - zMin) * index) / steps
      const xs = sorted.map((lane) => laneXAt(lane, z)).filter((value): value is number => value !== null)
      if (!xs.length) continue
      const left = Math.min(...xs) - 0.55
      const right = Math.max(...xs) + 0.55
      positions.push(left, 0.02, -z, right, 0.02, -z)
      if (index < steps) {
        const offset = index * 2
        indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3)
      }
    }
    if (!positions.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    return geometry
  }, [lanes])

  useEffect(() => () => surface?.dispose(), [surface])

  if (!surface) return null
  return (
    <mesh geometry={surface} renderOrder={1}>
      <meshBasicMaterial color={ROAD_SURFACE} transparent opacity={0.92} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

function DetectedLanes({ lanes, states }: { lanes: Array<Array<[number, number]>>; states?: BevLaneState[] }) {
  return (
    <group>
      <DetectedRoad lanes={lanes} />
      {lanes.map((lane, index) => {
        const state = states?.[index]
        const range = state?.observedRange
        // A solid line denotes current observation; history/prediction is dashed.
        const observed = state && !state.predicted && range
          ? lane.filter((point) => point[1] >= range[0] && point[1] <= range[1]) : []
        return <group key={index}>
          <Line points={lane.map(([x, z]) => [x, 0.075, -z] as [number, number, number])}
            color={state?.predicted ? BEV_SCENE_COLORS.coasting : LANE_LINE}
            lineWidth={2} dashed dashSize={0.6} gapSize={0.45} transparent opacity={0.48} />
          {observed.length >= 2 && <Line
            points={observed.map(([x, z]) => [x, 0.078, -z] as [number, number, number])}
            color={LANE_LINE} lineWidth={2.6} />}
        </group>
      })}
    </group>
  )
}

function EgoVehicle({ steeringDeg }: { steeringDeg: number }) {
  return (
    <group>
      <TeslaEgoModel steeringDeg={steeringDeg} />
    </group>
  )
}

/**
 * Renders one tracked road user with critically-damped motion toward the
 * interpolated target, which removes residual 1 Hz stepping from the timeline.
 */
function SemanticObject({
  object,
  selected,
  showLabel,
  showUncertainty,
  onSelect,
}: {
  object: BevObject
  selected: boolean
  showLabel: boolean
  showUncertainty: boolean
  onSelect: (id: string) => void
}) {
  // Scene transforms are a pure function of the playhead. Render-time damping
  // made pause/seek/reverse produce different positions at the same timestamp.
  const isPerson = object.kind === 'pedestrian' || object.kind === 'cyclist' || object.kind === 'motorcycle'
  const fade = (object.coasting ? 0.55 : 1) * (object.displayOpacity ?? 1)
  const distance = Math.hypot(object.x, object.z)
  const speed = Math.hypot(object.vx ?? 0, object.vz ?? 0) * 3.6
  const uncertainty = THREE.MathUtils.clamp(object.positionStdM ?? 0.6, 0.35, 5)
  const labelVisible = showLabel && (selected || distance < 44)

  return (
    <group
      position={[object.x, 0, -object.z]}
      rotation={[0, -object.heading, 0]}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(object.id)
      }}
    >
      {isPerson ? (
        <mesh position={[0, 0.82, 0]} castShadow>
          <capsuleGeometry args={[object.kind === 'pedestrian' ? 0.16 : 0.22, 0.82, 5, 10]} />
          <meshStandardMaterial color={BEV_SCENE_COLORS.object} roughness={0.78} transparent opacity={fade} />
        </mesh>
      ) : (
        <GenericRoadVehicle
          width={object.width}
          length={object.length}
          kind={object.kind === 'truck' || object.kind === 'bus' || object.kind === 'unknown' ? object.kind : 'vehicle'}
          opacity={fade}
        />
      )}

      {showUncertainty && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.055, 0]} renderOrder={5}>
          <ringGeometry args={[Math.max(0.1, uncertainty - 0.08), uncertainty, 48]} />
          <meshBasicMaterial
            color={object.coasting ? BEV_SCENE_COLORS.coasting : selected ? BEV_SCENE_COLORS.selected : BEV_SCENE_COLORS.tracked}
            transparent
            opacity={selected ? 0.8 : 0.38}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.065, 0]} renderOrder={6}>
          <ringGeometry args={[Math.max(object.width, 1.2) * 0.72, Math.max(object.width, 1.2) * 0.79, 48]} />
          <meshBasicMaterial color={BEV_SCENE_COLORS.warning} transparent opacity={0.9} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {labelVisible && (
        <Html
          position={[0, isPerson ? 2.05 : object.kind === 'truck' || object.kind === 'bus' ? 2.5 : 1.85, 0]}
          center
          distanceFactor={13}
          zIndexRange={[20, 8]}
          style={{ pointerEvents: 'none' }}
        >
          <div className={`bev-object-label ${selected ? 'selected' : ''}`}>
            <span>{object.id.replace('track-', '#')}</span>
            <strong>{KIND_LABEL[object.kind]} · {distance.toFixed(1)} m</strong>
            <small>{Math.round(object.confidence * 100)}% 检测分数 · {speed.toFixed(0)} km/h</small>
          </div>
        </Html>
      )}
    </group>
  )
}

function SceneGuides() {
  const guideRays = [-138, -92, 0, 92, 138, 180]
  return (
    <group>
      <Grid
        position={[0, -0.045, -8]}
        args={[100, 100]}
        cellSize={2}
        cellThickness={0.5}
        cellColor={BEV_SCENE_COLORS.gridCell}
        sectionSize={10}
        sectionThickness={0.8}
        sectionColor={BEV_SCENE_COLORS.gridSection}
        fadeDistance={72}
        fadeStrength={1.1}
        infiniteGrid
      />
      {guideRays.map((yaw) => {
        const angle = THREE.MathUtils.degToRad(yaw)
        return (
          <Line
            key={yaw}
            points={[[0, 0.015, 0], [Math.sin(angle) * 9, 0.015, -Math.cos(angle) * 9]]}
            color={BEV_SCENE_COLORS.evidence}
            lineWidth={0.65}
            transparent
            opacity={0.42}
          />
        )
      })}
    </group>
  )
}

function TrackTrails({ trails, selectedId }: { trails: ObjectTrails; selectedId: string | null }) {
  return (
    <group>
      {Object.entries(trails).map(([id, points]) => points.length > 1 ? (
        <Line
          key={id}
          points={points}
          color={selectedId === id ? BEV_SCENE_COLORS.warning : BEV_SCENE_COLORS.trail}
          lineWidth={selectedId === id ? 2.8 : 1.35}
          transparent
          opacity={selectedId === id ? 0.95 : 0.58}
          dashed={selectedId !== id}
          dashSize={0.45}
          gapSize={0.3}
        />
      ) : null)}
    </group>
  )
}

function GroundEvidence({ url }: { url: string }) {
  const texture = useTexture(url)
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    texture.needsUpdate = true
  }, [texture])
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, -3]} renderOrder={1}>
      <planeGeometry args={[72, 72]} />
      <meshBasicMaterial map={texture} transparent opacity={0.86} toneMapped={false} />
    </mesh>
  )
}

function BevCameraRig({ preset }: { preset: ViewPreset }) {
  const controls = useRef<OrbitControlsImpl>(null)
  const { camera } = useThree()
  useEffect(() => {
    const poses: Record<ViewPreset, { position: [number, number, number]; target: [number, number, number] }> = {
      orbit: { position: [13, 17, 15], target: [0, 0, 0] },
      // Tesla-style default: slightly behind and above, looking down the road.
      top: { position: [0, 64, 12], target: [0, 0, -6] },
      chase: { position: [0, 8.8, 13], target: [0, 0, -5] },
      driver: { position: [0, 3.2, 4.2], target: [0, 0.5, -9] },
    }
    const pose = poses[preset]
    camera.up.set(0, 1, 0)
    camera.position.set(...pose.position)
    controls.current?.target.set(...pose.target)
    controls.current?.update()
  }, [camera, preset])
  useFrame(() => controls.current?.update())
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={4}
      maxDistance={150}
      maxPolarAngle={Math.PI / 2.02}
    />
  )
}

function BevScene({
  telemetry,
  reconstructionUrl,
  preset,
  frame,
  evidenceUrl,
  renderMode,
  layers,
  trails,
  selectedId,
  onSelect,
}: Omit<BevViewProps, 'time' | 'hasImportedFootage' | 'bevManifestUrl' | 'bevTimelineUrl' | 'reconstructionState' | 'reconstructionMessage' | 'onSeek' | 'onInspect'> & {
  frame: BevSceneFrame | null
  evidenceUrl?: string
  renderMode: 'semantic' | 'evidence'
  layers: BevLayerFlags
  trails: ObjectTrails
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const hasSemantic = Boolean(frame?.objects.length || frame?.lanes.length)
  const canvasWidth = useThree((state) => state.size.width)
  const labelBudget = canvasWidth < 620 ? 3 : canvasWidth < 1200 ? 6 : 10
  const labelIds = useMemo(() => {
    const ranked = [...(frame?.objects.filter(isDisplayableObject) ?? [])]
      .sort((first, second) => {
        if (first.id === selectedId) return -1
        if (second.id === selectedId) return 1
        const score = (object: BevObject) => {
          const distance = Math.hypot(object.x, object.z)
          const vulnerablePriority = ['pedestrian', 'cyclist', 'motorcycle'].includes(object.kind) ? 8 : 0
          const rearPenalty = object.z < 0 ? 6 : 0
          return distance + rearPenalty - vulnerablePriority - object.confidence * 4
        }
        return score(first) - score(second)
      })
      .slice(0, labelBudget)
    return new Set(ranked.map((object) => object.id))
  }, [frame?.objects, labelBudget, selectedId])

  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 46, 120]} />
      <ambientLight intensity={1.6} color={BEV_SCENE_COLORS.light} />
      <directionalLight position={[8, 18, 10]} intensity={1.9} color={BEV_SCENE_COLORS.light} castShadow />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]} receiveShadow onClick={() => onSelect(null)}>
        <planeGeometry args={[240, 240]} />
        <meshStandardMaterial color={BACKGROUND} roughness={0.95} />
      </mesh>
      {layers.grid && <SceneGuides />}
      {renderMode === 'evidence' && evidenceUrl && <GroundEvidence url={evidenceUrl} />}
      {layers.lanes && Boolean(frame?.lanes.length) && <DetectedLanes lanes={frame!.lanes} states={frame!.laneStates} />}
      {renderMode === 'semantic' && !hasSemantic && reconstructionUrl && <SparseBevPoints url={reconstructionUrl} />}
      {layers.trails && <TrackTrails trails={trails} selectedId={selectedId} />}
      {layers.objects && frame?.objects.filter(isDisplayableObject).map((object) => (
        <SemanticObject
          key={object.id}
          object={object}
          selected={selectedId === object.id}
          showLabel={layers.labels && labelIds.has(object.id)}
          showUncertainty={layers.uncertainty}
          onSelect={(id) => onSelect(id)}
        />
      ))}
      <EgoVehicle steeringDeg={telemetry.steeringDeg ?? 0} />
      <ContactShadows position={[0, 0.02, 0]} opacity={0.22} scale={11} blur={2.6} far={16} />
      <BevCameraRig preset={preset} />
    </>
  )
}

export default function BevView({
  onInspect,
  time,
  telemetry,
  preset,
  reconstructionUrl,
  bevManifestUrl,
  bevTimelineUrl,
  reconstructionState,
  reconstructionMessage,
  hasImportedFootage,
  onSeek,
}: BevViewProps) {
  const [renderMode, setRenderMode] = useState<'semantic' | 'evidence'>('semantic')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileInsightsOpen, setMobileInsightsOpen] = useState(false)
  const [layers, setLayers] = useState<BevLayerFlags>({
    lanes: true,
    objects: true,
    trails: true,
    labels: true,
    uncertainty: true,
    grid: true,
  })
  const { manifest, snapshot, frame, evidenceUrl } = useBevScene(bevManifestUrl, bevTimelineUrl, time)
  const visibleObjects = useMemo(() => frame?.objects.filter(isDisplayableObject) ?? [], [frame])
  const objectCount = visibleObjects.length
  const laneCount = frame?.lanes.length ?? 0
  const trails = useMemo<ObjectTrails>(() => {
    if (!manifest?.frames?.length || !frame?.egoPose) return {}
    const result: ObjectTrails = {}
    manifest.frames
      .filter((item) => item.timeSec <= time && item.timeSec >= time - 6)
      .forEach((item) => item.objects.filter(isDisplayableObject).forEach((object) => {
        const points = result[object.id] ?? []
        if (!item.egoPose) return
        const [x, z] = reprojectPoint(object.x, object.z, item.egoPose, frame.egoPose!)
        points.push([x, 0.085, -z])
        result[object.id] = points
      }))
    return result
  }, [manifest, time, frame?.egoPose])
  const selectedObject = visibleObjects.find((object) => object.id === selectedId) ?? null
  const nearestObject = visibleObjects.reduce<BevObject | null>((nearest, object) => (
    !nearest || Math.hypot(object.x, object.z) < Math.hypot(nearest.x, nearest.z) ? object : nearest
  ), null)
  const averageConfidence = objectCount
    ? visibleObjects.reduce((total, object) => total + object.confidence, 0) / objectCount
    : 0
  const vulnerableCount = visibleObjects.filter((object) => ['pedestrian', 'cyclist', 'motorcycle'].includes(object.kind)).length

  useEffect(() => {
    if (selectedId && !visibleObjects.some((object) => object.id === selectedId)) setSelectedId(null)
  }, [selectedId, visibleObjects])

  const toggleLayer = (key: keyof BevLayerFlags) => {
    setLayers((current) => ({ ...current, [key]: !current[key] }))
  }

  return (
    <div className="bev-canvas" role="region" aria-label="BEV 鸟瞰融合视图">
      <Canvas style={{ position: 'absolute', top: 64, bottom: 202, height: 'auto' }} shadows dpr={[1, 1.65]} camera={{ fov: 42, near: 0.1, far: 220 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <ThreeCanvasA11y label={`BEV 三维鸟瞰融合，当前显示 ${objectCount} 个跟踪目标和 ${laneCount} 条车道；距离为视频估计尺度。`} />
        <BevScene
          telemetry={telemetry}
          preset={preset}
          reconstructionUrl={reconstructionUrl}
          frame={frame}
          evidenceUrl={evidenceUrl}
          renderMode={renderMode}
          layers={layers}
          trails={trails}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </Canvas>
      <div className="bev-overlay bev-overlay-top">
        <div className="bev-title"><span>BEV</span><strong>车辆坐标系鸟瞰</strong></div>
        <div className="bev-legend"><i className="legend-geometry" />真实检测 {objectCount} <i className="legend-reference" />车道 {laneCount}</div>
      </div>
      <div className="bev-layer-switch" role="group" aria-label="BEV 图层">
        <button aria-pressed={renderMode === 'semantic'} className={renderMode === 'semantic' ? 'active' : ''} onClick={() => setRenderMode('semantic')}>语义</button>
        <button
          aria-pressed={renderMode === 'evidence'}
          className={renderMode === 'evidence' ? 'active' : ''}
          onClick={() => {
            setRenderMode('evidence')
            if (snapshot?.timeSec !== undefined) onSeek?.(snapshot.timeSec)
          }}
          disabled={!evidenceUrl}
        >六路纹理</button>
      </div>
      <div className="bev-layer-toolbar" role="group" aria-label="感知显示图层">
        {([
          ['objects', '目标'],
          ['lanes', '车道'],
          ['trails', '轨迹'],
          ['uncertainty', '不确定性'],
          ['labels', '标签'],
          ['grid', '标尺'],
        ] as Array<[keyof BevLayerFlags, string]>).map(([key, label]) => (
          <button key={key} aria-pressed={layers[key]} className={layers[key] ? 'active' : ''} onClick={() => toggleLayer(key)}>
            <i />{label}
          </button>
        ))}
      </div>

      <button
        className="bev-mobile-insight-toggle"
        type="button"
        aria-expanded={mobileInsightsOpen}
        aria-controls="bev-insight-panel"
        onClick={() => setMobileInsightsOpen((open) => !open)}
      >
        识别 {objectCount} · 检测 {objectCount ? Math.round(averageConfidence * 100) : '—'}%
      </button>

      <aside id="bev-insight-panel" className={`bev-insight-panel ${mobileInsightsOpen ? 'mobile-open' : ''}`} aria-label="BEV 识别统计">
        <div className="bev-insight-heading"><span>PERCEPTION</span><strong>识别与跟踪</strong><i className={frame ? 'ready' : ''} /></div>
        {selectedObject ? (
          <div className="bev-selected-object">
            <span>已选目标 {selectedObject.id.replace('track-', '#')}</span>
            <strong>{KIND_LABEL[selectedObject.kind]} · {Math.hypot(selectedObject.x, selectedObject.z).toFixed(1)} m</strong>
            <small>
              {Math.round(selectedObject.confidence * 100)}% 检测分数 · 滤波 σ {(selectedObject.positionStdM ?? 0).toFixed(1)} m · {selectedObject.rangeSource === 'moge2' ? 'MoGe-2' : '射线估距'}
            </small>
            <small>尺寸使用类别先验；σ 不包含全部标定误差。</small>
            {selectedObject.observations?.map((observation, index) => <button
              className="bev-evidence-button" key={index} disabled={!hasImportedFootage || !onInspect}
              onClick={() => onInspect?.({ trackId: selectedObject.id, observation })}>
              查看 {observation.camera} · {observation.timeSec.toFixed(2)}s 原画面
            </button>)}
          </div>
        ) : <p>点击目标查看估计中心距离与来源。实线为当前观测，虚线为历史或预测；未观测区域留空。</p>}
        <dl className="bev-stat-grid">
          <div><dt>稳定目标</dt><dd>{objectCount}<small>个</small></dd></div>
          <div><dt>平均检测分数</dt><dd>{objectCount ? Math.round(averageConfidence * 100) : '—'}<small>%</small></dd></div>
          <div><dt>最近目标</dt><dd>{nearestObject ? Math.hypot(nearestObject.x, nearestObject.z).toFixed(1) : '—'}<small>m</small></dd></div>
          <div><dt>弱势交通</dt><dd>{vulnerableCount}<small>个</small></dd></div>
        </dl>
        <div className="bev-quality-row">
          <span><i className={manifest?.qualityGate?.passed ? 'pass' : ''} />结构检查</span>
          <strong>{manifest?.qualityGate ? (manifest.qualityGate.passed ? '通过 · 精度待核对' : '需复核') : '等待结果'}</strong>
        </div>
        <div className="bev-quality-row">
          <span><i className={manifest?.egoMotionCompensated ? 'pass' : ''} />自车运动补偿</span>
          <strong>{manifest?.egoMotionCompensated ? 'SEI 已融合' : '未启用'}</strong>
        </div>

      </aside>
      <div className="bev-overlay bev-overlay-bottom">
        <span className="bev-source-dot" />
        <span>{hasImportedFootage ? (frame ? '六路时间对齐 · 估计目标与车道' : manifest ? '此时刻没有场景数据' : reconstructionMessage || '六路视频已同步 · 等待语义重建') : '演示模式 · 非真实测量'}</span>
        <small>{frame ? `${renderMode === 'evidence' && snapshot?.timeSec !== undefined ? `${snapshot.timeSec.toFixed(1)}s 证据帧` : `${frame.timeSec.toFixed(1)}s`} · ${objectCount} 个目标 · ${laneCount} 条车道` : reconstructionState === 'error' ? '请查看右上角错误信息' : (frame === null && manifest ? '此时刻没有场景数据' : '自动重建进行中')}</small>
      </div>
      <div className="bev-fidelity-note">
        <span>{frame ? 'SIX-CAMERA PERCEPTION' : manifest ? 'NO SCENE DATA AT THIS TIME' : reconstructionState === 'error' ? 'RECONSTRUCTION ERROR' : 'RECONSTRUCTION PIPELINE'}</span>
        <strong>{frame ? `${manifest?.calibrated ? '视频估计标定 · 非工厂参数' : '种子标定 · 近似尺度'} · MoGe-2 米制深度 · Kalman 跨镜跟踪` : manifest ? '当前时间不在已重建区间，请查看右上角区间信息' : (reconstructionUrl ? '实际视频稀疏点云' : reconstructionState === 'error' ? '源视频定位、深度估计或质量门失败' : '正在生成检测与米制深度')}</strong>
      </div>
    </div>
  )
}
