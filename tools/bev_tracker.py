#!/usr/bin/env python3
"""Uncertainty-aware temporal fusion for TeslaCam BEV observations.

The detector produces independent ego-frame observations from six cameras.
This module turns them into stable tracks with a constant-velocity Kalman
filter, globally optimal assignment, explicit measurement covariance and
optional SEI ego-motion compensation. Lane markings use persistent metric
tracks plus a road-width topology check so a missed frame does not make the
whole lane set flash.
"""

from __future__ import annotations

from bisect import bisect_left
from copy import deepcopy
from itertools import combinations
import math

import numpy as np
from scipy.optimize import linear_sum_assignment


VEHICLE_FAMILY = {"vehicle", "truck", "bus"}
CONFIRM_HITS = 2
MAX_MISSES = 3
COAST_OUTPUT_MISSES = 1
DIMENSION_EMA = 0.18
CONFIDENCE_EMA = 0.28
MAHALANOBIS_GATE = 12.0
PROCESS_ACCELERATION_STD = 1.8
OVERLAP_HALF_X = 1.9
OVERLAP_HALF_Z = 3.0

CAMERA_HANDOFF_PAIRS = {
    frozenset(("front", "leftPillar")),
    frozenset(("front", "rightPillar")),
    frozenset(("leftPillar", "left")),
    frozenset(("rightPillar", "right")),
    frozenset(("left", "rear")),
    frozenset(("right", "rear")),
}

LANE_CONFIRM_HITS = 2
LANE_MAX_MISSES = 8
LANE_OUTPUT_MISSES = 4
LANE_EMA = 0.18
LANE_MATCH_DISTANCE = 1.15
LANE_EXPECTED_WIDTH = 3.7
LANE_MIN_SPACING = 2.45
LANE_MAX_SPACING = 5.45
MAX_OUTPUT_LANES = 5


def _same_family(a: str, b: str) -> bool:
    return a == b or {a, b} <= VEHICLE_FAMILY


def _detection_cameras(detection: dict) -> set[str]:
    values = detection.get("cameras")
    if isinstance(values, list):
        result = {str(value) for value in values if value}
        if result:
            return result
    camera = detection.get("camera")
    return {str(camera)} if camera else set()


def _camera_sets_compatible(previous: set[str], current: set[str]) -> bool:
    if not previous or not current or previous & current:
        return True
    return any(frozenset((before, after)) in CAMERA_HANDOFF_PAIRS for before in previous for after in current)


def _angle_delta_degrees(before: float, after: float) -> float:
    return (after - before + 180.0) % 360.0 - 180.0


def _nearest_sample(samples: list[dict], times: list[float], time_sec: float) -> dict | None:
    if not samples:
        return None
    index = bisect_left(times, time_sec)
    if index <= 0:
        return samples[0]
    if index >= len(samples):
        return samples[-1]
    return samples[index] if times[index] - time_sec < time_sec - times[index - 1] else samples[index - 1]


def _ego_delta(
    samples: list[dict],
    times: list[float],
    before_time: float,
    after_time: float,
) -> tuple[float, float]:
    """Forward travel in metres and clockwise yaw change in radians."""
    dt = max(0.0, after_time - before_time)
    if dt <= 0 or not samples:
        return 0.0, 0.0
    before = _nearest_sample(samples, times, before_time)
    after = _nearest_sample(samples, times, after_time)
    if before is None or after is None:
        return 0.0, 0.0
    speeds = [
        float(value)
        for value in (before.get("vehicle_speed_mps"), after.get("vehicle_speed_mps"))
        if isinstance(value, (int, float)) and math.isfinite(value)
    ]
    distance = max(0.0, sum(speeds) / len(speeds)) * dt if speeds else 0.0

    heading_before = before.get("heading_deg")
    heading_after = after.get("heading_deg")
    yaw = 0.0
    if all(isinstance(value, (int, float)) and math.isfinite(value) for value in (heading_before, heading_after)):
        candidate = math.radians(_angle_delta_degrees(float(heading_before), float(heading_after)))
        # GPS heading occasionally emits a discontinuous sample. Reject a yaw
        # rate beyond 25 deg/s; that is already much sharper than this footage.
        if abs(candidate) <= math.radians(25.0 * dt + 1.0):
            yaw = candidate
    return distance, yaw


