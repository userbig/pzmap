"""
parse_streets.py — mini-extract of street names for Muldraugh, KY.

Source: media/maps/Muldraugh, KY/streets.xml (world tile coordinates, float).
XML format:
  <streets><street name="Oak St" width="8"><points><point x="..." y="..."/>...</points></street>...</streets>

Output: data/streets.json
  {"streets": [{"n": "Oak St", "w": 8, "pts": [[x, y], ...]}, ...]}
Coordinates are rounded to 0.5. Compact JSON, UTF-8 without BOM.

Not part of build_all.py — run separately, once (street data is static for
the map). Does not touch the rest of the /extract pipeline.
"""
import argparse
import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GAME_DIR = os.environ.get(
    "PZMAP_GAME_DIR", r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid"
)
OUT_PATH = os.path.join(REPO_ROOT, "data", "streets.json")


def parse_args():
    p = argparse.ArgumentParser(
        description="Extract street names/geometry for Muldraugh, KY into data/streets.json."
    )
    p.add_argument(
        "--game-dir",
        default=DEFAULT_GAME_DIR,
        help="Path to the ProjectZomboid installation "
             "(default: $PZMAP_GAME_DIR env var, or %(default)r)",
    )
    return p.parse_args()


def round_half(v):
    return round(float(v) * 2) / 2


def main():
    args = parse_args()
    streets_xml = os.path.join(args.game_dir, "media", "maps", "Muldraugh, KY", "streets.xml")
    tree = ET.parse(streets_xml)
    root = tree.getroot()

    streets = []
    for street_el in root.findall("street"):
        name = street_el.get("name", "")
        width_raw = street_el.get("width", "0")
        try:
            width = int(round(float(width_raw)))
        except ValueError:
            width = 0

        pts = []
        points_el = street_el.find("points")
        if points_el is not None:
            for point_el in points_el.findall("point"):
                x = point_el.get("x")
                y = point_el.get("y")
                if x is None or y is None:
                    continue
                pts.append([round_half(x), round_half(y)])

        if not pts:
            continue

        streets.append({"n": name, "w": width, "pts": pts})

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"streets": streets}, f, ensure_ascii=False, separators=(",", ":"))

    print(f"streets: {len(streets)} -> {OUT_PATH}")


if __name__ == "__main__":
    main()
