import { useCallback } from 'react'
import { Camera, Maximize2 } from 'lucide-react'
import { CAMERA_META, CAMERA_ORDER, type CameraId, type CameraSource, type TeslaClipGroup } from '../types'

interface CameraDockProps {
  group: TeslaClipGroup | null
  registerVideo: (id: CameraId, node: HTMLVideoElement | null) => void
  onMetadata: () => void
}

function CameraTile({
  id,
  source,
  registerVideo,
  onMetadata,
}: {
  id: CameraId
  source?: CameraSource
  registerVideo: CameraDockProps['registerVideo']
  onMetadata: () => void
}) {
  const videoRef = useCallback((node: HTMLVideoElement | null) => registerVideo(id, node), [id, registerVideo])
  return (
    <article className={`camera-tile camera-${id}`}>
      <div className="camera-label"><span>{CAMERA_META[id].short}</span>{CAMERA_META[id].label}</div>
      {source ? (
        <video
          ref={videoRef}
          src={source.url}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={onMetadata}
        />
      ) : (
        <div className="demo-feed" aria-label={`${CAMERA_META[id].label}示例画面`}>
          <div className="demo-horizon" />
          <div className="demo-road" />
          <div className="demo-vehicle" />
          <Camera size={20} />
        </div>
      )}
      <button className="camera-expand" aria-label={`放大${CAMERA_META[id].label}`} title="聚焦此相机">
        <Maximize2 size={13} />
      </button>
      <span className="camera-timecode">REC · 30 FPS</span>
    </article>
  )
}

export default function CameraDock({ group, registerVideo, onMetadata }: CameraDockProps) {
  return (
    <section className="camera-dock" aria-labelledby="camera-heading">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">MULTI-CAMERA</p>
          <h2 id="camera-heading">六路同步画面</h2>
        </div>
        <span className="sync-badge"><i />SYNC</span>
      </div>
      <div className="camera-grid">
        {CAMERA_ORDER.map((id) => <CameraTile key={id} id={id} source={group?.cameras[id]} registerVideo={registerVideo} onMetadata={onMetadata} />)}
      </div>
    </section>
  )
}
