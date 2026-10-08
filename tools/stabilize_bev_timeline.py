#!/usr/bin/env python3
"""Re-run temporal tracking/smoothing over existing BEV timeline JSON files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from bev_tracker import smooth_timeline


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--force", action="store_true", help="Re-smooth files already at schemaVersion 2")
    args = parser.parse_args()
    for path in args.files:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if int(payload.get("schemaVersion", 1)) >= 2 and not args.force:
            print(f"skip {path}: already smoothed (use --force to re-run)")
            continue
        smooth_timeline(payload["frames"])
        payload["schemaVersion"] = 2
        notes = payload.setdefault("notes", [])
        smoothing_note = "Objects and lanes are temporally tracked and smoothed (alpha-beta + EMA)."
        if smoothing_note not in notes:
            notes.append(smoothing_note)
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"stabilized {path} ({len(payload['frames'])} frames)")


if __name__ == "__main__":
    main()
