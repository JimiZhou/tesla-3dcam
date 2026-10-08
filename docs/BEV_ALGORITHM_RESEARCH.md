# TeslaCam BEV algorithm review

Research snapshot: 2026-07-25. The current `YOLO box bottom -> seeded ground plane`
pipeline is retained only as a diagnostic baseline. It is not a valid metric BEV
reconstruction method.

Implementation status 2026-07-27: the local pipeline now implements footage-derived
intrinsics/road-plane fitting, MoGe-2 metric observations, covariance-aware Kalman
tracking, Hungarian global assignment, adjacent-camera handoff gates, SEI ego-motion
compensation, and persistent lane tracks. The single largest remaining systematic
error source is the incomplete camera calibration rather than the temporal tracker.

Implementation update 2026-08-20: adjacent-camera overlap observations are no longer
discarded after seam deduplication. They are fused using depth-source and
distance-aware precision weights, carried into the tracker with multi-camera
provenance, and assigned lower measurement covariance when corroborated by two views.
Vulnerable road users use a separate near-field confirmation threshold so small real
pedestrian/cyclist detections can reach temporal confirmation without relaxing the
long-range or ground-ray quality gates.

**Footage-estimated intrinsics.** The seed rig claimed 82-95 degrees horizontal field of
view per camera; MoGe-2's estimated intrinsics, taken as the median over 6 clips
x 6 frames, put every camera at 51-68 degrees. The seed focal lengths are roughly
half the footage-derived estimate, which compresses every inverse-perspective result to about
half its expected range and accounts for the 12.8 m / 31.6 m disagreement noted
below. `tools/calibrate_cameras.py` now estimates focal length, principal point,
pitch and roll from footage and writes `calibration/tesla_hw4_measured.json`,
which every tool prefers when present. The front camera estimate is 51.5 degrees,
consistent with the ~50 degree Model 3 forward main camera. This profile is not
Tesla factory calibration; yaw, mounting origin and height remain seeded.

**Ground-plane fit.** `tools/moge_depth.py` runs MoGe-2 ViT-S per camera and
fits the full road plane (normal plus offset) by iteratively reweighted SVD, not
just a scale factor. The normal supplies each camera's real pitch and roll and
the offset against the known camera height supplies the metric scale, so ground
points stay at zero height across the usable range instead of sinking below the
road with distance. Fits are rejected on weak support or large deviation from the
seed rig, which is what a pillar camera staring at a barrier produces; those fall
back to the ground ray per frame and per camera. Object range is the lower-band
median of the scaled point map, gated on contact height (-1.0 to 1.5 m) and on a
per-camera usable range.

**Lane extraction** moved from image-space Hough to a metric top-down
rectification with column-histogram seeding and sliding-window tracing, since the
Hough thresholds had been tuned against the wrong focal length.

**Tracking.** `tools/bev_tracker.py` uses a covariance-aware constant-velocity Kalman
filter, Mahalanobis gating, Hungarian global assignment, adjacent-camera handoff
constraints, confirmed/coasting states, and SEI speed/GPS-heading ego-motion
compensation. Per-track uncertainty is written as `positionStdM`. Vehicle heading is
derived from stable track velocity when observable. A full constant-turn-rate IMM,
appearance embeddings, visual-odometry fallback, and occupancy remain open.

## Why the current result drifts

- MoGe-2 supplies a lower-body metric contact observation, but it is still transformed
  through approximate camera extrinsics. Small pitch/yaw errors turn into large range
  and lateral errors, especially for distant targets.
- The same road user can be independently detected by several cameras. The tracker now
  gates handoff by covariance and adjacent fields of view, but it still has no learned
  appearance embedding for visually confirming identity across a long occlusion.
- Heading comes from stable track velocity, not a fitted 3D vehicle orientation, so it
  remains uncertain for stationary or newly confirmed targets.
- SEI speed/GPS heading now compensates ego motion, but clips without usable telemetry
  still lack a visual-odometry fallback.
- Class-size priors make a transient `bus` detection ten metres long, so one bad label
  can cover the ego vehicle.

On a real frame at `2026-07-23_07-53-37 + 5s`, the old projection placed the nearest
front vehicle at 12.8 m. MoGe-2's metric point map placed its lower body surface around
31.6 m. That magnitude of disagreement explains the visible jumps.

## Online projects evaluated

