"""build_all.py — full extraction of building/room geometry for Muldraugh, KY (B42).

The .lotheader format and coordinate system are confirmed in extract/explore_lotheader.py,
extract/scan_cells.py, extract/render_overview.py — the parser here reuses the same
read logic (see CONTRACT.md, section "Binary .lotheader format").

Output (see CONTRACT.md, section "Output data"):
    data/meta.json
    data/cells/{cx}_{cy}.json   (only cells with rooms)
    data/buildings_index.json
    data/room_names.txt
"""
import argparse
import json
import os
import re
import struct
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GAME_DIR = os.environ.get(
    "PZMAP_GAME_DIR", r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid"
)
TOWN_DIR = "Muldraugh, KY"
CELL_SIZE = 256
CELLS_X = 78
CELLS_Y = 63

DATA_DIR = os.path.join(REPO_ROOT, "data")
CELLS_DIR = os.path.join(DATA_DIR, "cells")


def parse_args():
    p = argparse.ArgumentParser(
        description="Extract building/room geometry for Muldraugh, KY (B42) into data/*.json."
    )
    p.add_argument(
        "--game-dir",
        default=DEFAULT_GAME_DIR,
        help="Path to the ProjectZomboid installation "
             "(default: $PZMAP_GAME_DIR env var, or %(default)r)",
    )
    return p.parse_args()

CELL_RE = re.compile(r"(\d+)_(\d+)\.lotheader")