def ego_translation(distance: float, yaw: float) -> np.ndarray:
    """Constant-turn arc displacement, expressed in the previous ego frame."""
    if abs(yaw) < 1e-8:
        return np.array([0.0, distance])
    return np.array([distance * (1 - math.cos(yaw)) / yaw, distance * math.sin(yaw) / yaw])


def _ego_speed_at(samples: list[dict], times: list[float], time_sec: float) -> float:
    sample = _nearest_sample(samples, times, time_sec)
    value = sample.get("vehicle_speed_mps") if sample else None
    return max(0.0, float(value)) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0


def _measurement_covariance(detection: dict) -> np.ndarray:
    x = float(detection["x"])
    z = float(detection["z"])
    distance = math.hypot(x, z)
    if detection.get("rangeSource") == "moge2":
        radial_std = 0.65 + 0.028 * distance
        tangent_std = 0.38 + 0.010 * distance
    else:
        radial_std = 1.8 + 0.085 * distance
        tangent_std = 0.7 + 0.018 * distance
    # Simultaneous overlap-seam observations constrain both range and bearing.
    # Keep the gain conservative because the monocular errors remain correlated.
    if int(detection.get("observationCount", 1)) > 1:
        radial_std *= 0.78
        tangent_std *= 0.72
    bearing = math.atan2(x, z)
    radial = np.array([math.sin(bearing), math.cos(bearing)], dtype=np.float64)
    tangent = np.array([math.cos(bearing), -math.sin(bearing)], dtype=np.float64)
    return radial_std**2 * np.outer(radial, radial) + tangent_std**2 * np.outer(tangent, tangent)


