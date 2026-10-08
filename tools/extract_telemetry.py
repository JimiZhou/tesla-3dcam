#!/usr/bin/env python3
"""Extract Tesla per-frame vehicle telemetry from H.264 SEI metadata.

Requires ffmpeg and ffprobe. The generated JSON can be imported directly into
Scene / Replay. Newer driving clips may contain this stream; older firmware and
stationary Sentry clips can legitimately contain no samples.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO, Iterator

MAGIC = b"\x42\x42\x42\x69"
FIELDS: dict[int, tuple[str, str]] = {
    1: ("version", "varint"),
    2: ("gear_state", "varint"),
    3: ("frame_seq_no", "varint"),
    4: ("vehicle_speed_mps", "float"),
    5: ("accelerator_pedal_position", "float"),
    6: ("steering_wheel_angle", "float"),
    7: ("blinker_on_left", "varint"),
    8: ("blinker_on_right", "varint"),
    9: ("brake_applied", "varint"),
    10: ("autopilot_state", "varint"),
    11: ("latitude_deg", "double"),
    12: ("longitude_deg", "double"),
    13: ("heading_deg", "double"),
    14: ("linear_acceleration_mps2_x", "double"),
    15: ("linear_acceleration_mps2_y", "double"),
    16: ("linear_acceleration_mps2_z", "double"),
}


def _read_varint(data: bytes, offset: int) -> tuple[int | None, int]:
    value = 0
    shift = 0
    while offset < len(data) and shift <= 63:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    return None, offset


def _remove_emulation_bytes(data: bytes) -> bytes:
    result = bytearray()
    index = 0
    while index < len(data):
        if (
            index >= 2
            and data[index] == 3
            and data[index - 2:index] == b"\x00\x00"
            and (index + 1 == len(data) or data[index + 1] <= 3)
        ):
            index += 1
            continue
        result.append(data[index])
        index += 1
    return bytes(result)


def _iter_annex_b_nals(stream: BinaryIO) -> Iterator[bytes]:
    buffer = bytearray()
    eof = False
    while not eof:
        chunk = stream.read(1024 * 1024)
        if chunk:
            buffer.extend(chunk)
        else:
            eof = True

        while True:
            first = buffer.find(b"\x00\x00\x01")
            if first < 0:
                if len(buffer) > 4:
                    del buffer[:-4]
                break
            second = buffer.find(b"\x00\x00\x01", first + 3)
            if second < 0:
                if first > 0:
                    del buffer[:first]
                break
            nal = bytes(buffer[first + 3:second])
            del buffer[:second]
            if nal:
                yield nal

        if eof:
            first = buffer.find(b"\x00\x00\x01")
            if first >= 0 and first + 3 < len(buffer):
                yield bytes(buffer[first + 3:])
            break


def _iter_sei_messages(nal: bytes) -> Iterator[bytes]:
    if not nal or nal[0] & 0x1F != 6:
        return
    rbsp = _remove_emulation_bytes(nal[1:])
    offset = 0
    while offset < len(rbsp) and rbsp[offset] != 0x80:
        payload_type = 0
        while offset < len(rbsp) and rbsp[offset] == 0xFF:
            payload_type += 255
            offset += 1
        if offset >= len(rbsp):
            return
        payload_type += rbsp[offset]
        offset += 1

        payload_size = 0
        while offset < len(rbsp) and rbsp[offset] == 0xFF:
            payload_size += 255
            offset += 1
        if offset >= len(rbsp):
            return
        payload_size += rbsp[offset]
        offset += 1
        if offset + payload_size > len(rbsp):
            return
        payload = rbsp[offset:offset + payload_size]
        offset += payload_size
        if payload_type == 5 and MAGIC in payload:
            yield payload


def _decode_message(payload: bytes) -> dict[str, object] | None:
    magic_at = payload.find(MAGIC)
    protobuf_at = payload.find(b"\x08", magic_at + len(MAGIC))
    if magic_at < 0 or protobuf_at < 0:
        return None
    data = payload[protobuf_at:]
    offset = 0
    result: dict[str, object] = {}
    while offset < len(data):
        tag, offset = _read_varint(data, offset)
        if tag is None:
            break
        field_number = tag >> 3
        wire_type = tag & 7
        if wire_type == 0:
            value, offset = _read_varint(data, offset)
            if value is None:
                break
        elif wire_type == 5:
            if offset + 4 > len(data):
                break
            value = struct.unpack_from("<f", data, offset)[0]
            offset += 4
        elif wire_type == 1:
            if offset + 8 > len(data):
                break
            value = struct.unpack_from("<d", data, offset)[0]
            offset += 8
        elif wire_type == 2:
            length, offset = _read_varint(data, offset)
            if length is None or offset + length > len(data):
                break
            offset += length
            continue
        else:
            break
        field = FIELDS.get(field_number)
        if field:
            result[field[0]] = value

    for key in ("blinker_on_left", "blinker_on_right", "brake_applied"):
        result[key] = bool(result.get(key, False))
    return result if "frame_seq_no" in result or "vehicle_speed_mps" in result else None


def _probe(path: Path, ffprobe: str) -> tuple[float, float]:
    command = [
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate:format=duration", "-of", "json", str(path),
    ]
    payload = json.loads(subprocess.check_output(command))
    rate = payload["streams"][0].get("avg_frame_rate", "30/1")
    numerator, denominator = (float(part) for part in rate.split("/"))
    fps = numerator / denominator if denominator else 30.0
    duration = float(payload.get("format", {}).get("duration", 0))
    return fps, duration


def extract_clip(path: Path, ffmpeg: str, ffprobe: str, offset_sec: float) -> tuple[list[dict[str, object]], float, float]:
    fps, duration = _probe(path, ffprobe)
    command = [
        ffmpeg, "-v", "error", "-i", str(path), "-map", "0:v:0",
        "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    samples: list[dict[str, object]] = []
    seen_sequences: set[int] = set()
    first_sequence: int | None = None
    for nal in _iter_annex_b_nals(process.stdout):
        for payload in _iter_sei_messages(nal):
            sample = _decode_message(payload)
            if not sample:
                continue
            sequence = int(sample.get("frame_seq_no", len(samples)))
            if sequence in seen_sequences:
                continue
            seen_sequences.add(sequence)
            if first_sequence is None:
                first_sequence = sequence
            sample["time_sec"] = offset_sec + (sequence - first_sequence) / fps
            sample["clip"] = path.name
            samples.append(sample)
    stderr = process.communicate()[1]
    if process.returncode:
        raise RuntimeError(stderr.decode("utf-8", "replace").strip() or f"ffmpeg failed for {path.name}")
    return samples, fps, duration


def discover(source: Path) -> list[Path]:
    if source.is_file():
        return [source]
    front = sorted(source.rglob("*-front.mp4"))
    if front:
        return front
    return sorted(source.rglob("*.mp4"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract embedded Tesla vehicle-state telemetry")
    parser.add_argument("source", type=Path, help="event folder or one Tesla MP4")
    parser.add_argument("-o", "--output", type=Path, help="output JSON path")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        parser.error("ffmpeg and ffprobe must be available on PATH")
    clips = discover(args.source.expanduser().resolve())
    if not clips:
        parser.error("no MP4 files found")

    all_samples: list[dict[str, object]] = []
    offset = 0.0
    output_fps = 30.0
    for clip in clips:
        print(f"extracting {clip.name}...", file=sys.stderr)
        samples, output_fps, duration = extract_clip(clip, ffmpeg, ffprobe, offset)
        all_samples.extend(samples)
        offset += duration

    output = args.output or (args.source if args.source.is_dir() else args.source.parent) / "scene-replay-telemetry.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "schema": "scene-replay/telemetry@1",
        "source": "sei",
        "fps": output_fps,
        "samples": all_samples,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(all_samples)} samples to {output}")
    if not all_samples:
        print("No Tesla SEI telemetry found. The clip may be parked or from older firmware.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
