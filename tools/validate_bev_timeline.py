#!/usr/bin/env python3
"""Check generated BEV timelines against physical plausibility limits.

The reconstruction can fail quietly: a bad calibration still produces a full
timeline, just one where vehicles interpenetrate, jump between frames, or sit
beyond any camera's usable range. This reports those directly so a clip can be
judged without watching it.

Example:
    .recon-venv/bin/python tools/validate_bev_timeline.py \\
      public/reconstruction/*-bev-timeline.json
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

# Two road users cannot occupy the same footprint; matches the reconstruction's
# own deduplication limits.
FOOTPRINT_HALF_X = 1.9
FOOTPRINT_HALF_Z = 3.0
# Opposing motorway traffic can have a large relative speed, but 80 m/s in the
# ego frame is already beyond a credible closing rate for this footage.
MAX_TRACK_SPEED_MPS = 80.0
MAX_OBJECT_RANGE_M = 120.0
MAX_GROUND_RAY_FRACTION = 0.35
MIN_LANE_SPACING_M = 2.2
MAX_LANE_SPACING_M = 6.0


def interpenetrating_pairs(objects: list[dict]) -> int:
    count = 0
    for index, first in enumerate(objects):
        for second in objects[index + 1:]:
            offset_x = first["x"] - second["x"]
            offset_z = first["z"] - second["z"]
            if (offset_x / FOOTPRINT_HALF_X) ** 2 + (offset_z / FOOTPRINT_HALF_Z) ** 2 < 1.0:
                count += 1
    return count


def analyse_payload(payload: dict, fallback_clip: str = "timeline") -> dict:
    frames = payload.get("frames", [])
    if not isinstance(frames, list) or not frames:
        return {"clip": payload.get("clip", fallback_clip), "error": "no frames", "frames": 0}

    # Validate before arithmetic so malformed caches produce a report, not a crash.
    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    for frame in frames:
        if not isinstance(frame, dict) or not isinstance(frame.get("objects"), list) or not isinstance(frame.get("lanes"), list):
            return {"error": "invalid frame structure", "frames": len(frames)}
        for item in frame["objects"]:
            if not isinstance(item, dict) or not all(finite(item.get(key)) for key in ("x", "z", "width", "length", "confidence", "heading")):
                return {"error": "invalid object geometry", "frames": len(frames)}
            if not (0 < item["width"] <= 5 and 0 < item["length"] <= 20 and 0 <= item["confidence"] <= 1):
                return {"error": "invalid object dimensions/confidence", "frames": len(frames)}
        for lane in frame["lanes"]:
            if not isinstance(lane, list) or len(lane) < 2 or any(
                not isinstance(point, list) or len(point) != 2 or not all(finite(v) for v in point) for point in lane
            ):
                return {"error": "invalid lane geometry", "frames": len(frames)}
            if any(b[1] <= a[1] for a, b in zip(lane, lane[1:])):
                return {"error": "lane support is not increasing", "frames": len(frames)}

    object_counts = [len(frame.get("objects", [])) for frame in frames]
    lane_counts = [len(frame.get("lanes", [])) for frame in frames]
    overlaps = sum(interpenetrating_pairs(frame.get("objects", [])) for frame in frames)
    sources = Counter(item.get("rangeSource", "unknown") for frame in frames for item in frame.get("objects", []))

    positions: dict[str, list[tuple[float, float, float]]] = {}
    duplicate_ids = 0
    non_finite = 0
    out_of_range = 0
    non_monotonic = 0
    previous_time = -math.inf
    for frame in frames:
        time_sec = frame.get("timeSec")
        if not isinstance(time_sec, (int, float)) or not math.isfinite(time_sec):
            non_finite += 1
            continue
        if time_sec <= previous_time:
            non_monotonic += 1
        previous_time = time_sec
        ids: set[str] = set()
        for item in frame.get("objects", []):
            track_id = item.get("id")
            values = [item.get(key) for key in ("x", "z", "width", "length", "confidence")]
            if not isinstance(track_id, str) or not track_id or any(
                not isinstance(value, (int, float)) or not math.isfinite(value) for value in values
            ):
                non_finite += 1
                continue
            if track_id in ids:
                duplicate_ids += 1
            ids.add(track_id)
            if math.hypot(item["x"], item["z"]) > MAX_OBJECT_RANGE_M:
                out_of_range += 1
            positions.setdefault(track_id, []).append((time_sec, item["x"], item["z"]))

    jumps = 0
    steps: list[float] = []
    for track in positions.values():
        for before, after in zip(track, track[1:]):
            step = math.hypot(after[1] - before[1], after[2] - before[2])
            steps.append(step)
            dt = after[0] - before[0]
            if dt <= 0 or step / dt > MAX_TRACK_SPEED_MPS:
                jumps += 1

    bad_spacing = 0
    lane_pairs = 0
    for frame in frames:
        lanes = frame.get("lanes", [])
        # Compare at the same longitudinal station, never at different endpoints.
        lo = max((lane[0][1] for lane in lanes), default=0)
        hi = min((lane[-1][1] for lane in lanes), default=0)
        station = min(hi, max(lo, 8.0))
        offsets = []
        if hi >= lo:
            for lane in lanes:
                for a, b in zip(lane, lane[1:]):
                    if a[1] <= station <= b[1]:
                        offsets.append(a[0] + (b[0] - a[0]) * (station - a[1]) / (b[1] - a[1]))
                        break
        offsets.sort()
        for before, after in zip(offsets, offsets[1:]):
            lane_pairs += 1
            if after - before < MIN_LANE_SPACING_M:
                bad_spacing += 1

    confirmed = [track for track in positions.values() if len(track) >= 3]
    track_lengths = sorted(len(track) for track in positions.values())
    return {
        "clip": payload.get("clip", fallback_clip),
        "frames": len(frames),
        "backend": payload.get("rangeBackend", "ground-ray"),
        "calibrated": bool(payload.get("calibrated", False)),
        "objectsPerFrame": sum(object_counts) / len(object_counts),
        "lanesPerFrame": sum(lane_counts) / len(lane_counts),
        "emptyLaneFrames": lane_counts.count(0),
        "observationFrames": sum(bool(f.get("objects") or f.get("lanes")) for f in frames),
        "tracks": len(positions),
        "confirmedTracks": len(confirmed),
        "medianTrackLength": track_lengths[len(track_lengths) // 2] if track_lengths else 0,
        "meanStepM": sum(steps) / len(steps) if steps else 0.0,
        "jumps": jumps,
        "overlaps": overlaps,
        "laneSpacingViolations": f"{bad_spacing}/{lane_pairs}",
        "laneSpacingViolationCount": bad_spacing,
        "laneSpacingPairCount": lane_pairs,
        "rangeSources": dict(sources),
        "duplicateIds": duplicate_ids,
        "nonFiniteValues": non_finite,
        "outOfRangeObjects": out_of_range,
        "nonMonotonicFrames": non_monotonic,
    }


def analyse(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {"clip": path.stem, "error": f"invalid JSON: {error}"}
    if not isinstance(payload, dict):
        return {"clip": path.stem, "error": "root is not an object"}
    return analyse_payload(payload, path.stem)


def quality_gate(report: dict, require_moge2: bool = True) -> dict:
    """Return the machine-readable quality decision used by generator and UI."""
    reasons: list[str] = []
    warnings: list[str] = ["尚未用独立标定/距离真值验证几何精度"]
    if report.get("error"):
        reasons.append(str(report["error"]))
    if report.get("frames", 0) < 2:
        reasons.append("同步帧不足")
    if require_moge2 and report.get("backend") != "moge2":
        reasons.append("未使用 MoGe-2 米制深度")
    if report.get("jumps", 0):
        reasons.append(f"检测到 {report['jumps']} 次轨迹瞬移")
    if report.get("overlaps", 0):
        reasons.append(f"检测到 {report['overlaps']} 对目标穿透")
    if report.get("duplicateIds", 0):
        reasons.append("单帧存在重复轨迹编号")
    if report.get("nonFiniteValues", 0):
        reasons.append("包含无效几何数值")
    if report.get("outOfRangeObjects", 0):
        reasons.append("目标超出重建有效范围")
    if report.get("nonMonotonicFrames", 0):
        reasons.append("时间轴不是严格递增的")

    sources = report.get("rangeSources", {})
    if isinstance(sources, dict):
        moge = int(sources.get("moge2", 0))
        fallback = sum(int(count) for source, count in sources.items() if source != "moge2")
        if moge + fallback and fallback / (moge + fallback) > MAX_GROUND_RAY_FRACTION:
            reasons.append("低精度地面射线距离占比过高")

    lane_pairs = int(report.get("laneSpacingPairCount", 0))
    lane_bad = int(report.get("laneSpacingViolationCount", 0))
    if lane_pairs >= 20 and lane_bad / lane_pairs > 0.5:
        reasons.append("多数车道间距不符合道路几何")
    elif lane_bad:
        warnings.append(f"{lane_bad}/{lane_pairs} 对车道间距需要复核")
    if report.get("tracks", 0) and report.get("medianTrackLength", 0) < 3:
        warnings.append("轨迹寿命偏短，目标可能闪烁")
    if not report.get("calibrated", False):
        warnings.append("使用近似种子标定，米制位置仅供参考")
    structural_passed = not reasons
    if not report.get("observationFrames", 0):
        reasons.append("没有可用目标或车道观测，请核对源视频")
    elif report.get("emptyLaneFrames", 0):
        warnings.append(f"{report['emptyLaneFrames']} 帧没有车道观测")
    return {"passed": not reasons, "structuralPassed": structural_passed,
            "observationCoverage": "available" if report.get("observationFrames", 0) else "none",
            "geometryVerified": False, "reasons": reasons, "warnings": warnings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="Print machine-readable reports")
    parser.add_argument("--allow-ground-ray", action="store_true", help="Do not fail a timeline that lacks MoGe-2")
    args = parser.parse_args()

    failures = 0
    reports: list[dict] = []
    if not args.json:
        print(f"{'clip':<22}{'frm':>4}{'obj/f':>7}{'lane/f':>7}{'trk':>5}{'step':>6}{'jump':>6}{'ovlp':>6}  backend")
    for path in sorted(args.files):
        report = analyse(path)
        gate = quality_gate(report, require_moge2=not args.allow_ground_ray)
        report["qualityGate"] = gate
        reports.append(report)
        if not gate["passed"]:
            failures += 1
        if args.json:
            continue
        if "error" in report:
            print(f"{report['clip']:<22}  {report['error']}")
            continue
        print(
            f"{report['clip']:<22}{report['frames']:>4}{report['objectsPerFrame']:>7.1f}"
            f"{report['lanesPerFrame']:>7.1f}{report['confirmedTracks']:>5}"
            f"{report['meanStepM']:>6.2f}{report['jumps']:>6}{report['overlaps']:>6}  {report['backend']}"
        )
    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        print()
        print(f"{len(args.files) - failures}/{len(args.files)} clips passed the BEV quality gate")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
