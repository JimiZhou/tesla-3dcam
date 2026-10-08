import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { TelemetryTrack } from '../types'

interface TimelineProps {
  time: number
  duration: number
  playing: boolean
  telemetry: TelemetryTrack | null
  onToggle: () => void
  onSeek: (value: number) => void
}

function formatTime(value: number): string {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor((seconds % 1) * 10)}`
}

export default function Timeline({ time, duration, playing, telemetry, onToggle, onSeek }: TimelineProps) {
  const safeDuration = Math.max(duration, 0.01)
  const progress = Math.min(100, (time / safeDuration) * 100)
  const chart = telemetry?.samples.filter((_, index) => index % Math.max(1, Math.floor(telemetry.samples.length / 160)) === 0) ?? []
  const points = chart.map((sample) => {
    const x = (sample.timeSec / safeDuration) * 100
    const y = 28 - Math.min(24, ((sample.speedKph ?? 0) / 90) * 24)
    return `${x},${y}`
  }).join(' ')

  const jump = (amount: number) => onSeek(Math.max(0, Math.min(duration, time + amount)))

  return (
    <section className="timeline-shell" aria-label="同步回放时间轴">
      <div className="transport">
        <button className="transport-button" onClick={() => jump(-5)} aria-label="后退五秒"><SkipBack size={16} /></button>
        <button className="play-button" onClick={onToggle} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button className="transport-button" onClick={() => jump(5)} aria-label="前进五秒"><SkipForward size={16} /></button>
      </div>

      <div className="timeline-readout">{formatTime(time)} <span>/ {formatTime(duration)}</span></div>

      <div className="timeline-track">
        <svg className="telemetry-trace" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="autopilot-band" style={{ left: '11%', width: '57%' }}><span>AP</span></div>
        <div className="timeline-progress" style={{ width: `${progress}%` }} />
        <div className="timeline-head" style={{ left: `${progress}%` }} />
        <input
          className="timeline-input"
          type="range"
          min="0"
          max={safeDuration}
          step="0.01"
          value={Math.min(time, safeDuration)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="回放位置"
        />
      </div>

      <div className="timeline-legend" aria-hidden="true">
        <span><i className="legend-line" />速度</span>
        <span><i className="legend-band" />辅助驾驶</span>
      </div>
    </section>
  )
}
