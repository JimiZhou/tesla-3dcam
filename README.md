# Scene / Replay

本地优先的 TeslaCam 多视角现场回放原型。它把六路录像、车辆状态、语义 BEV 和可拖动的动态环视放到同一条时间线上。

## 运行

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:4173` 后会进入三步引导：

1. 选择或拖入 TeslaCam 目录。
2. 应用按文件时间戳自动扫描，把同一时刻的多路摄像头画面归为一个事件段，并标出缺失的摄像头。
3. 选择一个事件段开始重建分析，默认进入 BEV 鸟瞰工作台，也可以切换到六路动态环视。

没有真实录像时可以从首页进入示例现场。当前识别以下文件名：

- `*-front.mp4`
- `*-back.mp4`（也兼容 `*-rear.mp4`）
- `*-left_repeater.mp4`
- `*-right_repeater.mp4`
- `*-left_pillar.mp4`
- `*-right_pillar.mp4`

导入视频通过浏览器本地 File API 读取；验收链接通过本机 Vite 服务读取工作区视频，不会上传到外部服务。

## 提取车辆状态

较新的 Tesla 固件会在驾驶中的 H.264 画面里通过 SEI 携带逐帧车辆状态，包括车速、方向盘角度、加速踏板、制动、转向灯、辅助驾驶状态、GPS、航向和三轴加速度。进入工作台后，浏览器会优先读取随目录导入的遥测 JSON；没有 JSON 时，会直接从当前前视 MP4 提取 SEI，因此不必预先生成旁车文件。也可以先用本地脚本导出：

```bash
npm run telemetry -- "/path/to/TeslaCam/SavedClips/event-folder"
```

脚本依赖 `ffmpeg` / `ffprobe`，默认在事件目录生成 `scene-replay-telemetry.json`。旧固件或停车状态的哨兵片段可能不含 SEI 数据，这是正常情况。播放底部的踏板、制动和转向灯使用图标状态：未触发时为灰色，触发时点亮，不用 `ON/OFF` 文本重复占用画面。

## 当前精度边界

当前工作台只保留两个主视图：

- `BEV 融合`：六路 YOLO 目标经过 MoGe-2 度量投影、跨相机去重、全局 Hungarian 关联和恒速 Kalman 跟踪后，显示在车辆坐标系中。前视车道使用持久轨迹和道路宽度拓扑筛选，短暂漏检不会让整组标线消失。
- `六路环视`：按摄像头朝向把前、后、左右重复器和左右柱视频映射到车辆周围的柱面；重叠边缘羽化并统一中性色调，没有录像覆盖的角度保持空白，不补画不存在的像素。它用于观察周围动态，不作为米制测量。

SEI 车速和 GPS 航向会参与自车运动补偿，减少车辆在播放中的相对漂移。前端还会对相邻半秒的场景帧插值，并淡化短暂预测状态。所有自动生成的时间轴必须通过结构与观测检查后才会显示“BEV 场景轨就绪”。

这仍不是 Tesla 工厂感知输出：相机内参（焦距、主点）和路面外参（俯仰、横滚）由 MoGe-2 **从实际录像估计**；偏航角、安装位置和相机高度沿用装配估计值；镜头畸变未建模；纯视觉也无法恢复被车体或摄像头盲区遮挡的内容。界面会明确标注“视频估计标定 · 非工厂参数”，可以用 `tools/validate_bev_timeline.py` 量化当前结果，而不能只凭画面宣称达到车机精度。

## 相机标定

`calibration/tesla_hw4_seed.json` 里的焦距是估计值，而且偏差很大：它声称每路相机水平视场 82–95°，实测只有 51–68°，焦距约差一倍。所有依赖逆透视的结果——车道线、融合地面纹理、框底测距回退——都会因此被压缩到真实距离的约一半，这正是研究文档记录的 12.8 m / 31.6 m 偏差的来源。

`tools/calibrate_cameras.py` 用真实录像估计并替换这些初始猜测值。它对每路相机跨多个片段采样若干帧，跑 MoGe-2 取估计内参和拟合路面，写出各项的中位数。结果会明确标记为 `footage-estimated`，不代表工厂标定：

```bash
HF_HUB_OFFLINE=1 .recon-venv/bin/python tools/calibrate_cameras.py videos \
  --clip-limit 6 --output calibration/tesla_hw4_measured.json