| Project | Useful capability | Blocking requirement / decision |
| --- | --- | --- |
| [Sparse4D v3](https://github.com/HorizonRobotics/Sparse4D) | End-to-end multi-camera 3D detection and tracking; temporal instances | Best server-side target, but uses custom CUDA and reports training on 8x RTX 3090. Not a local Apple-MPS backend. MIT. |
| [StreamPETR](https://github.com/exiawsh/StreamPETR) | Online multi-view temporal 3D detection and tracking; 12.5 FPS reported on RTX 3090 | Requires nuScenes-style six-camera calibration and NVIDIA stack. Repository has no detected SPDX license. |
| [BEVFormer](https://github.com/fundamentalvision/BEVFormer) | Camera-only temporal BEV representation and 3D detection | Small model reports about 10.5 GB GPU memory and still needs calibrated views plus a tracker. Apache-2.0. |
| [SurroundOcc](https://github.com/weiyithu/SurroundOcc) | Dense multi-camera occupancy and a private-data input template | Requires `intrinsic` and `lidar2img`; training/standard inference is an 8-GPU CUDA workflow. Apache-2.0. |
| [SelfOcc](https://github.com/huang-yh/SelfOcc) / [GaussianFormer](https://github.com/huang-yh/GaussianFormer) | Video/pose-supervised or Gaussian occupancy | Promising occupancy layer after calibration, but current code requires CUDA, spconv, and custom ops. Not the first repair. |
| [DrivingGaussian](https://github.com/VDIGPKU/DrivingGaussian), [EmerNeRF](https://github.com/NVlabs/EmerNeRF), [SplatAD](https://github.com/carlinds/splatad) | Photorealistic dynamic novel-view rendering | These reconstruct appearance after poses/calibration (and often LiDAR/CUDA). They do not by themselves produce stable metric road-user tracks. |
| [VGGT](https://github.com/facebookresearch/vggt) / [MASt3R-SLAM](https://github.com/rmurai0610/MASt3R-SLAM) | Camera poses, depth, point maps, dense SLAM | Useful offline pose refinement, but VGGT is a 1B model and MASt3R-SLAM requires CUDA. Too heavy as the default 16 GB M1 backend. |
| [MoGe-2](https://github.com/microsoft/MoGe) | Metric point maps, depth, normals, and estimated intrinsics from one image | Selected local geometry backbone. The 35M ViT-S normal model is MIT licensed and ran successfully on Apple MPS. |
| [ByteTrack](https://github.com/FoundationVision/ByteTrack) | Strong detection association baseline | Selected as a reference for association logic; final tracker must operate in 3D and compensate ego motion. MIT. |

No maintained open-source project was found that directly accepts an arbitrary TeslaCam
folder and produces Tesla-style, stable six-camera BEV playback without calibration or
model adaptation.

## Verified local MoGe-2 probe

Host: Apple M1 Pro, 16 GB unified memory, Metal/MPS available.

- Model: `Ruicheng/moge-2-vits-normal`, 35M parameters, 140 MB checkpoint, MIT.
- Input: a real front-camera frame, resized to 518 x 335, 900 inference tokens.
- Output: metric `points.exr`, `depth.exr`, normal map, mask, and estimated FOV.
- Estimated FOV: 45.44 degrees horizontal, 30.31 degrees vertical.
- Warm inference: 0.73-0.75 s per frame on MPS after model load and first warm-up.
- The model emitted an MPS autocast warning and correctly fell back to float32; output
  generation completed without an error.

Probe files are under `output/moge-probe/` and are derived from local source video.

## Replacement pipeline

1. **Geometry per camera**
   - Run persistent MoGe-2 ViT-S at 1 Hz (or adaptively around road users).
   - Use its point map and predicted intrinsics instead of box-bottom ray/plane range.
   - Fit the road plane with RANSAC and normalize scale/orientation using known camera
     height; refine each seeded camera pitch/roll over many frames.

2. **Object observation**
   - Detect/segment road users.
   - Estimate a robust 3D contact centroid from the lower mask and MoGe point map.
   - Estimate dimensions from visible 3D points with class priors as soft constraints,
     not fixed boxes. Infer heading from 3D shape and later from velocity.

3. **Six-camera fusion**
   - Transform observations into the ego frame with the refined rig.
   - Fuse same-timestamp observations by class compatibility and Mahalanobis distance;
     retain covariance and provenance instead of dropping duplicates by a fixed radius.

4. **Stable temporal tracking**
   - Use a constant-turn-rate/velocity EKF or IMM tracker.
   - Compensate ego translation/yaw with SEI speed, steering, heading/acceleration, and
     visual odometry when telemetry is incomplete.
   - Use global assignment, confirmed/tentative/lost states, and camera handoff
     appearance embeddings. Render predicted tracks briefly through occlusion.

5. **Static scene and occupancy**
   - Fuse ground, barriers, lanes, and static point maps into a rolling TSDF/voxel map.
   - Add GaussianFormer/SelfOcc or a Sparse4D server backend only after camera geometry
     has been validated. Keep photorealistic Gaussian replay as a separate optional
     representation, not the source of metric object locations.

6. **Quality gates**
   - Reject a clip when calibration residuals or ground-plane variance exceed limits.
   - Report range uncertainty in the artifact.
   - Measure track jitter, ID switches, impossible overlap, and reprojection error before
     labeling a result `BEV ready`.

Current implementation note: the local generator and Vite service enforce a hard
gate for MoGe-2 usage, malformed geometry, duplicate IDs, impossible range/speed,
interpenetration, excessive ground-ray fallback and lane-spacing failures. The
artifact carries per-track covariance-derived position uncertainty. Calibration
residuals, ID-switch scoring and reprojection error remain open because there is no
ground-truth identity or factory camera model for these clips.

## Deployment split

- **Local default:** MoGe-2 ViT-S + detector/segmenter + 3D EKF/IMM + rolling geometry.
- **NVIDIA quality backend:** fine-tuned Sparse4D v3 for direct 3D detection/tracking,
  followed by an occupancy model. The web artifact format remains the same.
- **Optional cinematic backend:** dynamic Gaussian/NeRF reconstruction after calibrated
  camera trajectories are available.
