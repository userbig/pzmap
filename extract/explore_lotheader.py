"""Exploration of the binary .lotheader format (B42, magic LOTH v1).

Prints the file structure step by step to nail down the format
before writing the production parser.
"""
import os
import struct
import sys

DEFAULT_GAME_DIR = os.environ.get(
    "PZMAP_GAME_DIR", r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid"
)
DEFAULT_PATH = os.path.join(
    DEFAULT_GAME_DIR, "media", "maps", "Muldraugh, KY", "30_30.lotheader"
)


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def u8(self) -> int:
        v = self.data[self.pos]
        self.pos += 1
        return v

    def raw(self, n: int) -> bytes:
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v

    def line(self) -> str:
        """String up to \n (this is how strings were stored in B41)."""
        end = self.data.index(b"\n", self.pos)
        v = self.data[self.pos:end].decode("utf-8", errors="replace")
        self.pos = end + 1
        return v

    def peek_hex(self, n: int = 48) -> str:
        chunk = self.data[self.pos:self.pos + n]
        return " ".join(f"{b:02X}" for b in chunk)

    def peek_ascii(self, n: int = 48) -> str:
        chunk = self.data[self.pos:self.pos + n]
        return "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)


def main(path: str) -> None:
    data = open(path, "rb").read()
    r = Reader(data)
    print(f"file size: {len(data)}")

    magic = r.raw(4)
    version = r.i32()
    print(f"magic={magic!r} version={version}")

    ntiles = r.i32()
    print(f"tile name count: {ntiles}")

    # Check the terminator of the first line: look for both \n and \0
    nl = data.index(b"\n", r.pos) - r.pos
    z = data.index(b"\x00", r.pos) - r.pos
    print(f"dist to newline={nl}, dist to nul={z}")

    names = [r.line() for _ in range(ntiles)]
    print(f"first: {names[0]!r}  last: {names[-1]!r}")

    w, h = r.i32(), r.i32()
    lvl_a, lvl_b = r.i32(), r.i32()
    print(f"w={w} h={h} levels: {lvl_a}..{lvl_b}")

    nrooms = r.i32()
    print(f"rooms: {nrooms}")
    for i in range(nrooms):
        name = r.line()
        level = r.i32()
        nrects = r.i32()
        rects = [(r.i32(), r.i32(), r.i32(), r.i32()) for _ in range(nrects)]
        nobjs = r.i32()
        objs = [(r.i32(), r.i32(), r.i32()) for _ in range(nobjs)]
        print(f"  room[{i}] {name!r} level={level} rects={rects} objs={objs}")

    nbld = r.i32()
    print(f"buildings: {nbld}")
    for i in range(nbld):
        n = r.i32()
        idx = [r.i32() for _ in range(n)]
        print(f"  building[{i}] rooms={idx}")

    rest = len(data) - r.pos
    print(f"remaining bytes: {rest} (32x32 density = 1024)")
    if rest:
        tail = data[r.pos:r.pos + 64]
        print("tail hex:", " ".join(f"{b:02X}" for b in tail))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH)