# ---------------------------------------------------------------------------
# Building classification by room names (CONTRACT.md, "Building classification").
# Lists are built from the actual name histogram (data/room_names.txt) —
# exact room name match, no substrings. Priority is the order below.
# ---------------------------------------------------------------------------
CATEGORIES = [
    ("police", "Police", "\U0001F693", {
        "policeoffice", "armory", "policestorage", "policelocker",
        "policegunstorage", "policehall", "policelibrary", "policearchive",
        "policegarage", "policeswat", "policeoutfitstorage",
        "detectiveoffice", "interrogationroom", "evidenceroom",
    }),
    ("prison", "Prison", "\U0001F512", {
        "prisoncells", "prisonoffice", "prisonlaundry", "prisonlocker",
        "prisonstorage", "prisonerbelongings", "prisonarmory", "prisonlibrary",
    }),
    ("fire", "Fire Station", "\U0001F692", {
        "firestorage", "firegarage", "firedisplay", "fireoffice",
    }),
    ("medical", "Hospital", "\U0001F3E5", {
        "medical", "doctoroffice", "medicaloffice", "hospitalroom",
        "dentaloffice", "medicalstorage", "oldmedical", "hospitalstorage",
        "hospitalhallway", "medclinic", "clinic", "morgue", "dentist",
        "dentiststorage", "optometrist", "optometriststorage",
    }),
    ("pharmacy", "Pharmacy", "\U0001F48A", {
        "pharmacy", "pharmacystorage",
    }),
    ("gun", "Gun Store", "\U0001F52B", {
        "gunstore", "gunstorestorage", "huntingstore", "gunstorage",
        "hunting", "armysurplus", "armysurplusguns",
    }),
    ("grocery", "Grocery Store", "\U0001F6D2", {
        "grocery", "grocerystorage", "gigamart", "supermarket", "minimart",
        "fruitmarket", "generalstore", "groceryfreezer", "gigamartkitchen",
        "generalstorestorage", "ww_generalstore", "cornerstore",
        "cornerstorestorage", "cornerstorecounter", "conveniencestore",
        "zippeestore", "zippeestorage", "producestorage",
    }),
    ("hardware", "Hardware Store", "\U0001F6E0", {
        "toolstore", "hardwarestore", "toolstorestorage", "toolstorage",
        "ww_toolstore",
    }),
    ("gas", "Gas Station", "\u26FD", {
        "gasstation", "gasstore", "gasstorage", "gas2go",
    }),
    ("library", "Library", "\U0001F4DA", {
        "library", "bookstore", "bookstorestorage", "universitylibrary",
        "bookstorage",
    }),
    ("school", "School", "\U0001F393", {
        "classroom", "school", "elementaryclassroom", "secondaryclassroom",
        "universityclassroom", "schoolstorage", "schoolgymstorage",
        "schoollab", "classroom_physics", "classroom_maths",
        "classroom_anthro", "classroom_medieval", "classroom_pioneer",
        "classroom_pottery", "metalclassroom", "musicschool",
        "elementaryhall", "secondaryhall",
    }),
    ("church", "Church", "\u26EA", {
        "church", "officechurch", "lobbychurch", "storagechurch",
    }),
    ("bank", "Bank", "\U0001F4B0", {
        "bank", "bankvault", "bankstorage", "depositboxes", "vault",
    }),
    ("restaurant", "Restaurant", "\U0001F354", {
        "restaurant", "diner", "cafe", "cafeteria", "pizzakitchen",
        "burgerkitchen", "bakery", "icecreamparlor", "restaurantkitchen",
        "restaurantdining", "restaurantdining_fancy", "restaurantkitchen_fancy",
        "chineserestaurant", "italianrestaurant", "restaurantstorage",
        "dinerkitchen", "dinerbackroom", "dinercounter", "cafeteriakitchen",
        "cafekitchen", "cybercafe", "pizzawhirled", "pizzawhirledcounter",
        "burgerdining", "burgerstorage", "bakerykitchen",
        "bakeryfactorykitchen", "bakeryfactorystorage", "bakeryfactoryshipping",
        "icecreamkitchen", "icecream", "icecreamstand", "spiffoskitchen",
        "spiffo_dining", "spiffosstorage", "jayschicken_dining",
        "jayschicken_kitchen", "chinesekitchen", "seafoodkitchen",
        "seafooddining", "mexicandining", "mexicankitchen", "westerndining",
        "westernkitchen", "italiankitchen", "sushikitchen", "sushidining",
        "donut_dining", "donut_kitchen", "donut_kitchenstorage",
        "hotdogstand", "foodcourt", "deepfry_kitchen", "deepfry_dining",
        "chilikitchen", "chili_dining", "catfish_dining", "catfish_kitchen",
        "arenakitchen", "arenakitchenstorage", "tacokitchen", "kitchen_crepe",
        "dining_crepe", "fishchipskitchen",
    }),
    ("bar", "Bar", "\U0001F37A", {
        "bar", "barkitchen", "nightclub", "ww_bar", "barstorage",
        "stripclub", "stripclubvip", "stripcluboffice",
    }),
    ("clothing", "Clothing Store", "\U0001F455", {
        "clothingstore", "shoestore", "departmentstore", "clothesstore",
        "clothesstorage", "clothesstorestorage", "clothingstorage",
        "leatherclothesstore", "clothesestorage", "shoestorage",
        "departmentstorage", "weddingstoresuit", "weddingstoredress",
        "weddingstorestorage",
    }),
    ("motel", "Motel", "\U0001F6CF", {
        "motelroom", "hotelroom", "moteloffice", "motelroomoccupied",
        "motelreception", "motelstorage",
    }),
    ("selfstorage", "Self Storage", "\U0001F4E6", {
        "storageunit",
    }),
    ("warehouse", "Warehouse", "\U0001F3ED", {
        "warehouse", "factory", "loggingwarehouse", "loggingfactory",
        "factorystorage", "derelict_steelfactorystorage",
        "derelict_steelfactory", "dogfoodfactory", "guitarfactory",
        "wirefactory", "mannequinfactory", "jerkyfactory", "batteryfactory",
        "knifefactory", "mapfactory", "radiofactory", "cabinetfactory",
        "golffactory", "batfactory", "cardfactory", "handlefactory",
        "tablefactory", "tofufactory", "tofustorage", "tofushipping",
        "hingefactory", "hingestorage", "hingeshipping",
    }),
]

# fast lookup: room name -> catid (highest priority one, if the name is in several)
NAME_TO_CAT = {}
for catid, _label, _emoji, names in CATEGORIES:
    for n in names:
        NAME_TO_CAT.setdefault(n, catid)
CAT_PRIORITY = [c[0] for c in CATEGORIES]
CAT_LABEL_EMOJI = {c[0]: (c[1], c[2]) for c in CATEGORIES}


def classify_building(room_names):
    """First category in priority order that has an exact name match."""
    present_cats = {NAME_TO_CAT[n] for n in room_names if n in NAME_TO_CAT}
    for catid in CAT_PRIORITY:
        if catid in present_cats:
            return catid
    return None


