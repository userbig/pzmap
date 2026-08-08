"""M1 sanity check: render all buildings of the world into a PNG (1 pixel = 2 tiles).

If the geometry was parsed correctly, the image will show a recognizable Knox County.
"""
import argparse
import os
import re
import struct
from pathlib import Path
from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GAME_DIR = os.environ.get(
    "PZMAP_GAME_DIR", r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid"
)
TOWN = "Muldraugh, KY"
CELL = 256
SCALE = 2  # tiles per pixel


def parse_args():
    p = argparse.ArgumentParser(
        description="M1 sanity check: render all buildings of the world into data/overview.png."
    )
    p.add_argument(
        "--game-dir",
        default=DEFAULT_GAME_DIR,
        help="Path to the ProjectZomboid installation "
             "(default: $PZMAP_GAME_DIR env var, or %(default)r)",
    )
    return p.parse_args()


def parse_cell(path):
    """[(name, level, [(x,y,w,h)...])] in local cell coordinates."""
    data = open(path, "rb").read()
    if data[:4] != b"LOTH":
        return []
    pos = 8
    (ntiles,) = struct.unpack_from("<i", data, pos)
    pos += 4
    for _ in range(ntiles):
        pos = data.index(b"\n", pos) + 1
    pos += 16
    (nrooms,) = struct.unpack_from("<i", data, pos)
    pos += 4
    rooms = []
    for _ in range(nrooms):
        end = data.index(b"\n", pos)
        name = data[pos:end].decode("utf-8", "replace")
        pos = end + 1
        level, nrects = struct.unpack_from("<ii", data, pos)
        pos += 8
        rects = [struct.unpack_from("<iiii", data, pos + i * 16) for i in range(nrects)]
        pos += nrects * 16
        (nobjs,) = struct.unpack_from("<i", data, pos)
        pos += 4 + nobjs * 12
        rooms.append((name, level, rects))
    return rooms


def main():
    args = parse_args()
    folder = os.path.join(args.game_dir, "media", "maps", TOWN)
    cells = []
    for fn in os.listdir(folder):
        m = re.fullmatch(r"(\d+)_(\d+)\.lotheader", fn)
        if m:
            cells.append((int(m.group(1)), int(m.group(2)), os.path.join(folder, fn)))

    max_x = max(c[0] for c in cells) + 1
    max_y = max(c[1] for c in cells) + 1
    w, h = max_x * CELL // SCALE, max_y * CELL // SCALE
    print(f"world: {max_x}x{max_y} cells -> image {w}x{h}")

    img = Image.new("RGB", (w, h), (24, 26, 30))
    draw = ImageDraw.Draw(img)

    nrooms = 0
    for cx, cy, path in cells:
        for name, level, rects in parse_cell(path):
            if level != 0:
                continue
            nrooms += 1
            outside = name in ("empty", "emptyoutside", "derelict")
            color = (90, 90, 100) if outside else (235, 170, 60)
            for x, y, rw, rh in rects:
                px = (cx * CELL + x) // SCALE
                py = (cy * CELL + y) // SCALE
                draw.rectangle(
                    [px, py, px + max(rw // SCALE, 1), py + max(rh // SCALE, 1)],
                    fill=color,
                )

    out = os.path.join(REPO_ROOT, "data", "overview.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out)
    print(f"rooms drawn: {nrooms}, saved: {os.path.abspath(out)}")


if __name__ == "__main__":
    main()
