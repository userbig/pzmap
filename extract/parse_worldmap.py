"""
Extracts vector features (water, forest, roads) from worldmap.xml (B42, Muldraugh, KY).

worldmap.xml format:
  <world><cell x="cx" y="cy"><feature><geometry type="Polygon"|"LineString"|"Point">
    <coordinates><point x=".." y=".."/>...</coordinates>
  </geometry><properties><property name="water" value="river"/>...</properties></feature>...
  </cell>...</world>

IMPORTANT: point coordinates are LOCAL to the cell, and this file's cell size is 300
(different from cellSize=256, used in lotheader/CONTRACT.md for buildings/rooms!).
World coordinates: world = cell*300 + local. World: 19968 x 16128 (same as in meta.json).

Output (format {"features":[{"t": <type>, "pts":[[x,y],...], "line": true?}, ...]}):
  data/worldmap_water.json   — property name="water"   (value = river etc.)
  data/worldmap_forest.json  — property name="natural"  (value = wood etc.)
  data/worldmap_roads.json   — property name="highway"  (value = secondary/tertiary/trail/primary/...)
                                geometry Polygon (road corridor) or LineString (rare, "line":true)

Polygons from neighboring cells are NOT merged — kept as-is (one per feature).
"""
import argparse
import xml.etree.ElementTree as ET
import json
import os
import sys
import io
from collections import Counter, defaultdict
from pathlib import Path

# Windows console may be in cp1252 — switch stdout to UTF-8 to avoid crashing on Cyrillic
if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GAME_DIR = os.environ.get(
    'PZMAP_GAME_DIR', r'C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid'
)
OUT_DIR = os.path.join(REPO_ROOT, 'data')


def parse_args():
    p = argparse.ArgumentParser(
        description='Extract vector features (water/forest/roads) from worldmap.xml into data/worldmap_*.json.'
    )
    p.add_argument(
        '--game-dir',
        default=DEFAULT_GAME_DIR,
        help="Path to the ProjectZomboid installation "
             "(default: $PZMAP_GAME_DIR env var, or %(default)r)",
    )
    return p.parse_args()

CELL_SIZE = 300
WORLD_W = 19968
WORLD_H = 16128
TOL = 300  # boundary validation tolerance, tiles

# property name -> (output filename, layer key for logging)
LAYERS = {
    'water': 'worldmap_water.json',
    'natural': 'worldmap_forest.json',
    'highway': 'worldmap_roads.json',
}

# forest simplification if the file would be > 8 MB: drop polygons with area < this threshold (tiles^2)
FOREST_MIN_AREA = 400
MAX_FOREST_BYTES = 8 * 1024 * 1024


