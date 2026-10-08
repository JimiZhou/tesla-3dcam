import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CarFront, ChevronLeft, ChevronRight, CircleDot, CloudOff, Eye, FolderOpen, LayoutGrid, Map, Rotate3D, ScanLine } from 'lucide-react'
import PlaybackDock from './components/PlaybackDock'
import MultiCameraReplay from './components/MultiCameraReplay'
import OnboardingFlow, { type OnboardingPhase, type ScanSummary } from './components/OnboardingFlow'
import { CAMERA_ORDER, type CameraId, type EvidenceSelection, type EventMetadata, type TelemetryTrack, type TeslaClipGroup, type ViewerMode, type ViewPreset } from './types'
import { folderFromFile, parseTeslaClips, revokeClipUrls } from './utils/teslaClips'
import { createDemoTelemetry, parseTelemetryPayload, readTelemetryFile, telemetryAt, telemetryForClip } from './utils/telemetry'
import { extractTelemetryFromVideo } from './utils/seiTelemetry'

const DEMO_DURATION = 72
const wait = (duration: number) => new Promise((resolve) => window.setTimeout(resolve, duration))
const SceneView = lazy(() => import('./components/SceneView'))

type ReconstructionState = 'idle' | 'queued' | 'building' | 'ready' | 'error'

interface ReconstructionStatus {
  clip: string
  state: Exclude<ReconstructionState, 'idle'>
  progress: number
  completed: number
  total: number
  message: string
  outputUrl?: string
  error?: string
}

const VIEW_PRESETS: Array<{ id: ViewPreset; label: string; icon: typeof Eye }> = [
  { id: 'orbit', label: '环绕', icon: Rotate3D },
  { id: 'top', label: '俯视', icon: Map },
  { id: 'chase', label: '跟车', icon: CarFront },
  { id: 'driver', label: '驾驶位', icon: Eye },
]

