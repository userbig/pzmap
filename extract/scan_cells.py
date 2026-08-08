"""Scan all .lotheader files of a town: room count per cell + room name histogram."""
import os
import re
import struct
import sys
from collections import Counter

DEFAULT_GAME_DIR = os.environ.get(
    "PZMAP_GAME_DIR", r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid"
)
MAPS = os.path.join(DEFAULT_GAME_DIR, "media", "maps")


def parse_rooms(path):
    """Returns the list of a cell's room names (fast, no objects/buildings)."""
    data = open(path, "rb").read()
    if data[:4] != b"LOTH":
        raise ValueError(f"not LOTH: {path}")
    pos = 8
    (ntiles,) = struct.unpack_from("<i", data, pos)
    pos += 4
    for _ in range(ntiles):
        pos = data.index(b"\n", pos) + 1
    pos += 16  # w, h, min_level, max_level
    (nrooms,) = struct.unpack_from("<i", data, pos)
    pos += 4
    names = []
    for _ in range(nrooms):
        end = data.index(b"\n", pos)
        names.append(data[pos:end].decode("utf-8", "replace"))
        pos = end + 1
        level, nrects = struct.unpack_from("<ii", data, pos)
        pos += 8 + nrects * 16
        (nobjs,) = struct.unpack_from("<i", data, pos)
        pos += 4 + nobjs * 12
    return names


def main(town):
    folder = os.path.join(MAPS, town)
    per_cell = {}
    hist = Counter()
    for fn in os.listdir(folder):
        m = re.fullmatch(r"(\d+)_(\d+)\.lotheader", fn)
        if not m:
            continue
        names = parse_rooms(os.path.join(folder, fn))
        if names:
            per_cell[(int(m.group(1)), int(m.group(2)))] = len(names)
            hist.update(names)
    print(f"{town}: cells with rooms: {len(per_cell)}, total rooms: {sum(per_cell.values())}")
    top = sorted(per_cell.items(), key=lambda kv: -kv[1])[:10]
    print("top cells:", ", ".join(f"{x}_{y}={n}" for (x, y), n in top))
    print("top room names:")
    for name, n in hist.most_common(25):
        print(f"  {name:30s} {n}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Muldraugh, KY")