def polygon_area(pts):
    # shoelace; pts may be unclosed — that's fine, the closing error is negligible
    n = len(pts)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def main():
    args = parse_args()
    src = os.path.join(args.game_dir, 'media', 'maps', 'Muldraugh, KY', 'worldmap.xml')

    # ElementTree iterparse doesn't give access to a feature's parent (cell)
    # without manual tracking, so we keep current cx/cy via start/end events on cell.
    layer_features = {name: [] for name in LAYERS}
    geom_type_count = Counter()
    prop_name_count = Counter()
    prop_pair_count = Counter()
    cells = 0
    cur_cx = cur_cy = None

    for event, elem in ET.iterparse(src, events=('start', 'end')):
        if elem.tag == 'cell':
            if event == 'start':
                cur_cx = int(elem.get('x'))
                cur_cy = int(elem.get('y'))
            else:
                cells += 1
                elem.clear()
        elif elem.tag == 'feature' and event == 'end':
            geom = elem.find('geometry')
            props = elem.find('properties')
            if geom is not None and props is not None:
                gtype = geom.get('type')
                geom_type_count[gtype] += 1

                prop_dict = {}
                for p in props.findall('property'):
                    name = p.get('name')
                    value = p.get('value')
                    prop_name_count[name] += 1
                    prop_pair_count[(name, value)] += 1
                    prop_dict[name] = value

                for prop_name, out_file in LAYERS.items():
                    if prop_name in prop_dict and gtype in ('Polygon', 'LineString'):
                        coords_elem = geom.find('coordinates')
                        pts = []
                        if coords_elem is not None:
                            for pt in coords_elem.findall('point'):
                                lx = float(pt.get('x'))
                                ly = float(pt.get('y'))
                                wx = int(round(cur_cx * CELL_SIZE + lx))
                                wy = int(round(cur_cy * CELL_SIZE + ly))
                                pts.append([wx, wy])
                        if len(pts) >= 2:
                            feat = {'t': prop_dict[prop_name], 'pts': pts}
                            if gtype == 'LineString':
                                feat['line'] = True
                            layer_features[prop_name].append(feat)
                        break  # a feature belongs to only one layer (by the first matching property)
            elem.clear()

    print(f'cells: {cells}')
    print('geometry types:', dict(geom_type_count))
    print('property names:', dict(prop_name_count))
    print()

    # ---- coordinate validation ----
    all_min_x = all_min_y = float('inf')
    all_max_x = all_max_y = float('-inf')
    out_of_range = 0
    total_pts = 0
    for name, feats in layer_features.items():
        for f in feats:
            for x, y in f['pts']:
                total_pts += 1
                if x < all_min_x: all_min_x = x
                if y < all_min_y: all_min_y = y
                if x > all_max_x: all_max_x = x
                if y > all_max_y: all_max_y = y
                if not (-TOL <= x <= WORLD_W + TOL and -TOL <= y <= WORLD_H + TOL):
                    out_of_range += 1

    print(f'total points: {total_pts}')
    print(f'bbox all layers: x[{all_min_x}, {all_max_x}]  y[{all_min_y}, {all_max_y}]')
    print(f'points out of [0..{WORLD_W}]x[0..{WORLD_H}] (tol {TOL}): {out_of_range}')
    if out_of_range > 0:
        print('!! WARNING: points out of the allowed range — check the world=cell*300+local formula')

    # check: water should reach the northern edge (Ohio River), y < 1000 in the northeast (high x)
    water_feats = layer_features.get('water', [])
    north_river_ok = any(
        y < 1000 and x > WORLD_W * 0.5
        for f in water_feats for x, y in f['pts']
    )
    if water_feats:
        if north_river_ok:
            print('OK: water found in the north (y<1000) in the eastern half of the map (Ohio River)')
        else:
            print('!! WARNING: no water found in the north of the map (y<1000, x>50% of width) — check coordinate formula')
    else:
        print('(no water found at all — is the "water" property missing?)')
    print()

    # ---- forest simplification if needed ----
    forest_feats = layer_features.get('natural', [])
    if forest_feats:
        raw_json = json.dumps({'features': forest_feats}, separators=(',', ':'))
        if len(raw_json.encode('utf-8')) > MAX_FOREST_BYTES:
            before = len(forest_feats)
            forest_feats = [f for f in forest_feats if polygon_area(f['pts']) >= FOREST_MIN_AREA]
            print(f'forest: simplifying by area < {FOREST_MIN_AREA} tiles^2: {before} -> {len(forest_feats)} polygons')
            layer_features['natural'] = forest_feats

    # ---- write files (only if features exist) ----
    os.makedirs(OUT_DIR, exist_ok=True)
    summary = {}
    for prop_name, out_file in LAYERS.items():
        feats = layer_features[prop_name]
        out_path = os.path.join(OUT_DIR, out_file)
        if not feats:
            print(f'{out_file}: no features, file not created')
            continue
        with open(out_path, 'w', encoding='utf-8') as fh:
            json.dump({'features': feats}, fh, separators=(',', ':'))
        size = os.path.getsize(out_path)
        type_counts = Counter(f['t'] for f in feats)
        summary[out_file] = (len(feats), size, dict(type_counts))
        print(f'{out_file}: {len(feats)} features, {size/1024:.1f} KB, types: {dict(type_counts)}')

    print()
    print('=== SUMMARY ===')
    for out_file, (n, size, types) in summary.items():
        print(f'{out_file}: {n} polygons/lines, {size} bytes ({size/1024/1024:.2f} MB)')
        for t, c in sorted(types.items(), key=lambda kv: -kv[1]):
            print(f'    {t}: {c}')
    print(f'bbox: x[{all_min_x}, {all_max_x}]  y[{all_min_y}, {all_max_y}]')


if __name__ == '__main__':
    main()
