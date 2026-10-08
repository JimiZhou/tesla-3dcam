#!/usr/bin/env python3
"""Project a sparse SfM PLY into a BEV scene interchange file.

This is deliberately a geometry-only stage. It does not invent object labels:
``objects`` stays empty until a calibrated detector/tracker supplies them.
The output is intended to be consumed by the browser BEV layer or by a later
occupancy/depth model.

Example:
    .recon-venv/bin/python tools/build_bev_scene.py \
      public/reconstruction/07-20-38.ply \
      --output public/reconstruction/07-20-38-bev.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def read_ply(path: Path) -> list[tuple[float, float, float, int, int, int]]:
    text = path.read_text(encoding="utf-8")
    header_end = text.find("end_header")
    if header_end < 0:
        raise ValueError("PLY header is missing end_header")
    header = text[:header_end].splitlines()
    vertex_line = next((line for line in header if line.startswith("element vertex ")), None)
    count = int(vertex_line.split()[2]) if vertex_line else 0
    rows = text[header_end + len("end_header") :].strip().splitlines()
    points: list[tuple[float, float, float]] = []
    for row in rows[:count]:
        values = row.split()
        if len(values) < 6:
            continue
        try:
            x, y, z = (float(values[index]) for index in range(3))
            r, g, b = (int(float(values[index])) for index in range(3, 6))
        except ValueError:
            continue
        points.append((x, y, z, r, g, b))
    return points


def project(points: list[tuple[float, float, float]], cell: float, max_points: int) -> list[list[float]]:
    # Keep the point nearest the ground in each BEV cell. This removes optical
    # flow duplicates while retaining an RGB hint for the browser renderer.
    cells: dict[tuple[int, int], tuple[float, float, float, int, int, int]] = {}
    for x, y, z, r, g, b in points:
        key = (round(x / cell), round(z / cell))
        current = cells.get(key)
        if current is None or y < current[1]:
            cells[key] = (x, y, z, r, g, b)
    selected = sorted(cells.values(), key=lambda item: abs(item[0]) + abs(item[2]))[:max_points]
    return [[round(x, 4), round(z, 4), round(y, 4), r, g, b] for x, y, z, r, g, b in selected]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ply", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cell", type=float, default=0.18, help="BEV downsample cell in scene units")
    parser.add_argument("--max-points", type=int, default=24000)
    args = parser.parse_args()

    points = read_ply(args.ply)
    occupancy = project(points, max(0.02, args.cell), max(1, args.max_points))
    scene = {
        "schemaVersion": 1,
        "source": "video-sfm",
        "coordinateFrame": "tesla-vehicle-seed-extrinsics",
        "calibrated": False,
        "occupancyPoints": occupancy,
        "objects": [],
        "lanePoints": [],
        "notes": [
            "Sparse SfM only; no semantic detector has been applied.",
            "Scale and camera extrinsics remain approximate until a calibration profile is supplied.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({len(points)} input points, {len(occupancy)} BEV cells)")


if __name__ == "__main__":
    main()