function App() {
  const [appPhase, setAppPhase] = useState<OnboardingPhase | 'workspace'>(() => new URLSearchParams(window.location.search).has('timeline') ? 'workspace' : 'welcome')
  const [scanProgress, setScanProgress] = useState(0)
  const [scanStage, setScanStage] = useState('准备读取目录')
  const [scanError, setScanError] = useState('')
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null)
  const scanGeneration = useRef(0)
  const [groups, setGroups] = useState<TeslaClipGroup[]>([])
  const groupsRef = useRef<TeslaClipGroup[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [time, setTime] = useState(() => { const value = Number(new URLSearchParams(window.location.search).get('time') ?? 16.4); return Number.isFinite(value) ? value : 0 })
  const [evidence, setEvidence] = useState<EvidenceSelection | null>(null)
  const [duration, setDuration] = useState(DEMO_DURATION)
  const [preset, setPreset] = useState<ViewPreset>('top')
  const [viewerMode, setViewerMode] = useState<ViewerMode>('bev')
  const [videoElements, setVideoElements] = useState<Partial<Record<CameraId, HTMLVideoElement>>>({})
  const videoRefs = useRef<Partial<Record<CameraId, HTMLVideoElement>>>({})
  const resumeAfterGroupChange = useRef(false)
  const [track, setTrack] = useState<TelemetryTrack | null>(() => new URLSearchParams(window.location.search).has('timeline') ? null : createDemoTelemetry(DEMO_DURATION))
  const [tracksByFolder, setTracksByFolder] = useState<Record<string, TelemetryTrack>>({})
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({})
  const [telemetryLoading, setTelemetryLoading] = useState(false)
  const telemetryGeneration = useRef(0)
  const [buildStatus, setBuildStatus] = useState<ReconstructionState>('idle')
  const [buildProgress, setBuildProgress] = useState(0)
  const [buildMessage, setBuildMessage] = useState('等待导入行车记录仪目录')
  const [buildError, setBuildError] = useState('')
  const [bevTimelineUrl, setBevTimelineUrl] = useState<string>()
  // Debug hook: `?timeline=/reconstruction/xx-bev-timeline.json` previews a
  // precomputed scene track without importing the source TeslaCam directory.
  const debugTimelineUrl = useMemo(() => new URLSearchParams(window.location.search).get('timeline') ?? undefined, [])

  const activeGroup = useMemo(() => groups.find((group) => group.id === activeId) ?? groups[0] ?? null, [activeId, groups])
  const currentTelemetry = useMemo(() => telemetryAt(track, time), [time, track])
  const reconstructionUrl = useMemo(() => {
    const filename = activeGroup?.cameras.front?.filename
    // The checked-in artifact is generated from the real first event in the
    // supplied TeslaCam directory. Other clips remain eligible for the CLI
    // reconstruction pipeline described in tools/reconstruct_scene.py.
    return filename?.startsWith('2026-07-23_07-20-38-front') ? '/reconstruction/07-20-38.ply' : undefined
  }, [activeGroup])
  const activeClip = useMemo(() => {
    const filename = activeGroup?.cameras.front?.filename
    return filename?.match(/(20\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-front\.mp4$/i)?.[1]
  }, [activeGroup])
  const previewActive = Boolean(debugTimelineUrl) && (!activeGroup || activeGroup.id.startsWith('preview:'))
  useEffect(() => {
    if (!debugTimelineUrl) return
    let alive = true
    void fetch(debugTimelineUrl).then((response) => response.json()).then(async (manifest) => {
      if (!manifest.clip) return
      const response = await fetch(`/api/bev/sources?clip=${encodeURIComponent(manifest.clip)}`)
      if (!response.ok) throw new Error('验收视频不可用')
      const data = await response.json() as { cameras: Array<{ camera: CameraId; filename: string; url: string }> }
      if (!alive) return
      const folder = `preview:${manifest.clip}`
      const group: TeslaClipGroup = { id: folder, folder, label: `${manifest.clip} · 验收片段`, timestamp: null, cameras: {} }
      data.cameras.forEach((item) => { group.cameras[item.camera] = { ...item, file: new File([], item.filename) } })
      setGroups([group])
      setActiveId(group.id)
      if (manifest.egoSamples?.length) setTracksByFolder({ [folder]: parseTelemetryPayload({ source: 'sei', samples: manifest.egoSamples }) })
      setBuildStatus(manifest.qualityGate?.passed ? 'ready' : 'error')
      setBuildProgress(100)
      setBuildMessage(`验收区间 ${manifest.frames?.[0]?.timeSec ?? 0}–${manifest.frames?.at(-1)?.timeSec ?? 0}s · 精度待核对`)
    }).catch((error) => { if (alive) setBuildError(String(error)) })
    return () => { alive = false }
  }, [debugTimelineUrl])

  const bevArtifactKey = activeClip?.match(/_(\d{2}-\d{2}-\d{2})$/)?.[1]
  const bevManifestUrl = bevArtifactKey === '07-20-38' ? '/reconstruction/07-20-38-bev.json' : undefined

  useEffect(() => {
    groupsRef.current = groups
  }, [groups])

  const registerVideo = useCallback((id: CameraId, node: HTMLVideoElement | null) => {
    if (node) videoRefs.current[id] = node
    else delete videoRefs.current[id]
    setVideoElements((current) => {
      if (node ? current[id] === node : !current[id]) return current
      const next = { ...current }
      if (node) next[id] = node
      else delete next[id]
      return next
    })
  }, [])

  const refreshDuration = useCallback(() => {
    const expectedCameras = CAMERA_ORDER.filter((id) => activeGroup?.cameras[id])
    const readyVideos = expectedCameras
      .map((id) => videoRefs.current[id])
      .filter((video): video is HTMLVideoElement => Boolean(video?.readyState && Number.isFinite(video.duration)))
    const durations = readyVideos
      .map((video) => video.duration)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    if (durations.length) setDuration(Math.min(...durations))
    readyVideos.forEach((video) => { if (Math.abs(video.currentTime - time) > 0.1) video.currentTime = time })
    if (resumeAfterGroupChange.current && expectedCameras.length > 0 && readyVideos.length === expectedCameras.length) {
      resumeAfterGroupChange.current = false
      setTime(0)
      setPlaying(true)
      readyVideos.forEach((video) => {
        video.currentTime = 0
        video.playbackRate = playbackRate
        void video.play().catch(() => setPlaying(false))
      })
    }
  }, [activeGroup, playbackRate, time])

  useEffect(() => {
    Object.values(videoRefs.current).forEach((video) => {
      video.playbackRate = playbackRate
    })
  }, [playbackRate, videoElements])

  const handleFiles = useCallback(async (files: File[]) => {
    if (!files.length) {
      setScanError('这个目录没有返回可读取的文件。请选择包含 TeslaCam MP4 的目录。')
      setAppPhase('welcome')
      return
    }

    const generation = ++scanGeneration.current
    const folderName = files[0]?.webkitRelativePath.split('/')[0] || '所选目录'
    setAppPhase('scanning')
    setScanError('')
    setScanSummary(null)
    setScanProgress(8)
    setScanStage(`已读取 ${files.length} 个目录条目，正在筛选视频文件`)
    await wait(180)

    const nextGroups = parseTeslaClips(files)
    const telemetryFiles = files.filter((file) => /(?:telemetry|vehicle[_-]?state).*\.json$/i.test(file.name))
    const metadataFiles = files.filter((file) => file.name.toLowerCase() === 'event.json')
    if (generation !== scanGeneration.current) {
      revokeClipUrls(nextGroups)
      return
    }

    setScanProgress(42)
    setScanStage('正在按时间戳匹配前、后、左右侧和左右柱摄像头')
    if (!nextGroups.length) {
      setScanError('没有找到可归组的 TeslaCam 录像。文件名需要类似“2026-07-22_18-42-16-front.mp4”。')
      setAppPhase('welcome')
      return
    }

    await wait(260)
    if (generation !== scanGeneration.current) {
      revokeClipUrls(nextGroups)
      return
    }

    revokeClipUrls(groupsRef.current)
    setGroups(nextGroups)
    const preferred = nextGroups.find((group) => CAMERA_ORDER.every((camera) => group.cameras[camera])) ?? nextGroups[0]
    setActiveId(preferred.id)
    setPlaying(false)
    setTime(0)
    setDuration(60)
    setBuildStatus('idle')
    setBuildProgress(0)
    setBuildMessage('等待自动重建')
    setBuildError('')
    setBevTimelineUrl(undefined)
    setViewerMode('bev')
    setPreset('top')
    setTrack(null)
    const completeCount = nextGroups.filter((group) => CAMERA_ORDER.every((camera) => group.cameras[camera])).length
    const videoCount = nextGroups.reduce((total, group) => total + CAMERA_ORDER.filter((camera) => group.cameras[camera]).length, 0)
    setScanProgress(72)
    setScanStage(`已归组 ${nextGroups.length} 个事件段，正在检查车辆状态与文件完整性`)

    const loadedTracks: Record<string, TelemetryTrack> = {}
    await Promise.all(telemetryFiles.map(async (file) => {
      try {
        loadedTracks[folderFromFile(file)] = await readTelemetryFile(file)
      } catch { /* Embedded SEI remains available as a fallback. */ }
    }))
    setTracksByFolder(loadedTracks)

    const loadedMetadata: Record<string, EventMetadata> = {}
    await Promise.all(metadataFiles.map(async (file) => {
      try {
        loadedMetadata[folderFromFile(file)] = JSON.parse(await file.text()) as EventMetadata
      } catch { /* A missing event.json does not block video reconstruction. */ }
    }))
    setEventMetadata(loadedMetadata)

    if (generation !== scanGeneration.current) return
    setScanSummary({
      folderName,
      fileCount: files.length,
      videoCount,
      completeCount,
      incompleteCount: nextGroups.length - completeCount,
      telemetryFound: telemetryFiles.length > 0,
    })
    setScanProgress(94)
    setScanStage('正在建立重建任务索引并选择第一组完整事件')
    await wait(320)
    if (generation !== scanGeneration.current) return
    setScanProgress(100)
    setScanStage('目录分析完成')
    await wait(220)
    if (generation === scanGeneration.current) setAppPhase('ready')
  }, [])

  const resetImport = () => {
    scanGeneration.current += 1
    Object.values(videoRefs.current).forEach((video) => video.pause())
    revokeClipUrls(groupsRef.current)
    groupsRef.current = []
    setGroups([])
    setActiveId(null)
    setScanSummary(null)
    setScanError('')
    setScanProgress(0)
    setTrack(createDemoTelemetry(DEMO_DURATION))
    setTracksByFolder({})
    setEventMetadata({})
    setAppPhase('welcome')
  }

  const openDemo = () => {
    scanGeneration.current += 1
    revokeClipUrls(groupsRef.current)
    groupsRef.current = []
    setGroups([])
    setActiveId(null)
    setTrack(createDemoTelemetry(DEMO_DURATION))
    setTracksByFolder({})
    setEventMetadata({})
    setTime(16.4)
    setDuration(DEMO_DURATION)
    setBuildStatus('ready')
    setBuildProgress(100)
    setBuildMessage('演示空间预览就绪')
    setBuildError('')
    setBevTimelineUrl(undefined)
    setViewerMode('bev')
    setPreset('top')
    setAppPhase('workspace')
  }

  const selectGroup = useCallback((id: string, resume = false) => {
    resumeAfterGroupChange.current = resume
    Object.values(videoRefs.current).forEach((video) => video.pause())
    setPlaying(false)
    setActiveId(id)
    setTime(0)
    setBuildStatus('idle')
    setBuildProgress(0)
    setBuildMessage('等待自动重建')
    setBuildError('')
    setBevTimelineUrl(undefined)
  }, [])

  useEffect(() => {
    if (previewActive || !activeClip || (appPhase !== 'ready' && appPhase !== 'workspace')) return
    let alive = true
    const controller = new AbortController()

    const applyStatus = (status: ReconstructionStatus) => {
      if (!alive) return
      setBuildStatus(status.state)
      setBuildProgress(status.progress)
      setBuildMessage(status.message)
      setBuildError(status.error ?? '')
      if (status.state === 'ready' && status.outputUrl) setBevTimelineUrl(status.outputUrl)
    }

    const readResponse = async (response: Response): Promise<ReconstructionStatus> => {
      const payload = await response.json() as ReconstructionStatus & { error?: string }
      if (!response.ok) throw new Error(payload.error || `本地重建服务返回 ${response.status}`)
      return payload
    }

    const run = async () => {
      setBuildStatus('queued')
      setBuildProgress(0)
      setBuildMessage('正在检查本地 BEV 缓存')
      setBuildError('')
      setBevTimelineUrl(undefined)

      let status = await readResponse(await fetch(`/api/bev/status?clip=${encodeURIComponent(activeClip)}`, {
        cache: 'no-store',
        signal: controller.signal,
      }))
      applyStatus(status)

      if (status.state === 'queued' && status.progress === 0) {
        status = await readResponse(await fetch('/api/bev/reconstruct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clip: activeClip, duration }),
          signal: controller.signal,
        }))
        applyStatus(status)
      }

      while (alive && status.state !== 'ready' && status.state !== 'error') {
        await wait(850)
        if (!alive) return
        status = await readResponse(await fetch(`/api/bev/status?clip=${encodeURIComponent(activeClip)}`, {
          cache: 'no-store',
          signal: controller.signal,
        }))
        applyStatus(status)
      }
    }

    void run().catch((error) => {
      if (!alive || controller.signal.aborted) return
      setBuildStatus('error')
      setBuildProgress(0)
      setBuildMessage('自动重建无法继续')
      setBuildError(error instanceof Error ? error.message : '本地重建服务不可用')
    })

    return () => {
      alive = false
      controller.abort()
    }
  }, [activeClip, appPhase, duration, previewActive])

  useEffect(() => {
    if (appPhase !== 'workspace' || !activeGroup) return
    const front = activeGroup.cameras.front
    if (!front) {
      setTrack(null)
      setTelemetryLoading(false)
      return
    }
    const supplied = telemetryForClip(tracksByFolder[activeGroup.folder] ?? null, front.filename)
    if (supplied?.samples.length) {
      setTrack(supplied)
      setTelemetryLoading(false)
      return
    }

    const generation = ++telemetryGeneration.current
    setTelemetryLoading(true)
    setTrack(null)
    void extractTelemetryFromVideo(front.file)
      .then((result) => {
        if (generation === telemetryGeneration.current) setTrack(result.samples.length ? result : null)
      })
      .catch(() => {
        if (generation === telemetryGeneration.current) setTrack(null)
      })
      .finally(() => {
        if (generation === telemetryGeneration.current) setTelemetryLoading(false)
      })
  }, [activeGroup, appPhase, tracksByFolder])

  const seek = useCallback((value: number) => {
    const next = Math.max(0, Math.min(duration, value))
    setTime(next)
    Object.values(videoRefs.current).forEach((video) => {
      if (Math.abs(video.currentTime - next) > 0.04) video.currentTime = next
    })
  }, [duration])

  const togglePlayback = useCallback(() => {
    const next = !playing
    if (next && time >= duration - 0.05) seek(0)
    setPlaying(next)
    Object.values(videoRefs.current).forEach((video) => {
      if (next) void video.play().catch(() => setPlaying(false))
      else video.pause()
    })
  }, [duration, playing, seek, time])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, select, textarea, button')) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault()
        seek(time - (event.shiftKey ? 5 : 1 / 30))
      } else if (event.code === 'ArrowRight') {
        event.preventDefault()
        seek(time + (event.shiftKey ? 5 : 1 / 30))
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [seek, time, togglePlayback])

  useEffect(() => {
    if (!playing) return
    let animation = 0
    let previous = performance.now()
    const tick = (now: number) => {
      if (activeGroup) {
        const master = videoRefs.current.front ?? Object.values(videoRefs.current)[0]
        if (master) {
          const masterTime = master.currentTime
          setTime(masterTime)
          Object.entries(videoRefs.current).forEach(([id, video]) => {
            if (id !== 'front' && Math.abs(video.currentTime - masterTime) > 0.11) video.currentTime = masterTime
          })
          if (masterTime >= duration - 0.04) {
            const index = groups.findIndex((group) => group.id === activeGroup.id)
            const nextGroup = groups[index + 1]
            if (nextGroup) {
              selectGroup(nextGroup.id, true)
            } else {
              setPlaying(false)
              Object.values(videoRefs.current).forEach((video) => video.pause())
            }
            return
          }
        }
      } else {
        const delta = Math.min(0.1, (now - previous) / 1000)
        previous = now
        setTime((current) => current + delta >= DEMO_DURATION ? 0 : current + delta)
      }
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [activeGroup, duration, groups, playing, selectGroup])

  const continueToWorkspace = () => {
    setAppPhase('workspace')
  }

  const moveGroup = (offset: number) => {
    if (!groups.length || !activeGroup) return
    const index = groups.findIndex((group) => group.id === activeGroup.id)
    const next = groups[(index + offset + groups.length) % groups.length]
    selectGroup(next.id)
  }

  if (appPhase !== 'workspace') {
    return (
      <OnboardingFlow
        phase={appPhase}
        progress={scanProgress}
        scanStage={scanStage}
        error={scanError}
        groups={groups}
        selectedId={activeId}
        summary={scanSummary}
        onFiles={(files) => { void handleFiles(files) }}
        onSelect={selectGroup}
        onContinue={continueToWorkspace}
        onReset={resetImport}
        onDemo={openDemo}
      />
    )
  }

  return (
    <div className="app-shell immersive-shell">
      <a className="skip-link" href="#scene-viewer">跳到现场回放</a>
      <header className="topbar">
        <div className="brand-mark"><span>S/R</span><strong>SCENE / REPLAY</strong></div>
        <div className="event-title"><CircleDot size={14} /><span>{eventMetadata[activeGroup?.folder ?? '']?.street || eventMetadata[activeGroup?.folder ?? '']?.city || activeGroup?.label || '示例事件'}</span><small>{activeGroup ? activeGroup.label : 'DEMO SESSION'}</small></div>
        <div className="topbar-actions"><button onClick={resetImport}><FolderOpen size={14} /><span>更换目录</span></button><div className="local-status"><CloudOff size={14} /><span>仅本地处理</span><i /></div></div>
      </header>

      <main className="immersive-workspace">
        <section className="viewer-stage" id="scene-viewer" tabIndex={-1} aria-label="现场回放工作区">
          <div className="viewer-toolbar">
            <div className="viewer-mode" role="group" aria-label="可视化模式">
              <button aria-pressed={viewerMode === 'bev'} className={viewerMode === 'bev' ? 'active' : ''} onClick={() => { setViewerMode('bev'); setPreset('top') }}><CarFront size={15} />BEV融合</button>
              <button aria-pressed={viewerMode === 'mosaic'} className={viewerMode === 'mosaic' ? 'active' : ''} onClick={() => setViewerMode('mosaic')}><LayoutGrid size={15} />六路回放</button>
              <button aria-pressed={viewerMode === 'surround'} className={viewerMode === 'surround' ? 'active' : ''} onClick={() => setViewerMode('surround')}><ScanLine size={15} />动态环景</button>
            </div>
            {viewerMode === 'bev' && (
              <div className="view-presets" role="group" aria-label="BEV 观察视角">
                {VIEW_PRESETS.map(({ id, label, icon: Icon }) => (
                  <button key={id} aria-pressed={preset === id} className={preset === id ? 'active' : ''} onClick={() => setPreset(id)} title={`${label}视角`}><Icon size={15} /><span>{label}</span></button>
                ))}
              </div>
            )}
          </div>

          {activeGroup && (
            <div className="scene-event-switcher">
              <button onClick={() => moveGroup(-1)} aria-label="上一事件段"><ChevronLeft size={17} /></button>
              <span><small>EVENT SEGMENT</small><strong>{groups.findIndex((group) => group.id === activeGroup.id) + 1} / {groups.length}</strong></span>
              <button onClick={() => moveGroup(1)} aria-label="下一事件段"><ChevronRight size={17} /></button>
            </div>
          )}

          <div className={`analysis-chip ${viewerMode !== 'bev' ? (Object.keys(videoElements).length ? 'ready' : 'queued') : buildStatus}`} title={viewerMode !== 'bev' ? '六路摄像头同步回放' : buildError || buildMessage}>
            <i />
            {viewerMode !== 'bev'
              ? `${Object.keys(videoElements).length}/6 路视频已对齐 · ${playbackRate}×`
              : buildStatus === 'building' || buildStatus === 'queued'
              ? `${buildMessage} · ${buildProgress}%`
              : buildStatus === 'error'
                ? `重建失败 · ${buildError || buildMessage}`
                : bevTimelineUrl
                  ? '六路 BEV 场景轨就绪'
                  : reconstructionUrl
                    ? '稀疏 SfM 点云就绪'
                    : buildMessage}
          </div>

          <Suspense fallback={(
            <div className="scene-canvas scene-engine-loading" role="status" aria-live="polite">
              <span /><strong>正在载入可视化引擎</strong>
            </div>
          )}>
            <SceneView
              time={time}
              preset={preset}
              videoElements={videoElements}
              hasImportedFootage={Boolean(activeGroup)}
              telemetry={currentTelemetry}
              mode={viewerMode}
              reconstructionUrl={reconstructionUrl}
              bevManifestUrl={bevManifestUrl}
              bevTimelineUrl={previewActive ? debugTimelineUrl : bevTimelineUrl}
              reconstructionState={buildStatus}
              reconstructionMessage={buildError || buildMessage}
              onSeek={seek}
              onInspect={(selection) => {
                setPlaying(false)
                Object.values(videoRefs.current).forEach((video) => video.pause())
                seek(selection.observation.timeSec)
                setEvidence(selection)
                setViewerMode('mosaic')
              }}
            />
          </Suspense>

          <MultiCameraReplay
            group={activeGroup}
            visible={viewerMode === 'mosaic'}
            evidence={evidence}
            time={time}
            registerVideo={registerVideo}
            onMetadata={refreshDuration}
          />

          <div className="scene-help">
            {viewerMode === 'mosaic'
              ? <><span>双击聚焦</span><i />空格播放 <i />方向键逐帧</>
              : viewerMode === 'surround'
              ? <><span>拖动环视</span><i />滚轮缩放 <i />未覆盖留空</>
              : <><span>拖动旋转</span><i />滚轮缩放 <i />右键平移</>}
          </div>
          <PlaybackDock
            group={activeGroup}
            metadata={eventMetadata[activeGroup?.folder ?? '']}
            sample={currentTelemetry}
            track={track}
            telemetryLoading={telemetryLoading}
            time={time}
            duration={duration}
            playing={playing}
            playbackRate={playbackRate}
            groups={groups}
            activeGroupId={activeGroup?.id ?? null}
            onToggle={togglePlayback}
            onSeek={seek}
            onPlaybackRate={setPlaybackRate}
            onSelectGroup={selectGroup}
          />
        </section>
      </main>
    </div>
  )
}

export default App
