#!/usr/bin/env python3
"""Build a sparse, metric-ish TeslaCam scene from synchronized video frames.

This is intentionally a conservative first reconstruction stage. It performs
temporal two-view SfM per camera, uses the recorded/estimated vehicle speed to
set scale, transforms each camera cloud into a common vehicle frame, and writes
an ASCII PLY plus a small manifest. It is not a dense 3DGS trainer.

Example:
    .recon-venv/bin/python tools/reconstruct_scene.py \
      videos/2026-07-23_07-31-15 --clip 2026-07-23_07-20-38 \
      --speed-kph 82 --output output/reconstruction/07-20-38
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np


CAMERA_RE = {
    "front": re.compile(r"-front\.mp4$", re.I),
    "rear": re.compile(r"-(?:back|rear)\.mp4$", re.I),
    "left": re.compile(r"-left_repeater\.mp4$", re.I),
    "right": re.compile(r"-right_repeater\.mp4$", re.I),
    "leftPillar": re.compile(r"-left_pillar\.mp4$", re.I),
    "rightPillar": re.compile(r"-right_pillar\.mp4$", re.I),
}

# Approximate fixed TeslaCam mounting directions. These are seed extrinsics,
# not a substitute for a checkerboard calibration session.
CAMERA_EXTRINSICS = {
    "front": ((0.0, 1.42, 0.0), 0.0),
    "rear": ((0.0, 1.42, 0.0), math.pi),
    "left": ((-0.95, 1.25, 0.72), math.pi * 0.72),
    "right": ((0.95, 1.25, 0.72), -math.pi * 0.72),
    "leftPillar": ((-0.90, 1.35, -0.42), math.pi / 2),
    "rightPillar": ((0.90, 1.35, -0.42), -math.pi / 2),
}


@dataclass
class Point:
    xyz: tuple[float, float, float]
    rgb: tuple[int, int, int]
    camera: str
    time_sec: float


def read_frame(path: Path, time_sec: float) -> np.ndarray | None:
    """Decode a single frame without asking OpenCV to open the full 2.7 GB clip."""
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{time_sec:.3f}",
        "-i", str(path), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0 or not result.stdout:
        return None
    image = cv2.imdecode(np.frombuffer(result.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)
    return image


def resize_for_features(image: np.ndarray, max_width: int) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    scale = min(1.0, max_width / width)
    if scale == 1.0:
        return image, 1.0
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), scale


def camera_from_file(path: Path) -> str | None:
    for camera, pattern in CAMERA_RE.items():
        if pattern.search(path.name):
            return camera
    return None


def vehicle_speed(speed_kph: float, time_sec: float) -> np.ndarray:
    """Vehicle trajectory in the scene frame: +z is behind, -z is ahead."""
    return np.array([0.0, 0.0, -(speed_kph / 3.6) * time_sec], dtype=np.float64)


def local_to_vehicle(points: np.ndarray, camera: str, time_sec: float, speed_kph: float) -> np.ndarray:
    """Map OpenCV camera coordinates (x right, y down, z forward) to scene axes."""
    origin, yaw = CAMERA_EXTRINSICS[camera]
    x_local = points[:, 0]
    y_local = points[:, 1]
    z_local = points[:, 2]
    world_x = math.cos(yaw) * x_local + math.sin(yaw) * z_local
    world_z = math.sin(yaw) * x_local - math.cos(yaw) * z_local
    result = np.column_stack([world_x, -y_local, world_z])
    result += np.array(origin, dtype=np.float64)
    result += vehicle_speed(speed_kph, time_sec)
    return result


def estimate_pair(
    first: np.ndarray,
    second: np.ndarray,
    camera: str,
    time_sec: float,
    interval: float,
    speed_kph: float,
    max_width: int,
) -> tuple[np.ndarray, np.ndarray] | None:
    first, scale = resize_for_features(first, max_width)
    second, _ = resize_for_features(second, max_width)
    gray_first = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_second = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=3500, contrastThreshold=0.015)
    key_first, desc_first = sift.detectAndCompute(gray_first, None)
    key_second, desc_second = sift.detectAndCompute(gray_second, None)
    if desc_first is None or desc_second is None:
        return None

    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc_first, desc_second, k=2)
    good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < 0.72 * pair[1].distance]
    if len(good) < 32:
        return None
    points_first = np.float32([key_first[m.queryIdx].pt for m in good])
    points_second = np.float32([key_second[m.trainIdx].pt for m in good])
    height, width = first.shape[:2]
    # Keep the lower image band where roadway, barriers and vehicles live.
    # Sky-only matches are geometrically unstable and otherwise dominate a
    # sparse cloud with bright, nearly coplanar points.
    ground_roi = (points_first[:, 1] > height * 0.28) & (points_second[:, 1] > height * 0.28)
    points_first = points_first[ground_roi]
    points_second = points_second[ground_roi]
    if len(points_first) < 32:
        return None
    focal = 0.90 * width
    intrinsics = np.array([[focal, 0.0, width / 2], [0.0, focal, height / 2], [0.0, 0.0, 1.0]], dtype=np.float64)
    essential, inlier_mask = cv2.findEssentialMat(
        points_first, points_second, intrinsics, method=cv2.RANSAC,
        prob=0.999, threshold=1.0,
    )
    if essential is None or inlier_mask is None:
        return None
    _, rotation, translation, pose_mask = cv2.recoverPose(
        essential, points_first, points_second, intrinsics, mask=inlier_mask,
    )
    valid = pose_mask.ravel() > 0
    points_first = points_first[valid]
    points_second = points_second[valid]
    if len(points_first) < 24:
        return None

    # Re-use the recovered pose for a much denser optical-flow sample. SIFT
    # gives a stable pose but only a few hundred points; Lucas-Kanade adds
    # roadway and barrier texture without pretending it is a dense surface.
    roi_mask = np.zeros_like(gray_first)
    roi_mask[int(gray_first.shape[0] * 0.28):, :] = 255
    corners = cv2.goodFeaturesToTrack(
        gray_first, maxCorners=2600, qualityLevel=0.006, minDistance=7,
        blockSize=7, mask=roi_mask,
    )
    if corners is not None:
        tracked, status, error = cv2.calcOpticalFlowPyrLK(
            gray_first, gray_second, corners, None,
            winSize=(31, 31), maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
        )
        if tracked is not None and status is not None and error is not None:
            flow_first = corners.reshape(-1, 2)
            flow_second = tracked.reshape(-1, 2)
            flow_keep = (
                (status.reshape(-1) > 0) & (error.reshape(-1) < 40.0)
                & (flow_second[:, 0] >= 0) & (flow_second[:, 0] < gray_first.shape[1])
                & (flow_second[:, 1] >= 0) & (flow_second[:, 1] < gray_first.shape[0])
            )
            points_first = np.vstack([points_first, flow_first[flow_keep]])
            points_second = np.vstack([points_second, flow_second[flow_keep]])

    # recoverPose returns a unit translation. The real distance travelled over
    # this interval supplies the scale, which is also recorded in the manifest.
    travelled = max(0.35, speed_kph / 3.6 * interval)
    projection_first = intrinsics @ np.hstack([np.eye(3), np.zeros((3, 1))])
    projection_second = intrinsics @ np.hstack([rotation, translation * travelled])
    homogeneous = cv2.triangulatePoints(projection_first, projection_second, points_first.T, points_second.T)
    homogeneous_w = homogeneous[3:]
    local_points = (homogeneous[:3] / np.where(np.abs(homogeneous_w) < 1e-8, 1e-8, homogeneous_w)).T
    second_points = (rotation @ local_points.T + translation * travelled).T
    depth_first = local_points[:, 2]
    depth_second = second_points[:, 2]
    reproj_first = projection_first @ np.column_stack([local_points, np.ones(len(local_points))]).T
    reproj_w = reproj_first[2:]
    reproj_first = (reproj_first[:2] / np.where(np.abs(reproj_w) < 1e-8, 1e-8, reproj_w)).T
    reproj_error = np.linalg.norm(reproj_first - points_first, axis=1)
    keep = (
        (depth_first > 0.2) & (depth_second > 0.2)
        & (depth_first < 100.0) & (np.abs(local_points[:, 1]) < 10.0)
        & (np.linalg.norm(local_points[:, :2], axis=1) < 90.0)
        & (reproj_error < 3.5)
    )
    if int(keep.sum()) < 18:
        return None
    colors = first[np.clip(points_first[:, 1].astype(int), 0, height - 1), np.clip(points_first[:, 0].astype(int), 0, width - 1)]
    # OpenCV stores BGR; PLY stores RGB.
    colors = colors[:, ::-1]
    world_points = local_to_vehicle(local_points[keep], camera, time_sec, speed_kph)
    return world_points, colors[keep]


def write_ply(path: Path, points: Iterable[Point]) -> None:
    point_list = list(points)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        handle.write("ply\nformat ascii 1.0\n")
        handle.write(f"element vertex {len(point_list)}\n")
        handle.write("property float x\nproperty float y\nproperty float z\n")
        handle.write("property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
        for point in point_list:
            x, y, z = point.xyz
            r, g, b = point.rgb
            handle.write(f"{x:.5f} {y:.5f} {z:.5f} {r} {g} {b}\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("event_dir", type=Path)
    parser.add_argument("--clip", default=None, help="Timestamp stem, e.g. 2026-07-23_07-20-38")
    parser.add_argument("--speed-kph", type=float, default=50.0)
    parser.add_argument("--start", type=float, default=5.0)
    parser.add_argument("--interval", type=float, default=0.22)
    parser.add_argument("--pairs", type=int, default=4)
    parser.add_argument("--max-width", type=int, default=1280)
    parser.add_argument("--output", type=Path, default=Path("output/reconstruction/scene"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.event_dir.is_dir():
        raise SystemExit(f"事件目录不存在: {args.event_dir}")
    videos: dict[str, Path] = {}
    for file in sorted(args.event_dir.glob("*.mp4")):
        if args.clip and not file.name.startswith(args.clip):
            continue
        camera = camera_from_file(file)
        if camera:
            videos[camera] = file
    if not videos:
        raise SystemExit("没有找到六路 TeslaCam MP4，请检查 --clip 或事件目录")

    points: list[Point] = []
    report: dict[str, object] = {
        "stage": "temporal-sfm-sparse",
        "event": str(args.event_dir),
        "clip": args.clip,
        "speedKph": args.speed_kph,
        "intervalSec": args.interval,
        "pairs": args.pairs,
        "cameras": {},
        "calibration": "approximate TeslaCam seed extrinsics; replace with checkerboard calibration",
    }
    for camera, path in videos.items():
        camera_count = 0
        for pair_index in range(args.pairs):
            time_sec = args.start + pair_index * args.interval
            first = read_frame(path, time_sec)
            second = read_frame(path, time_sec + args.interval)
            if first is None or second is None:
                continue
            result = estimate_pair(first, second, camera, time_sec, args.interval, args.speed_kph, args.max_width)
            if result is None:
                continue
            world_points, colors = result
            for xyz, rgb in zip(world_points, colors):
                points.append(Point(tuple(float(x) for x in xyz), tuple(int(x) for x in rgb), camera, time_sec))
            camera_count += len(world_points)
        report["cameras"][camera] = {"file": path.name, "points": camera_count}

    write_ply(args.output.with_suffix(".ply"), points)
    report["pointCount"] = len(points)
    report["output"] = str(args.output.with_suffix(".ply"))
    args.output.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if points else 2


if __name__ == "__main__":
    raise SystemExit(main())
