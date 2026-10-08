#!/usr/bin/env python3
"""Build a time-indexed semantic BEV track from a TeslaCam event segment.

The detector is loaded once, then each synchronized six-camera timestamp is
projected into the vehicle frame. The compact JSON result is designed for the
browser player: it contains real detections and lane observations, but no raw
video pixels.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

from bev_tracker import smooth_timeline
from bev_version import SCHEMA_VERSION, TRACKER_VERSION, pipeline_fingerprint, source_fingerprint
from reconstruct_bev import (
    compute_depth_frames,
    default_calibration,
    detect_front_lanes,
    detect_objects,
    discover_videos,
    load_depth_estimator,
    load_profile,
    read_frame,
)
from validate_bev_timeline import analyse_payload, quality_gate
from extract_telemetry import extract_clip


def load_ego_samples(front_video: Path) -> list[dict]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("SEI ego motion unavailable: ffmpeg/ffprobe not found", flush=True)
        return []
    try:
        samples, _, _ = extract_clip(front_video, ffmpeg, ffprobe, 0.0)
    except Exception as error:  # noqa: BLE001 - telemetry must not block geometry
        print(f"SEI ego motion unavailable: {error}", flush=True)
        return []
    print(f"SEI ego motion samples={len(samples)}", flush=True)
    return samples


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--clip", required=True)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument("--step", type=float, default=0.5)
    parser.add_argument("--calibration", type=Path, default=None)
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--confidence", type=float, default=0.24)
    parser.add_argument("--no-depth", action="store_true", help="Skip MoGe metric depth, use ground-ray range")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    calibration_path = args.calibration or default_calibration()
    profile_raw, profiles = load_profile(calibration_path)
    if args.step <= 0 or args.duration <= 0:
        parser.error("step and duration must be positive")
    videos = discover_videos(args.folder, args.clip)
    missing = sorted(set(profiles) - set(videos))
    if missing:
        raise SystemExit(f"missing cameras: {', '.join(missing)}")
    fingerprint = pipeline_fingerprint(Path(__file__).resolve().parent.parent, calibration_path, Path(args.model))
    source_signature = source_fingerprint(videos)
    estimator = None if args.no_depth else load_depth_estimator()
    ego_samples = load_ego_samples(videos["front"])

    frames_out: list[dict] = []
    time_sec = max(0.0, args.start)
    end_time = time_sec + max(args.step, args.duration)
    while time_sec < end_time - 1e-6:
        try:
            frames = {camera: read_frame(path, time_sec) for camera, path in videos.items()}
        except RuntimeError as error:
            print(f"stop at {time_sec:.2f}s: {error}", flush=True)
            break
        depth_frames = compute_depth_frames(frames, profiles, estimator)
        objects, _ = detect_objects(frames, profiles, args.model, args.confidence, depth_frames)
        for item in objects:
            for observation in item.get("observations", []):
                observation["sourceFile"] = videos[observation["camera"]].name
        lanes = detect_front_lanes(frames["front"], profiles["front"], depth_frames.get("front"))
        frames_out.append({
            "timeSec": round(time_sec, 3),
            "objects": objects,
            "lanes": lanes,
        })
        print(f"{time_sec:06.2f}s objects={len(objects)} lanes={len(lanes)}", flush=True)
        time_sec += max(0.1, args.step)

    raw_frames = json.loads(json.dumps(frames_out))
    smooth_timeline(frames_out, ego_samples)

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "pipelineFingerprint": fingerprint,
        "sourceFingerprint": source_signature,
        "durationSec": args.duration,
        "startSec": args.start,
        "clip": args.clip,
        "source": "six-camera-yolo-moge2-bev" if estimator is not None else "six-camera-yolo-ground-projection",
        "calibrated": bool(profile_raw.get("calibrated", False)),
        "calibration": profile_raw.get("name"),
        "stepSec": max(0.1, args.step),
        "rangeBackend": "moge2" if estimator is not None else "ground-ray",
        "tracker": TRACKER_VERSION,
        "positionReference": "estimated-center",
        "geometryVerified": False,
        "rawFrames": raw_frames,
        "egoMotionCompensated": bool(ego_samples),
        "egoSamples": ego_samples,
        "frames": frames_out,
        "notes": [
            "Each frame uses synchronized detections from all six TeslaCam cameras.",
            "Object range and lane geometry use the selected camera calibration profile.",
            "Objects use covariance-aware Kalman tracking and global assignment.",
            "SEI speed and heading compensate ego motion when embedded telemetry is available.",
            "Lane tracks persist through missed detections and are filtered by road-width topology.",
        ],
    }
    report = analyse_payload(payload, args.clip)
    payload["qualityGate"] = quality_gate(report, require_moge2=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Replace atomically so the dev server never validates a half-written JSON
    # file while the last frame is being flushed.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.output.parent, delete=False) as temporary:
        temporary.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, args.output)
    print(f"wrote {args.output} ({len(frames_out)} frames)")
    if not payload["qualityGate"]["passed"]:
        raise SystemExit("BEV quality gate failed: " + "; ".join(payload["qualityGate"]["reasons"]))


if __name__ == "__main__":
    main()