```

测量项为 `focalScale`、`principalPoint`、`pitchDeg`、`rollDeg`。偏航角、安装位置和相机离地高度保持原值——它们是单目估计无法从单一视角观测的机械量，其中高度还是度量尺度的锚定基准。只要 `calibration/tesla_hw4_measured.json` 存在，所有工具和本地重建服务都会自动优先使用它。

## 六路语义 BEV

`tools/reconstruct_bev.py` 会在同一时刻读取六个摄像头，把可见地面投影到车辆坐标系，并用 YOLO 检测车辆、卡车、公交车、行人、骑行者和摩托车。

目标测距使用 MoGe-2 度量深度（`tools/moge_depth.py`）。每路画面推理一张度量点图后，用法线筛出路面像素并**拟合完整的路面平面**（法向 + 距离），而不只是求一个尺度系数：平面法向给出该相机真实的俯仰和横滚，平面距离对上已知离地高度给出度量尺度。这样地面点在整个有效距离上都落在零高度，不会像只做尺度锚定时那样随距离逐渐沉到路面以下。拟合结果需要足够的支撑像素并且不能偏离种子装配太远才会被采纳——紧贴护栏、看不到路面的柱侧相机会被判为不可用并逐帧逐相机回退到框底射线。

拟合出的三维坐标还要过两道门限：接触点必须贴近路面（离地 -1.0 至 1.5 m，滤掉护栏、天桥和反光造成的伪目标），并且不能超出该相机的有效距离（`maxRangeM`，广角侧视和柱侧相机在远处几乎没有分辨率）。每个目标的 `rangeSource` 字段标记实际来源（`moge2` / `ground-ray`）。加 `--no-depth` 可跳过深度模型。

车道线在**度量俯视校正图**上提取：先用相机模型把前视画面反透视到正射的路面视图，再用列直方图找到起点、滑动窗口向远处追踪各条标线。在校正后的视图里标线就是固定横向位置上的近似竖直条带，比原先在图像空间做 Hough 拟合稳健得多——后者依赖一整排手调阈值，而那些阈值是针对错误焦距调出来的。

```bash
.recon-venv/bin/pip install ultralytics
.recon-venv/bin/python tools/reconstruct_bev.py \
  videos/2026-07-23_07-31-15 \
  --clip 2026-07-23_07-20-38 \
  --time 8 \
  --output output/bev/07-20-38-8s
```

输出包括：

- `*.jpg`：六路真实像素的地面投影纹理，只作为可追溯证据层。
- `*-semantic.png`：白底车机式语义 BEV 预览。
- `*.json`：车辆坐标、车道、置信度、来源摄像头和标定状态。
- `*-detections/`：六路检测框调试帧。

整段一分钟动态场景轨使用：

```bash
.recon-venv/bin/python tools/reconstruct_bev_timeline.py \
  videos/2026-07-23_07-31-15 \
  --clip 2026-07-23_07-20-38 \
  --duration 60 --step 0.5 \
  --output output/bev/07-20-38-bev-timeline.json
