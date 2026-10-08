#!/usr/bin/env python3
"""Fuse synchronized TeslaCam frames into a ground-plane BEV texture.

The projection is geometric and reproducible: every BEV pixel is transformed
to the vehicle frame, intersected with the ground plane and sampled from every
camera that can see it. Camera weights are feathered by viewing angle and image
edge distance. The bundled profile is an explicit visual seed, not a claim of
Tesla factory calibration.

Example:
    .recon-venv/bin/python tools/reconstruct_bev.py \
      videos/2026-07-23_07-31-15 --clip 2026-07-23_07-20-38 \
      --time 8 --output output/bev/07-20-38-8s
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


CAMERA_PATTERNS = {
    "front": re.compile(r"-front\.mp4$", re.I),
    "rear": re.compile(r"-(?:back|rear)\.mp4$", re.I),
    "left": re.compile(r"-left_repeater\.mp4$", re.I),
    "right": re.compile(r"-right_repeater\.mp4$", re.I),
    "leftPillar": re.compile(r"-left_pillar\.mp4$", re.I),
    "rightPillar": re.compile(r"-right_pillar\.mp4$", re.I),
}


@dataclass
class CameraProfile:
    yaw_deg: float
    pitch_deg: float
    height_m: float
    origin_m: tuple[float, float]
    focal_scale: float
    principal_point: tuple[float, float]
    priority: float
    max_range_m: float = 60.0
    roll_deg: float = 0.0


# A detection's ground-contact point must sit near the road plane. The window is
# asymmetric: plane residual and high sills push the sampled band up more often
# than a real contact patch dips below the road.
MIN_CONTACT_HEIGHT_M = -1.0
MAX_CONTACT_HEIGHT_M = 1.5


OBJECT_DIMENSIONS = {
    "vehicle": (1.9, 4.5),
    "truck": (2.5, 8.0),
    "bus": (2.6, 10.5),
    "pedestrian": (0.7, 0.7),
    "cyclist": (0.8, 1.8),
    "motorcycle": (0.8, 2.1),
}

YOLO_CLASS_MAP = {
    "car": "vehicle",
    "truck": "truck",
    "bus": "bus",
    "person": "pedestrian",
    "bicycle": "cyclist",
    "motorcycle": "motorcycle",
}

_DETECTOR_CACHE: dict[str, object] = {}
_DEPTH_CACHE: dict[str, object] = {}


def load_depth_estimator(model_name: str | None = None):
    """Lazily build the MoGe estimator; returns None when unavailable."""
    key = model_name or "default"
    if key in _DEPTH_CACHE:
        return _DEPTH_CACHE[key]
    try:
        from moge_depth import MetricDepthEstimator
        estimator = MetricDepthEstimator(**({"model_name": model_name} if model_name else {}))
    except Exception as error:  # noqa: BLE001 - torch/moge/model download can fail many ways
        print(f"metric depth unavailable, falling back to ground-ray projection: {error}", flush=True)
        estimator = None
    _DEPTH_CACHE[key] = estimator
    return estimator


def compute_depth_frames(
    frames: dict[str, np.ndarray],
    profiles: dict[str, CameraProfile],
    estimator,
) -> dict[str, object]:
    depth_frames: dict[str, object] = {}
    if estimator is None:
        return depth_frames
    for camera, frame in frames.items():
        profile = profiles[camera]
        result = estimator.infer(frame, profile.pitch_deg, profile.height_m, camera)
        if result is not None:
            depth_frames[camera] = result
    return depth_frames


def discover_videos(folder: Path, clip: str) -> dict[str, Path]:
    videos: dict[str, Path] = {}
    for path in folder.glob(f"{clip}-*.mp4"):
        for camera, pattern in CAMERA_PATTERNS.items():
            if pattern.search(path.name):
                videos[camera] = path
                break
    return videos


def read_frame(path: Path, time_sec: float) -> np.ndarray:
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{time_sec:.3f}",
        "-i", str(path), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"could not decode {path.name} at {time_sec:.3f}s")
    frame = cv2.imdecode(np.frombuffer(result.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError(f"ffmpeg returned an invalid frame for {path.name}")
    return frame


SEED_CALIBRATION = Path("calibration/tesla_hw4_seed.json")
MEASURED_CALIBRATION = Path("calibration/tesla_hw4_measured.json")


def default_calibration() -> Path:
    """Prefer the measured rig; the seed rig's focal guesses are ~2x off."""
    return MEASURED_CALIBRATION if MEASURED_CALIBRATION.exists() else SEED_CALIBRATION


