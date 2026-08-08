#!/usr/bin/env python3
"""
pack_release.py - splits render/gen/html/map_data/base into zip parts sized
for GitHub Releases (2 GB per-file limit), so the tile pack can be attached
to a release and unpacked into render/ by anyone building/running locally
(see README.md's "Run locally" section).

Files are bin-packed greedily (in path order) into parts that stay under
--max-size-gb (default 1.9 GB, leaving headroom below GitHub's 2 GB cap).
Each part is a plain, uncompressed (ZIP_STORED) zip - the tiles are already
compressed images, so re-compressing them would just burn CPU for no size
benefit - containing the files at their path relative to --source, so
unpacking any/all parts on top of each other reconstructs the same tree.
A manifest.json next to the parts records, per part, its file count, total
size and the list of files, plus overall totals - for verifying a download
before trusting it.

Usage:
    python tools/pack_release.py --dry-run   # print the packing plan only
    python tools/pack_release.py             # actually write the zip parts
"""

import argparse
import json
import sys
import time
import zipfile
from pathlib import Path

DEFAULT_SOURCE = Path(__file__).resolve().parent.parent / "render" / "gen" / "html" / "map_data" / "base"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "release_packs"
GIB = 1024 ** 3


def iter_files(source: Path):
    """All files under source, sorted for a deterministic packing plan."""
    for p in sorted(source.rglob("*")):
        if p.is_file():
            yield p


def plan_parts(source: Path, max_size_bytes: int):
    """Greedily bin-pack files (in path order) into parts <= max_size_bytes.
    A single file larger than the limit gets its own oversized part rather
    than being split (zip doesn't support splitting one entry across parts
    in a way plain `unzip`/Explorer can reassemble)."""
    parts = []
    current = []
    current_size = 0
    for f in iter_files(source):
        size = f.stat().st_size
        if current and current_size + size > max_size_bytes:
            parts.append(current)
            current = []
            current_size = 0
        current.append((f, size))
        current_size += size
    if current:
        parts.append(current)
    return parts


def write_part(part_index: int, files, source: Path, output_dir: Path, prefix: str) -> dict:
    name = f"{prefix}_part{part_index:03d}.zip"
    dest = output_dir / name
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED) as zf:
        for f, _size in files:
            zf.write(f, f.relative_to(source).as_posix())
    return {
        "file": name,
        "bytes": dest.stat().st_size,
        "entry_count": len(files),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE),
                         help="Directory to pack (default: render/gen/html/map_data/base)")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT),
                         help="Where to write the zip parts + manifest.json (default: release_packs/)")
    parser.add_argument("--prefix", default="pzmap-tiles",
                         help="Zip filename prefix (default: pzmap-tiles -> pzmap-tiles_part001.zip, ...)")
    parser.add_argument("--max-size-gb", type=float, default=1.9,
                         help="Max size per zip part, in GiB (default: 1.9, under GitHub's 2 GB release-asset limit)")
    parser.add_argument("--dry-run", action="store_true",
                         help="Only compute and print the packing plan; don't write any zip files")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.is_dir():
        print(f"error: source directory not found: {source}", file=sys.stderr)
        return 1

    max_size_bytes = int(args.max_size_gb * GIB)
    parts = plan_parts(source, max_size_bytes)
    total_files = sum(len(p) for p in parts)
    total_bytes = sum(size for p in parts for _f, size in p)

    print(f"Source: {source}")
    print(f"Max part size: {args.max_size_gb} GiB")
    print(f"Files: {total_files}  Total size: {total_bytes / GIB:.2f} GiB")
    print(f"Parts: {len(parts)}")
    for i, part in enumerate(parts, start=1):
        part_bytes = sum(size for _f, size in part)
        print(f"  part{i:03d}: {len(part):6d} files, {part_bytes / GIB:6.2f} GiB")

    if args.dry_run:
        print("\nDry run - no zip files were written.")
        return 0

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "source": str(source),
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "max_part_size_bytes": max_size_bytes,
        "total_files": total_files,
        "total_bytes": total_bytes,
        "parts": [],
    }
    for i, part in enumerate(parts, start=1):
        print(f"Writing part {i}/{len(parts)}...")
        info = write_part(i, part, source, output_dir, args.prefix)
        manifest["parts"].append(info)

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nWrote {len(parts)} part(s) and {manifest_path.name} to {output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
