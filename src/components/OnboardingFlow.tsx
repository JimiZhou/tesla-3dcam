import { useRef, type DragEvent } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  CloudOff,
  FolderSearch,
  Gauge,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react'
import { CAMERA_META, CAMERA_ORDER, type TeslaClipGroup } from '../types'

export type OnboardingPhase = 'welcome' | 'scanning' | 'ready'

export interface ScanSummary {
  folderName: string
  fileCount: number
  videoCount: number
  completeCount: number
  incompleteCount: number
  telemetryFound: boolean
}

interface OnboardingFlowProps {
  phase: OnboardingPhase
  progress: number
  scanStage: string
  error: string
  groups: TeslaClipGroup[]
  selectedId: string | null
  summary: ScanSummary | null
  onFiles: (files: File[]) => void
  onSelect: (id: string) => void
  onContinue: () => void
  onReset: () => void
  onDemo: () => void
}

interface DroppedEntry {
  isFile: boolean
  isDirectory: boolean
  file?: (success: (file: File) => void, error?: (error: DOMException) => void) => void
  createReader?: () => { readEntries: (success: (entries: DroppedEntry[]) => void, error?: (error: DOMException) => void) => void }
}

async function readDroppedEntry(entry: DroppedEntry): Promise<File[]> {
  if (entry.isFile && entry.file) {
    return new Promise((resolve, reject) => entry.file?.((file) => resolve([file]), reject))
  }
  if (!entry.isDirectory || !entry.createReader) return []
  const reader = entry.createReader()
  const children: DroppedEntry[] = []
  while (true) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    children.push(...batch)
  }
  return (await Promise.all(children.map(readDroppedEntry))).flat()
}

function cameraCount(group: TeslaClipGroup): number {
  return CAMERA_ORDER.filter((camera) => group.cameras[camera]).length
}

