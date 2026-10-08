#!/usr/bin/env python3
"""Metric depth backend for the BEV pipeline, based on MoGe-2.

MoGe-2 predicts a metric point map, validity mask and surface normals from a
single image. Two things are wrong with using that output directly: its absolute
scale from one frame is only approximate, and the seed rig's pitch/roll are
guesses. Both are corrected here by fitting the road plane in the point map:

- the fitted plane normal gives the camera's real pitch and roll, so ground
  points land at zero height across the whole useful range instead of drifting
  below the road with distance;
- the fitted plane distance against the known camera height gives the metric
  scale.

A fit is only trusted when it has broad support and stays near the seed rig.
Cameras that mostly see a barrier (the pillars in dense traffic) fail that test
and fall back to the old box-bottom ground ray, per frame and per camera.

The model runs on Apple MPS when available and falls back to CPU. Loading is
lazy so `reconstruct_bev.py --no-depth` never imports torch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


DEFAULT_MODEL = "Ruicheng/moge-2-vits-normal"

# The ViT backbone resamples internally to a fixed token budget, so a smaller
# input mainly saves decode/copy time without changing runtime much. 1152 px
# keeps distant vehicles a few pixels wide for the box-band median.
DEFAULT_MAX_WIDTH = 1152

# Plane-fit acceptance. A camera staring at a barrier can still produce a
# confident-looking plane from a few thousand pixels, so support is gated hard.
MIN_GROUND_PIXELS = 25_000
MIN_GROUND_FRACTION = 0.02
MAX_PITCH_DEVIATION_DEG = 10.0
MAX_ROLL_DEG = 8.0
PLANE_INLIER_M = 0.18
PLANE_ITERATIONS = 3
# Anchor over a longer span than objects are read at, so residual tilt is
# minimised where vehicles actually sit rather than only in the near field.
GROUND_FIT_MAX_Z = 40.0

MIN_BOX_PIXELS = 20

# Extrinsics drift slowly (suspension, load), so per-camera pitch/roll are
# smoothed across frames; a single noisy frame cannot swing the geometry.
EXTRINSIC_EMA = 0.25


@dataclass
class GroundPlane:
    """Road plane recovered from one frame's point map."""

    pitch_deg: float
    roll_deg: float
    scale: float
    pixels: int


@dataclass
class DepthFrame:
    """Scaled camera-frame point map plus mapping from source pixels."""

    points: np.ndarray  # (H, W, 3) float32, metric, OpenCV camera axes
    valid: np.ndarray  # (H, W) bool
    plane: GroundPlane
    sx: float  # source-image x -> map column factor
    sy: float

    @property
    def scale(self) -> float:
        return self.plane.scale


def camera_axes(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0):
    """Camera right/down/forward axes expressed in the vehicle frame.

    Vehicle frame is x-right, y-up, z-forward; the camera frame is the OpenCV
    x-right, y-down, z-forward convention, so the mapping flips handedness.
    """
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    roll = math.radians(roll_deg)
    right = np.array([math.cos(yaw), 0.0, -math.sin(yaw)])
    forward = np.array([
        math.sin(yaw) * math.cos(pitch),
        -math.sin(pitch),
        math.cos(yaw) * math.cos(pitch),
    ])
    up = np.array([
        math.sin(yaw) * math.sin(pitch),
        math.cos(pitch),
        math.cos(yaw) * math.sin(pitch),
    ])
    down = -up
    if roll:
        rolled_right = math.cos(roll) * right - math.sin(roll) * down
        down = math.sin(roll) * right + math.cos(roll) * down
        right = rolled_right
    return right, down, forward


def camera_point_to_vehicle(
    camera_point: np.ndarray,
    yaw_deg: float,
    pitch_deg: float,
    roll_deg: float,
    height_m: float,
    origin_m: tuple[float, float],
) -> np.ndarray:
    right, down, forward = camera_axes(yaw_deg, pitch_deg, roll_deg)
    return (
        np.array([origin_m[0], height_m, origin_m[1]])
        + camera_point[0] * right
        + camera_point[1] * down
        + camera_point[2] * forward
    )


def fit_ground_plane(
    points: np.ndarray,
    valid: np.ndarray,
    normal: np.ndarray | None,
    seed_pitch_deg: float,
    height_m: float,
) -> GroundPlane | None:
    """Robustly fit the road plane and convert it to pitch/roll/scale.

    Returns None when the fit lacks support or disagrees with the seed rig,
    which is the signal for the caller to use the ground-ray fallback.
    """
    seed_pitch = math.radians(seed_pitch_deg)
    height, width = valid.shape
    rows = np.arange(height)[:, None]
    candidates = valid & np.broadcast_to(rows >= int(height * 0.55), valid.shape)
    candidates &= points[..., 2] < GROUND_FIT_MAX_Z
    if normal is not None:
        # Road normal in camera space is approximately (0, -cos p, -sin p).
        expected = np.array([0.0, -math.cos(seed_pitch), -math.sin(seed_pitch)], dtype=np.float32)
        candidates &= (normal @ expected) > 0.80
    if int(np.count_nonzero(candidates)) < MIN_GROUND_PIXELS:
        return None

    selected = points[candidates]
    if normal is not None:
        unit = np.median(normal[candidates], axis=0).astype(np.float64)
    else:
        unit = np.array([0.0, -math.cos(seed_pitch), -math.sin(seed_pitch)])
    norm = np.linalg.norm(unit)
    if norm < 1e-6:
        return None
    unit /= norm

    # Iteratively reweight: keep points close to the current plane and refit by
    # SVD, so lane paint, shadows and the odd car bumper drop out.
    inliers = selected
    for _ in range(PLANE_ITERATIONS):
        offset = float(np.median(inliers @ unit))
        residual = np.abs(selected @ unit - offset)
        inliers = selected[residual < PLANE_INLIER_M]
        if len(inliers) < MIN_GROUND_PIXELS:
            return None
        centered = inliers - inliers.mean(axis=0)
        # Smallest singular direction of a planar patch is its normal.
        refined = np.linalg.svd(centered, full_matrices=False)[2][-1]
        if refined @ unit < 0:
            refined = -refined
        unit = refined / np.linalg.norm(refined)

    if len(inliers) / float(height * width) < MIN_GROUND_FRACTION:
        return None

    predicted_height = float(np.median(-(inliers @ unit)))
    if not 0.4 < predicted_height < 5.0:
        return None
    scale = height_m / predicted_height
    if not 0.4 < scale < 2.5:
        return None

    pitch_deg = math.degrees(math.asin(float(np.clip(-unit[2], -1.0, 1.0))))
    roll_deg = math.degrees(math.atan2(float(unit[0]), float(-unit[1])))
    if abs(pitch_deg - seed_pitch_deg) > MAX_PITCH_DEVIATION_DEG or abs(roll_deg) > MAX_ROLL_DEG:
        return None
    return GroundPlane(pitch_deg=pitch_deg, roll_deg=roll_deg, scale=scale, pixels=len(inliers))


