import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Connect, Plugin, ResolvedConfig } from 'vite'

type JobState = 'queued' | 'building' | 'ready' | 'error'

interface ReconstructionJob {
  clip: string
  state: JobState
  progress: number
  completed: number
  total: number
  message: string
  outputUrl?: string
  error?: string
  startedAt: number
  updatedAt: number
  process?: ChildProcessWithoutNullStreams
}

interface ArtifactCandidate {
  filename: string
  url: string
  validationError?: string
}

interface CachedValidation {
  mtimeMs: number
  fingerprint: string
  error?: string
}

const CLIP_PATTERN = /^20\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/

function json(response: ServerResponse, statusCode: number, value: unknown) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 16_384) throw new Error('请求内容过大')
  }
  return body ? JSON.parse(body) as Record<string, unknown> : {}
}

async function findFile(directory: string, filename: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return candidate
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename)
      if (nested) return nested
    }
  }
  return null
}

async function matchingLegacyArtifact(filename: string, clip: string): Promise<boolean> {
  if (!(await exists(filename))) return false
  try {
    const payload = JSON.parse(await readFile(filename, 'utf8')) as { clip?: string }
    return payload.clip === clip
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject stale or physically implausible cache files before the UI can call
 * them ready. This deliberately duplicates the generator's small set of hard
 * quality limits: status checks stay fast and do not need to start Python.
 */
export function validateTimelinePayload(value: unknown, clip: string): string | undefined {
  if (!isRecord(value)) return 'BEV 缓存不是有效的 JSON 对象'
  if (value.clip !== clip) return 'BEV 缓存与当前事件时间戳不匹配'
  if (typeof value.schemaVersion !== 'number' || value.schemaVersion !== 4) return 'BEV 缓存使用旧跟踪器，需要重新构建'
  if (typeof value.startSec === 'number' && value.startSec !== 0) return '缓存只覆盖部分片段，请重新构建整段'
  if (value.tracker !== 'kalman-road-history-v2') return 'BEV 缓存缺少全局 Kalman 跟踪结果'
  if (value.rangeBackend !== 'moge2') return '缓存未使用 MoGe-2 米制深度，已拒绝旧的地面射线结果'
  if (isRecord(value.qualityGate) && value.qualityGate.passed === false) {
    const reasons = Array.isArray(value.qualityGate.reasons)
      ? value.qualityGate.reasons.filter((item): item is string => typeof item === 'string')
      : []
    return `BEV 质量门未通过${reasons.length ? `：${reasons.slice(0, 2).join('；')}` : ''}`
  }
  if (!Array.isArray(value.frames) || value.frames.length < 2) return 'BEV 缓存没有足够的同步帧'

  let observations = 0
  let previousTime = -Infinity
  let mogeRanges = 0
  let fallbackRanges = 0
  const lastPosition = new Map<string, { time: number; x: number; z: number }>()
  for (const rawFrame of value.frames) {
    if (!isRecord(rawFrame) || typeof rawFrame.timeSec !== 'number' || !Number.isFinite(rawFrame.timeSec)) {
      return 'BEV 缓存包含无效时间戳'
    }
    if (rawFrame.timeSec <= previousTime) return 'BEV 缓存时间轴不是严格递增的'
    previousTime = rawFrame.timeSec
    if (!Array.isArray(rawFrame.objects) || !Array.isArray(rawFrame.lanes)) return 'BEV 缓存帧结构不完整'

    observations += rawFrame.objects.length + rawFrame.lanes.length
    for (const lane of rawFrame.lanes) {
      if (!Array.isArray(lane) || lane.length < 2) return 'BEV 车道结构无效'
      let previousZ = -Infinity
      for (const point of lane) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'BEV 车道包含无效坐标'
        if (point[1] <= previousZ) return 'BEV 车道纵向坐标不是递增的'
        previousZ = point[1]
      }
    }
    const seenIds = new Set<string>()
    const positions: Array<{ x: number; z: number }> = []
    for (const rawObject of rawFrame.objects) {
      if (!isRecord(rawObject) || typeof rawObject.id !== 'string' || !rawObject.id) return 'BEV 目标缺少稳定轨迹编号'
      if (seenIds.has(rawObject.id)) return 'BEV 单帧包含重复轨迹编号'
      seenIds.add(rawObject.id)
      const numeric = [rawObject.x, rawObject.z, rawObject.width, rawObject.length, rawObject.confidence, rawObject.heading]
      if (!numeric.every((item) => typeof item === 'number' && Number.isFinite(item))) return 'BEV 目标包含非有限几何数值'
      const x = rawObject.x as number
      const z = rawObject.z as number
      const width = rawObject.width as number
      const length = rawObject.length as number
      if ((rawObject.confidence as number) < 0 || (rawObject.confidence as number) > 1) return 'BEV 检测分数无效'
      if (Math.hypot(x, z) > 120 || width <= 0 || width > 5 || length <= 0 || length > 20) return 'BEV 目标几何超出物理范围'
      if (positions.some((other) => ((x - other.x) / 1.9) ** 2 + ((z - other.z) / 3) ** 2 < 1)) {
        return 'BEV 同一帧存在互相穿透的车辆轨迹'
      }
      positions.push({ x, z })
      const previous = lastPosition.get(rawObject.id)
      if (previous) {
        const dt = rawFrame.timeSec - previous.time
        if (dt > 0 && Math.hypot(x - previous.x, z - previous.z) / dt > 80) return 'BEV 轨迹包含不可能的瞬移'
      }
      lastPosition.set(rawObject.id, { time: rawFrame.timeSec, x, z })
      if (rawObject.rangeSource === 'moge2') mogeRanges += 1
      else fallbackRanges += 1
    }
  }
  if (!observations) return '没有可用目标或车道观测，请核对源视频'
  if (mogeRanges + fallbackRanges > 0 && fallbackRanges / (mogeRanges + fallbackRanges) > 0.35) {
    return 'BEV 目标过多依赖低精度地面射线距离'
  }
  return undefined
}

const PIPELINE_FILES = [
  'tools/bev_version.py', 'tools/bev_tracker.py', 'tools/moge_depth.py',
  'tools/reconstruct_bev.py', 'tools/reconstruct_bev_timeline.py',
  'tools/validate_bev_timeline.py',
]

export async function inputFingerprints(root: string, clip: string): Promise<{ pipeline: string; source: string }> {
  const hash = createHash('sha256')
  for (const file of PIPELINE_FILES) hash.update(file + '\n').update(await readFile(path.join(root, file)))
  const measured = path.join(root, 'calibration/tesla_hw4_measured.json')
  const calibration = await exists(measured) ? measured : path.join(root, 'calibration/tesla_hw4_seed.json')
  hash.update('calibration\n').update(await readFile(calibration))
  hash.update('model\n').update(await readFile(path.join(root, 'yolo11n.pt')))
  const front = await findFile(path.join(root, 'videos'), `${clip}-front.mp4`)
  if (!front) throw new Error('找不到缓存对应的源视频')
  const folder = path.dirname(front)
  const names = (await readdir(folder)).filter((name) => name.startsWith(clip + '-') && /-(front|back|rear|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i.test(name)).sort()
  const entries = await Promise.all(names.map(async (name) => {
    const metadata = await stat(path.join(folder, name))
    return [name, metadata.size, Math.floor(metadata.mtimeMs / 1000)]
  }))
  return { pipeline: hash.digest('hex'), source: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

export function bevReconstructionPlugin(): Plugin {
  let config: ResolvedConfig
  const jobs = new Map<string, ReconstructionJob>()
  const children = new Set<ChildProcessWithoutNullStreams>()
  const pending: Array<() => void> = []
  const pump = () => { if (!children.size) pending.shift()?.() }
  const validationCache = new Map<string, CachedValidation>()

  const candidateFor = async (filename: string, url: string, clip: string): Promise<ArtifactCandidate> => {
    const details = await stat(filename)
    let fingerprints
    try { fingerprints = await inputFingerprints(config.root, clip) } catch (error) {
      return { filename, url, validationError: error instanceof Error ? error.message : '缓存输入校验失败' }
    }
    const fingerprint = fingerprints.pipeline + fingerprints.source
    const cached = validationCache.get(filename)
    if (cached?.mtimeMs === details.mtimeMs && cached.fingerprint === fingerprint) return { filename, url, validationError: cached.error }
    let validationError: string | undefined
    try {
      const payload = JSON.parse(await readFile(filename, 'utf8'))
      validationError = validateTimelinePayload(payload, clip)
      if (!validationError && (payload.pipelineFingerprint !== fingerprints.pipeline || payload.sourceFingerprint !== fingerprints.source)) {
        validationError = '算法、标定或源视频已改变，需要重新构建'
      }
    } catch {
      validationError = 'BEV 缓存 JSON 已损坏'
    }
    validationCache.set(filename, { mtimeMs: details.mtimeMs, fingerprint, error: validationError })
    return { filename, url, validationError }
  }

  const artifactFor = async (clip: string): Promise<ArtifactCandidate | null> => {
    const outputDirectory = path.join(config.root, 'public', 'reconstruction')
    const filename = path.join(outputDirectory, `${clip}-bev-timeline.json`)
    if (await exists(filename)) {
      const details = await stat(filename)
      return candidateFor(filename, `/reconstruction/${clip}-bev-timeline.json?v=${Math.round(details.mtimeMs)}`, clip)
    }

    const timeKey = clip.match(/_(\d{2}-\d{2}-\d{2})$/)?.[1]
    const legacyFilename = timeKey ? path.join(outputDirectory, `${timeKey}-bev-timeline.json`) : ''
    if (legacyFilename && await matchingLegacyArtifact(legacyFilename, clip)) {
      const details = await stat(legacyFilename)
      return candidateFor(legacyFilename, `/reconstruction/${timeKey}-bev-timeline.json?v=${Math.round(details.mtimeMs)}`, clip)
    }
    return null
  }

  const publicJob = (job: ReconstructionJob) => ({
    clip: job.clip,
    state: job.state,
    progress: job.progress,
    completed: job.completed,
    total: job.total,
    message: job.message,
    outputUrl: job.outputUrl,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  })

  const readyJob = async (clip: string): Promise<ReconstructionJob | null> => {
    const artifact = await artifactFor(clip)
    if (!artifact || artifact.validationError) return null
    const current = jobs.get(clip)
    const ready: ReconstructionJob = {
      clip,
      state: 'ready',
      progress: 100,
      completed: current?.completed ?? current?.total ?? 0,
      total: current?.total ?? 0,
      message: 'BEV 场景轨就绪 · 几何精度待核对',
      outputUrl: artifact.url,
      startedAt: current?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    jobs.set(clip, ready)
    return ready
  }

  const startJob = async (clip: string, duration: number): Promise<ReconstructionJob> => {
    const cached = await readyJob(clip)
    if (cached) return cached

    const existing = jobs.get(clip)
    if (existing && (existing.state === 'queued' || existing.state === 'building')) return existing

    const videosRoot = path.join(config.root, 'videos')
    const frontVideo = await findFile(videosRoot, `${clip}-front.mp4`)
    const total = Math.max(1, Math.ceil(duration / 0.5))
    const now = Date.now()
    const job: ReconstructionJob = {
      clip,
      state: 'queued',
      progress: 2,
      completed: 0,
      total,
      message: '正在定位六路源视频',
      startedAt: now,
      updatedAt: now,
    }
    jobs.set(clip, job)

    if (!frontVideo) {
      job.state = 'error'
      job.progress = 0
      job.error = `本地服务未在工作区 videos/ 中找到 ${clip}-front.mp4`
      job.message = '无法定位源视频'
      job.updatedAt = Date.now()
      return job
    }

    const pythonCandidates = [
      path.join(config.root, '.recon-venv', 'bin', 'python'),
      'python3',
    ]
    const python = await exists(pythonCandidates[0]) ? pythonCandidates[0] : pythonCandidates[1]
    const outputFilename = path.join(config.root, 'public', 'reconstruction', `${clip}-bev-timeline.json`)
    // The measured rig replaces the seed rig's focal guesses, which are about
    // half the true value and compress every ground projection accordingly.
    const measured = path.join(config.root, 'calibration', 'tesla_hw4_measured.json')
    const calibration = await exists(measured)
      ? measured
      : path.join(config.root, 'calibration', 'tesla_hw4_seed.json')
    const args = [
      path.join(config.root, 'tools', 'reconstruct_bev_timeline.py'),
      path.dirname(frontVideo),
      '--clip', clip,
      '--duration', duration.toFixed(3),
      '--step', '0.5',
      '--calibration', calibration,
      '--model', path.join(config.root, 'yolo11n.pt'),
      '--output', outputFilename,
    ]

    const launch = () => {
      const child = spawn(python, args, {
        cwd: config.root,
        // The MoGe checkpoint is cached locally; offline mode keeps model
        // loading from stalling behind proxy environments.
        env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      children.add(child)
      job.process = child
      job.state = 'building'
      job.progress = 4
      job.message = '正在载入检测模型与六路视频'
      job.updatedAt = Date.now()

      let stdoutBuffer = ''
      let stderrTail = ''
      const consumeLine = (line: string) => {
        const match = line.match(/([\d.]+)s objects=(\d+) lanes=(\d+)/)
        if (!match) return
        const timeSec = Number(match[1])
        job.completed = Math.min(job.total, Math.round(timeSec / 0.5) + 1)
        job.progress = Math.min(96, 5 + Math.round((job.completed / job.total) * 90))
        job.message = `同步时间点 ${job.completed}/${job.total} · 目标 ${match[2]} · 车道 ${match[3]}`
        job.updatedAt = Date.now()
      }
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        lines.forEach(consumeLine)
      })
      child.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-6_000)
      })
      child.on('error', (error) => {
        job.state = 'error'
        job.progress = 0
        job.error = error.message
        job.message = '重建进程启动失败'
        job.updatedAt = Date.now()
        children.delete(child)
      })
      child.on('close', async (code) => {
        children.delete(child)
        delete job.process
        if (stdoutBuffer) consumeLine(stdoutBuffer)
        const artifact = await artifactFor(clip).catch(() => null)
        if (code === 0 && artifact && !artifact.validationError) {
          job.state = 'ready'
          job.progress = 100
          job.completed = Math.max(job.completed, job.total)
          job.message = 'BEV 场景轨就绪 · 几何精度待核对'
          job.outputUrl = artifact.url
          delete job.error
        } else {
          job.state = 'error'
          job.progress = 0
          job.message = '六路重建失败'
          job.error = artifact?.validationError || stderrTail.trim().split(/\r?\n/).slice(-4).join(' · ') || `重建进程退出码 ${code ?? 'unknown'}`
        }
        job.updatedAt = Date.now()
        pump()
      })
    }
    job.message = children.size ? '等待前一段重建完成' : job.message
    pending.push(launch)
    pump()

    return job
  }

  const middleware: Connect.NextHandleFunction = async (request, response, next) => {
    if (!request.url?.startsWith('/api/bev/')) return next()
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    const clipFromQuery = requestUrl.searchParams.get('clip') ?? ''

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/api/bev/sources') {
        if (!CLIP_PATTERN.test(clipFromQuery)) return json(response, 400, { error: '无效片段' })
        const front = await findFile(path.join(config.root, 'videos'), `${clipFromQuery}-front.mp4`)
        if (!front) return json(response, 404, { error: '未找到源视频' })
        const folder = path.dirname(front)
        const ids: Record<string, string> = { front: 'front', back: 'rear', rear: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'leftPillar', right_pillar: 'rightPillar' }
        const cameras = (await readdir(folder)).flatMap((filename) => {
          if (!filename.startsWith(clipFromQuery + '-')) return []
          const suffix = filename.slice(clipFromQuery.length + 1).replace(/\.mp4$/i, '')
          if (!ids[suffix]) return []
          const relative = path.relative(config.root, path.join(folder, filename))
          return [{ camera: ids[suffix], filename, url: '/' + relative.split(path.sep).map(encodeURIComponent).join('/') }]
        })
        return json(response, 200, { cameras })
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/bev/status') {
        if (!CLIP_PATTERN.test(clipFromQuery)) return json(response, 400, { error: '无效的片段时间戳' })
        const ready = await readyJob(clipFromQuery)
        const stored = jobs.get(clipFromQuery)
        const current = ready ?? (stored?.state === 'ready' ? undefined : stored)
        return json(response, 200, current ? publicJob(current) : {
          clip: clipFromQuery,
          state: 'queued',
          progress: 0,
          completed: 0,
          total: 0,
          message: '等待自动重建',
          updatedAt: Date.now(),
        })
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/bev/reconstruct') {
        const body = await readBody(request)
        const clip = typeof body.clip === 'string' ? body.clip : ''
        if (!CLIP_PATTERN.test(clip)) return json(response, 400, { error: '无效的片段时间戳' })
        const requestedDuration = typeof body.duration === 'number' ? body.duration : 60
        const duration = Math.min(600, Math.max(1, Number.isFinite(requestedDuration) ? requestedDuration : 60))
        const job = await startJob(clip, duration)
        return json(response, job.state === 'error' ? 422 : 202, publicJob(job))
      }

      return json(response, 404, { error: '未知的 BEV API' })
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : '本地重建服务异常' })
    }
  }

  const install = (server: { middlewares: Connect.Server; httpServer?: { once(event: 'close', callback: () => void): unknown } | null }) => {
    server.middlewares.use(middleware)
    server.httpServer?.once('close', () => {
      pending.length = 0
      children.forEach((child) => child.kill('SIGTERM'))
      children.clear()
    })
  }

  return {
    name: 'tesla-bev-local-reconstruction',
    configResolved(resolved) {
      config = resolved
    },
    configureServer(server) {
      install(server)
    },
    configurePreviewServer(server) {
      install(server)
    },
  }
}