export default function OnboardingFlow(props: OnboardingFlowProps) {
  const folderInput = useRef<HTMLInputElement>(null)
  const folderAttributes = { webkitdirectory: '', directory: '' } as Record<string, string>

  const openFolder = () => folderInput.current?.click()
  const drop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (props.phase !== 'welcome') return
    const entries = Array.from(event.dataTransfer.items).reduce<DroppedEntry[]>((result, item) => {
      const entry = (item as unknown as { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.()
      if (entry) result.push(entry)
      return result
    }, [])
    const files = entries.length
      ? (await Promise.all(entries.map(readDroppedEntry))).flat()
      : Array.from(event.dataTransfer.files)
    props.onFiles(files)
  }

  return (
    <main className={`onboarding onboarding-${props.phase}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { void drop(event) }}>
      <header className="onboarding-header">
        <div className="brand-mark onboarding-brand"><span>S/R</span><strong>SCENE / REPLAY</strong></div>
        <div className="onboarding-steps" aria-label="导入步骤">
          <span className={props.phase === 'welcome' ? 'active' : 'done'}><i>01</i>选择目录</span>
          <b />
          <span className={props.phase === 'scanning' ? 'active' : props.phase === 'ready' ? 'done' : ''}><i>02</i>自动扫描</span>
          <b />
          <span className={props.phase === 'ready' ? 'active' : ''}><i>03</i>重建分析</span>
        </div>
        <div className="local-status onboarding-local"><CloudOff size={14} /><span>仅本地处理</span><i /></div>
      </header>

      <input
        ref={folderInput}
        className="onboarding-folder-input"
        type="file"
        multiple
        accept="video/*,.json"
        {...folderAttributes}
        onChange={(event) => props.onFiles(Array.from(event.target.files ?? []))}
      />

      {props.phase === 'welcome' && (
        <section className="welcome-stage" aria-labelledby="welcome-title">
          <div className="welcome-orbit" aria-hidden="true">
            <span className="orbit-ring ring-one" />
            <span className="orbit-ring ring-two" />
            {CAMERA_ORDER.map((camera, index) => (
              <i className={`orbit-camera orbit-camera-${index + 1}`} key={camera}>{CAMERA_META[camera].short}</i>
            ))}
          </div>
          <div className="welcome-copy">
            <p className="eyebrow">TESLACAM RECONSTRUCTION</p>
            <h1 id="welcome-title">选择录像目录，<br />还原当时的现场。</h1>
            <p>系统会自动识别同一时刻保存的多路摄像头画面，生成稳定 BEV，并提供六路动态环视。</p>
          </div>

          <button className="folder-hero-button" onClick={openFolder}>
            <span className="folder-button-icon"><FolderSearch size={27} /></span>
            <span><strong>选择 TeslaCam 目录</strong><small>支持 SavedClips、RecentClips 和 SentryClips</small></span>
            <ArrowRight size={21} />
          </button>
          <p className="drop-directory-hint">也可以把整个事件目录拖到这里</p>

          {props.error && <div className="onboarding-error" role="alert"><AlertTriangle size={16} /><span>{props.error}</span></div>}

          <button className="demo-link" onClick={props.onDemo}><Play size={13} fill="currentColor" />没有录像，先查看示例现场</button>

          <div className="welcome-assurances">
            <span><ShieldCheck size={16} /><b>数据不离开设备</b><small>浏览器本地读取，不会上传</small></span>
                <span><ScanSearch size={16} /><b>自动匹配六路画面</b><small>按时间戳与摄像头名称归组</small></span>
            <span><Gauge size={16} /><b>同步车辆状态</b><small>识别可用的 SEI 遥测数据</small></span>
          </div>
        </section>
      )}

      {props.phase === 'scanning' && (
        <section className="scanning-stage" aria-live="polite" aria-busy="true">
          <div className="scan-visual" aria-hidden="true">
            <div className="scan-core"><ScanSearch size={31} /><span>{props.progress}%</span></div>
            <span className="scan-ring scan-ring-one" />
            <span className="scan-ring scan-ring-two" />
            <i className="scan-beam" />
            {CAMERA_ORDER.map((camera, index) => (
              <div className={`scan-camera scan-camera-${index + 1}`} key={camera}>
                <Camera size={15} /><span>{CAMERA_META[camera].label}</span><Check size={12} />
              </div>
            ))}
          </div>
          <p className="eyebrow">SCANNING LOCAL DIRECTORY</p>
          <h1>正在整理同一时刻的画面</h1>
          <p className="scan-stage-copy">{props.scanStage}</p>
          <div className="scan-progress"><span style={{ transform: `scaleX(${props.progress / 100})` }} /></div>
          <small>只建立本地文件索引，不会复制或修改原始录像</small>
        </section>
      )}

      {props.phase === 'ready' && props.summary && (
        <section className="scan-results" aria-labelledby="results-title">
          <div className="results-heading">
            <div>
              <span className="results-check"><Check size={20} /></span>
              <p className="eyebrow">DIRECTORY READY</p>
              <h1 id="results-title">找到 {props.groups.length} 个可分析的事件段</h1>
              <p>{props.summary.folderName} · 已按时间戳完成多路画面归组</p>
            </div>
            <button className="reset-directory" onClick={props.onReset}><RotateCcw size={15} />重新选择目录</button>
          </div>

          <div className="results-layout">
            <div className="event-picker">
              <div className="event-picker-heading"><span>选择要重建的事件</span><small>默认选中第一组完整录像</small></div>
              <div className="event-list-results">
                {props.groups.map((group, index) => {
                  const count = cameraCount(group)
                  const complete = count === CAMERA_ORDER.length
                  return (
                    <button
                      className={`event-result-row ${props.selectedId === group.id ? 'selected' : ''}`}
                      key={group.id}
                      onClick={() => props.onSelect(group.id)}
                      aria-pressed={props.selectedId === group.id}
                    >
                      <span className="event-sequence">{String(index + 1).padStart(2, '0')}</span>
                      <span className="event-result-copy"><strong>{group.label}</strong><small>{group.folder}</small></span>
                      <span className="event-cameras" aria-label={`${count} 路摄像头`}>
                        {CAMERA_ORDER.map((camera) => <i className={group.cameras[camera] ? 'found' : 'missing'} key={camera}>{CAMERA_META[camera].short}</i>)}
                      </span>
                      <span className={`event-health ${complete ? 'complete' : 'partial'}`}>{complete ? '完整' : `缺 ${CAMERA_ORDER.length - count} 路`}</span>
                      <ChevronRight size={16} />
                    </button>
                  )
                })}
              </div>
            </div>

            <aside className="scan-summary">
              <p className="eyebrow">SCAN REPORT</p>
              <h2>可重建性检查</h2>
              <dl>
                <div><dt>目录文件</dt><dd>{props.summary.fileCount}</dd></div>
                <div><dt>识别的视频</dt><dd>{props.summary.videoCount}</dd></div>
                <div><dt>完整事件段</dt><dd>{props.summary.completeCount}</dd></div>
                <div><dt>缺少摄像头</dt><dd className={props.summary.incompleteCount ? 'warning' : ''}>{props.summary.incompleteCount}</dd></div>
              </dl>
              <div className={`telemetry-result ${props.summary.telemetryFound ? 'found' : ''}`}>
                <Gauge size={16} />
                <span><strong>{props.summary.telemetryFound ? '检测到车辆状态文件' : '暂未检测到车辆状态文件'}</strong><small>{props.summary.telemetryFound ? '将在回放中同步解析' : '仍可从较新 MP4 的 SEI 中继续提取'}</small></span>
              </div>
              <button className="start-reconstruction" onClick={props.onContinue} disabled={!props.selectedId}>
                <span><strong>开始重建分析</strong><small>进入感知融合工作台</small></span><ArrowRight size={20} />
              </button>
              <p className="analysis-boundary">工作台只保留 BEV 与六路动态环视；未覆盖区域不会生成虚构画面。</p>
            </aside>
          </div>
        </section>
      )}
    </main>
  )
}