class MetricDepthEstimator:
    def __init__(self, model_name: str = DEFAULT_MODEL, max_width: int = DEFAULT_MAX_WIDTH) -> None:
        import torch
        from moge.model.v2 import MoGeModel

        self._torch = torch
        self.device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        self.model = MoGeModel.from_pretrained(model_name).to(self.device).eval()
        self.max_width = max_width
        self._extrinsics: dict[str, tuple[float, float]] = {}

    def infer(
        self,
        frame_bgr: np.ndarray,
        pitch_deg: float,
        height_m: float,
        camera: str = "",
    ) -> DepthFrame | None:
        import cv2

        torch = self._torch
        source_h, source_w = frame_bgr.shape[:2]
        if source_w > self.max_width:
            width = self.max_width
            height = int(round(source_h * width / source_w))
            small = cv2.resize(frame_bgr, (width, height), interpolation=cv2.INTER_AREA)
        else:
            small = frame_bgr
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        tensor = torch.tensor(rgb / 255.0, dtype=torch.float32, device=self.device).permute(2, 0, 1)
        with torch.no_grad():
            output = self.model.infer(tensor)

        points = output["points"].cpu().numpy().astype(np.float32)
        valid = output["mask"].cpu().numpy().astype(bool)
        normal = output.get("normal")
        normal = normal.cpu().numpy().astype(np.float32) if normal is not None else None
        valid &= np.isfinite(points).all(axis=-1)

        plane = fit_ground_plane(points, valid, normal, pitch_deg, height_m)
        if plane is None:
            return None
        if camera:
            plane = self._smooth_extrinsics(camera, plane)
        return DepthFrame(
            points=points * plane.scale,
            valid=valid,
            plane=plane,
            sx=small.shape[1] / source_w,
            sy=small.shape[0] / source_h,
        )

    def _smooth_extrinsics(self, camera: str, plane: GroundPlane) -> GroundPlane:
        previous = self._extrinsics.get(camera)
        if previous is None:
            self._extrinsics[camera] = (plane.pitch_deg, plane.roll_deg)
            return plane
        pitch = previous[0] + EXTRINSIC_EMA * (plane.pitch_deg - previous[0])
        roll = previous[1] + EXTRINSIC_EMA * (plane.roll_deg - previous[1])
        self._extrinsics[camera] = (pitch, roll)
        return GroundPlane(pitch_deg=pitch, roll_deg=roll, scale=plane.scale, pixels=plane.pixels)


def box_ground_position(
    depth: DepthFrame,
    box: tuple[float, float, float, float],
    yaw_deg: float,
    height_m: float,
    origin_m: tuple[float, float],
) -> tuple[float, float, float] | None:
    """Vehicle-frame (x, y, z) of a detection from the scaled point map.

    Samples the lower band of the detection box (body sill and wheels), takes
    the per-axis median to reject background and window pixels, and rotates the
    camera-frame point into the vehicle frame using the fitted plane. The
    returned y is height above the road, which the caller gates on: a real road
    user's contact patch sits near zero.
    """
    x1, y1, x2, y2 = box
    column_lo = int((x1 + (x2 - x1) * 0.18) * depth.sx)
    column_hi = int((x2 - (x2 - x1) * 0.18) * depth.sx)
    row_hi = int(y2 * depth.sy)
    row_lo = int((y2 - max(6.0, (y2 - y1) * 0.30)) * depth.sy)
    height, width = depth.valid.shape
    column_lo, column_hi = max(0, column_lo), min(width, column_hi)
    row_lo, row_hi = max(0, row_lo), min(height, row_hi)
    if column_hi - column_lo < 2 or row_hi - row_lo < 1:
        return None
    patch_valid = depth.valid[row_lo:row_hi, column_lo:column_hi]
    if int(np.count_nonzero(patch_valid)) < MIN_BOX_PIXELS:
        return None
    patch = depth.points[row_lo:row_hi, column_lo:column_hi][patch_valid]
    camera_point = np.median(patch, axis=0)
    if not np.isfinite(camera_point).all() or camera_point[2] <= 0.3:
        return None

    position = camera_point_to_vehicle(
        camera_point, yaw_deg, depth.plane.pitch_deg, depth.plane.roll_deg, height_m, origin_m,
    )
    return float(position[0]), float(position[1]), float(position[2])
