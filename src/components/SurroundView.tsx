import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Eye, Rotate3D, ZoomIn, ZoomOut } from 'lucide-react'
import * as THREE from 'three'
import { CAMERA_META, CAMERA_ORDER, type CameraId } from '../types'
import ThreeCanvasA11y from './ThreeCanvasA11y'

interface SurroundViewProps {
  videos: Partial<Record<CameraId, HTMLVideoElement>>
  hasImportedFootage: boolean
}

interface CameraSector {
  id: CameraId
  yawDeg: number
  fovDeg: number
}

// Footage-derived horizontal FOV estimates. They define only where recorded
// pixels exist; uncovered angles intentionally remain empty.
const CAMERA_SECTORS: CameraSector[] = [
  { id: 'front', yawDeg: 0, fovDeg: 52 },
  { id: 'rightPillar', yawDeg: 92, fovDeg: 58 },
  { id: 'right', yawDeg: 138, fovDeg: 62 },
  { id: 'rear', yawDeg: 180, fovDeg: 68 },
  { id: 'left', yawDeg: -138, fovDeg: 58 },
  { id: 'leftPillar', yawDeg: -92, fovDeg: 52 },
]

const SURROUND_SCENE_COLORS = {
  uncovered: '#171b19',
} as const

const SURROUND_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SURROUND_FRAGMENT_SHADER = `
  uniform sampler2D videoMap;
  varying vec2 vUv;
  void main() {
    vec4 video = texture2D(videoMap, vUv);
    float leftEdge = smoothstep(0.0, 0.32, vUv.x);
    float rightEdge = smoothstep(0.0, 0.32, 1.0 - vUv.x);
    float luminance = dot(video.rgb, vec3(0.2126, 0.7152, 0.0722));
    video.rgb = mix(vec3(luminance), video.rgb, 0.88) * vec3(0.985, 0.985, 0.96);
    gl_FragColor = vec4(video.rgb, leftEdge * rightEdge * 0.99);
    #include <colorspace_fragment>
  }
`

function CameraCylinderSector({ sector, video, index }: { sector: CameraSector; video: HTMLVideoElement; index: number }) {
  const texture = useMemo(() => {
    const result = new THREE.VideoTexture(video)
    result.colorSpace = THREE.SRGBColorSpace
    result.minFilter = THREE.LinearFilter
    result.magFilter = THREE.LinearFilter
    result.generateMipmaps = false
    // Cylinder UVs are viewed from inside, so flip the horizontal axis once;
    // otherwise the front view swaps the left and right sides of the road.
    result.wrapS = THREE.RepeatWrapping
    result.repeat.x = -1
    result.offset.x = 1
    // When the texture is created after the user has already scrubbed to a
    // paused frame, Chromium may not fire a new requestVideoFrameCallback.
    // Force the decoded current frame to upload on the first render.
    result.needsUpdate = true
    return result
  }, [video])
  const geometry = useMemo(() => {
    const fov = THREE.MathUtils.degToRad(sector.fovDeg)
    const center = Math.PI - THREE.MathUtils.degToRad(sector.yawDeg)
    return new THREE.CylinderGeometry(12 + index * 0.012, 12 + index * 0.012, 6.4, 48, 1, true, center - fov / 2, fov)
  }, [index, sector.fovDeg, sector.yawDeg])
  const uniforms = useMemo(() => ({ videoMap: { value: texture } }), [texture])

  useEffect(() => () => {
    texture.dispose()
    geometry.dispose()
  }, [geometry, texture])

  useEffect(() => {
    const refresh = () => { texture.needsUpdate = true }
    video.addEventListener('loadeddata', refresh)
    video.addEventListener('seeked', refresh)
    return () => {
      video.removeEventListener('loadeddata', refresh)
      video.removeEventListener('seeked', refresh)
    }
  }, [texture, video])

  return (
    <mesh geometry={geometry} renderOrder={index + 1}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={SURROUND_VERTEX_SHADER}
        fragmentShader={SURROUND_FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        depthTest={false}
        side={THREE.BackSide}
        toneMapped={false}
      />
    </mesh>
  )
}

function CenterCamera({ yaw, pitch, fov }: { yaw: number; pitch: number; fov: number }) {
  const { camera } = useThree()
  useEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera
    perspective.position.set(0, 0, 0)
    perspective.rotation.order = 'YXZ'
    perspective.rotation.set(pitch, yaw, 0)
    perspective.fov = fov
    perspective.updateProjectionMatrix()
  }, [camera, fov, pitch, yaw])
  return null
}