def load_profile(path: Path) -> tuple[dict, dict[str, CameraProfile]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    profiles: dict[str, CameraProfile] = {}
    for camera, item in raw["cameras"].items():
        profiles[camera] = CameraProfile(
            yaw_deg=float(item["yawDeg"]),
            pitch_deg=float(item["pitchDeg"]),
            height_m=float(item["heightM"]),
            origin_m=(float(item["originM"][0]), float(item["originM"][1])),
            focal_scale=float(item["focalScale"]),
            principal_point=(float(item["principalPoint"][0]), float(item["principalPoint"][1])),
            priority=float(item.get("priority", 1.0)),
            max_range_m=float(item.get("maxRangeM", 60.0)),
            roll_deg=float(item.get("rollDeg", 0.0)),
        )
    return raw, profiles


def projection_maps(
    frame: np.ndarray,
    profile: CameraProfile,
    size: int,
    meters_per_pixel: float,
    origin_px: tuple[float, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = frame.shape[:2]
    rows, columns = np.mgrid[0:size, 0:size].astype(np.float32)
    world_x = (columns - origin_px[0]) * meters_per_pixel - profile.origin_m[0]
    world_z = (origin_px[1] - rows) * meters_per_pixel - profile.origin_m[1]
    world_y = np.full_like(world_x, -profile.height_m)

    from moge_depth import camera_axes
    right, down, forward = camera_axes(profile.yaw_deg, profile.pitch_deg, profile.roll_deg)

    camera_x = world_x * right[0] + world_y * right[1] + world_z * right[2]
    camera_y = world_x * down[0] + world_y * down[1] + world_z * down[2]
    camera_z = world_x * forward[0] + world_y * forward[1] + world_z * forward[2]

    focal = profile.focal_scale * width
    center_x = profile.principal_point[0] * width
    center_y = profile.principal_point[1] * height
    safe_z = np.maximum(camera_z, 1e-4)
    map_x = focal * camera_x / safe_z + center_x
    map_y = focal * camera_y / safe_z + center_y

    visible = (
        (camera_z > 0.45)
        & (map_x >= 2.0)
        & (map_x <= width - 3.0)
        & (map_y >= height * 0.30)
        & (map_y <= height * 0.985)
    )
    horizontal_edge = np.minimum(map_x / width, 1.0 - map_x / width)
    vertical_edge = np.minimum((map_y - height * 0.28) / (height * 0.72), (height - map_y) / (height * 0.72))
    edge_feather = np.clip(np.minimum(horizontal_edge * 5.0, vertical_edge * 6.0), 0.0, 1.0)
    ground_distance = np.sqrt(world_x * world_x + world_z * world_z)
    view_cosine = np.clip(camera_z / np.maximum(ground_distance, 0.1), 0.0, 1.0)
    distance_fade = np.clip((55.0 - ground_distance) / 12.0, 0.0, 1.0)
    weight = visible.astype(np.float32) * edge_feather * (0.18 + 0.82 * view_cosine ** 1.6) * distance_fade
    weight *= profile.priority
    return map_x.astype(np.float32), map_y.astype(np.float32), weight.astype(np.float32)


def camera_basis(
    profile: CameraProfile,
    pitch_deg: float | None = None,
    roll_deg: float | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Camera axes in the vehicle frame; None falls back to the profile value."""
    from moge_depth import camera_axes
    return camera_axes(
        profile.yaw_deg,
        profile.pitch_deg if pitch_deg is None else pitch_deg,
        profile.roll_deg if roll_deg is None else roll_deg,
    )


def image_point_to_ground(
    point: tuple[float, float],
    frame_shape: tuple[int, ...],
    profile: CameraProfile,
    pitch_deg: float | None = None,
    roll_deg: float | None = None,
) -> tuple[float, float] | None:
    height, width = frame_shape[:2]
    focal = profile.focal_scale * width
    center_x = profile.principal_point[0] * width
    center_y = profile.principal_point[1] * height
    normalized_x = (point[0] - center_x) / focal
    normalized_y = (point[1] - center_y) / focal
    right, down, forward = camera_basis(profile, pitch_deg, roll_deg)
    direction = normalized_x * right + normalized_y * down + forward
    if direction[1] >= -1e-4:
        return None
    distance = -profile.height_m / direction[1]
    if distance <= 0:
        return None
    world_x = profile.origin_m[0] + distance * direction[0]
    world_z = profile.origin_m[1] + distance * direction[2]
    if math.hypot(world_x, world_z) > profile.max_range_m:
        return None
    return float(world_x), float(world_z)


def estimate_box_center(contact: tuple[float, float], origin: tuple[float, float],
                        width: float, length: float, heading: float) -> tuple[float, float]:
    """Move a visible surface observation into a class-prior oriented footprint.

    This is a geometric prior, not a measured 3D box. Keep the surface point in
    observations so it can be re-fitted when orientation/shape is observable.
    """
    ray = np.asarray(contact, dtype=np.float64) - np.asarray(origin, dtype=np.float64)
    distance = float(np.linalg.norm(ray))
    if distance < 0.1:
        return contact
    ray /= distance
    right = np.array([math.cos(heading), -math.sin(heading)])
    forward = np.array([math.sin(heading), math.cos(heading)])
    offset = min(width / (2 * max(abs(float(ray @ right)), 1e-6)),
                 length / (2 * max(abs(float(ray @ forward)), 1e-6)))
    center = np.asarray(contact) + offset * ray
    return float(center[0]), float(center[1])


def detect_objects(
    frames: dict[str, np.ndarray],
    profiles: dict[str, CameraProfile],
    model_path: str,
    confidence: float,
    depth_frames: dict[str, object] | None = None,
) -> tuple[list[dict], dict[str, np.ndarray]]:
    try:
        from ultralytics import YOLO
    except ImportError as error:
        raise RuntimeError("object detection requires: .recon-venv/bin/pip install ultralytics") from error

    model = _DETECTOR_CACHE.get(model_path)
    if model is None:
        model = YOLO(model_path)
        _DETECTOR_CACHE[model_path] = model
    detections: list[dict] = []
    debug_frames: dict[str, np.ndarray] = {}
    for camera, frame in frames.items():
        result = model.predict(frame, imgsz=960, conf=confidence, verbose=False)[0]
        debug = frame.copy()
        depth = (depth_frames or {}).get(camera)
        for box in result.boxes:
            label = result.names[int(box.cls.item())]
            kind = YOLO_CLASS_MAP.get(label)
            if kind is None:
                continue
            x1, y1, x2, y2 = (float(value) for value in box.xyxy[0].tolist())
            score = float(box.conf.item())
            profile = profiles[camera]
            contact = None
            range_source = "ground-ray"
            if depth is not None:
                from moge_depth import box_ground_position
                located = box_ground_position(
                    depth, (x1, y1, x2, y2), profile.yaw_deg, profile.height_m, profile.origin_m,
                )
                # A contact point far off the road plane means the sampled band
                # hit a barrier, an overpass or a reflection, not a road user.
                if located is not None and MIN_CONTACT_HEIGHT_M <= located[1] <= MAX_CONTACT_HEIGHT_M:
                    contact = (located[0], located[2])
                    range_source = "moge2"
            if contact is None:
                # None lets each angle fall back to the measured profile value
                # rather than being forced flat.
                pitch = depth.plane.pitch_deg if depth is not None else None
                roll = depth.plane.roll_deg if depth is not None else None
                contact = image_point_to_ground(((x1 + x2) * 0.5, y2), frame.shape, profile, pitch, roll)
            if contact is None:
                continue
            x, z = contact
            # Wide-angle repeaters and pillars resolve almost nothing past their
            # useful range; anything beyond it is noise, whatever produced it.
            if math.hypot(x, z) > profile.max_range_m:
                continue
            width_m, length_m = OBJECT_DIMENSIONS[kind]
            # Highway traffic is aligned with the ego path. Side-facing cameras
            # keep the nearest longitudinal orientation instead of pretending
            # the 2D box reveals a fully observable 3D yaw.
            heading = 0.0  # Undirected longitudinal prior; motion refines heading in the tracker.
            surface_position = [round(x, 3), round(z, 3)]
            if kind in {"vehicle", "truck", "bus"}:
                x, z = estimate_box_center((x, z), profile.origin_m, width_m, length_m, heading)
            detections.append({
                "id": f"{camera}-{len(detections) + 1}",
                "kind": kind,
                "x": round(x, 3),
                "z": round(z, 3),
                "width": width_m,
                "length": length_m,
                "heading": round(heading, 4),
                "confidence": round(score, 4),
                "source": "yolo11",
                "camera": camera,
                "rangeSource": range_source,
                "imageBox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                "observations": [{
                    "camera": camera, "imageBox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "imageSize": [frame.shape[1], frame.shape[0]],
                    "surfacePosition": surface_position, "rangeSource": range_source, "confidence": round(score, 4),
                }],
            })
            color = (72, 117, 230) if kind == "vehicle" else (70, 165, 110)
            cv2.rectangle(debug, (int(x1), int(y1)), (int(x2), int(y2)), color, 3, cv2.LINE_AA)
            cv2.putText(debug, f"{kind} {score:.2f} {range_source}", (int(x1), max(24, int(y1) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA)
        debug_frames[camera] = debug
    return deduplicate_objects(detections), debug_frames


# Monocular range error runs along the viewing ray and grows with distance,
# while bearing stays well determined. A circular merge radius therefore either
# leaves the same car duplicated across two cameras or eats genuinely adjacent
# vehicles; these gates are applied along and across the ray separately.
DEDUP_RADIAL_BASE_M = 3.8
DEDUP_RADIAL_RATE = 0.16
DEDUP_RADIAL_MAX_M = 7.5
DEDUP_TANGENTIAL_M = 1.8
DEDUP_LARGE_SCALE = 1.4
# The detector's NMS runs per class, so one vehicle labelled both `car` and
# `truck` survives as two boxes on the same pixels. Overlap catches that.
DEDUP_SAME_CAMERA_IOU = 0.55
# Two road users cannot interpenetrate. The half-axes sit inside one lane width
# and inside a car length, so vehicles in adjacent lanes or queued nose-to-tail
# still register as distinct.
DEDUP_FOOTPRINT_HALF_X = 1.9
DEDUP_FOOTPRINT_HALF_Z = 3.0

# Only neighbouring fields of view can observe the same road user. Restricting
# cross-camera fusion to these seams lets the radial gate be generous enough for
# monocular depth uncertainty without merging unrelated front/rear traffic.
CAMERA_OVERLAP_PAIRS = {
    frozenset(("front", "leftPillar")),
    frozenset(("front", "rightPillar")),
    frozenset(("leftPillar", "left")),
    frozenset(("rightPillar", "right")),
    frozenset(("left", "rear")),
    frozenset(("right", "rear")),
}


def _box_iou(a: list[float], b: list[float]) -> float:
    left = max(a[0], b[0])
    top = max(a[1], b[1])
    right = min(a[2], b[2])
    bottom = min(a[3], b[3])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def _fusion_weight(item: dict) -> float:
    """Precision-like weight for two seam observations of one road user."""
    distance = math.hypot(float(item["x"]), float(item["z"]))
    if item.get("rangeSource") == "moge2":
        radial_std = 0.65 + 0.028 * distance
    else:
        radial_std = 1.8 + 0.085 * distance
    return max(0.01, float(item["confidence"]) / max(0.05, radial_std**2))


def _merge_cross_camera_observations(primary: dict, secondary: dict) -> None:
    """Fuse an overlap-seam duplicate while retaining detector provenance.

    The former implementation simply discarded ``secondary``. That prevented a
    strong MoGe contact point from correcting a higher-confidence ground-ray
    observation. Precision weighting makes the metric observation dominate
    without pretending the two monocular estimates are independent ground truth.
    """
    primary.setdefault("observations", []).extend(secondary.get("observations", []))
    primary_weight = _fusion_weight(primary)
    secondary_weight = _fusion_weight(secondary)
    total = primary_weight + secondary_weight
    primary["x"] = round((primary["x"] * primary_weight + secondary["x"] * secondary_weight) / total, 3)
    primary["z"] = round((primary["z"] * primary_weight + secondary["z"] * secondary_weight) / total, 3)
    # A second view is corroborating evidence, but its detector score is not
    # statistically independent; apply only a modest bounded confidence lift.
    first_confidence = float(primary["confidence"])
    second_confidence = float(secondary["confidence"])
    primary["confidence"] = round(min(0.995, first_confidence + 0.22 * second_confidence * (1.0 - first_confidence)), 4)
    cameras = set(primary.get("cameras", [primary.get("camera")]))
    cameras.update(secondary.get("cameras", [secondary.get("camera")]))
    primary["cameras"] = sorted(camera for camera in cameras if camera)
    primary["observationCount"] = int(primary.get("observationCount", 1)) + int(secondary.get("observationCount", 1))
    if secondary.get("rangeSource") == "moge2":
        primary["rangeSource"] = "moge2"


def deduplicate_objects(objects: list[dict]) -> list[dict]:
    """Collapse repeated observations of one road user into a single object.

    Two failure modes are handled separately. Within one camera, duplicates come
    from class-wise NMS letting the same pixels through under two labels, which
    image-box overlap identifies directly. Across cameras, the same vehicle
    lands at different ranges along a shared bearing, so the gate is generous
    radially and tight tangentially rather than a single circle.
    """
    selected: list[dict] = []
    for candidate in sorted(objects, key=lambda item: item["confidence"], reverse=True):
        distance = math.hypot(candidate["x"], candidate["z"])
        scale = DEDUP_LARGE_SCALE if candidate["kind"] in {"truck", "bus"} else 1.0
        radial_gate = min(DEDUP_RADIAL_MAX_M, DEDUP_RADIAL_BASE_M + DEDUP_RADIAL_RATE * distance) * scale
        tangential_gate = DEDUP_TANGENTIAL_M * scale
        bearing = math.atan2(candidate["x"], candidate["z"])
        along = (math.sin(bearing), math.cos(bearing))

        duplicate_index: int | None = None
        fuse_cross_camera = False
        for existing_index, existing in enumerate(selected):
            same_family = candidate["kind"] == existing["kind"] or {
                candidate["kind"], existing["kind"]
            } <= {"vehicle", "truck", "bus"}
            if not same_family:
                continue
            offset_x = candidate["x"] - existing["x"]
            offset_z = candidate["z"] - existing["z"]
            interpenetrating = (
                (offset_x / DEDUP_FOOTPRINT_HALF_X) ** 2 + (offset_z / DEDUP_FOOTPRINT_HALF_Z) ** 2
            ) < 1.0
            if existing["camera"] == candidate["camera"]:
                if interpenetrating or _box_iou(candidate["imageBox"], existing["imageBox"]) > DEDUP_SAME_CAMERA_IOU:
                    duplicate_index = existing_index
                    break
                continue
            # One fused target may contain at most one observation per camera.
            # Otherwise adjacent vehicles in the same image can collapse through
            # a third camera acting as a transitive bridge.
            if candidate["camera"] in existing.get("cameras", [existing["camera"]]):
                continue
            if frozenset((existing["camera"], candidate["camera"])) not in CAMERA_OVERLAP_PAIRS:
                continue
            radial = abs(offset_x * along[0] + offset_z * along[1])
            tangential = abs(offset_x * along[1] - offset_z * along[0])
            if radial < radial_gate and tangential < tangential_gate:
                duplicate_index = existing_index
                fuse_cross_camera = True
                break
        if duplicate_index is None:
            candidate["cameras"] = [candidate["camera"]]
            candidate["observationCount"] = 1
            selected.append(candidate)
        elif fuse_cross_camera:
            _merge_cross_camera_observations(selected[duplicate_index], candidate)
    for index, item in enumerate(selected, start=1):
        item["id"] = f"object-{index:03d}"
    return selected


# Lane search volume in the vehicle frame, and the top-down resolution the
# front image is rectified to before markings are traced.
LANE_HALF_WIDTH_M = 11.0
LANE_MIN_Z_M = 4.0
LANE_MAX_Z_M = 60.0
LANE_BEV_RESOLUTION = 0.08
LANE_WINDOW_COUNT = 18
LANE_WINDOW_HALF_WIDTH_M = 0.9
LANE_MIN_WINDOW_PIXELS = 26
LANE_MIN_WINDOWS = 5
LANE_MIN_Z_SPAN_M = 9.0
# A traced marking may curve, but it cannot sweep sideways the way an
# out-of-plane barrier smears under inverse perspective.
LANE_MAX_LATERAL_DRIFT = 0.075
LANE_MIN_SEPARATION_M = 2.2


def lane_marking_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, np.array([0, 0, 150]), np.array([180, 80, 255]))
    yellow = cv2.inRange(hsv, np.array([12, 60, 90]), np.array([40, 255, 255]))
    mask = cv2.bitwise_or(white, yellow)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))


def rectify_to_ground(
    image: np.ndarray,
    profile: CameraProfile,
    pitch_deg: float,
    roll_deg: float,
) -> np.ndarray:
    """Warp a front-camera image to a metric top-down view of the road plane.

    Row 0 is the near edge at LANE_MIN_Z_M and column 0 is the left edge at
    -LANE_HALF_WIDTH_M, so a BEV pixel maps linearly back to vehicle metres.
    """
    from moge_depth import camera_axes

    height, width = image.shape[:2]
    columns = int(round(2 * LANE_HALF_WIDTH_M / LANE_BEV_RESOLUTION))
    rows = int(round((LANE_MAX_Z_M - LANE_MIN_Z_M) / LANE_BEV_RESOLUTION))
    world_x = (np.arange(columns, dtype=np.float32) * LANE_BEV_RESOLUTION - LANE_HALF_WIDTH_M)[None, :]
    world_z = (LANE_MIN_Z_M + np.arange(rows, dtype=np.float32) * LANE_BEV_RESOLUTION)[:, None]

    right, down, forward = camera_axes(profile.yaw_deg, pitch_deg, roll_deg)
    relative_x = world_x - profile.origin_m[0]
    relative_y = np.float32(-profile.height_m)
    relative_z = world_z - profile.origin_m[1]
    camera_x = relative_x * right[0] + relative_y * right[1] + relative_z * right[2]
    camera_y = relative_x * down[0] + relative_y * down[1] + relative_z * down[2]
    camera_z = relative_x * forward[0] + relative_y * forward[1] + relative_z * forward[2]

    focal = profile.focal_scale * width
    safe_z = np.maximum(camera_z, 1e-4)
    map_x = (focal * camera_x / safe_z + profile.principal_point[0] * width).astype(np.float32)
    map_y = (focal * camera_y / safe_z + profile.principal_point[1] * height).astype(np.float32)
    map_x[camera_z <= 0.4] = -1
    warped = cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    return warped


def _trace_lane(bev: np.ndarray, start_column: float) -> list[tuple[float, float]]:
    """Follow one marking upward through the rectified view with a sliding window."""
    rows, columns = bev.shape
    window_rows = max(1, rows // LANE_WINDOW_COUNT)
    half_width = int(LANE_WINDOW_HALF_WIDTH_M / LANE_BEV_RESOLUTION)
    center = start_column
    traced: list[tuple[float, float]] = []
    for index in range(LANE_WINDOW_COUNT):
        row_lo = index * window_rows
        row_hi = min(rows, row_lo + window_rows)
        if row_hi - row_lo < 1:
            break
        column_lo = max(0, int(center - half_width))
        column_hi = min(columns, int(center + half_width))
        if column_hi - column_lo < 2:
            break
        window = bev[row_lo:row_hi, column_lo:column_hi]
        hits = np.count_nonzero(window)
        if hits < LANE_MIN_WINDOW_PIXELS:
            continue
        weights = window.sum(axis=0).astype(np.float64)
        if weights.sum() <= 0:
            continue
        center = column_lo + float(np.average(np.arange(column_hi - column_lo), weights=weights))
        world_x = center * LANE_BEV_RESOLUTION - LANE_HALF_WIDTH_M
        world_z = LANE_MIN_Z_M + (row_lo + row_hi) * 0.5 * LANE_BEV_RESOLUTION
        traced.append((world_x, world_z))
    return traced


def detect_front_lanes(
    frame: np.ndarray,
    profile: CameraProfile,
    depth: object | None = None,
) -> list[list[list[float]]]:
    """Trace lane markings in a metric top-down rectification of the front view.

    Working in the rectified plane rather than image space means a marking is a
    near-vertical stripe at a fixed lateral offset, which a column histogram and
    sliding window recover directly. The earlier image-space Hough fit needed a
    row of hand-tuned thresholds that only held for one particular (and, as it
    turned out, wrong) focal length.
    """
    pitch_deg = depth.plane.pitch_deg if depth is not None else profile.pitch_deg
    roll_deg = depth.plane.roll_deg if depth is not None else profile.roll_deg
    mask = lane_marking_mask(frame)
    bev = rectify_to_ground(mask, profile, pitch_deg, roll_deg)
    if bev.size == 0:
        return []
    bev = (bev > 96).astype(np.uint8)

    rows, columns = bev.shape
    # Seed from the near field, where markings are widest and least distorted.
    histogram = bev[: max(1, rows // 3)].sum(axis=0).astype(np.float64)
    if histogram.max() <= 0:
        return []
    kernel = max(3, int(0.25 / LANE_BEV_RESOLUTION) | 1)
    histogram = cv2.GaussianBlur(histogram.reshape(1, -1), (kernel, 1), 0).ravel()
    threshold = max(float(histogram.max()) * 0.25, LANE_MIN_WINDOW_PIXELS * 0.5)
    separation = int(LANE_MIN_SEPARATION_M / LANE_BEV_RESOLUTION)

    peaks: list[int] = []
    for column in np.argsort(histogram)[::-1]:
        if histogram[column] < threshold:
            break
        if all(abs(int(column) - existing) >= separation for existing in peaks):
            peaks.append(int(column))
        if len(peaks) >= 6:
            break

    lanes: list[tuple[float, list[list[float]]]] = []
    for peak in peaks:
        traced = _trace_lane(bev, float(peak))
        if len(traced) < LANE_MIN_WINDOWS:
            continue
        z_values = np.array([point[1] for point in traced], dtype=np.float64)
        x_values = np.array([point[0] for point in traced], dtype=np.float64)
        if float(np.ptp(z_values)) < LANE_MIN_Z_SPAN_M:
            continue
        degree = 2 if len(traced) >= 8 else 1
        coefficients = np.polyfit(z_values, x_values, degree)
        start_z, end_z = float(z_values.min()), float(z_values.max())
        drift = abs(float(np.polyval(coefficients, end_z) - np.polyval(coefficients, start_z))) / max(1e-6, end_z - start_z)
        if drift > LANE_MAX_LATERAL_DRIFT:
            continue
        samples = np.linspace(start_z, end_z, min(48, max(10, int((end_z - start_z) / 1.2))))
        polyline = [
            [round(float(np.polyval(coefficients, z)), 3), round(float(z), 3)]
            for z in samples
        ]
        if any(abs(point[0]) > LANE_HALF_WIDTH_M for point in polyline):
            continue
        lanes.append((float(np.polyval(coefficients, LANE_MIN_Z_M)), polyline))

    lanes.sort(key=lambda item: item[0])
    selected: list[tuple[float, list[list[float]]]] = []
    for lane in lanes:
        if all(abs(lane[0] - existing[0]) >= LANE_MIN_SEPARATION_M for existing in selected):
            selected.append(lane)
    return [lane[1] for lane in selected[:5]]


def fuse_frames(
    frames: dict[str, np.ndarray],
    profiles: dict[str, CameraProfile],
    output_config: dict,
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    size = int(output_config["size"])
    meters_per_pixel = float(output_config["metersPerPixel"])
    origin_px = (float(output_config["origin"][0]), float(output_config["origin"][1]))
    accumulator = np.zeros((size, size, 3), dtype=np.float32)
    total_weight = np.zeros((size, size), dtype=np.float32)
    coverage: dict[str, int] = {}

    for camera, frame in frames.items():
        profile = profiles[camera]
        map_x, map_y, weight = projection_maps(frame, profile, size, meters_per_pixel, origin_px)
        sampled = cv2.remap(frame, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        accumulator += sampled.astype(np.float32) * weight[..., None]
        total_weight += weight
        coverage[camera] = int(np.count_nonzero(weight > 0.02))

    output = np.zeros_like(accumulator, dtype=np.uint8)
    valid = total_weight > 1e-4
    output[valid] = np.clip(accumulator[valid] / total_weight[valid, None], 0, 255).astype(np.uint8)

    # Neutral, Tesla-like map background outside the observable ground plane.
    background = np.full_like(output, (238, 240, 237), dtype=np.uint8)
    feather = np.clip(total_weight / 0.45, 0.0, 1.0)[..., None]
    output = np.clip(output * feather + background * (1.0 - feather), 0, 255).astype(np.uint8)
    return output, total_weight, coverage


def draw_vehicle_mask(image: np.ndarray, output_config: dict) -> None:
    size = image.shape[0]
    origin_x, origin_y = (int(value) for value in output_config["origin"])
    meters_per_pixel = float(output_config["metersPerPixel"])
    car_width = max(36, int(1.95 / meters_per_pixel))
    car_length = max(76, int(4.72 / meters_per_pixel))
    center_y = origin_y + int(0.15 / meters_per_pixel)
    overlay = image.copy()
    cv2.ellipse(overlay, (origin_x, center_y), (car_width // 2 + 10, car_length // 2 + 13), 0, 0, 360, (230, 232, 228), -1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.82, image, 0.18, 0, image)
    cv2.rectangle(
        image,
        (origin_x - car_width // 2, center_y - car_length // 2),
        (origin_x + car_width // 2, center_y + car_length // 2),
        (249, 249, 245),
        -1,
        cv2.LINE_AA,
    )
    cv2.rectangle(
        image,
        (origin_x - int(car_width * 0.36), center_y - int(car_length * 0.19)),
        (origin_x + int(car_width * 0.36), center_y + int(car_length * 0.19)),
        (54, 61, 60),
        -1,
        cv2.LINE_AA,
    )
    cv2.line(
        image,
        (origin_x - int(car_width * 0.38), center_y + car_length // 2 - 3),
        (origin_x + int(car_width * 0.38), center_y + car_length // 2 - 3),
        (62, 75, 188),
        3,
        cv2.LINE_AA,
    )


def world_to_pixel(x: float, z: float, output_config: dict) -> tuple[int, int]:
    origin_x, origin_y = output_config["origin"]
    scale = float(output_config["metersPerPixel"])
    return int(round(origin_x + x / scale)), int(round(origin_y - z / scale))


def render_semantic_preview(
    output_config: dict,
    objects: list[dict],
    lanes: list[list[list[float]]],
) -> np.ndarray:
    size = int(output_config["size"])
    image = np.full((size, size, 3), (245, 246, 243), dtype=np.uint8)
    grid_color = (232, 235, 230)
    for distance in range(-30, 31, 5):
        start = world_to_pixel(distance, -35, output_config)
        end = world_to_pixel(distance, 35, output_config)
        cv2.line(image, start, end, grid_color, 1, cv2.LINE_AA)
        start = world_to_pixel(-35, distance, output_config)
        end = world_to_pixel(35, distance, output_config)
        cv2.line(image, start, end, grid_color, 1, cv2.LINE_AA)

    for lane in lanes:
        pixels = np.array([world_to_pixel(point[0], point[1], output_config) for point in lane], dtype=np.int32)
        if len(pixels) >= 2:
            cv2.polylines(image, [pixels], False, (183, 187, 181), 5, cv2.LINE_AA)

    colors = {
        "vehicle": (118, 126, 123),
        "truck": (102, 114, 117),
        "bus": (98, 111, 116),
        "pedestrian": (78, 134, 185),
        "cyclist": (82, 145, 148),
        "motorcycle": (88, 137, 145),
    }
    scale = float(output_config["metersPerPixel"])
    for item in objects:
        center = world_to_pixel(item["x"], item["z"], output_config)
        width = max(8, int(item["width"] / scale))
        length = max(8, int(item["length"] / scale))
        rectangle = ((float(center[0]), float(center[1])), (float(width), float(length)), -math.degrees(item["heading"]))
        box = cv2.boxPoints(rectangle).astype(np.int32)
        cv2.fillConvexPoly(image, box, colors.get(item["kind"], (130, 130, 130)), cv2.LINE_AA)
        cv2.polylines(image, [box], True, (80, 86, 84), 2, cv2.LINE_AA)
    draw_vehicle_mask(image, output_config)
    return image


def write_manifest(
    path: Path,
    clip: str,
    time_sec: float,
    profile_raw: dict,
    coverage: dict[str, int],
    texture_name: str,
    semantic_name: str,
    objects: list[dict],
    lanes: list[list[list[float]]],
) -> None:
    payload = {
        "schemaVersion": 1,
        "clip": clip,
        "timeSec": time_sec,
        "source": "six-camera-ground-projection",
        "calibrated": bool(profile_raw.get("calibrated", False)),
        "calibration": profile_raw.get("name"),
        "coordinateFrame": profile_raw.get("coordinateFrame"),
        "texture": texture_name,
        "semanticPreview": semantic_name,
        "coveragePixels": coverage,
        "objects": objects,
        "lanes": lanes,
        "notes": [
            "All visible pixels originate from synchronized TeslaCam frames.",
            "Objects are YOLO detections projected from their ground-contact image point.",
            "Lane polylines are extracted from the front camera and intersected with the ground plane.",
            "Metric scale remains approximate while the seed calibration is active.",
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--clip", required=True)
    parser.add_argument("--time", type=float, default=8.0)
    parser.add_argument("--calibration", type=Path, default=None)
    parser.add_argument("--output", type=Path, required=True, help="Output basename without extension")
    parser.add_argument("--model", default="yolo11n.pt", help="Ultralytics detector model")
    parser.add_argument("--confidence", type=float, default=0.24)
    parser.add_argument("--no-detection", action="store_true")
    parser.add_argument("--no-depth", action="store_true", help="Skip MoGe metric depth, use ground-ray range")
    args = parser.parse_args()

    profile_raw, profiles = load_profile(args.calibration or default_calibration())
    videos = discover_videos(args.folder, args.clip)
    missing = sorted(set(profiles) - set(videos))
    if missing:
        raise SystemExit(f"missing cameras: {', '.join(missing)}")
    frames = {camera: read_frame(path, args.time) for camera, path in videos.items()}
    texture, weight, coverage = fuse_frames(frames, profiles, profile_raw["output"])
    draw_vehicle_mask(texture, profile_raw["output"])
    depth_frames: dict[str, object] = {}
    if args.no_detection:
        objects: list[dict] = []
        debug_frames: dict[str, np.ndarray] = {}
    else:
        estimator = None if args.no_depth else load_depth_estimator()
        depth_frames = compute_depth_frames(frames, profiles, estimator)
        objects, debug_frames = detect_objects(frames, profiles, args.model, args.confidence, depth_frames)
    lanes = detect_front_lanes(frames["front"], profiles["front"], depth_frames.get("front"))
    semantic = render_semantic_preview(profile_raw["output"], objects, lanes)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    texture_path = args.output.with_suffix(".jpg")
    coverage_path = args.output.with_name(f"{args.output.name}-coverage.png")
    semantic_path = args.output.with_name(f"{args.output.name}-semantic.png")
    manifest_path = args.output.with_suffix(".json")
    if not cv2.imwrite(str(texture_path), texture, [cv2.IMWRITE_JPEG_QUALITY, 92]):
        raise SystemExit(f"could not write {texture_path}")
    coverage_image = np.clip(weight / max(float(weight.max()), 1e-6) * 255.0, 0, 255).astype(np.uint8)
    cv2.imwrite(str(coverage_path), coverage_image)
    cv2.imwrite(str(semantic_path), semantic)
    if debug_frames:
        debug_dir = args.output.with_name(f"{args.output.name}-detections")
        debug_dir.mkdir(parents=True, exist_ok=True)
        for camera, frame in debug_frames.items():
            cv2.imwrite(str(debug_dir / f"{camera}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
    write_manifest(
        manifest_path, args.clip, args.time, profile_raw, coverage,
        texture_path.name, semantic_path.name, objects, lanes,
    )
    print(f"wrote {texture_path}, {semantic_path}, {coverage_path}, and {manifest_path}")
    print(f"semantic objects={len(objects)} lanes={len(lanes)}")
    print("coverage " + " ".join(f"{camera}={pixels}" for camera, pixels in sorted(coverage.items())))


if __name__ == "__main__":
    main()
