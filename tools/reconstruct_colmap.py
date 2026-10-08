#!/usr/bin/env python3
"""Run per-camera COLMAP SfM through the project-local pycolmap wheel.

The six TeslaCam views have little overlap with one another, so asking one
global mapper to solve them as a single rig tends to create false matches. This
script solves each camera's temporal sequence independently, scales its local
model from the vehicle speed, and merges the resulting clouds using the
approximate fixed camera directions. Replace those seed extrinsics with a
calibrated rig before treating the output as metric.

Example:
    .recon-venv/bin/python tools/reconstruct_colmap.py \
      videos/2026-07-23_07-31-15 --clip 2026-07-23_07-20-38 \
      --speed-kph 82 --output output/reconstruction/07-20-38-colmap
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import cv2
import numpy as np
import pycolmap

from reconstruct_scene import CAMERA_RE, camera_from_file, local_to_vehicle, read_frame, write_ply, Point


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("event_dir", type=Path)
    parser.add_argument("--clip", required=True)
    parser.add_argument("--speed-kph", type=float, default=50.0)
    parser.add_argument("--start", type=float, default=2.0)
    parser.add_argument("--interval", type=float, default=0.7)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--max-image-size", type=int, default=900)
    parser.add_argument("--output", type=Path, default=Path("output/reconstruction/colmap"))
    parser.add_argument("--keep-workspace", action="store_true")
    return parser.parse_args()


def transform_points(reconstruction: pycolmap.Reconstruction, camera: str, speed_kph: float, start: float, interval: float) -> list[Point]:
    registered = [image for image in reconstruction.images.values() if image.has_pose]
    if len(registered) < 3:
        return []
    first = next((image for image in registered if image.name.endswith("/0000.jpg")), registered[0])
    second = next((image for image in registered if image.name.endswith("/0001.jpg")), None)
    if second is None:
        ordered = sorted(registered, key=lambda image: image.name)
        second = ordered[1] if len(ordered) > 1 else None
    baseline = 1.0
    if second is not None:
        baseline = max(1e-3, float(np.linalg.norm(first.projection_center() - second.projection_center())))
    scale = max(0.35, speed_kph / 3.6 * interval) / baseline
    transform = first.cam_from_world().matrix()
    result: list[Point] = []
    for point in reconstruction.points3D.values():
        if point.error > 3.0:
            continue
        local = (transform[:, :3] @ point.xyz + transform[:, 3]) * scale
        if not np.all(np.isfinite(local)) or local[2] < 0.2 or local[2] > 140:
            continue
        if abs(local[1]) > 12:
            continue
        world = local_to_vehicle(local.reshape(1, 3), camera, start, speed_kph)[0]
        rgb = tuple(int(value) for value in point.color)
        result.append(Point(tuple(float(value) for value in world), rgb, camera, start))
    return result


def solve_camera(
    camera: str,
    video: Path,
    workspace: Path,
    speed_kph: float,
    start: float,
    interval: float,
    frame_count: int,
    max_image_size: int,
) -> tuple[list[Point], dict[str, object]]:
    images = workspace / "images" / camera
    images.mkdir(parents=True, exist_ok=True)
    for index in range(frame_count):
        frame = read_frame(video, start + index * interval)
        if frame is not None:
            cv2.imwrite(str(images / f"{index:04d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])

    image_count = len(list(images.glob("*.jpg")))
    if image_count < 3:
        return [], {"images": image_count, "points": 0, "status": "not-enough-frames"}
    database = workspace / "database.db"
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "SIMPLE_RADIAL"
    reader.default_focal_length_factor = 0.70
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.max_image_size = max_image_size
    extraction.num_threads = 2
    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = 2
    pycolmap.extract_features(database, images, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader, extraction_options=extraction)
    pycolmap.match_exhaustive(database, matching_options=matching)
    options = pycolmap.IncrementalPipelineOptions()
    options.num_threads = 2
    options.max_num_models = 1
    options.min_num_matches = 15
    options.min_model_size = 3
    options.ba_refine_focal_length = True
    models = pycolmap.incremental_mapping(database, images, workspace / "sparse", options=options)
    if not models:
        return [], {"images": image_count, "points": 0, "status": "no-model"}
    model = max(models.values(), key=lambda reconstruction: reconstruction.num_points3D())
    points = transform_points(model, camera, speed_kph, start, interval)
    model.export_PLY(workspace / "model.ply")
    return points, {
        "images": image_count,
        "registeredImages": model.num_reg_images(),
        "points3D": model.num_points3D(),
        "points": len(points),
        "meanReprojectionError": model.compute_mean_reprojection_error(),
        "status": "ok",
    }


def main() -> int:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    all_points: list[Point] = []
    report: dict[str, object] = {
        "stage": "per-camera-colmap-sfm",
        "event": str(args.event_dir),
        "clip": args.clip,
        "speedKph": args.speed_kph,
        "startSec": args.start,
        "intervalSec": args.interval,
        "frames": args.frames,
        "calibration": "approximate TeslaCam seed extrinsics; replace with calibrated rig",
        "cameras": {},
    }
    for camera in CAMERA_RE:
        video = next((file for file in args.event_dir.glob(f"{args.clip}-*.mp4") if camera_from_file(file) == camera), None)
        if video is None:
            report["cameras"][camera] = {"status": "missing"}
            continue
        workspace = args.output / "workspace" / camera
        points, camera_report = solve_camera(camera, video, workspace, args.speed_kph, args.start, args.interval, args.frames, args.max_image_size)
        all_points.extend(points)
        report["cameras"][camera] = camera_report
        if not args.keep_workspace and workspace.exists():
            shutil.rmtree(workspace)

    ply_path = args.output.with_suffix(".ply")
    write_ply(ply_path, all_points)
    report["pointCount"] = len(all_points)
    report["output"] = str(ply_path)
    args.output.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all_points else 2


if __name__ == "__main__":
    raise SystemExit(main())