```

浏览器会根据视频时间在相邻 BEV 帧之间插值，因此目标不会每秒跳动。`语义`图层是默认车机视图；`六路纹理`图层可用于核对目标和车道是否确实来自原始画面。当前种子标定位于 `calibration/tesla_hw4_seed.json`，界面会明确标记为“种子标定”，不会把近似距离宣传成真实测量值。

生成结果可以用 `tools/validate_bev_timeline.py` 量化验收，不必只靠肉眼看播放：

```bash
.recon-venv/bin/python tools/validate_bev_timeline.py public/reconstruction/*-bev-timeline.json
```

它报告每帧目标数与车道数、确认轨迹条数、帧间平均位移，并检查目标穿模、轨迹瞬移、重复 ID、无效数值、超范围目标、非递增时间轴、MoGe-2/射线回退占比和明显错误的车道间距。生成器会把 `qualityGate` 写入时间轴，本地开发服务还会独立复核缓存；质量未通过时不会再向界面返回“BEV 场景轨就绪”。

时间轴在写盘前会经过 `tools/bev_tracker.py` 的时序融合：带协方差的恒速 Kalman 预测、各向异性测量噪声、全局 Hungarian 分配、相邻视场接力门控、SEI 自车运动补偿，以及 tentative / confirmed / coasting 轨迹状态。车道使用长时域持久轨迹、全局匹配和道路宽度拓扑筛选。当前 schema 为 v4，旧缓存会由本地服务拒绝并自动重建。

前端只使用时间轴插值，失配目标保持最后位置并淡出，不再将世界速度用于相对位置外推。移除了渲染时阻尼，暂停、顺播和拖动到同一时刻时坐标一致。开发时可用 `?timeline=/reconstruction/xx-bev-timeline.json` 直接预览某条已生成的场景轨。

## 稀疏 SfM 实验链路

当前仓库已经提供一条真实视频的第一阶段重建脚本。它从相邻时刻的真实帧中提取 SIFT 特征、估计相对位姿、使用车速设置尺度，并把六路时间序列点云合并为 PLY。需要先安装隔离环境：

```bash
python3 -m venv .recon-venv
.recon-venv/bin/pip install -r tools/requirements-reconstruction.txt
.recon-venv/bin/python tools/reconstruct_scene.py \
  videos/2026-07-23_07-31-15 \
  --clip 2026-07-23_07-20-38 \
  --speed-kph 82 \
  --output output/reconstruction/07-20-38
```

这一步输出的是稀疏点云，不是密集网格或训练完成的 3DGS；脚本内的 TeslaCam 外参仍是近似种子，正式版本需要用棋盘格/AprilTag 做每台车的内参、畸变和外参标定。这条实验链路保留供离线研究，不再作为当前工作台的独立可视化入口。

可以把 PLY 再投影成 BEV 的几何交换文件。该步骤只做栅格化和去重，不会虚构车辆/行人标签：

```bash
.recon-venv/bin/python tools/build_bev_scene.py \
  public/reconstruction/07-20-38.ply \
  --output output/reconstruction/07-20-38-bev.json
```

若要运行 COLMAP 多帧版本：

```bash
.recon-venv/bin/python tools/reconstruct_colmap.py \
  videos/2026-07-23_07-31-15 \
  --clip 2026-07-23_07-20-38 \
  --speed-kph 82 \
  --output output/reconstruction/07-20-38-colmap
```

它会按摄像头独立建模，避免左右视角之间的错误匹配；当前仍使用近似固定外参，生成的结果需要经过标定后才能进入密集 MVS/3DGS。

## 在线项目调研（2026-07）

本次检索没有找到“直接读取 TeslaCam 六路 MP4 并还原成车机级 BEV”的开源项目。找到的项目分别覆盖文件合并、通用多摄像头 BEV/occupancy 网络和通用几何/渲染基础设施：

| 项目 | 直接解决 TeslaCam 六路 BEV | 可复用内容 | 主要限制 |
| --- | --- | --- | --- |
| [tesla_dashcam](https://github.com/ehendrix23/tesla_dashcam) | 否 | 六路文件识别、同步、合成布局 | 目标是合成视频，不做几何、检测或标定 |
| [BEVFormer](https://arxiv.org/abs/2203.17270) / [代码](https://github.com/fundamentalvision/BEVFormer) | 否 | 多摄像头时空 BEV 表征、3D 检测和地图分割 | 需要相机标定、训练数据和模型推理环境 |
| [SurroundOcc](https://arxiv.org/abs/2303.09551) | 否 | 多摄像头 3D occupancy 体素预测 | 依赖 nuScenes 等训练分布；不能直接把 TeslaCam 当作已标定输入 |
| [BEVFusion](https://arxiv.org/abs/2205.13542) / [代码](https://github.com/mit-han-lab/bevfusion) | 否 | 统一 BEV 空间中的多传感器融合 | 典型输入包含 LiDAR/相机标定，仓库目前已归档 |
| [COLMAP](https://github.com/colmap/colmap) / pycolmap | 部分 | SfM/MVS 位姿和稀疏/稠密几何 | 六路视野重叠有限；不能单独提供语义目标和车机风格 BEV |
| [gsplat](https://github.com/nerfstudio-project/gsplat) | 部分 | CUDA 3D Gaussian Splatting 光栅化 | 需要稳定位姿、内外参和足够多的多视角训练帧 |

因此项目采用“先稳定可验证的 BEV 语义，再评估可选外观层”的顺序：

```text
六路 MP4 + SEI → 同步抽帧/去畸变 → 内外参标定
        → 深度/检测/跟踪 → 车辆坐标系 occupancy/BEV
        → 车道、车辆、卡车、行人语义层 → BEV 回放 / 六路柱面环视
```

当前前端已建立 `CalibrationProfile`、`BevObject` 和 `BevSceneFrame` 数据边界，并接入本地检测、深度、跟踪和质量门。后续改进重点是镜头畸变标定、跨摄像头外观关联和专用的车道/可行驶区域分割，而不是增加更多近似视图。

## 生产构建

```bash
npm run build
npm run preview
```

## 2026-10-02 修复版验收

运行 `npm run dev` 后打开：

[真实六路录像验收，54 秒](http://127.0.0.1:4173/?timeline=/reconstruction/acceptance-07-54-38.json&time=54)

验收场景轨覆盖 `2026-07-23_07-54-38` 的 48–59.5 秒（0.5 秒间隔）。六路原视频自动从本机工作区加载。可旋转、缩放、暂停、慢放；点击车辆后，右侧“查看原画面”会暂停并定位到对应摄像头和检测框。超出重建窗口时不显示冻结的旧场景。

修复包括：速度语义、确定性播放、车道曲线与自车运动补偿、真实道路历史、基于可见表面与类别尺寸先验的中心修正、跨镜融合的一相机一观测约束、来源框保留、空结果验收、缓存指纹、串行重建队列。车道实线表示当前观测，虚线表示历史/预测，未知区域留空；原视频完整显示，不裁剪。

“结构检查通过”不代表米制精度通过。界面显示的检测分数不是位置准确率，滤波 σ 不包含全部标定误差。尺寸和初始车辆朝向仍使用先验，尚未实现实例分割、有向三维框联合优化、工厂标定或跨分钟统一 ID；2 Hz 也不能保证捕捉到所有快速事件。

导入其他片段时，旧 v3 缓存会自动失效并重新推理。缓存指纹包含算法源码、标定与 YOLO 权重，以及源视频名称/大小/修改时间；模型仓库中的深度权重若单独变化，应清理缓存再重建。首次计算比播放耗时，任务按顺序运行以避免抢占显存。

回归验证：

```bash
.recon-venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
npm run build
npm run lint
```