# ---------------------------------------------------------------------------
# .lotheader parser (see explore_lotheader.py / scan_cells.py / render_overview.py)
# ---------------------------------------------------------------------------
def parse_lotheader(path):
    data = open(path, "rb").read()
    if data[:4] != b"LOTH":
        raise ValueError(f"not LOTH magic: {path}")
    (version,) = struct.unpack_from("<i", data, 4)
    pos = 8
    (ntiles,) = struct.unpack_from("<i", data, pos)
    pos += 4
    for _ in range(ntiles):
        pos = data.index(b"\n", pos) + 1

    chunk_w, chunk_h, min_level, max_level = struct.unpack_from("<iiii", data, pos)
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
        pos += 4
        pos += nobjs * 12
        rooms.append({"name": name, "level": level, "rects": rects})

    (nbld,) = struct.unpack_from("<i", data, pos)
    pos += 4
    buildings = []
    for _ in range(nbld):
        (nr,) = struct.unpack_from("<i", data, pos)
        pos += 4
        if nr:
            idx = list(struct.unpack_from(f"<{nr}i", data, pos))
        else:
            idx = []
        pos += nr * 4
        buildings.append(idx)

    pos += 1024  # zombieDensity
    if pos != len(data):
        raise ValueError(f"{path}: parsed to {pos}, file size {len(data)} (mismatch)")

    return rooms, buildings


# ---------------------------------------------------------------------------
# towns from worldmap-annotations.lua
# ---------------------------------------------------------------------------
def camel_to_spaced(s):
    return re.sub(r"(?<!^)(?=[A-Z])", " ", s)


def extract_towns_lupa(lua_path):
    import lupa
    lua = lupa.LuaRuntime(unpack_returned_tuples=True)
    src = open(lua_path, encoding="utf-8").read()
    calls = []

    def add_text(id_, cls_, x, y):
        calls.append((str(id_), str(cls_), x, y))

    setup = lua.execute(
        """
        local addTextFn = ...
        local dummy = {}
        local dummymt = {}
        dummymt.__index = function(t,k) return function(...) return dummy end end
        setmetatable(dummy, dummymt)

        local sapi = {}
        function sapi:addUntranslatedText(id, cls, x, y)
            addTextFn(id, cls, x, y)
            return dummy
        end
        function sapi:addTranslatedText(...)
            return dummy
        end
        local sapimt = {}
        sapimt.__index = function(t,k) return function(...) return dummy end end
        setmetatable(sapi, sapimt)

        local api = {}
        function api:getSymbolsAPIv2() return sapi end
        local apimt = {}
        apimt.__index = function(t,k) return function(...) return dummy end end
        setmetatable(api, apimt)

        local mapUI = {}
        mapUI.javaObject = {}
        function mapUI.javaObject:getAPIv3() return api end

        return mapUI
        """,
        add_text,
    )
    fn = lua.execute(src)
    fn(setup)

    towns = []
    for id_, cls_, x, y in calls:
        if cls_ != "text-town":
            continue
        m = re.match(r"MapLabel_(\w+)", id_)
        raw = m.group(1) if m else id_
        towns.append({"name": camel_to_spaced(raw), "x": int(x), "y": int(y)})
    return towns


def extract_towns_regex(lua_path):
    src = open(lua_path, encoding="utf-8").read()
    towns = []
    for m in re.finditer(
        r'addUntranslatedText\("MapLabel_(\w+)",\s*"text-town",\s*(-?\d+),\s*(-?\d+)\)',
        src,
    ):
        towns.append({
            "name": camel_to_spaced(m.group(1)),
            "x": int(m.group(2)),
            "y": int(m.group(3)),
        })
    return towns


TOWNS_FALLBACK = [
    {"name": "Muldraugh", "x": 10754, "y": 9926},
    {"name": "West Point", "x": 11654, "y": 6864},
    {"name": "Riverside", "x": 6450, "y": 5430},
    {"name": "Rosewood", "x": 8159, "y": 11661},
    {"name": "March Ridge", "x": 10130, "y": 12801},
    {"name": "Valley Station", "x": 13447, "y": 5278},
    {"name": "Louisville", "x": 13077, "y": 2238},
    {"name": "Brandenburg", "x": 2056, "y": 6070},
    {"name": "Ekron", "x": 634, "y": 9746},
    {"name": "Echo Creek", "x": 3589, "y": 10952},
    {"name": "Fallas Lake", "x": 7253, "y": 8279},
    {"name": "Irvington", "x": 2427, "y": 14185},
]


