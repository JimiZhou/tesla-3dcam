import { useRef, type DragEvent } from 'react'
import { Check, ChevronRight, FileVideo2, FolderOpen, Plus, ScanLine, UploadCloud } from 'lucide-react'
import { CAMERA_ORDER, type TeslaClipGroup } from '../types'

interface SourcePanelProps {
  groups: TeslaClipGroup[]
  activeId: string | null
  buildStatus: 'idle' | 'building' | 'ready'
  buildProgress: number
  importMessage: string
  onFiles: (files: File[]) => void
  onSelect: (id: string) => void
  onBuild: () => void
}

export default function SourcePanel(props: SourcePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const folderAttributes = { webkitdirectory: '', directory: '' } as Record<string, string>

  const drop = (event: DragEvent) => {
    event.preventDefault()
    props.onFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <aside className="source-panel" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <div className="source-intro">
        <p className="eyebrow">LOCAL EVIDENCE</p>
        <h1>把录像变回<br />当时的空间。</h1>
        <p>六路影像、车辆状态与三维轨迹在同一条时间线上对齐。</p>
      </div>

      <div className="import-actions">
        <button className="primary-action" onClick={() => folderInput.current?.click()}>
          <FolderOpen size={17} />选择 TeslaCam 文件夹
        </button>
        <button className="icon-action" onClick={() => fileInput.current?.click()} aria-label="选择多个视频" title="选择多个视频">
          <Plus size={18} />
        </button>
        <input ref={folderInput} type="file" multiple accept="video/*,.json" {...folderAttributes} onChange={(event) => props.onFiles(Array.from(event.target.files ?? []))} />
        <input ref={fileInput} type="file" multiple accept="video/*,.json" onChange={(event) => props.onFiles(Array.from(event.target.files ?? []))} />
      </div>

      <div className="drop-hint"><UploadCloud size={15} /><span>{props.importMessage || '也可以把整个事件文件夹拖到这里'}</span></div>

      <div className="source-divider"><span>录像段</span><strong>{props.groups.length || 1}</strong></div>

      <div className="clip-list">
        {props.groups.length === 0 ? (
          <button className="clip-row active" type="button">
            <span className="clip-icon"><ScanLine size={16} /></span>
            <span className="clip-copy"><strong>示例 · 城市道路</strong><small>07/22 18:42:16</small></span>
            <span className="camera-count">6/6</span>
            <ChevronRight size={15} />
          </button>
        ) : props.groups.map((group) => {
          const count = CAMERA_ORDER.filter((camera) => group.cameras[camera]).length
          return (
            <button className={`clip-row ${group.id === props.activeId ? 'active' : ''}`} type="button" key={group.id} onClick={() => props.onSelect(group.id)}>
              <span className="clip-icon"><FileVideo2 size={16} /></span>
              <span className="clip-copy"><strong>{group.label}</strong><small>{group.folder}</small></span>
              <span className={`camera-count ${count < CAMERA_ORDER.length ? 'incomplete' : ''}`}>{count}/{CAMERA_ORDER.length}</span>
              <ChevronRight size={15} />
            </button>
          )
        })}
      </div>

      <div className="build-zone">
        <div className="build-copy">
          <span className={`build-status ${props.buildStatus}`}>
            {props.buildStatus === 'ready' ? <Check size={13} /> : <i />}
            {props.buildStatus === 'ready' ? '空间预览已就绪' : props.buildStatus === 'building' ? '正在建立空间预览' : '等待建立预览'}
          </span>
          <small>{props.buildStatus === 'building' ? `${props.buildProgress}% · 对齐相机与车辆状态` : '相对尺度 · 可继续升级 3DGS'}</small>
        </div>
        <button className="build-button" disabled={props.buildStatus === 'building'} onClick={props.onBuild}>
          {props.buildStatus === 'building' ? `${props.buildProgress}%` : props.buildStatus === 'ready' ? '重新构建' : '构建预览'}
        </button>
        <div className="build-progress"><span style={{ transform: `scaleX(${props.buildProgress / 100})` }} /></div>
      </div>
    </aside>
  )
}
