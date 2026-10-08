#!/usr/bin/env python3
"""Measure camera intrinsics and ground-plane extrinsics from real footage.

The bundled seed rig guesses every camera's focal length, and those guesses are
about half the true value: it claims 82-95 degrees horizontal field of view
where the footage shows 47-70. Every inverse-perspective result built on it -
lane polylines, the fused ground texture, and the box-bottom range fallback -
is compressed to roughly half the true distance as a result.

This tool replaces the guesses with measurements. For each camera it samples
frames across a clip, runs MoGe-2 to obtain estimated intrinsics and a fitted
road plane, and writes the per-camera median of:

- `focalScale` and `principalPoint` from the estimated intrinsics,
- `pitchDeg` and `rollDeg` from the fitted road-plane normal.

Yaw, mounting origin and camera height stay as supplied: they are mechanical
quantities a monocular estimator cannot observe from one view, and the height in
particular is the anchor the metric scale is solved against.

Example:
    HF_HUB_OFFLINE=1 .recon-venv/bin/python tools/calibrate_cameras.py \\
      videos/2026-07-23_07-58-12 --clip 2026-07-23_07-52-37 \\
      --output calibration/tesla_hw4_measured.json
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch

from moge_depth import MetricDepthEstimator, fit_ground_plane
from reconstruct_bev import discover_videos, load_profile, read_frame

MIN_ACCEPTED_SAMPLES = 3


def discover_clips(root: Path, limit: int) -> list[tuple[Path, str]]:
    """Find complete six-camera clips under a TeslaCam directory tree."""
    found: list[tuple[Path, str]] = []
    for front in sorted(root.rglob("*-front.mp4")):
        clip = front.name[: -len("-front.mp4")]
        if len(discover_videos(front.parent, clip)) == 6:
            found.append((front.parent, clip))
        if len(found) >= limit:
            break
    return found


def measure_camera(
    estimator: MetricDepthEstimator,
    videos: list[Path],
    profile,
    times: list[float],
) -> dict[str, float] | None:
    import cv2

    focals: list[float] = []
    centers_x: list[float] = []
    centers_y: list[float] = []
    pitches: list[float] = []
    rolls: list[float] = []

    for video, time_sec in ((video, t) for video in videos for t in times):
        try:
            frame = read_frame(video, time_sec)
        except RuntimeError:
            continue
        source_h, source_w = frame.shape[:2]
        width = min(estimator.max_width, source_w)
        small = cv2.resize(frame, (width, int(round(source_h * width / source_w))), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        tensor = torch.tensor(rgb / 255.0, dtype=torch.float32, device=estimator.device).permute(2, 0, 1)
        with torch.no_grad():
            output = estimator.model.infer(tensor)

        intrinsics = output["intrinsics"].cpu().numpy()
        points = output["points"].cpu().numpy().astype(np.float32)
        valid = output["mask"].cpu().numpy().astype(bool) & np.isfinite(points).all(axis=-1)
        normal = output.get("normal")
        normal = normal.cpu().numpy().astype(np.float32) if normal is not None else None

        plane = fit_ground_plane(points, valid, normal, profile.pitch_deg, profile.height_m)
        if plane is None:
            continue
        focals.append(float(intrinsics[0, 0]))
        centers_x.append(float(intrinsics[0, 2]))
        centers_y.append(float(intrinsics[1, 2]))
        pitches.append(plane.pitch_deg)
        rolls.append(plane.roll_deg)

    if len(focals) < MIN_ACCEPTED_SAMPLES:
        return None
    return {
        "focalScale": round(float(np.median(focals)), 4),
        "principalPoint": [round(float(np.median(centers_x)), 4), round(float(np.median(centers_y)), 4)],
        "pitchDeg": round(float(np.median(pitches)), 3),
        "rollDeg": round(float(np.median(rolls)), 3),
        "samples": len(focals),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", type=Path, help="TeslaCam directory tree to search for clips")
    parser.add_argument("--clip", action="append", default=[], help="Clip timestamp; repeatable. Auto-discovered when omitted")
    parser.add_argument("--clip-limit", type=int, default=4, help="How many clips to sample when auto-discovering")
    parser.add_argument("--seed", type=Path, default=Path("calibration/tesla_hw4_seed.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=6, help="Frames sampled per clip")
    parser.add_argument("--start", type=float, default=4.0)
    parser.add_argument("--span", type=float, default=48.0)
    args = parser.parse_args()

    profile_raw, profiles = load_profile(args.seed)
    if args.clip:
        clips = [(args.folder, clip) for clip in args.clip]
    else:
        clips = discover_clips(args.folder, args.clip_limit)
    if not clips:
        raise SystemExit(f"no complete six-camera clips found under {args.folder}")

    videos_by_camera: dict[str, list[Path]] = {camera: [] for camera in profiles}
    for folder, clip in clips:
        found = discover_videos(folder, clip)
        missing = sorted(set(profiles) - set(found))
        if missing:
            print(f"skip {clip}: missing {', '.join(missing)}", flush=True)
            continue
        for camera, path in found.items():
            videos_by_camera[camera].append(path)
    print(f"sampling {len(clips)} clip(s) x {args.samples} frames", flush=True)

    times = [args.start + args.span * index / max(1, args.samples - 1) for index in range(args.samples)]
    estimator = MetricDepthEstimator()

    measured = json.loads(json.dumps(profile_raw))
    calibrated_cameras: list[str] = []
    for camera in sorted(videos_by_camera):
        result = measure_camera(estimator, videos_by_camera[camera], profiles[camera], times)
        entry = measured["cameras"][camera]
        if result is None:
            print(f"{camera:<12} no usable road plane; keeping seed values", flush=True)
            continue
        samples = result.pop("samples")
        seed_fov = 2 * math.degrees(math.atan(0.5 / entry["focalScale"]))
        measured_fov = 2 * math.degrees(math.atan(0.5 / result["focalScale"]))
        print(
            f"{camera:<12} focal {entry['focalScale']:.3f} -> {result['focalScale']:.3f} "
            f"({seed_fov:.1f} -> {measured_fov:.1f} deg hfov)  "
            f"pitch {entry['pitchDeg']:.1f} -> {result['pitchDeg']:.1f}  "
            f"roll {result['rollDeg']:+.1f}  n={samples}",
            flush=True,
        )
        entry.update(result)
        calibrated_cameras.append(camera)

    measured["name"] = "Tesla HW4 six-camera footage-estimated rig"
    measured["source"] = "moge2-footage-estimate"
    measured["factoryCalibrated"] = False
    measured["calibrated"] = len(calibrated_cameras) == len(profiles)
    measured["calibratedCameras"] = calibrated_cameras
    measured["notes"] = [
        "Focal length, principal point, pitch and roll are estimated from real footage with MoGe-2.",
        "Yaw, mounting origin and camera height are carried over from the seed rig.",
        "This is not Tesla factory calibration; metric positions remain approximate.",
        f"Measured from {len(clips)} clip(s) x {args.samples} frames: {', '.join(clip for _, clip in clips)}.",
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(measured, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({len(calibrated_cameras)}/{len(profiles)} cameras measured)")


if __name__ == "__main__":
    main()
