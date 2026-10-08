"""Content fingerprint shared with the local Vite reconstruction service."""
from hashlib import sha256
from pathlib import Path
import json

SCHEMA_VERSION = 4
TRACKER_VERSION = 'kalman-road-history-v2'
PIPELINE_FILES = [
    'tools/bev_version.py', 'tools/bev_tracker.py', 'tools/moge_depth.py',
    'tools/reconstruct_bev.py', 'tools/reconstruct_bev_timeline.py',
    'tools/validate_bev_timeline.py',
]


def pipeline_fingerprint(root: Path, calibration: Path, model: Path) -> str:
    digest = sha256()
    for name in PIPELINE_FILES:
        digest.update(name.encode() + b'\n' + (root / name).read_bytes())
    digest.update(b'calibration\n' + calibration.read_bytes())
    digest.update(b'model\n' + model.read_bytes())
    return digest.hexdigest()


def source_fingerprint(videos: dict[str, Path]) -> str:
    entries = sorted([path.name, path.stat().st_size, int(path.stat().st_mtime)] for path in videos.values())
    return sha256(json.dumps(entries, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
