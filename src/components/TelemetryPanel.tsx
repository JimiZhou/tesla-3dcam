import { Activity, ArrowDownToLine, BrainCircuit, Gauge, Navigation, RotateCw } from 'lucide-react'
import type { SceneLayers, TelemetrySample, TelemetryTrack } from '../types'
import { autopilotLabel } from '../utils/telemetry'

interface TelemetryPanelProps {
  sample: TelemetrySample
  track: TelemetryTrack | null
  layers: SceneLayers
  onLayer: (key: keyof SceneLayers) => void
  onTelemetryFile: (file: File) => void
  onExport: () => void
}

function value(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits)
}

export default function TelemetryPanel({ sample, track, layers, onLayer, onTelemetryFile, onExport }: TelemetryPanelProps) {
  const apActive = (sample.autopilotState ?? 0) >= 2
  return (
    <aside className="inspector-panel">
      <section className="telemetry-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">VEHICLE STATE</p>
            <h2>车辆状态轨</h2>
          </div>
          <span className={`source-chip ${track?.source === 'demo' ? '' : 'real'}`}>{track?.source === 'demo' ? '模拟' : track ? track.source.toUpperCase() : '无数据'}</span>
        </div>

        <div className="speed-block">
          <Gauge size={18} />
          <strong>{value(sample.speedKph)}</strong>
          <span>km/h</span>
          <div className={`ap-state ${apActive ? 'active' : ''}`}><BrainCircuit size={15} />{autopilotLabel(sample.autopilotState)}</div>
        </div>

        <div className="telemetry-grid">
          <div className="telemetry-cell">
            <span><RotateCw size={14} />方向盘</span>
            <strong>{value(sample.steeringDeg, 1)}°</strong>
            <div className="steering-viz"><i style={{ transform: `rotate(${sample.steeringDeg ?? 0}deg)` }} /></div>
          </div>
          <div className="telemetry-cell">
            <span><Navigation size={14} />航向</span>
            <strong>{value(sample.headingDeg, 1)}°</strong>
            <small>{sample.blinkerLeft ? '左转灯' : sample.blinkerRight ? '右转灯' : '转向灯关闭'}</small>
          </div>
        </div>

        <div className="pedals">
          <div><span>加速踏板</span><strong>{value(sample.acceleratorPct)}%</strong><i><b style={{ transform: `scaleX(${(sample.acceleratorPct ?? 0) / 100})` }} /></i></div>
          <div className={sample.brakeApplied ? 'braking' : ''}><span>制动</span><strong>{sample.brakeApplied ? '已踩下' : '未踩下'}</strong><i><b style={{ transform: `scaleX(${sample.brakeApplied ? 1 : 0})` }} /></i></div>
        </div>

        <div className="accel-row">
          <Activity size={14} />
          <span>纵向加速度</span>
          <strong>{value(sample.accelerationX, 2)} m/s²</strong>
        </div>

        <label className="telemetry-import">
          <ArrowDownToLine size={15} />导入遥测 JSON
          <input type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && onTelemetryFile(event.target.files[0])} />
        </label>
      </section>

      <section className="layer-section">
        <div className="source-divider"><span>现场图层</span><strong>04</strong></div>
        {([
          ['splats', '高斯点云', '环境外观与空间结构'],
          ['tracks', '目标与轨迹', '动态车辆和运动方向'],
          ['perception', '感知融合', '车道边界与预测行驶走廊'],
          ['cameras', '相机投影', '四路原始画面与视锥'],
        ] as Array<[keyof SceneLayers, string, string]>).map(([key, title, description]) => (
          <button className="layer-row" key={key} onClick={() => onLayer(key)} aria-pressed={layers[key]}>
            <span className={`layer-toggle ${layers[key] ? 'on' : ''}`}><i /></span>
            <span><strong>{title}</strong><small>{description}</small></span>
          </button>
        ))}
      </section>

      <section className="export-section">
        <p>真实 3DGS 需要相机标定、位姿求解与动态物体分层；任务清单可交给本地重建管线。</p>
        <button onClick={onExport}><ArrowDownToLine size={15} />导出重建任务</button>
      </section>
    </aside>
  )
}