function SurroundScene({ videos, yaw, pitch, fov }: { videos: Partial<Record<CameraId, HTMLVideoElement>>; yaw: number; pitch: number; fov: number }) {
  return (
    <>
      <color attach="background" args={[SURROUND_SCENE_COLORS.uncovered]} />
      {CAMERA_SECTORS.map((sector, index) => {
        const video = videos[sector.id]
        return video ? <CameraCylinderSector key={sector.id} sector={sector} video={video} index={index} /> : null
      })}
      <CenterCamera yaw={yaw} pitch={pitch} fov={fov} />
    </>
  )
}

const DIRECTIONS = [
  { label: '前', yaw: 0 },
  { label: '右', yaw: -Math.PI / 2 },
  { label: '后', yaw: -Math.PI },
  { label: '左', yaw: Math.PI / 2 },
]

export default function SurroundView({ videos, hasImportedFootage }: SurroundViewProps) {
  const [yaw, setYaw] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [fov, setFov] = useState(64)
  const drag = useRef<{ pointerId: number; x: number; y: number; yaw: number; pitch: number } | null>(null)
  const cameraCount = CAMERA_ORDER.filter((camera) => videos[camera]).length

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw, pitch }
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    setYaw(start.yaw - (event.clientX - start.x) * 0.0045)
    setPitch(THREE.MathUtils.clamp(start.pitch - (event.clientY - start.y) * 0.0035, -0.55, 0.55))
  }
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    setFov((current) => THREE.MathUtils.clamp(current + event.deltaY * 0.025, 42, 86))
  }

  return (
    <div
      className="surround-view"
      role="region"
      aria-label="六路摄像头动态环视融合"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onWheel={wheel}
    >
      {cameraCount ? (
        <Canvas dpr={[1, 1.5]} camera={{ fov: 64, near: 0.1, far: 40 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
          <ThreeCanvasA11y label={`${cameraCount} 路摄像头动态柱面环视。可拖动画面观察，也可使用方向和缩放按钮。`} />
          <SurroundScene videos={videos} yaw={yaw} pitch={pitch} fov={fov} />
        </Canvas>
      ) : (
        <div className="surround-empty" role="status">
          <Eye size={28} />
          <strong>{hasImportedFootage ? '正在连接六路视频' : '导入 TeslaCam 目录后查看动态环视'}</strong>
          <span>这里只显示摄像头实际覆盖的方向</span>
        </div>
      )}

      <div className="surround-heading">
        <span>LIVE SURROUND</span>
        <strong>六路动态环视融合</strong>
        <small>{cameraCount}/6 路同步 · 重叠区域羽化 · 统一中性色调</small>
      </div>

      <div className="surround-direction" role="group" aria-label="环视方向">
        <Rotate3D size={15} />
        <button
          className="surround-zoom"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setFov((current) => Math.min(86, current + 8)) }}
          aria-label="缩小环视画面"
          title="缩小"
        ><ZoomOut size={16} /></button>
        {DIRECTIONS.map((direction) => (
          <button
            key={direction.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); setYaw(direction.yaw); setPitch(0) }}
            aria-label={`查看车辆${direction.label}方`}
          >{direction.label}</button>
        ))}
        <button
          className="surround-zoom"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setFov((current) => Math.max(42, current - 8)) }}
          aria-label="放大环视画面"
          title="放大"
        ><ZoomIn size={16} /></button>
      </div>

      <div className="surround-camera-map" aria-label="摄像头覆盖状态">
        {CAMERA_SECTORS.map((sector) => (
          <span key={sector.id} className={videos[sector.id] ? 'covered' : ''}>{CAMERA_META[sector.id].short}</span>
        ))}
      </div>

      <div className="surround-disclaimer">未覆盖区域保持空白 · 画面为柱面观察融合，不作为米制测量</div>
    </div>
  )
}
