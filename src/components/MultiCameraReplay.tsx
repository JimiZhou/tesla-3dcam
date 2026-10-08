import { useCallback, useEffect, useState } from 'react'
import { CameraOff, Grid2X2, Maximize2, Minimize2, Radio } from 'lucide-react'
import {
  CAMERA_META,
  type CameraId,
  type EvidenceSelection,
  type CameraSource,
  type TeslaClipGroup,
} from '../types'

interface MultiCameraReplayProps {
  group: TeslaClipGroup | null
  visible: boolean
  evidence?: EvidenceSelection | null
  time: number
  registerVideo: (id: CameraId, node: HTMLVideoElement | null) => void
  onMetadata: () => void
}

interface CameraFeedProps {
  id: CameraId
  evidence?: EvidenceSelection | null
  source?: CameraSource
  focused: boolean
  dimmed: boolean
  registerVideo: MultiCameraReplayProps['registerVideo']
  onMetadata: MultiCameraReplayProps['onMetadata']
  onFocus: (id: CameraId) => void
}

// Mirrors the physical camera layout: the forward and rear cameras retain more
// horizontal room, while pillar/repeater views occupy the flanks.
const MOSAIC_ORDER: CameraId[] = ['leftPillar', 'front', 'rightPillar', 'right', 'rear', 'left']

function CameraFeed({ id, evidence, source, focused, dimmed, registerVideo, onMetadata, onFocus }: CameraFeedProps) {
  const videoRef = useCallback((node: HTMLVideoElement | null) => registerVideo(id, node), [id, registerVideo])
  const meta = CAMERA_META[id]

  return (
    <article
      className={`replay-feed replay-feed-${id} ${focused ? 'focused' : ''} ${dimmed ? 'dimmed' : ''}`}
      onDoubleClick={() => onFocus(id)}
    >
      {source ? (
        <video
          ref={videoRef}
          src={source.url}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={onMetadata}
        />
      ) : (
        <div className="replay-no-signal" role="status">
          <CameraOff size={20} />
          <strong>未发现画面</strong>
          <span>{meta.label}摄像头</span>
        </div>
      )}

      {evidence && source && <svg className="replay-evidence-overlay"
        viewBox={`0 0 ${evidence.observation.imageSize[0]} ${evidence.observation.imageSize[1]}`}
        preserveAspectRatio="xMidYMid meet" aria-label={`目标 ${evidence.trackId} 的原始检测框`}>
        <rect x={evidence.observation.imageBox[0]} y={evidence.observation.imageBox[1]}
          width={evidence.observation.imageBox[2] - evidence.observation.imageBox[0]}
          height={evidence.observation.imageBox[3] - evidence.observation.imageBox[1]}
          fill="none" stroke="#ffad59" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      </svg>}
      <div className="replay-feed-heading">
        <span className="replay-camera-code">{meta.short}</span>
        <strong>{meta.label}</strong>
        <i className={source ? 'online' : ''} />
      </div>
      {source && <span className="replay-filename">{source.filename.replace(/\.mp4$/i, '')}</span>}
      <button
        className="replay-focus-button"
        onClick={() => onFocus(id)}
        aria-label={focused ? `退出${meta.label}单路视图` : `聚焦${meta.label}`}
        title={focused ? '返回六宫格' : '聚焦此相机'}
      >
        {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </article>
  )
}

export default function MultiCameraReplay({ group, visible, evidence, time, registerVideo, onMetadata }: MultiCameraReplayProps) {
  const [focusedCamera, setFocusedCamera] = useState<CameraId | null>(null)
  const cameraCount = MOSAIC_ORDER.filter((camera) => group?.cameras[camera]).length

  useEffect(() => setFocusedCamera(null), [group?.id])
  useEffect(() => { if (evidence) setFocusedCamera(evidence.observation.camera) }, [evidence])

  const toggleFocus = (id: CameraId) => {
    setFocusedCamera((current) => current === id ? null : id)
  }

  return (
    <section
      className={`multi-camera-replay ${visible ? 'visible' : 'video-bank'} ${focusedCamera ? 'camera-focused' : ''}`}
      aria-label="六路同步视频回放"
      aria-hidden={!visible}
    >
      <div className="replay-grid">
        {MOSAIC_ORDER.map((id) => (
          <CameraFeed
            key={id}
            id={id}
            source={group?.cameras[id]}
            evidence={evidence?.observation.camera === id && Math.abs(time - evidence.observation.timeSec) < 0.06 ? evidence : null}
            focused={focusedCamera === id}
            dimmed={focusedCamera !== null && focusedCamera !== id}
            registerVideo={registerVideo}
            onMetadata={onMetadata}
            onFocus={toggleFocus}
          />
        ))}
      </div>

      {visible && (
        <div className="replay-statusbar">
          <span className="replay-live"><Radio size={14} /><b>{cameraCount}/6</b> 路时间对齐</span>
          <span className="replay-layout-state"><Grid2X2 size={14} />{focusedCamera ? `${CAMERA_META[focusedCamera].label}单路` : '宽幅六宫格'}</span>
          {focusedCamera && <button onClick={() => setFocusedCamera(null)}>返回六宫格</button>}
          <small>{evidence && Math.abs(time - evidence.observation.timeSec) < 0.06 ? `目标 ${evidence.trackId} · ${evidence.observation.timeSec.toFixed(2)}s 检测框` : '双击画面聚焦 · 片段末尾自动接续'}</small>
        </div>
      )}
    </section>
  )
}