def get_towns(game_maps):
    lua_path = os.path.join(game_maps, TOWN_DIR, "worldmap-annotations.lua")
    if os.path.isfile(lua_path):
        try:
            towns = extract_towns_lupa(lua_path)
            if towns:
                return towns, "lupa"
        except Exception as e:
            print(f"  [towns] lupa failed ({e}), falling back to regex", file=sys.stderr)
        try:
            towns = extract_towns_regex(lua_path)
            if towns:
                return towns, "regex"
        except Exception as e:
            print(f"  [towns] regex failed ({e}), using hardcoded list", file=sys.stderr)
    return TOWNS_FALLBACK, "hardcoded"


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def build_cell_json(cx, cy, rooms, buildings):
    """Returns (cell_dict, n_rooms_total, room_name_counter)."""
    def to_world_rects(rects):
        return [[cx * CELL_SIZE + x, cy * CELL_SIZE + y, w, h] for (x, y, w, h) in rects]

    room_world = []  # per room index: dict with world rects
    for r in rooms:
        room_world.append({
            "name": r["name"],
            "level": r["level"],
            "rects": to_world_rects(r["rects"]),
        })

    used_idx = set()
    out_buildings = []
    for bi, room_idx in enumerate(buildings):
        room_idx = [i for i in room_idx if 0 <= i < len(room_world)]
        used_idx.update(room_idx)
        if not room_idx:
            continue
        b_rooms = [room_world[i] for i in room_idx]
        names = {rw["name"] for rw in b_rooms}
        cat = classify_building(names)

        minx = miny = None
        maxx = maxy = None
        minl = maxl = None
        rooms_out = []
        for rw in b_rooms:
            rooms_out.append({"n": rw["name"], "l": rw["level"], "r": rw["rects"]})
            lvl = rw["level"]
            minl = lvl if minl is None else min(minl, lvl)
            maxl = lvl if maxl is None else max(maxl, lvl)
            for (wx, wy, w, h) in rw["rects"]:
                x2, y2 = wx + w, wy + h
                minx = wx if minx is None else min(minx, wx)
                miny = wy if miny is None else min(miny, wy)
                maxx = x2 if maxx is None else max(maxx, x2)
                maxy = y2 if maxy is None else max(maxy, y2)

        if minx is None:
            continue  # building with no rectangles at all — skip

        out_buildings.append({
            "id": f"{cx}_{cy}_{bi}",
            "cat": cat,
            "bbox": [minx, miny, maxx - minx, maxy - miny],
            "levels": [minl, maxl],
            "rooms": rooms_out,
        })

    # rooms not belonging to any building -> one pseudo-building with cat=null
    orphan_idx = [i for i in range(len(room_world)) if i not in used_idx]
    if orphan_idx:
        b_rooms = [room_world[i] for i in orphan_idx]
        minx = miny = None
        maxx = maxy = None
        minl = maxl = None
        rooms_out = []
        for rw in b_rooms:
            rooms_out.append({"n": rw["name"], "l": rw["level"], "r": rw["rects"]})
            lvl = rw["level"]
            minl = lvl if minl is None else min(minl, lvl)
            maxl = lvl if maxl is None else max(maxl, lvl)
            for (wx, wy, w, h) in rw["rects"]:
                x2, y2 = wx + w, wy + h
                minx = wx if minx is None else min(minx, wx)
                miny = wy if miny is None else min(miny, wy)
                maxx = x2 if maxx is None else max(maxx, x2)
                maxy = y2 if maxy is None else max(maxy, y2)
        if minx is not None:
            out_buildings.append({
                "id": f"{cx}_{cy}_{len(buildings)}",
                "cat": None,
                "bbox": [minx, miny, maxx - minx, maxy - miny],
                "levels": [minl, maxl],
                "rooms": rooms_out,
            })

    total_rooms_written = sum(len(b["rooms"]) for b in out_buildings)
    name_counter = Counter(r["name"] for r in rooms)
    return {"cx": cx, "cy": cy, "buildings": out_buildings}, total_rooms_written, name_counter


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = parse_args()
    game_maps = os.path.join(args.game_dir, "media", "maps")
    town_path = os.path.join(game_maps, TOWN_DIR)
    if not os.path.isdir(town_path):
        print(f"ERROR: town dir not found: {town_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(CELLS_DIR, exist_ok=True)
    # clear old cell files (idempotency: don't leave leftovers from previous runs)
    for fn in os.listdir(CELLS_DIR):
        if fn.endswith(".json"):
            os.remove(os.path.join(CELLS_DIR, fn))

    cell_files = []
    for fn in os.listdir(town_path):
        m = CELL_RE.fullmatch(fn)
        if m:
            cell_files.append((int(m.group(1)), int(m.group(2)), os.path.join(town_path, fn)))
    cell_files.sort()

    hist = Counter()
    total_rooms = 0
    total_buildings = 0
    total_categorized = 0
    cells_with_rooms = 0
    cat_counts = Counter()
    all_buildings_index = []

    for cx, cy, path in cell_files:
        rooms, buildings = parse_lotheader(path)
        if not rooms:
            continue
        cells_with_rooms += 1
        cell_json, n_rooms_written, name_counter = build_cell_json(cx, cy, rooms, buildings)
        hist.update(name_counter)
        total_rooms += n_rooms_written

        out_path = os.path.join(CELLS_DIR, f"{cx}_{cy}.json")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cell_json, f, ensure_ascii=False, separators=(",", ":"))

        for b in cell_json["buildings"]:
            total_buildings += 1
            if b["cat"] is not None:
                total_categorized += 1
                cat_counts[b["cat"]] += 1
                bx, by, bw, bh = b["bbox"]
                all_buildings_index.append({
                    "id": b["id"],
                    "cat": b["cat"],
                    "x": bx + bw / 2,
                    "y": by + bh / 2,
                    "cell": [cx, cy],
                })

    # room_names.txt
    room_names_path = os.path.join(DATA_DIR, "room_names.txt")
    with open(room_names_path, "w", encoding="utf-8", newline="\n") as f:
        for name, count in hist.most_common():
            f.write(f"{name}\t{count}\n")

    # buildings_index.json
    with open(os.path.join(DATA_DIR, "buildings_index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"buildings": all_buildings_index}, f, ensure_ascii=False, separators=(",", ":"))

    # towns
    towns, towns_source = get_towns(game_maps)

    # meta.json — categories only include ones actually present (cat_counts)
    categories_meta = {}
    for catid in CAT_PRIORITY:
        if cat_counts.get(catid):
            label, emoji = CAT_LABEL_EMOJI[catid]
            categories_meta[catid] = {"label": label, "emoji": emoji}

    meta = {
        "cellSize": CELL_SIZE,
        "cellsX": CELLS_X,
        "cellsY": CELLS_Y,
        "worldW": CELLS_X * CELL_SIZE,
        "worldH": CELLS_Y * CELL_SIZE,
        "categories": categories_meta,
        "towns": towns,
        "stats": {
            "cellsWithRooms": cells_with_rooms,
            "rooms": total_rooms,
            "buildings": total_buildings,
            "categorized": total_categorized,
        },
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    # ------------------------------------------------------------------
    # Report to stdout
    # ------------------------------------------------------------------
    print(f"cells with rooms: {cells_with_rooms}")
    print(f"rooms total: {total_rooms}")
    print(f"buildings total: {total_buildings}, categorized: {total_categorized}")
    print(f"towns: {len(towns)} (source: {towns_source})")
    print("categories:")
    for catid, n in cat_counts.most_common():
        label, emoji = CAT_LABEL_EMOJI[catid]
        print(f"  {catid:12s} {emoji} {label:20s} {n}")

    unclassified = Counter()
    for name, count in hist.items():
        if name not in NAME_TO_CAT:
            unclassified[name] = count
    print(f"distinct room names: {len(hist)}, unclassified distinct: {len(unclassified)}")
    print("top-50 unclassified room names:")
    for name, count in unclassified.most_common(50):
        print(f"  {name:30s} {count}")


if __name__ == "__main__":
    main()