class _Track:
    __slots__ = (
        "track_id", "state", "covariance", "width", "length", "confidence",
        "hits", "misses", "kind_votes", "camera", "cameras", "source", "range_source", "observations", "last_observed", "heading_prior",
    )

    def __init__(self, track_id: str, detection: dict, initial_forward_speed: float = 0.0) -> None:
        self.track_id = track_id
        # Most motorway traffic initially shares the ego's forward velocity.
        # Starting at zero would move every new track backwards by one full ego
        # travel distance before it has a second observation to learn from.
        self.state = np.array([
            float(detection["x"]), float(detection["z"]), 0.0, initial_forward_speed,
        ], dtype=np.float64)
        measurement = _measurement_covariance(detection)
        self.covariance = np.zeros((4, 4), dtype=np.float64)
        self.covariance[:2, :2] = measurement
        self.covariance[2:, 2:] = np.eye(2) * 16.0
        self.width = float(detection["width"])
        self.length = float(detection["length"])
        self.confidence = float(detection["confidence"])
        self.hits = 1
        self.misses = 0
        self.kind_votes: dict[str, float] = {detection["kind"]: float(detection["confidence"])}
        self.camera = detection.get("camera", "")
        self.cameras = _detection_cameras(detection)
        self.source = detection.get("source", "")
        self.range_source = detection.get("rangeSource", "")
        self.observations = deepcopy(detection.get("observations", []))
        self.last_observed = detection.get("timeSec")
        self.heading_prior = float(detection.get("heading", 0.0))

    @property
    def x(self) -> float:
        return float(self.state[0])

    @property
    def z(self) -> float:
        return float(self.state[1])

    @property
    def vx(self) -> float:
        return float(self.state[2])

    @property
    def vz(self) -> float:
        return float(self.state[3])

    @property
    def kind(self) -> str:
        return max(self.kind_votes.items(), key=lambda item: item[1])[0]

    @property
    def heading(self) -> float:
        speed = math.hypot(self.vx, self.vz)
        if speed >= 1.5:
            return math.atan2(self.vx, self.vz) % (2 * math.pi)
        return self.heading_prior

    def predict(self, dt: float, ego_distance: float, ego_yaw: float) -> None:
        transition = np.array([
            [1.0, 0.0, dt, 0.0],
            [0.0, 1.0, 0.0, dt],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
        dt2 = dt * dt
        process = PROCESS_ACCELERATION_STD**2 * np.array([
            [dt2 * dt2 / 4, 0.0, dt2 * dt / 2, 0.0],
            [0.0, dt2 * dt2 / 4, 0.0, dt2 * dt / 2],
            [dt2 * dt / 2, 0.0, dt2, 0.0],
            [0.0, dt2 * dt / 2, 0.0, dt2],
        ])
        self.state = transition @ self.state
        self.covariance = transition @ self.covariance @ transition.T + process

        # Express the predicted world-relative state in the new ego frame.
        self.state[:2] -= ego_translation(ego_distance, ego_yaw)
        self.heading_prior = (self.heading_prior - ego_yaw) % (2 * math.pi)
        if abs(ego_yaw) > 1e-8:
            cosine = math.cos(ego_yaw)
            sine = math.sin(ego_yaw)
            rotation = np.array([[cosine, -sine], [sine, cosine]], dtype=np.float64)
            self.state[:2] = rotation @ self.state[:2]
            self.state[2:] = rotation @ self.state[2:]
            transform = np.zeros((4, 4), dtype=np.float64)
            transform[:2, :2] = rotation
            transform[2:, 2:] = rotation
            self.covariance = transform @ self.covariance @ transform.T

    def association_cost(self, detection: dict) -> float:
        if not _same_family(self.kind, detection["kind"]):
            return math.inf
        measurement = np.array([float(detection["x"]), float(detection["z"])])
        residual = measurement - self.state[:2]
        detection_cameras = _detection_cameras(detection)
        if not _camera_sets_compatible(self.cameras, detection_cameras):
            return math.inf
        euclidean = float(np.linalg.norm(residual))
        absolute_gate = min(10.0, 3.2 + 0.08 * math.hypot(self.x, self.z) + 1.4 * self.misses)
        if euclidean > absolute_gate:
            return math.inf
        innovation = self.covariance[:2, :2] + _measurement_covariance(detection)
        try:
            distance = float(residual.T @ np.linalg.solve(innovation, residual))
        except np.linalg.LinAlgError:
            return math.inf
        if distance > MAHALANOBIS_GATE:
            return math.inf
        camera_penalty = 0.35 if self.cameras and detection_cameras and not self.cameras & detection_cameras else 0.0
        class_penalty = 0.25 if self.kind != detection["kind"] else 0.0
        return distance + camera_penalty + class_penalty

    def update(self, detection: dict) -> None:
        measurement = np.array([float(detection["x"]), float(detection["z"])])
        observation = np.array([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]])
        noise = _measurement_covariance(detection)
        innovation = observation @ self.covariance @ observation.T + noise
        gain = self.covariance @ observation.T @ np.linalg.inv(innovation)
        residual = measurement - observation @ self.state
        self.state = self.state + gain @ residual
        identity = np.eye(4)
        # Joseph form keeps the covariance symmetric and positive semi-definite.
        correction = identity - gain @ observation
        self.covariance = correction @ self.covariance @ correction.T + gain @ noise @ gain.T
        self.width += DIMENSION_EMA * (float(detection["width"]) - self.width)
        self.length += DIMENSION_EMA * (float(detection["length"]) - self.length)
        self.confidence += CONFIDENCE_EMA * (float(detection["confidence"]) - self.confidence)
        kind = detection["kind"]
        self.kind_votes[kind] = self.kind_votes.get(kind, 0.0) + float(detection["confidence"])
        self.camera = detection.get("camera", self.camera)
        self.cameras = _detection_cameras(detection) or self.cameras
        self.source = detection.get("source", self.source)
        self.range_source = detection.get("rangeSource", self.range_source)
        self.observations = deepcopy(detection.get("observations", []))
        self.last_observed = detection.get("timeSec")
        self.hits += 1
        self.misses = 0

    def to_object(self) -> dict:
        confidence = self.confidence * (0.72 if self.misses else 1.0)
        return {
            "id": self.track_id,
            "kind": self.kind,
            "x": round(self.x, 3),
            "z": round(self.z, 3),
            "vx": round(self.vx, 3),
            "vz": round(self.vz, 3),
            "width": round(self.width, 2),
            "length": round(self.length, 2),
            "heading": round(self.heading, 4),
            "confidence": round(max(0.0, min(1.0, confidence)), 4),
            "positionStdM": round(math.sqrt(max(0.0, float(np.trace(self.covariance[:2, :2]) / 2))), 3),
            "source": self.source,
            "camera": self.camera,
            "cameras": sorted(self.cameras),
            "rangeSource": self.range_source,
            "coasting": self.misses > 0,
            "observations": self.observations,
            "lastObservedSec": self.last_observed,
            "positionReference": "estimated-center",
            "dimensionsSource": "class-prior",
        }


def _is_plausible_detection(detection: dict) -> bool:
    distance = math.hypot(float(detection["x"]), float(detection["z"]))
    if distance < 1.4 or distance > 90.0:
        return False
    confidence = float(detection["confidence"])
    # Vulnerable road users occupy fewer pixels than vehicles. Requiring the
    # vehicle threshold discarded real pedestrians before temporal confirmation
    # could help; retain them at a slightly lower near-field threshold, while
    # still tightening every class at long monocular range.
    kind = detection.get("kind")
    minimum = 0.29 if kind in {"pedestrian", "cyclist", "motorcycle"} else 0.34
    if detection.get("rangeSource") != "moge2":
        minimum += 0.04
    if distance >= 45:
        minimum += 0.08
    return confidence >= minimum


def _associate(tracks: list[_Track], detections: list[dict]) -> tuple[dict[int, int], set[int], set[int]]:
    if not tracks or not detections:
        return {}, set(), set()
    large = 1e8
    costs = np.full((len(tracks), len(detections)), large, dtype=np.float64)
    for track_index, track in enumerate(tracks):
        for detection_index, detection in enumerate(detections):
            cost = track.association_cost(detection)
            if math.isfinite(cost):
                costs[track_index, detection_index] = cost
    rows, columns = linear_sum_assignment(costs)
    matches: dict[int, int] = {}
    used_tracks: set[int] = set()
    used_detections: set[int] = set()
    for track_index, detection_index in zip(rows.tolist(), columns.tolist()):
        if costs[track_index, detection_index] >= large:
            continue
        matches[track_index] = detection_index
        used_tracks.add(track_index)
        used_detections.add(detection_index)
    return matches, used_tracks, used_detections


def _resolve_overlaps(tracks: list[_Track]) -> list[_Track]:
    """Keep one physically plausible track per occupied road footprint.

    Class-wise detectors can label the same pixels as both a vehicle and a
    vulnerable road user.  Family-only suppression left those contradictions
    in the final BEV even when both tracks came from the same camera.  Preserve
    cross-class tracks from disjoint views, but resolve same-camera footprint
    collisions using track age, confidence and covariance.
    """
    ranked = sorted(
        tracks,
        key=lambda track: (track.hits, -track.misses, track.confidence, -float(np.trace(track.covariance[:2, :2]))),
        reverse=True,
    )
    kept: list[_Track] = []
    for track in ranked:
        overlapping = any(
            (_same_family(track.kind, other.kind) or bool(track.cameras & other.cameras))
            and ((track.x - other.x) / OVERLAP_HALF_X) ** 2
            + ((track.z - other.z) / OVERLAP_HALF_Z) ** 2 < 1.0
            for other in kept
        )
        if not overlapping:
            kept.append(track)
    surviving = {id(track) for track in kept}
    return [track for track in tracks if id(track) in surviving]


class _LaneTrack:
    """Observed road polyline, transported between ego frames without extension."""
    def __init__(self, points: np.ndarray) -> None:
        self.points = points.copy()
        self.hits = 1
        self.misses = 0
        self.track_id = ""
        self.observed_range = [float(points[0, 1]), float(points[-1, 1])]

    @property
    def reference_x(self) -> float:
        return float(np.interp(8.0, self.points[:, 1], self.points[:, 0]))

    def predict(self, distance: float, yaw: float) -> None:
        cosine, sine = math.cos(yaw), math.sin(yaw)
        rotation = np.array([[cosine, -sine], [sine, cosine]])
        self.points = (self.points - ego_translation(distance, yaw)) @ rotation.T
        self.points = self.points[np.argsort(self.points[:, 1])]
        self.points = self.points[(self.points[:, 1] >= -30) & (self.points[:, 1] <= 80)]

    def association_cost(self, observed: np.ndarray) -> float:
        if len(self.points) < 2:
            return math.inf
        lo = max(self.points[0, 1], observed[0, 1])
        hi = min(self.points[-1, 1], observed[-1, 1])
        if hi - lo < 3:
            return math.inf
        zs = np.linspace(lo, min(hi, lo + 25), 12)
        residual = np.abs(np.interp(zs, self.points[:, 1], self.points[:, 0])
                          - np.interp(zs, observed[:, 1], observed[:, 0]))
        return float(np.mean(residual))

    def update(self, observed: np.ndarray) -> None:
        old = self.points
        blended = observed.copy()
        overlap = (observed[:, 1] >= old[0, 1]) & (observed[:, 1] <= old[-1, 1])
        # Smooth only where both frames actually observed the road. Keep the
        # transported near-field history so roads behind ego come from footage.
        blended[overlap, 0] = (0.45 * np.interp(observed[overlap, 1], old[:, 1], old[:, 0])
                              + 0.55 * observed[overlap, 0])
        self.points = np.concatenate([old[old[:, 1] < observed[0, 1]], blended])
        self.observed_range = [float(observed[0, 1]), float(observed[-1, 1])]
        self.hits += 1
        self.misses = 0

    def polyline(self) -> list[list[float]]:
        # Uniform longitudinal support; no artificial minimum length or extrapolation.
        zs = np.linspace(self.points[0, 1], self.points[-1, 1], 48)
        xs = np.interp(zs, self.points[:, 1], self.points[:, 0])
        return np.round(np.column_stack([xs, zs]), 3).tolist()


def _lane_points(lane: list[list[float]]) -> np.ndarray | None:
    points = np.asarray(lane, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 2 or not np.isfinite(points).all():
        return None
    points = points[np.argsort(points[:, 1])]
    points = points[np.r_[True, np.diff(points[:, 1]) > 0.01]]
    return points if len(points) >= 2 and np.ptp(points[:, 1]) >= 3 else None


def _select_lane_topology(lanes: list[_LaneTrack]) -> list[_LaneTrack]:
    if len(lanes) <= 1:
        return lanes
    candidates = sorted(lanes, key=lambda lane: lane.reference_x)
    best: tuple[tuple[float, float, float], tuple[_LaneTrack, ...]] | None = None
    for count in range(1, min(MAX_OUTPUT_LANES, len(candidates)) + 1):
        for subset in combinations(candidates, count):
            spacings = [after.reference_x - before.reference_x for before, after in zip(subset, subset[1:])]
            if any(spacing < LANE_MIN_SPACING for spacing in spacings):
                continue
            spacing_error = sum(abs(spacing - max(1, round(spacing / LANE_EXPECTED_WIDTH)) * LANE_EXPECTED_WIDTH) for spacing in spacings)
            center_error = min(abs(lane.reference_x) for lane in subset)
            score = (-float(count), spacing_error, center_error)
            if best is None or score < best[0]:
                best = (score, subset)
    return list(best[1]) if best else [min(candidates, key=lambda lane: abs(lane.reference_x))]


def _update_lanes(lane_tracks: list[_LaneTrack], observed_lanes: list[list[list[float]]]) -> list[_LaneTrack]:
    observed = [points for points in (_lane_points(lane) for lane in observed_lanes) if points is not None]
    if lane_tracks and observed:
        large = 1e6
        costs = np.full((len(lane_tracks), len(observed)), large, dtype=np.float64)
        for track_index, lane_track in enumerate(lane_tracks):
            for observation_index, points in enumerate(observed):
                cost = lane_track.association_cost(points)
                if cost < LANE_MATCH_DISTANCE:
                    costs[track_index, observation_index] = cost
        rows, columns = linear_sum_assignment(costs)
        used_tracks: set[int] = set()
        used_observations: set[int] = set()
        for track_index, observation_index in zip(rows.tolist(), columns.tolist()):
            if costs[track_index, observation_index] >= large:
                continue
            lane_tracks[track_index].update(observed[observation_index])
            used_tracks.add(track_index)
            used_observations.add(observation_index)
        for index, lane_track in enumerate(lane_tracks):
            if index not in used_tracks:
                lane_track.misses += 1
        for index, params in enumerate(observed):
            if index not in used_observations:
                lane_tracks.append(_LaneTrack(params))
    else:
        for lane_track in lane_tracks:
            lane_track.misses += 1
        lane_tracks.extend(_LaneTrack(params) for params in observed)
    return [lane for lane in lane_tracks if lane.misses <= LANE_MAX_MISSES]


def smooth_timeline(frames: list[dict], ego_samples: list[dict] | None = None) -> None:
    """Replace frame observations with stable tracked objects and lanes in place."""
    tracks: list[_Track] = []
    lane_tracks: list[_LaneTrack] = []
    next_track = 1
    next_lane = 1
    world_position = np.zeros(2)
    world_yaw = 0.0
    previous_time: float | None = None
    samples = sorted(ego_samples or [], key=lambda item: float(item.get("time_sec", 0.0)))
    sample_times = [float(item.get("time_sec", 0.0)) for item in samples]

    for frame in frames:
        time_sec = float(frame.get("timeSec", 0.0))
        dt = 1.0 if previous_time is None else max(0.1, time_sec - previous_time)
        ego_distance, ego_yaw = (0.0, 0.0) if previous_time is None else _ego_delta(samples, sample_times, previous_time, time_sec)
        ego_speed = _ego_speed_at(samples, sample_times, time_sec)
        previous_time = time_sec
        rotation_to_world = np.array([[math.cos(world_yaw), math.sin(world_yaw)], [-math.sin(world_yaw), math.cos(world_yaw)]])
        world_position += rotation_to_world @ ego_translation(ego_distance, ego_yaw)
        world_yaw += ego_yaw
        if samples:
            frame["egoPose"] = {"x": round(float(world_position[0]), 5), "z": round(float(world_position[1]), 5), "yaw": round(world_yaw, 7)}
        frame["velocityFrame"] = "world-in-ego-axes" if samples else "ego-relative"
        for item in frame.get("objects", []):
            item["timeSec"] = time_sec
            for observation in item.get("observations", []):
                observation["timeSec"] = time_sec

        for track in tracks:
            track.predict(dt, ego_distance, ego_yaw)

        detections = [item for item in frame.get("objects", []) if _is_plausible_detection(item)]
        matches, used_tracks, used_detections = _associate(tracks, detections)
        for track_index, detection_index in matches.items():
            tracks[track_index].update(detections[detection_index])
        for track_index, track in enumerate(tracks):
            if track_index not in used_tracks:
                track.misses += 1
        for detection_index, detection in enumerate(detections):
            if detection_index not in used_detections:
                tracks.append(_Track(f"track-{next_track:04d}", detection, ego_speed))
                next_track += 1
        tracks = _resolve_overlaps([track for track in tracks if track.misses <= MAX_MISSES])
        frame["objects"] = [
            track.to_object()
            for track in tracks
            if track.hits >= CONFIRM_HITS
            and track.misses <= COAST_OUTPUT_MISSES
            and (track.misses == 0 or track.hits >= 4)
        ]

        for lane in lane_tracks:
            lane.predict(ego_distance, ego_yaw)
        lane_tracks = [lane for lane in lane_tracks if len(lane.points) >= 2]
        lane_tracks = _update_lanes(lane_tracks, frame.get("lanes", []))
        for lane in lane_tracks:
            if not lane.track_id:
                lane.track_id = f"lane-{next_lane:04d}"
                next_lane += 1
        stable = [
            lane for lane in lane_tracks
            if lane.hits >= LANE_CONFIRM_HITS and lane.misses <= LANE_OUTPUT_MISSES
        ]
        selected = _select_lane_topology(stable)
        frame["lanes"] = [lane.polyline() for lane in selected]
        frame["laneIds"] = [lane.track_id for lane in selected]
        frame["laneStates"] = [{"predicted": lane.misses > 0, "observedRange": lane.observed_range if not lane.misses else None} for lane in selected]
