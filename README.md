# PZ Map

![image](/web/og.png)

Unofficial interactive map for **Project Zomboid Build 42** — isometric world
view with real floors, points of interest, street names, a spoiler-free mode
and shareable markers.

> Unofficial fan project. Not affiliated with or endorsed by The Indie Stone.
> Game data © The Indie Stone. From Ukraine with Love 🇺🇦

## Features

- Isometric map rendered from the actual game files (floor-by-floor, including basements)
- Top-down vector "scheme" mode: buildings, streets, water
- 19 point-of-interest categories with search (towns & categories)
- Spoiler mode: locations stay hidden until you mark them visited
- Custom markers with instant share links (markers are encoded in the URL — nothing to download)
- English / Ukrainian interface, light / dark theme
- Fully static: no backend, no accounts, no tracking

## Run locally

```
python tools/serve.py 8000
# open http://localhost:8000/web/
```

Map tiles are not stored in this repository (18+ GB). The production site
loads them from object storage (see `web/config.js`). To browse with full
tiles locally, download the render pack from the GitHub Releases page and
unpack it into `render/`, or regenerate it yourself (below).

## Regenerating data from game files

Requires a local Project Zomboid B42 installation and Python 3.10+.

1. `python extract/build_all.py` — parses the game map files into `data/`
   (buildings, categories, towns) plus `extract/parse_streets.py` and
   `extract/parse_worldmap.py` for streets and water.
2. Isometric tiles are rendered with [pzmap2dzi](https://github.com/cff29546/pzmap2dzi)
   (see its docs; expect several hours and ~20 GB).

## Hosting

The site is fully static. `web/` + `data/` fit GitHub Pages; tiles live in
any object storage with public reads (Cloudflare R2 is what production uses).
Point `web/config.js` at your tile base URL.

## Credits

- Map viewer built on [Leaflet](https://leafletjs.com)
- Isometric render pipeline: [pzmap2dzi](https://github.com/cff29546/pzmap2dzi)
- Game data © [The Indie Stone](https://projectzomboid.com)

## License

Code: [MIT](LICENSE). Game-derived data and rendered tiles remain © The Indie Stone.
