import { useMemo } from 'react'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  MapPin,
  Pause,
  Play,
  RotateCw,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import {
  CAMERA_ORDER,
  type EventMetadata,
  type TelemetrySample,
  type TelemetryTrack,
  type TeslaClipGroup,
} from '../types'
import { autopilotLabel } from '../utils/telemetry'

interface PlaybackDockProps {
  group: TeslaClipGroup | null
  metadata?: EventMetadata
  sample: TelemetrySample
  track: TelemetryTrack | null
  telemetryLoading: boolean
  time: number
  duration: number
  playing: boolean
  playbackRate: number
  groups: TeslaClipGroup[]
  activeGroupId: string | null
  onToggle: () => void
  onSeek: (time: number) => void
  onPlaybackRate: (rate: number) => void
  onSelectGroup: (id: string) => void
}

function formatTime(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`
}

function value(number: number | null, digits = 0): string {
  return number === null ? '—' : number.toFixed(digits)
}

function gearLabel(gear: number | null): string {
  if (gear === 0) return 'P'
  if (gear === 1) return 'D'
  if (gear === 2) return 'R'
  if (gear === 3) return 'N'
  return '—'
}

function PedalIcon({ kind }: { kind: 'accelerator' | 'brake' }) {
  return (
    <svg className="pedal-svg" viewBox="0 0 24 30" aria-hidden="true">
      {kind === 'accelerator' ? (
        <path d="M14.8 2.5c2.2.5 3.7 2.7 3.2 4.9l-3.8 17.1c-.5 2.2-2.6 3.5-4.8 3l-1.1-.2c-2.2-.5-3.6-2.7-3.1-4.9L9 5.3c.5-2.2 2.7-3.3 4.8-2.9l1 .1Z" />
      ) : (
        <path d="M6.2 3h11.6c1.8 0 3.2 1.5 3.2 3.3v17.4c0 1.8-1.4 3.3-3.2 3.3H6.2A3.2 3.2 0 0 1 3 23.7V6.3C3 4.5 4.4 3 6.2 3Zm1.4 5.2h8.8M7.6 13h8.8m-8.8 4.8h8.8" />
      )}
    </svg>
  )
}

function GForceMeter({ lateralG, longitudinalG, trail }: {
  lateralG: number | null
  longitudinalG: number | null
  trail: Array<{ lateral: number; longitudinal: number }>
}) {
  const LIMIT_G = 0.6
  const point = (lateral: number, longitudinal: number) => ({
    x: 50 + Math.max(-1, Math.min(1, lateral / LIMIT_G)) * 40,
    y: 50 - Math.max(-1, Math.min(1, longitudinal / LIMIT_G)) * 40,
  })
  const points = trail.map((sample) => point(sample.lateral, sample.longitudinal))
  const current = point(lateralG ?? 0, longitudinalG ?? 0)

  return (
    <div className="g-meter-group" role="img" aria-label={`动态加速度计，横向 ${value(lateralG, 2)} g，纵向 ${value(longitudinalG, 2)} g`}>
      <div className="g-meter">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <linearGradient id="g-trail-gradient" x1="0" y1="1" x2="1" y2="0">
              <stop className="g-trail-start" offset="0" stopOpacity="0.15" />
              <stop className="g-trail-end" offset="1" stopOpacity="0.9" />
            </linearGradient>
          </defs>
          <circle className="g-ring outer" cx="50" cy="50" r="40" />
          <circle className="g-ring middle" cx="50" cy="50" r="27" />
          <circle className="g-ring inner" cx="50" cy="50" r="13.5" />
          <path className="g-axis" d="M10 50h80M50 10v80" />
          <path className="g-tick" d="M50 7v6M50 87v6M7 50h6M87 50h6" />
          {points.length > 1 && <polyline className="g-trail" points={points.map(({ x, y }) => `${x},${y}`).join(' ')} />}
          {points.slice(-12).map(({ x, y }, index, visible) => (
            <circle key={`${x}-${y}-${index}`} className="g-history-dot" cx={x} cy={y} r={1.2 + index / Math.max(1, visible.length) * 0.8} opacity={0.12 + index / Math.max(1, visible.length) * 0.48} />
          ))}
          <circle className="g-current-halo" cx={current.x} cy={current.y} r="5.2" />
          <circle className="g-current-dot" cx={current.x} cy={current.y} r="2.8" />
        </svg>
        <span className="g-label g-label-top">加速</span>
        <span className="g-label g-label-bottom">制动</span>
        <span className="g-label g-label-left">左</span>
        <span className="g-label g-label-right">右</span>
        <strong>G</strong>
      </div>
      <span className="g-compact-readout" aria-hidden="true">
        <span><b>横</b>{value(lateralG, 2)}</span>
        <span><b>纵</b>{value(longitudinalG, 2)}</span>
      </span>
    </div>
  )
}

export default function PlaybackDock(props: PlaybackDockProps) {
  const duration = Math.max(props.duration, 0.01)
  const progress = Math.min(100, (props.time / duration) * 100)
  const lateralG = props.sample.accelerationX === null ? null : props.sample.accelerationX / 9.81
  const longitudinalG = props.sample.accelerationY === null ? null : props.sample.accelerationY / 9.81
  const gTrail = useMemo(() => {
    if (!props.track?.samples.length) return []
    const start = Math.max(0, props.time - 2.6)
    const points = props.track.samples
      .filter((sample) => sample.timeSec >= start && sample.timeSec <= props.time)
      .map((sample) => ({
        lateral: (sample.accelerationX ?? 0) / 9.81,
        longitudinal: (sample.accelerationY ?? 0) / 9.81,
      }))
    const stride = Math.max(1, Math.ceil(points.length / 28))
    return points.filter((_, index) => index % stride === 0).slice(-28)
  }, [props.time, props.track])
  const eventDate = props.group?.timestamp
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(props.group.timestamp)
    : '示例事件'

  const jump = (seconds: number) => props.onSeek(Math.max(0, Math.min(props.duration, props.time + seconds)))

  return (
    <section className="playback-dock" aria-label="播放与车辆状态">
      <div className="sensor-bar">
        <div className="event-sensor-block">
          <MapPin size={16} />
          <span><strong>{props.metadata?.street || props.metadata?.city || props.group?.folder || '本地录像'}</strong><small>{eventDate}</small></span>
        </div>

        <div className={`primary-driving-state ${props.sample.autopilotState ? 'autopilot' : ''}`}>
          <span className="gear-state">{gearLabel(props.sample.gearState)}</span>
          <ArrowLeft className={`turn-indicator ${props.sample.blinkerLeft ? 'signal-on' : ''}`} size={18} aria-label={props.sample.blinkerLeft ? '左转向灯已开启' : '左转向灯关闭'} />
          <strong>{value(props.sample.speedKph)}</strong>
          <span className="speed-unit">km/h</span>
          <ArrowRight className={`turn-indicator ${props.sample.blinkerRight ? 'signal-on' : ''}`} size={18} aria-label={props.sample.blinkerRight ? '右转向灯已开启' : '右转向灯关闭'} />
          <small>{props.telemetryLoading ? '正在读取视频传感器数据…' : autopilotLabel(props.sample.autopilotState)}</small>
          <div className="pedal-indicators">
            <span className={`pedal-indicator accelerator ${(props.sample.acceleratorPct ?? 0) > 0.5 ? 'active' : ''}`} aria-label={(props.sample.acceleratorPct ?? 0) > 0.5 ? '加速踏板已踩下' : '加速踏板未踩下'}>
              <PedalIcon kind="accelerator" />
              <small>电门</small>
            </span>
            <span className={`pedal-indicator brake ${props.sample.brakeApplied ? 'active' : ''}`} aria-label={props.sample.brakeApplied ? '制动踏板已踩下' : '制动踏板未踩下'}>
              <PedalIcon kind="brake" />
              <small>制动</small>
            </span>
          </div>
        </div>

        <div className="sensor-values">
          <div className="motion-readouts">
            <span><RotateCw size={14} /><i>方向盘转角</i><strong>{value(props.sample.steeringDeg, 1)}°</strong></span>
            <span><Activity size={14} /><i>横向 / 纵向 G</i><strong>{value(lateralG, 2)} / {value(longitudinalG, 2)}</strong></span>
          </div>
          <GForceMeter lateralG={lateralG} longitudinalG={longitudinalG} trail={gTrail} />
        </div>
      </div>

      <div className="dock-transport">
        <div className="dock-buttons">
          <button onClick={() => jump(-5)} aria-label="后退五秒"><SkipBack size={16} /><span>后退 <small>5秒</small></span></button>
          <button className="dock-play" onClick={props.onToggle} aria-label={props.playing ? '暂停' : '播放'}>
            {props.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            <span>{props.playing ? '暂停' : '播放'}</span>
          </button>
          <button onClick={() => jump(5)} aria-label="前进五秒"><SkipForward size={16} /><span>前进 <small>5秒</small></span></button>
        </div>
        <span className="dock-time"><small>片段时间</small>{formatTime(props.time)} <i>/</i> {formatTime(props.duration)}</span>
        <div className="dock-scrubber">
          <div className="dock-progress" style={{ transform: `scaleX(${progress / 100})` }} />
          <div className="dock-playhead" style={{ left: `${progress}%` }} />
          <input
            type="range"
            min="0"
            max={duration}
            step="0.01"
            value={Math.min(props.time, duration)}
            onChange={(event) => props.onSeek(Number(event.target.value))}
            aria-label="回放位置"
            aria-valuetext={`${formatTime(props.time)} / ${formatTime(duration)}`}
          />
        </div>
        <span className={`telemetry-source ${props.track?.samples.length ? 'available' : ''}`} title={props.track?.samples.length ? `${props.track.samples.length} 个 SEI 传感器采样点` : '当前片段没有传感器轨'}><i /><b>车辆数据</b>{props.track?.samples.length ? `SEI ${props.track.samples.length}` : '无传感器轨'}</span>
        <label className="playback-rate">
          <span>倍率</span>
          <select value={props.playbackRate} onChange={(event) => props.onPlaybackRate(Number(event.target.value))} aria-label="播放速度">
            {[0.25, 0.5, 1, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
          </select>
        </label>
      </div>

      <div className="event-segment-rail" aria-label="事件片段">
        <span className="segment-rail-label"><b>事件时间线</b><small>{props.groups.length || 1} 个连续片段</small></span>
        <div className="segment-track">
          {(props.groups.length ? props.groups : [null]).map((group, index) => {
            const active = group ? group.id === props.activeGroupId : true
            const cameras = group ? CAMERA_ORDER.filter((camera) => group.cameras[camera]).length : 6
            return group ? (
              <button
                key={group.id}
                className={active ? 'active' : ''}
                onClick={() => props.onSelectGroup(group.id)}
                aria-pressed={active}
                title={`${group.label} · ${cameras}/6 路`}
              >
                <i />
                <span>{String(index + 1).padStart(2, '0')}</span>
                <small>{cameras}/6</small>
              </button>
            ) : <span className="demo-segment active" key="demo"><i /><b>DEMO</b></span>
          })}
        </div>
      </div>
    </section>
  )
}
