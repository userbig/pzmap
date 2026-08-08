"use strict";
/*
 * PZ Map — frontend (v3: two display modes + spoilers/sharing/floors/streets/markers/save).
 * No build step, no external dependencies other than Leaflet (CDN).
 * All fetch paths are absolute from the server root: /data/..., /render/...
 *
 * Modes:
 *   iso      — isometric basemap (tiles render/iso/{z}/{y}/{x}.jpg), default.
 *   topdown  — the old vector top-down mode ("Scheme").
 * Switching mode = full recreation of L.map (map.remove() + new L.map)
 * while preserving the world center position (world coordinates are shared between both modes).
 *
 * File structure (single file, logically split into modules):
 *   1. coords / coordsIso — world coordinate <-> latLng conversion
 *   2. state    — shared application state
 *   3. util     — small utilities (escapeHtml, throttle, store...)
 *   4. cells    — lazy loading/cache/render of cells (data/cells/*.json), floor-aware
 *   5. icons    — building icon layer (data/buildings_index.json), spoiler-mode-aware
 *   6. towns    — town labels (meta.towns)
 *   7. filters  — category filter panel + building outline toggle
 *   8. status   — status bar (cursor coordinates, cell)
 *   9. hash     — sync map position with #m,x,y,zoom[,px,py] in the URL
 *  10. mode     — "Isometric" / "Scheme" mode switcher
 *  11. spoilers — spoiler mode ("?" icons, visited-place marks)
 *  12. share    — click on empty map spot -> popup with coordinates/link/marker
 *  13. markers  — custom user markers
 *  14. streets  — street names (data/streets.json)
 *  15. floors   — floor selector
 *  16. save     — save export/import (markers, marks, spoilers, floor)
 *  17. init     — entry point, map creation/recreation
 */

// ---------------------------------------------------------------------------
// 0. base paths — see web/config.js (window.PZMAP_CONFIG), loaded before this
//    script. Every data/tile URL in this file goes through one of these
//    functions instead of a hardcoded absolute path, so the app keeps
//    working when served from a sub-path (e.g. a GitHub Pages project site)
//    or with tiles hosted on external storage.
// ---------------------------------------------------------------------------

/** Site root: the directory containing web/ (data/ and render/ live there
 *  too), as an absolute path ending in "/". "auto" (default) derives it from
 *  location.pathname up to the "/web/" segment; PZMAP_CONFIG.base can
 *  override it with an explicit prefix. */
function appBase() {
  const cfg = window.PZMAP_CONFIG || {};
  if (cfg.base && cfg.base !== "auto") return cfg.base;
  const i = location.pathname.indexOf("/web/");
  return i >= 0 ? location.pathname.slice(0, i + 1) : "/";
}

/** Prefix for the "own" render's DZI tiles (render/gen/html/map_data/base/).
 *  PZMAP_CONFIG.tileBase overrides it with an external tile host (e.g. a CDN
 *  bucket URL); otherwise it resolves locally under appBase(). */
function tileBase() {
  const cfg = window.PZMAP_CONFIG || {};
  return cfg.tileBase || (appBase() + "render/gen/html/map_data/base/");
}

/** Resolve a root-absolute path baked into a data file (e.g. iso_meta.json's
 *  "tileUrl": "/render/iso/...") against appBase(). Used for assets that,
 *  unlike the DZI tiles above, are always served locally — the legacy
 *  collage basemap isn't distributed externally (PZMAP_CONFIG.collageAvailable). */
function resolveSiteUrl(u) {
  return u && u.startsWith("/") ? appBase() + u.slice(1) : u;
}

// ---------------------------------------------------------------------------
// 1a. coords — top-down mode. The single place where world coordinates
//     are turned into latLng for the "Scheme".
//     World: x grows to the right, y grows DOWN (as in the game/raster coordinates).
//     L.CRS.Simple treats lat as "up", so lat = -y (inverted).
// ---------------------------------------------------------------------------
const coords = {
  /** World (wx, wy) -> L.LatLng */
  toLatLng(wx, wy) {
    return L.latLng(-wy, wx);
  },
  /** L.LatLng -> world {x, y} */
  toWorld(latlng) {
    return { x: latlng.lng, y: -latlng.lat };
  },
  /** World rectangle [x, y, w, h] -> L.LatLngBounds */
  bboxToBounds(x, y, w, h) {
    return L.latLngBounds(
      coords.toLatLng(x, y + h), // south-west (larger y -> smaller lat)
      coords.toLatLng(x + w, y)  // north-east
    );
  },
  /** Visible map L.LatLngBounds -> world rectangle {minX, minY, maxX, maxY} */
  viewToWorld(latLngBounds) {
    return {
      minX: latLngBounds.getWest(),
      maxX: latLngBounds.getEast(),
      minY: -latLngBounds.getNorth(),
      maxY: -latLngBounds.getSouth(),
    };
  },
};

// ---------------------------------------------------------------------------
// 1b. coordsIso — iso mode. All the "world -> basemap pixels" projection math
//     and its inverse are encapsulated here; the topdown code (coords) is untouched.
//     Two basemaps share this module (state.isoBasemap, localStorage 'pz.isoBasemap'):
//
//     - "own"     — our own pzmap2dzi Deep Zoom render (render/gen/html/map_data/base),
//                   state.renderMeta (see buildRenderMeta()). Exact projection, no
//                   correction, floor-aware (a `layer` argument shifts py — see below).
//     - "collage" — the legacy third-party collage (render/iso/{z}/{y}/{x}.jpg),
//                   state.isoMeta (data/iso_meta.json). Kept as a fallback / user
//                   choice; single-floor only (the `layer` argument is ignored).
//
//     "own" forward transform — from render/gen/html/pzmap/map.js Map.square2pixel()
//     (world x,y IS the "square" coordinate: cell2square() there is just cx*cell_size,
//     and meta.json's cellSize/x/y already match those raw tile units) combined with
//     the per-floor shift from render/gen/html/pzmap/coordinates.js fromIsoSquare()
//     (getViewportPointBySquare feeds it map.sqr as `step`, layer as-is):
//       rawPx = x0 + (x - y)*sqr/2
//       rawPy = y0 + (x + y)*sqr/4 - 1.5*layer*sqr
//       px = rawPx / scale,  py = rawPy / scale        (scale — see buildRenderMeta)
//     Inverse is the algebraic inverse of the same formula (cross-checked against
//     coordinates.js toIsoSquare(), which inverts the identical shape).
//     latLng: L.latLng(-py/2^refLevel, px/2^refLevel) — refLevel is picked so that at
//     leaflet zoom == refLevel, 1 screen point == 1 pixel of the declared DZI <Size>
//     (== leaflet zoom == DZI tile level directly, see DziTileLayer below).
//
//     "collage" forward transform (unchanged from the previous revision):
//       corr(x,y) = IDW correction of the anchor offsets, w_i = 1/(d_i^2 + 1000)
//       px = (x - y)*s + ox + corr.dx
//       py = (x + y)*s/2 + oy + corr.dy
//     Inverse (pixels -> world): no correction + 2 refinement iterations of corr.
//     Collage latLng: L.latLng(-py/256, px/256) (at zoom=8, 1px = 1 latLng*256).
// ---------------------------------------------------------------------------

/** Which DZI floor a ground-referenced inverse lookup (click/hover/viewport) should
 *  assume "under the cursor" — the currently selected floor when floors are actually
 *  stacked (own render), always 0 for the single-floor collage. Mirrors pzmap.html's
 *  getSquare(), which defaults to g.currentLayer. */
function currentIsoLayer() {
  return state.isoBasemap === "own" && state.renderMeta ? state.floor : 0;
}

const coordsIso = {
  /** IDW interpolation of anchor offsets at world point (x, y) -> {dx, dy}. Collage only. */
  _corr(x, y) {
    const anchors = (state.isoMeta && state.isoMeta.anchors) || [];
    if (!anchors.length) return { dx: 0, dy: 0 };
    let sw = 0, sdx = 0, sdy = 0;
    for (const a of anchors) {
      const ddx = x - a.x;
      const ddy = y - a.y;
      const d2 = ddx * ddx + ddy * ddy;
      const w = 1 / (d2 + 1000);
      sw += w;
      sdx += w * a.dx;
      sdy += w * a.dy;
    }
    return sw > 0 ? { dx: sdx / sw, dy: sdy / sw } : { dx: 0, dy: 0 };
  },
  /** World (x, y[, layer]) -> own-render pixels {px, py} (forward transform, exact). */
  _ownWorldToPixel(x, y, layer) {
    const m = state.renderMeta;
    const rawPx = m.x0 + (x - y) * m.sqr / 2;
    const rawPy = m.y0 + (x + y) * m.sqr / 4 - 1.5 * layer * m.sqr;
    return { px: rawPx / m.scale, py: rawPy / m.scale };
  },
  /** Own-render pixels {px, py}[, layer] -> world {x, y} (inverse, exact). */
  _ownPixelToWorld(px, py, layer) {
    const m = state.renderMeta;
    const dx = px * m.scale - m.x0;
    const dy = py * m.scale - m.y0 + 1.5 * layer * m.sqr;
    const fgx = dx / m.sqr;       // = (x - y) / 2
    const fgy = (2 * dy) / m.sqr; // = (x + y) / 2
    return { x: fgx + fgy, y: fgy - fgx };
  },
  /** World (x, y[, layer]) -> basemap pixels {px, py} (forward transform), dispatched
   *  by the active basemap. `layer` only matters for "own" (default: ground, 0). */
  worldToPixel(x, y, layer = 0) {
    if (state.isoBasemap === "own" && state.renderMeta) {
      return coordsIso._ownWorldToPixel(x, y, layer);
    }
    const m = state.isoMeta;
    const c = coordsIso._corr(x, y);
    return {
      px: (x - y) * m.s + m.ox + c.dx,
      py: ((x + y) * m.s) / 2 + m.oy + c.dy,
    };
  },
  /** Basemap pixels {px, py}[, layer] -> world {x, y} (inverse), dispatched by the
   *  active basemap. `layer` is ignored for "collage" (no floors there). */
  pixelToWorld(px, py, layer = 0) {
    if (state.isoBasemap === "own" && state.renderMeta) {
      return coordsIso._ownPixelToWorld(px, py, layer);
    }
    const m = state.isoMeta;
    // 1) without correction
    let u = (px - m.ox) / m.s;
    let v = (2 * (py - m.oy)) / m.s;
    let x = (u + v) / 2;
    let y = (v - u) / 2;
    // 2) two refinement iterations: recompute corr at the current point,
    //    subtract it from px,py and repeat the inverse transform
    for (let i = 0; i < 2; i++) {
      const c = coordsIso._corr(x, y);
      const u2 = (px - c.dx - m.ox) / m.s;
      const v2 = (2 * (py - c.dy - m.oy)) / m.s;
      x = (u2 + v2) / 2;
      y = (v2 - u2) / 2;
    }
    return { x, y };
  },
  /** World (wx, wy[, layer=ground]) -> L.LatLng on the basemap. Icons/markers/streets/
   *  town labels are all ground-referenced and rely on the layer=0 default; per-floor
   *  room outlines pass their own floor explicitly (see renderCellRooms). */
  toLatLng(wx, wy, layer = 0) {
    const { px, py } = coordsIso.worldToPixel(wx, wy, layer);
    if (state.isoBasemap === "own" && state.renderMeta) {
      const d = Math.pow(2, state.renderMeta.refLevel);
      return L.latLng(-py / d, px / d);
    }
    return L.latLng(-py / 256, px / 256);
  },
  /** Basemap L.LatLng -> world {x, y}. `layer` defaults to the floor currently on
   *  screen (see currentIsoLayer) — that's "what world point is under this pixel". */
  toWorld(latlng, layer = currentIsoLayer()) {
    if (state.isoBasemap === "own" && state.renderMeta) {
      const d = Math.pow(2, state.renderMeta.refLevel);
      return coordsIso._ownPixelToWorld(latlng.lng * d, -latlng.lat * d, layer);
    }
    const px = latlng.lng * 256;
    const py = -latlng.lat * 256;
    return coordsIso.pixelToWorld(px, py, layer);
  },
  /** World rectangle [x,y,w,h] (optionally on a given floor) -> 4 parallelogram
   *  corners (L.LatLng[]) */
  bboxCorners(x, y, w, h, layer = 0) {
    return [
      coordsIso.toLatLng(x, y, layer),
      coordsIso.toLatLng(x + w, y, layer),
      coordsIso.toLatLng(x + w, y + h, layer),
      coordsIso.toLatLng(x, y + h, layer),
    ];
  },
  /** Visible L.LatLngBounds -> the enclosing world rectangle (for lazy loading),
   *  on the floor currently on screen. */
  viewToWorld(latLngBounds) {
    const corners = [
      latLngBounds.getNorthWest(),
      latLngBounds.getNorthEast(),
      latLngBounds.getSouthWest(),
      latLngBounds.getSouthEast(),
    ];
    const layer = currentIsoLayer();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ll of corners) {
      const w = coordsIso.toWorld(ll, layer);
      if (w.x < minX) minX = w.x;
      if (w.x > maxX) maxX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.y > maxY) maxY = w.y;
    }
    return { minX, maxX, minY, maxY };
  },
  /** Bounds of the whole basemap in latLng (for L.tileLayer bounds / fit-view) */
  imageBounds() {
    if (state.isoBasemap === "own" && state.renderMeta) {
      const m = state.renderMeta;
      const d = Math.pow(2, m.refLevel);
      return L.latLngBounds(L.latLng(-m.imageH / d, 0), L.latLng(0, m.imageW / d));
    }
    const m = state.isoMeta;
    return L.latLngBounds(
      L.latLng(-m.image.h / 256, 0),
      L.latLng(0, m.image.w / 256)
    );
  },
};

// ---------------------------------------------------------------------------
// 1c. DziTileLayer — Leaflet adapter for our own pzmap2dzi Deep Zoom render
//     (render/gen/html/map_data/base/layer{N}_files/{level}/{col}_{row}.{ext}).
//     Tile addressing is the plain Deep Zoom Image scheme (TileSize 1024, Overlap 0);
//     coordsIso's latLng normalization (see buildRenderMeta().refLevel) is set up so
//     that Leaflet zoom `z` equals the DZI level `z` directly — no extra coordinate
//     remapping needed here, just the URL template.
//     layer 0 (ground) is baked opaque jpg; every other floor is alpha webp — see
//     the Format field of the corresponding layer{N}.dzi on disk. Areas with no
//     content on a given floor 404 — Leaflet just leaves that tile blank, which is
//     exactly the look we want for "nothing here on this floor".
// ---------------------------------------------------------------------------
const DziTileLayer = L.TileLayer.extend({
  options: { tileSize: 1024, noWrap: true },
  getTileUrl(coords) {
    const ext = this.options.pzLayer === 0 ? "jpg" : "webp";
    return `${this.options.pzBase}layer${this.options.pzLayer}_files/${coords.z}/${coords.x}_${coords.y}.${ext}`;
  },
  createTile(coords, done) {
    const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
    // Deep Zoom crops edge tiles (and the whole-image tiles of low levels) to
    // the actual content instead of padding them to TileSize. Leaflet inlines
    // width/height = tileSize on every tile img, stretching those cropped
    // tiles — at low zooms this smeared a 283x125 whole-map tile across the
    // screen. Render every tile at its natural pixel size instead (1 DZI px
    // == 1 css px at the matching zoom; the overzoom container transform
    // scales uniformly on top, so this stays correct at maxZoom+1).
    tile.addEventListener("load", () => {
      if (tile.naturalWidth && tile.naturalHeight) {
        tile.style.width = tile.naturalWidth + "px";
        tile.style.height = tile.naturalHeight + "px";
      }
    });
    return tile;
  },
});

/** Build state.renderMeta from render/gen/html/map_data/base/map_info.json (fetched
 *  directly in init() — no local copy is kept, so a re-render is always picked up).
 *
 *  `scale` — render/gen/html/pzmap/map.js Map.initMap()'s setinfo(): scale = 1 << skip.
 *  It's the factor between the raw x0/y0/sqr-based pixel position (see
 *  coordsIso._ownWorldToPixel) and the pixel space actually declared by each
 *  layer{N}.dzi's <Size> (== info.w x info.h here, confirmed: dividing the raw
 *  formula's output by `scale` reproduces exactly w=578592,h=255480 for this render).
 *
 *  `refLevel` — the Deep Zoom level whose own tile grid equals that declared <Size>
 *  1:1 (standard DZI level count = ceil(log2(max(w,h)))); confirmed against the
 *  actual tile folders on disk (level `refLevel` has ceil(w/1024) x ceil(h/1024)
 *  tile files — deeper "bonus" levels exist on disk from the render pipeline but
 *  aren't part of the declared pyramid, so — like the reference pzmap.html/
 *  OpenSeadragon viewer — we never request them). coordsIso normalizes latLng so
 *  that leaflet zoom `z` == DZI level `z` directly (see DziTileLayer above). */
function buildRenderMeta(info) {
  const scale = 1 << (info.skip || 0);
  const refLevel = Math.ceil(Math.log2(Math.max(info.w, info.h)));
  return {
    basePath: tileBase(),
    x0: info.x0,
    y0: info.y0,
    sqr: info.sqr,
    scale,
    minlayer: info.minlayer,
    maxlayer: info.maxlayer, // exclusive upper bound, like map.js (layer indices minlayer..maxlayer-1)
    imageW: info.w,
    imageH: info.h,
    refLevel,
    maxNativeZoom: refLevel,
    maxZoom: refLevel + 1, // one extra overzoom step; Leaflet upsamples from maxNativeZoom
  };
}

/** Active coordinate module for the current mode */
function getCoords() {
  return state.mode === "iso" ? coordsIso : coords;
}

// ---------------------------------------------------------------------------
// 2. state
// ---------------------------------------------------------------------------
const state = {
  mode: "iso",               // "iso" | "topdown"
  theme: "dark",              // "light" | "dark", localStorage 'pz.theme'; default — dark
  lang: "en",                  // "uk" | "en", localStorage 'pz.lang'; default — English
  map: null,
  renderer: null,
  meta: null,                // data/meta.json
  isoMeta: null,              // data/iso_meta.json (legacy collage basemap)
  renderMeta: null,           // built from render/gen/html/map_data/base/map_info.json (own render basemap), see buildRenderMeta()
  isoBasemap: "own",          // "own" | "collage", localStorage 'pz.isoBasemap'; default — own render
  isoLayers: null,            // Map<layerIndex, L.TileLayer> — currently mounted DZI floor layers (own basemap only)
  isoBackdropLayer: null,     // low-res layer0 DZI blur backdrop, mounted once per map (own basemap only), see updateIsoTileStack()
  worldZoom: 0,               // (topdown) zoom at which the whole world is visible
  cellsMinZoom: 0,             // (topdown) zoom threshold for loading cells
  iconsMinZoom: 0,             // zoom threshold for showing icons (both modes)
  townsMaxZoom: 0,             // zoom threshold above which town labels are hidden
  showBuildingOutlines: false, // (iso) "Building outlines" checkbox
  cellCache: new Map(),       // "cx_cy" -> { data, group, renderedFloor, lastUsed, empty, loading }
  cellsRoot: null,             // L.LayerGroup — container for all cell layers
  cellsVisible: false,
  iconsRoot: null,             // L.LayerGroup — container for all icon categories
  categoryLayers: {},          // catId -> L.LayerGroup
  categoryChecked: {},         // catId -> bool (preserved across mode switches)
  buildingsIndexRaw: null,     // raw data/buildings_index.json data (loaded once)
  townsLayer: null,
  townsVisible: false,
  hashSuspend: false,          // suppress hash writes while programmatically setting the view
  searchFilterActive: false,   // whether a single category is enabled via search (for reset on X/empty input)

  // --- spoiler mode ---
  spoilersOn: true,            // localStorage 'pz.spoilers'
  revealedSet: new Set(),      // localStorage 'pz.revealed' — ids of buildings "you've been here"

  // --- point sharing / pin ---
  pin: null,                   // {x, y} world coordinates, from the link hash, or null
  pinLayer: null,               // L.LayerGroup with the red "X"

  // --- custom markers ---
  markers: [],                 // localStorage 'pz.markers': [{id,x,y,name,icon}]
  markersLayer: null,
  markersVisible: true,
  // One-shot "+ Add" mode: the next left click on the map places a marker
  // there instead of opening the building/icon under the cursor.
  addingMarker: false,
  // Master toggle: hide ALL markers from the map (category icons/"?",
  // my markers, "X" pin). Does not touch town labels or streets.
  allMarkersVisible: true,     // localStorage 'pz.allMarkers'

  // --- streets ---
  streetsRaw: null,            // data/streets.json (loaded once), null = not loaded yet
  streetsLinesLayer: null,
  streetLineEntries: null,     // [{w, outline, main}] — for setStyle by zoom/theme without recreation
  streetLabelsLayer: null,
  streetsVisible: false,       // "Street names" checkbox: in topdown controls only the labels

  // --- topdown basemap: water/forest (Apple Maps day/night) ---
  waterRaw: null,               // data/worldmap_water.json .features, null = not loaded yet, [] = no file
  forestRaw: null,               // data/worldmap_forest.json .features
  waterLayer: null,
  forestLayer: null,
  waterPolygons: [],            // L.polygon[] — for setStyle on theme change
  forestPolygons: [],
  basemapRenderer: null,        // separate canvas renderer in pzBasemapPane (below buildings/streets)

  // --- floors ---
  floor: 0,                    // -1..7, only affects topdown
};

const CELL_CACHE_LIMIT = 150;
const CELL_BUFFER = 1; // buffer cells around the viewport

// Fixed visibility thresholds for iso mode, calibrated for the COLLAGE's 0..10
// zoom range. The own render uses an unrelated zoom scale (DZI levels, ~0..21) —
// isoThreshold() below shifts these onto whichever basemap is active so they keep
// the same on-screen meaning (see isoBasemapZoomShift()).
const ISO_ICONS_MIN_ZOOM_COLLAGE = 4;
const ISO_CELLS_MIN_ZOOM_COLLAGE = 5;
const ISO_TOWNS_MAX_ZOOM_COLLAGE = 5;
const ISO_STREET_LABEL_MIN_ZOOM_COLLAGE = 6;

// Reference collage scale (isoMeta.s) the constants above were calibrated
// against — used by isoScaleExponent() as a fallback when no collage data is
// loaded (PZMAP_CONFIG.collageAvailable=false), so the "own" render still
// gets correctly-shifted thresholds without needing actual collage data.
const COLLAGE_REFERENCE_S = 1.904;

/** log2(K) for a given iso basemap, K = screen px per world unit at that basemap's
 *  zoom 0 (the x-direction coefficient of its forward transform, folded through the
 *  latLng normalization). Used to relate the two iso basemaps' unrelated zoom scales
 *  to each other (isoBasemapZoomShift) and to topdown's (isoTdZoomOffset) — both are
 *  "solve K1*2^z1 = K2*2^z2 for z1-z2", i.e. -log2(K) is the offset against a basemap
 *  where 1 world unit == 1 zoom-0 screen px (topdown, or a hypothetical K=1 iso). */
function isoScaleExponent(basemap) {
  if (basemap === "own" && state.renderMeta) {
    const m = state.renderMeta;
    return Math.log2((m.sqr / (2 * m.scale)) / Math.pow(2, m.refLevel));
  }
  const s = (state.isoMeta && state.isoMeta.s) || COLLAGE_REFERENCE_S;
  return Math.log2(s / 256);
}

/** Rounded zoom offset between the active iso basemap and topdown (see switchMode()) —
 *  computed per-basemap so it stays correct for either "own" or "collage". */
function isoTdZoomOffset() {
  return Math.round(-isoScaleExponent(state.isoBasemap));
}

/** Rounded zoom shift to go from a collage-calibrated zoom value to the equivalent
 *  (same on-screen scale) value on the currently active basemap. 0 for "collage". */
function isoBasemapZoomShift() {
  return state.isoBasemap === "own"
    ? Math.round(isoScaleExponent("collage") - isoScaleExponent("own"))
    : 0;
}

/** Convert one of the *_COLLAGE zoom-threshold constants above to the active basemap. */
function isoThreshold(collageZoom) {
  return collageZoom + isoBasemapZoomShift();
}
// Topdown: street lines are ALWAYS drawn (not gated by the checkbox) starting at this zoom,
// slightly earlier than building outlines (worldZoom + 4) — the checkbox only controls the labels.
const STREETS_TOPDOWN_MIN_ZOOM_OFFSET = 3;

const MARKER_ICONS = ["📍", "⭐", "🏠", "💀", "🔫", "🍎", "🚗", "❗"];

// ---------------------------------------------------------------------------
// 3z. CATEGORY_STYLE — color + svg glyph (symbol id from index.html) for each
//     catId from data/meta.json. Purely a presentation table (label/emoji
//     stay in meta.json) — used by chips, map POI badges and the
//     search dropdown. The order here also sets the chip order in the UI.
// ---------------------------------------------------------------------------
const CATEGORY_STYLE = {
  police:      { color: "#3478F6", glyph: "g-police" },
  fire:        { color: "#FF453A", glyph: "g-fire" },
  medical:     { color: "#FF375F", glyph: "g-med" },
  pharmacy:    { color: "#FF6482", glyph: "g-pharmacy" },
  restaurant:  { color: "#FF9500", glyph: "g-food" },
  grocery:     { color: "#F7B500", glyph: "g-cart" },
  bar:         { color: "#BF5AF2", glyph: "g-bar" },
  gun:         { color: "#5E5CE6", glyph: "g-gun" },
  gas:         { color: "#32ADE6", glyph: "g-gas" },
  hardware:    { color: "#34C759", glyph: "g-tool" },
  library:     { color: "#A2845E", glyph: "g-book" },
  school:      { color: "#B45309", glyph: "g-school" },
  church:      { color: "#8E8E93", glyph: "g-church" },
  bank:        { color: "#00A88E", glyph: "g-bank" },
  clothing:    { color: "#D648D6", glyph: "g-clothing" },
  motel:       { color: "#0FB5AE", glyph: "g-motel" },
  prison:      { color: "#5B6472", glyph: "g-prison" },
  selfstorage: { color: "#C69026", glyph: "g-selfstorage" },
  warehouse:   { color: "#6B7C93", glyph: "g-warehouse" },
};
const FALLBACK_CAT_STYLE = { color: "#8E8E93", glyph: "g-flag" };

function catStyle(catId) {
  return CATEGORY_STYLE[catId] || FALLBACK_CAT_STYLE;
}

/** HTML content of a POI badge (colored circle + category svg glyph). */
function poiBadgeHtml(catId) {
  const st = catStyle(catId);
  return `<svg><use href="#${st.glyph}"/></svg>`;
}

// ---------------------------------------------------------------------------
// 3y. I18N — uk/en dictionary (en is the default), t(key, vars) function with
//     {name}-placeholder substitution, applyI18n() (static [data-i18n]/[data-i18n-title]/
//     [data-i18n-placeholder] in index.html), catLabel() (catId translation with
//     a fallback to the Russian label from meta.json) and setLang() (instant
//     language switch without a reload). state.lang is read from localStorage 'pz.lang'
//     a bit below (see section 3a, next to the analogous state.theme initialization).
//     Custom marker names/icons and town/street names are map data,
//     not UI strings — this dictionary does NOT translate them.
// ---------------------------------------------------------------------------
const I18N = {
  uk: {
    "search.placeholder": "Місто, категорія…",
    "search.clear": "Очистити",
    "search.empty": "Нічого не знайдено",
    "search.towns": "Міста",
    "search.cats": "Категорії",

    "zoom.in": "Наблизити",
    "zoom.out": "Віддалити",

    "mode.title": "Ізометрія / Схема",
    "mode.toScheme": "Перемкнути на «Схему»",
    "mode.toIso": "Перемкнути на ізометрію",

    "layers.title": "Шари",
    "layers.outlines": "Контури будівель",
    "layers.basemapCollage": "Колаж-підложка (замість власного рендера)",
    "layers.streets": "Назви вулиць",
    "layers.allmarkers": "Маркери на карті",
    "layers.spoilers": "Спойлери",
    "layers.compactchips": "Чипи без підписів",
    "layers.search": "Пошук",
    "layers.chips": "Чипи категорій",
    "layers.showall": "Показати все",
    "layers.resetmarks": "Скинути позначки",

    // Native language names — identical in both dicts on purpose (a language name
    // isn't translated depending on the currently active UI language).
    "lang.uk": "Українська",
    "lang.en": "English",

    "theme.title": "Тема",
    "theme.toLight": "Світла тема",
    "theme.toDark": "Темна тема",

    "floor.up": "Поверх вище",
    "floor.down": "Поверх нижче",
    "floor.isoHint": "недоступно з колаж-підложкою",

    "chips.all": "Всі",

    "status.cell": "клітинка",
    "status.floor": "поверх",

    "iso.disclaimer": "інша ревізія мапи",
    "iso.disclaimerTitle": "Підложка — рендер іншої ревізії мапи; можливі розбіжності",

    "compass.title": "Сторони світу в поточній проекції",
    "compass.n": "Пн",
    "compass.e": "Сх",
    "compass.s": "Пд",
    "compass.w": "Зх",

    "popup.noCategory": "Без категорії",
    "popup.loading": "Завантаження…",
    "popup.roomsEmpty": "Немає кімнат на рівні 0",
    "popup.zoomForRooms": "Наблизьте карту для списку кімнат",

    "spoiler.title": "Ви тут були?",
    "spoiler.mark": "Позначити місце",
    "spoiler.confirmReset": "Скинути всі позначки відвіданих місць?",

    "share.copyLink": "Скопіювати посилання",
    "share.placeMarker": "Поставити маркер",
    "share.copied": "Скопійовано!",
    "share.copyFail": "Не вдалося скопіювати",

    "markerForm.title": "Новий маркер",
    "markerForm.namePlaceholder": "Назва",
    "markerForm.save": "Зберегти",

    "markers.pill": "Маркери",
    "markers.title": "Мої маркери",
    "markers.show": "Показувати",
    "markers.add": "Додати",
    "markers.share": "Посилання",
    "markers.shareTitle": "Скопіювати посилання, в яке вшиті всі маркери — отримувачу не потрібен файл",
    "markers.import": "Імпорт",
    "markers.export": "Експорт",
    "markers.delete": "Видалити",
    "markers.confirmDelete": "Видалити маркер «{name}»?",
    "markers.showOnMap": "Показати на карті",
    "markers.default": "Маркер",
    "markers.emptyList": "Поки що пусто. Клікни по карті і обери<br>«Поставити маркер» — або тисни «Додати».",
    "markers.addHint": "Клацни лівою кнопкою по мапі, щоб поставити маркер",
    "markers.noneToShare": "Немає маркерів — нічого надсилати",

    "toast.linkReadFail": "Не вдалося прочитати маркери з посилання",
    "toast.allDup": "Усі маркери з посилання ({n} шт.) вже є у вас — нічого не додано",
    "toast.addedWithDups": "Додано: {n}, пропущено дублікатів: {m}",
    "toast.added": "Додано маркерів: {n}",
    "toast.linkCopied": "Посилання з маркерами ({n} шт.) скопійовано",
    "toast.linkCopyFail": "Не вдалося скопіювати посилання",
    "toast.importDup": "Імпорт: пропущено дублікатів — {n}",

    "confirm.addMarkers": "Посилання містить нові маркери ({n} шт.{dupNote}). Додати?",
    "confirm.dupNote": ", ще {n} — дублікати, пропустимо",

    "import.badJson": "Некоректний JSON-файл",
    "import.readFail": "Не вдалося прочитати файл",

    "onb.layers": "Тут налаштування: шари, тема, вигляд карти",
    "onb.markers": "Твої маркери: список, імпорт та експорт — «Посилання» миттєво ділиться всіма",
    "onb.goodluck": "Вдалої гри!",
    "onboarding.skip": "Пропустити тур",

    "about.open": "Про цю мапу",
    "about.close": "Закрити",
    "about.tagline": "неофіційна інтерактивна мапа",
    "about.notice": "Неофіційний фанатський проєкт. Не пов'язаний з The Indie Stone.",
    "about.madein": "З України з любов'ю",
    "about.builtwith": "Створено на основі",
    "about.gamedata": "ігрові дані © The Indie Stone",
    "about.mapdata": "Дані мапи",
    "about.gameline": "Гра: {game} · build id {buildId}",
    "about.dateline": "Дані видобуто: {date}",

    "attribution.unofficial": "Неофіційно",
    "attribution.notaffiliated": "не пов'язано з The Indie Stone",

    "cat.police": "Поліція",
    "cat.fire": "Пожежна станція",
    "cat.medical": "Лікарня",
    "cat.pharmacy": "Аптека",
    "cat.restaurant": "Ресторан",
    "cat.grocery": "Продуктовий магазин",
    "cat.bar": "Бар",
    "cat.gun": "Зброярня",
    "cat.gas": "АЗС",
    "cat.hardware": "Будівельний магазин",
    "cat.library": "Бібліотека",
    "cat.school": "Школа",
    "cat.church": "Церква",
    "cat.bank": "Банк",
    "cat.clothing": "Магазин одягу",
    "cat.motel": "Мотель",
    "cat.prison": "В'язниця",
    "cat.selfstorage": "Камери схову",
    "cat.warehouse": "Склад",
  },
  en: {
    "search.placeholder": "Town, category…",
    "search.clear": "Clear",
    "search.empty": "Nothing found",
    "search.towns": "Towns",
    "search.cats": "Categories",

    "zoom.in": "Zoom in",
    "zoom.out": "Zoom out",

    "mode.title": "Isometric / Scheme",
    "mode.toScheme": "Switch to Scheme view",
    "mode.toIso": "Switch to isometric view",

    "layers.title": "Layers",
    "layers.outlines": "Building outlines",
    "layers.basemapCollage": "Collage basemap (instead of our own render)",
    "layers.streets": "Street names",
    "layers.allmarkers": "Markers on map",
    "layers.spoilers": "Spoilers",
    "layers.compactchips": "Chips without labels",
    "layers.search": "Search",
    "layers.chips": "Category chips",
    "layers.showall": "Show all",
    "layers.resetmarks": "Reset marks",

    "lang.uk": "Українська",
    "lang.en": "English",

    "theme.title": "Theme",
    "theme.toLight": "Light theme",
    "theme.toDark": "Dark theme",

    "floor.up": "Floor up",
    "floor.down": "Floor down",
    "floor.isoHint": "unavailable with the collage basemap",

    "chips.all": "All",

    "status.cell": "cell",
    "status.floor": "floor",

    "iso.disclaimer": "different map revision",
    "iso.disclaimerTitle": "Underlay is rendered from a different map revision; discrepancies are possible",

    "compass.title": "Compass directions in the current projection",
    "compass.n": "N",
    "compass.e": "E",
    "compass.s": "S",
    "compass.w": "W",

    "popup.noCategory": "No category",
    "popup.loading": "Loading…",
    "popup.roomsEmpty": "No rooms on level 0",
    "popup.zoomForRooms": "Zoom in to see the room list",

    "spoiler.title": "Have you been here?",
    "spoiler.mark": "Mark visited",
    "spoiler.confirmReset": "Reset all visited-place marks?",

    "share.copyLink": "Copy link",
    "share.placeMarker": "Place marker",
    "share.copied": "Copied!",
    "share.copyFail": "Could not copy",

    "markerForm.title": "New marker",
    "markerForm.namePlaceholder": "Name",
    "markerForm.save": "Save",

    "markers.pill": "Markers",
    "markers.title": "My markers",
    "markers.show": "Show",
    "markers.add": "Add",
    "markers.share": "Link",
    "markers.shareTitle": "Copy a link with all markers baked in — the recipient doesn't need a file",
    "markers.import": "Import",
    "markers.export": "Export",
    "markers.delete": "Delete",
    "markers.confirmDelete": "Delete marker \"{name}\"?",
    "markers.showOnMap": "Show on map",
    "markers.default": "Marker",
    "markers.emptyList": "Empty for now. Click the map and choose<br>“Place marker” — or press “Add”.",
    "markers.addHint": "Left-click the map to place a marker",
    "markers.noneToShare": "No markers — nothing to share",

    "toast.linkReadFail": "Could not read markers from the link",
    "toast.allDup": "All markers from the link ({n}) are already yours — nothing added",
    "toast.addedWithDups": "Added: {n}, skipped duplicates: {m}",
    "toast.added": "Added markers: {n}",
    "toast.linkCopied": "Link with markers ({n}) copied",
    "toast.linkCopyFail": "Could not copy the link",
    "toast.importDup": "Import: skipped duplicates — {n}",

    "confirm.addMarkers": "The link contains new markers ({n}{dupNote}). Add them?",
    "confirm.dupNote": ", {n} more are duplicates and will be skipped",

    "import.badJson": "Invalid JSON file",
    "import.readFail": "Could not read the file",

    "onb.layers": "Settings live here: layers, theme, map view",
    "onb.markers": "Your markers: list, import & export — “Link” instantly shares them all",
    "onb.goodluck": "Good luck out there!",
    "onboarding.skip": "Skip tour",

    "about.open": "About this map",
    "about.close": "Close",
    "about.tagline": "unofficial interactive map",
    "about.notice": "Unofficial fan project. Not affiliated with The Indie Stone.",
    "about.madein": "From Ukraine with Love",
    "about.builtwith": "Built with",
    "about.gamedata": "game data © The Indie Stone",
    "about.mapdata": "Map data",
    "about.gameline": "Game: {game} · build id {buildId}",
    "about.dateline": "Data extracted: {date}",

    "attribution.unofficial": "Unofficial",
    "attribution.notaffiliated": "not affiliated with The Indie Stone",

    "cat.police": "Police",
    "cat.fire": "Fire Station",
    "cat.medical": "Hospital",
    "cat.pharmacy": "Pharmacy",
    "cat.restaurant": "Restaurant",
    "cat.grocery": "Grocery Store",
    "cat.bar": "Bar",
    "cat.gun": "Gun Store",
    "cat.gas": "Gas Station",
    "cat.hardware": "Hardware Store",
    "cat.library": "Library",
    "cat.school": "School",
    "cat.church": "Church",
    "cat.bank": "Bank",
    "cat.clothing": "Clothing Store",
    "cat.motel": "Motel",
    "cat.prison": "Prison",
    "cat.selfstorage": "Self Storage",
    "cat.warehouse": "Warehouse",
  },
};

/** Translate a string by key for the current (or explicitly given) language,
 *  substituting {name}-placeholders from vars. Fallback: uk -> the key itself. */
function t(key, vars, lang) {
  const l = lang || state.lang;
  const dict = I18N[l] || I18N.uk;
  let str = dict[key];
  if (str === undefined) str = I18N.uk[key] !== undefined ? I18N.uk[key] : key;
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  }
  return str;
}

/** Translate a category name: the I18N dictionary takes priority, otherwise — fall
 *  back to the Russian label from data/meta.json (for a catId missing from I18N). */
function catLabel(catId, lang) {
  const l = lang || state.lang;
  const key = "cat." + catId;
  const dict = I18N[l] || I18N.uk;
  if (dict[key]) return dict[key];
  const categories = (state.meta && state.meta.categories) || {};
  return (categories[catId] && categories[catId].label) || catId;
}

/** Apply translations to all static index.html elements marked with
 *  data-i18n (textContent) / data-i18n-title (title attribute) /
 *  data-i18n-placeholder (placeholder attribute). */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
}

/** Highlight the active language switcher pill in the "Layers" panel. */
function updateLangUI() {
  const ukBtn = document.getElementById("lang-uk-btn");
  const enBtn = document.getElementById("lang-en-btn");
  if (ukBtn) ukBtn.classList.toggle("active", state.lang === "uk");
  if (enBtn) enBtn.classList.toggle("active", state.lang === "en");
}

/** Update category chip labels (.lbl text + the "All" chip) without recreating the
 *  DOM/handlers — a full initChips() would spawn duplicate wheel listeners
 *  on #chips across repeated language switches within one session. */
function updateChipsI18n() {
  const box = document.getElementById("chips");
  if (!box) return;
  const allChip = box.querySelector(".chip-all");
  if (allChip) allChip.textContent = t("chips.all");
  box.querySelectorAll(".chip[data-cat]").forEach((chip) => {
    const lbl = chip.querySelector(".lbl");
    if (lbl) lbl.textContent = catLabel(chip.dataset.cat);
  });
}

/** Switch the interface language: saves to localStorage, reapplies static
 *  and dynamic texts (chips/compass/status/titles/markers pill/category
 *  icon tooltips) without reloading the page. */
function setLang(lang) {
  const next = lang === "en" ? "en" : "uk";
  if (next === state.lang) return;
  state.lang = next;
  store.set("pz.lang", state.lang);
  document.documentElement.lang = state.lang;

  applyI18n();
  updateLangUI();
  updateChipsI18n();
  updateThemeUI();
  updateModeUI(); // this also triggers renderCompass() + updateFloorUI() (-> updateStatusBar())
  refreshMarkerPanel();
  if (state.buildingsIndexRaw) buildIconsLayers(); // updates category tooltips on map icons
}

function initLangSwitch() {
  const ukBtn = document.getElementById("lang-uk-btn");
  const enBtn = document.getElementById("lang-en-btn");
  if (ukBtn) ukBtn.addEventListener("click", () => setLang("uk"));
  if (enBtn) enBtn.addEventListener("click", () => setLang("en"));
  updateLangUI();
}

// ---------------------------------------------------------------------------
// 3. util
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function throttleRaf(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}

async function fetchJson(url) {
  let resp;
  try {
    // no-cache: revalidate with the server every time. Python's http.server
    // sends Last-Modified only, and the browser's heuristic freshness would
    // otherwise serve stale data/*.json (e.g. iso_meta anchors) after edits.
    resp = await fetch(url, { cache: "no-cache" });
  } catch (e) {
    console.warn("[pzmap] network error", url, e);
    return null;
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    console.warn("[pzmap] fetch failed", url, resp.status);
    return null;
  }
  try {
    return await resp.json();
  } catch (e) {
    console.warn("[pzmap] bad json", url, e);
    return null;
  }
}

/** Unified access to localStorage — resilient to private mode/quota errors (try/catch). */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// 3a. THEME — "Apple Maps day/night" palettes for Leaflet's vector canvas
//     layers (buildings/rooms, streets, water, forest). UI colors (panels, popups,
//     icon badges, labels) live in CSS variables (web/css/style.css,
//     body.theme-light/body.theme-dark classes) — Leaflet path styles don't
//     understand var(), so canvas needs a separate JS palette.
// ---------------------------------------------------------------------------
const THEME = {
  light: {
    water: "#A8D0EE",
    forest: "#D5E8CF",
    buildingFill: "#E2DFD6",
    buildingStroke: "#CBC7BC",
    buildingCatFill: "#FFD9A8",
    buildingCatStroke: "#E0A85C",
    streetFill: "#FFFFFF",
    streetStroke: "#D8D4CA",
  },
  dark: {
    water: "#0F2A43",
    forest: "#16241A",
    buildingFill: "#2C2C2E",
    buildingStroke: "#3A3A3C",
    buildingCatFill: "#4A3A22",
    buildingCatStroke: "#8C6A34",
    streetFill: "#3A3A3C",
    streetStroke: "#2C2C2E",
  },
};

/** Palette of the current theme (canvas layers). */
function currentTheme() {
  return THEME[state.theme] || THEME.light;
}

/** Apply the theme class on <body> (doesn't touch mode classes). */
function applyThemeClass() {
  document.body.classList.toggle("theme-light", state.theme === "light");
  document.body.classList.toggle("theme-dark", state.theme === "dark");
}

// Apply the theme as early as possible (the script runs at the end of <body>, the
// element already exists) to avoid a flash of default styles before DOMContentLoaded.
state.theme = store.get("pz.theme", "dark") === "dark" ? "dark" : "light";
applyThemeClass();

// Interface language — for the same reason (see the comment on applyThemeClass() above)
// applied as early as possible: the script runs at the end of <body>, all static
// markup text (data-i18n) is already in the DOM, so we apply it right away, without waiting
// for DOMContentLoaded/init() — otherwise on a slow meta.json fetch() the uk text would flash
// even with en saved.
state.lang = store.get("pz.lang", "en") === "uk" ? "uk" : "en";
document.documentElement.lang = state.lang;
applyI18n();
updateLangUI();

function updateThemeUI() {
  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.classList.toggle("seg-on", state.theme === "dark");
    btn.title = state.theme === "dark" ? t("theme.toLight") : t("theme.toDark");
  }
}

/** Switch the theme: saves to localStorage, applies the class on body,
 *  redraws all vector layers without reloading the page. */
function setTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  if (next === state.theme) return;
  state.theme = next;
  store.set("pz.theme", state.theme);
  applyThemeClass();
  updateThemeUI();
  redrawForTheme();
}

/** Redraw all canvas layers for the new theme: cells (buildings/rooms) —
 *  full group recreation (as on a floor change), streets/water/forest —
 *  a cheap setStyle without recreating the geometry. */
function redrawForTheme() {
  refreshCellsForFloor(); // ensureCellRendered now also checks the theme (see below)
  updateStreetsTheme();
  updateBasemapTheme();
}

function initThemeControls() {
  const btn = document.getElementById("theme-btn");
  if (btn) btn.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  updateThemeUI();
}

/** Copy text to the clipboard: navigator.clipboard, fallback to textarea+execCommand. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // fall through to the fallback below
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4. cells — lazy loading of cells by viewport, rendering of building outlines
//    (floor 0) or rooms of a specific floor (topdown, floor != 0).
//    Top-down uses rectangles (bbox), iso uses parallelograms (bboxCorners).
//    Works the same way in both modes via getCoords().viewToWorld(...).
// ---------------------------------------------------------------------------
function cellKey(cx, cy) {
  return cx + "_" + cy;
}

function buildPopupHtml(b) {
  const categories = (state.meta && state.meta.categories) || {};
  const catInfo = b.cat ? categories[b.cat] : null;
  const catLabelHtml = catInfo
    ? `${escapeHtml(catInfo.emoji || "")} ${escapeHtml(catLabel(b.cat))}`
    : t("popup.noCategory");

  const counts = new Map();
  for (const r of b.rooms || []) {
    if (r.l === 0) {
      counts.set(r.n, (counts.get(r.n) || 0) + 1);
    }
  }

  let roomsHtml;
  if (counts.size) {
    const items = [...counts.entries()]
      .sort((a, b2) => b2[1] - a[1])
      .map(([n, c]) => `<li>${escapeHtml(n)} × ${c}</li>`)
      .join("");
    roomsHtml = `<ul class="popup-rooms">${items}</ul>`;
  } else {
    roomsHtml = `<div class="popup-empty">${t("popup.roomsEmpty")}</div>`;
  }

  return `<div class="popup-title">${catLabelHtml}</div>${roomsHtml}`;
}

/** Floor 0: building bboxes (vs. renderCellRooms below for other floors). */
function renderCellBuildings(cellData) {
  const group = L.layerGroup();
  if (!cellData || !Array.isArray(cellData.buildings)) return group;

  const iso = state.mode === "iso";
  const th = currentTheme();
  for (const b of cellData.buildings) {
    if (!b.bbox || b.bbox.length !== 4) continue;
    const [x, y, w, h] = b.bbox;
    const categorized = !!b.cat;
    const fillColor = categorized ? th.buildingCatFill : th.buildingFill;
    const strokeColor = categorized ? th.buildingCatStroke : th.buildingStroke;

    let layer;
    if (iso) {
      // Parallelogram: 4 bbox corners via coordsIso (thinner/more transparent than top-down,
      // since the basemap is a photorealistic collage — the fill stays a light tint layer).
      layer = L.polygon(coordsIso.bboxCorners(x, y, w, h), {
        renderer: state.renderer,
        color: strokeColor,
        weight: 1,
        fillColor,
        fillOpacity: categorized ? 0.16 : 0.08,
        interactive: true,
        bubblingMouseEvents: false,
      });
    } else {
      // Scheme: fill — full-strength building color in Apple Maps style.
      layer = L.rectangle(coords.bboxToBounds(x, y, w, h), {
        renderer: state.renderer,
        color: strokeColor,
        weight: 1,
        fillColor,
        fillOpacity: categorized ? 0.95 : 0.9,
        interactive: true,
        bubblingMouseEvents: false,
      });
    }
    layer.bindPopup(() => buildPopupHtml(b), { maxWidth: 280 });
    group.addLayer(layer);
  }
  return group;
}

/**
 * Floor N != 0: instead of building bboxes — rectangles (or, in iso, parallelograms
 * shifted onto that floor's DZI layer — same treatment as renderCellBuildings) of the
 * rooms on that floor. Buildings with no rooms on floor N don't appear on the map.
 * A room's popup is just its name.
 */
function renderCellRooms(cellData, floor) {
  const group = L.layerGroup();
  if (!cellData || !Array.isArray(cellData.buildings)) return group;

  const iso = state.mode === "iso";
  const th = currentTheme();
  for (const b of cellData.buildings) {
    if (!Array.isArray(b.rooms)) continue;
    const categorized = !!b.cat;
    const fillColor = categorized ? th.buildingCatFill : th.buildingFill;
    const strokeColor = categorized ? th.buildingCatStroke : th.buildingStroke;
    for (const room of b.rooms) {
      if (room.l !== floor || !Array.isArray(room.r)) continue;
      const roomName = room.n;
      for (const rect of room.r) {
        if (!rect || rect.length !== 4) continue;
        const [x, y, w, h] = rect;
        let layer;
        if (iso) {
          layer = L.polygon(coordsIso.bboxCorners(x, y, w, h, floor), {
            renderer: state.renderer,
            color: strokeColor,
            weight: 1,
            fillColor,
            fillOpacity: categorized ? 0.16 : 0.08,
            interactive: true,
            bubblingMouseEvents: false,
          });
        } else {
          layer = L.rectangle(coords.bboxToBounds(x, y, w, h), {
            renderer: state.renderer,
            color: strokeColor,
            weight: 1,
            fillColor,
            fillOpacity: 0.9,
            interactive: true,
            bubblingMouseEvents: false,
          });
        }
        layer.bindPopup(() => `<div class="popup-title">${escapeHtml(roomName)}</div>`, { maxWidth: 240 });
        group.addLayer(layer);
      }
    }
  }
  return group;
}

/** Effective floor for cell rendering: topdown always follows state.floor; iso follows
 *  it too, but only on the "own" basemap (the collage has no floor data — always 0). */
function effectiveFloor() {
  if (state.mode === "iso" && state.isoBasemap !== "own") return 0;
  return state.floor;
}

/** Rebuild (if needed) a cell's render for the current floor/theme. */
function ensureCellRendered(entry) {
  if (!entry.data) return;
  const floor = effectiveFloor();
  if (entry.group && entry.renderedFloor === floor && entry.renderedTheme === state.theme) return;
  const wasVisible = !!(entry.group && state.cellsRoot.hasLayer(entry.group));
  if (entry.group) state.cellsRoot.removeLayer(entry.group);
  entry.group = floor === 0 ? renderCellBuildings(entry.data) : renderCellRooms(entry.data, floor);
  entry.renderedFloor = floor;
  entry.renderedTheme = state.theme;
  if (wasVisible) state.cellsRoot.addLayer(entry.group);
}

/** Redraw all cached cells for the new floor/theme (without re-fetching). */
function refreshCellsForFloor() {
  for (const entry of state.cellCache.values()) {
    if (entry.data) ensureCellRendered(entry);
  }
}

async function ensureCellLoaded(cx, cy) {
  const key = cellKey(cx, cy);
  let entry = state.cellCache.get(key);
  if (entry) {
    entry.lastUsed = Date.now();
    if (!entry.loading) ensureCellRendered(entry);
    if (entry.group && state.cellsVisible && !state.cellsRoot.hasLayer(entry.group)) {
      state.cellsRoot.addLayer(entry.group);
    }
    return;
  }

  // placeholder to avoid starting a parallel reload of the same cell
  entry = { data: null, group: null, renderedFloor: null, lastUsed: Date.now(), empty: false, loading: true };
  state.cellCache.set(key, entry);

  const data = await fetchJson(`${appBase()}data/cells/${cx}_${cy}.json`);
  entry.loading = false;
  if (!data) {
    entry.empty = true;
    entry.data = null;
    entry.group = null;
    return;
  }
  entry.data = data;
  ensureCellRendered(entry);
  if (state.cellsVisible && isCellInWantedRange(cx, cy)) {
    state.cellsRoot.addLayer(entry.group);
  }
  updateStatusLoaded();
}

// range of cells that should currently be loaded (recomputed in updateCells)
let wantedRange = { cxMin: 0, cxMax: -1, cyMin: 0, cyMax: -1 };

function isCellInWantedRange(cx, cy) {
  return cx >= wantedRange.cxMin && cx <= wantedRange.cxMax &&
         cy >= wantedRange.cyMin && cy <= wantedRange.cyMax;
}

function evictCells(wantedKeys) {
  if (state.cellCache.size <= CELL_CACHE_LIMIT) return;
  const candidates = [];
  for (const [key, entry] of state.cellCache.entries()) {
    if (wantedKeys.has(key)) continue; // don't touch visible ones
    candidates.push([key, entry]);
  }
  candidates.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let toRemove = state.cellCache.size - CELL_CACHE_LIMIT;
  for (const [key, entry] of candidates) {
    if (toRemove <= 0) break;
    if (entry.group && state.cellsRoot.hasLayer(entry.group)) {
      state.cellsRoot.removeLayer(entry.group);
    }
    state.cellCache.delete(key);
    toRemove--;
  }
}

/** Whether building outlines should currently be visible (zoom threshold + mode-specific conditions) */
function cellsShouldShow(zoom) {
  if (state.mode === "iso") {
    return state.showBuildingOutlines && zoom >= isoThreshold(ISO_CELLS_MIN_ZOOM_COLLAGE);
  }
  return zoom >= state.cellsMinZoom;
}

function updateCells() {
  if (!state.meta) return;
  const zoom = state.map.getZoom();
  const shouldShow = cellsShouldShow(zoom);

  if (!shouldShow) {
    if (state.cellsVisible) {
      state.cellsRoot.clearLayers();
      state.cellsVisible = false;
    }
    wantedRange = { cxMin: 0, cxMax: -1, cyMin: 0, cyMax: -1 };
    updateStatusLoaded();
    return;
  }
  state.cellsVisible = true;

  const cellSize = state.meta.cellSize;
  const w = getCoords().viewToWorld(state.map.getBounds());
  const cxMin = clamp(Math.floor(w.minX / cellSize) - CELL_BUFFER, 0, state.meta.cellsX - 1);
  const cxMax = clamp(Math.floor(w.maxX / cellSize) + CELL_BUFFER, 0, state.meta.cellsX - 1);
  const cyMin = clamp(Math.floor(w.minY / cellSize) - CELL_BUFFER, 0, state.meta.cellsY - 1);
  const cyMax = clamp(Math.floor(w.maxY / cellSize) + CELL_BUFFER, 0, state.meta.cellsY - 1);
  wantedRange = { cxMin, cxMax, cyMin, cyMax };

  const wantedKeys = new Set();
  for (let cy = cyMin; cy <= cyMax; cy++) {
    for (let cx = cxMin; cx <= cxMax; cx++) {
      wantedKeys.add(cellKey(cx, cy));
      ensureCellLoaded(cx, cy);
    }
  }

  // remove from the scene cells that fell outside the wanted range (but keep in cache)
  for (const [key, entry] of state.cellCache.entries()) {
    if (!wantedKeys.has(key) && entry.group && state.cellsRoot.hasLayer(entry.group)) {
      state.cellsRoot.removeLayer(entry.group);
    }
  }

  evictCells(wantedKeys);
  updateStatusLoaded();
}

// ---------------------------------------------------------------------------
// 5. icons — building icon layer from buildings_index.json.
//    The data (buildingsIndexRaw) is loaded once and reused across
//    mode switches; the L.marker layers (categoryLayers) are rebuilt
//    from scratch on every initMap(), since latLng depends on the active mode.
//    In spoiler mode, unvisited buildings are drawn as a neutral "?".
// ---------------------------------------------------------------------------
function buildIconsLayers() {
  // buildIconsLayers() can be called multiple times over a map's lifetime
  // (spoiler mode toggle, save import) — the old L.layerGroup needs to be
  // removed from iconsRoot, otherwise markers get duplicated.
  if (state.iconsRoot) state.iconsRoot.clearLayers();
  state.categoryLayers = {};
  const raw = state.buildingsIndexRaw;
  const categories = (state.meta && state.meta.categories) || {};

  if (raw) {
    const cf = getCoords();
    for (const b of raw) {
      if (!b.cat) continue;
      if (!state.categoryLayers[b.cat]) {
        state.categoryLayers[b.cat] = L.layerGroup();
      }
      const catInfo = categories[b.cat] || {};
      const hidden = state.spoilersOn && !state.revealedSet.has(b.id);

      let icon, marker;
      if (hidden) {
        icon = L.divIcon({
          className: "poi-badge spoiler",
          html: "?",
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        marker = L.marker(cf.toLatLng(b.x, b.y), { icon, interactive: true, keyboard: false, bubblingMouseEvents: false });
        marker.on("click", () => { if (!state.addingMarker) openSpoilerPopup(b); });
      } else {
        const st = catStyle(b.cat);
        icon = L.divIcon({
          className: "poi-wrap",
          html: `<span class="poi-badge" style="background:${st.color}">${poiBadgeHtml(b.cat)}</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        marker = L.marker(cf.toLatLng(b.x, b.y), { icon, interactive: true, keyboard: false, bubblingMouseEvents: false });
        marker.bindTooltip(escapeHtml(catLabel(b.cat)), { direction: "top", offset: [0, -8] });
        marker.on("click", () => { if (!state.addingMarker) openBuildingPopupById(b); });
      }
      state.categoryLayers[b.cat].addLayer(marker);
    }
  }

  for (const cat of Object.keys(state.categoryLayers)) {
    if (state.categoryChecked[cat] === undefined) state.categoryChecked[cat] = true;
  }

  updateIconsVisibility();
}

async function loadBuildingsIndex() {
  if (!state.buildingsIndexRaw) {
    const data = await fetchJson(`${appBase()}data/buildings_index.json`);
    if (!data || !Array.isArray(data.buildings)) return;
    state.buildingsIndexRaw = data.buildings;
  }
  buildIconsLayers();
}

/** Full building record (with .rooms) for a buildings_index entry: cellCache
 *  first, otherwise fetch the cell json directly — works at any zoom, in
 *  both modes, independently of whether the building-outlines layer (which
 *  fills cellCache as a side effect) is currently loaded. */
async function fetchBuildingById(b) {
  if (!Array.isArray(b.cell) || b.cell.length !== 2) return null;
  const key = cellKey(b.cell[0], b.cell[1]);
  const cached = state.cellCache.get(key);
  const cellData = cached && cached.data
    ? cached.data
    : await fetchJson(`${appBase()}data/cells/${b.cell[0]}_${b.cell[1]}.json`);
  if (!cellData || !Array.isArray(cellData.buildings)) return null;
  return cellData.buildings.find((bb) => bb.id === b.id) || null;
}

/** Building icon click (both modes, any zoom): open the popup immediately with
 *  a "Loading…" placeholder, then fill it in with the same title+room-list
 *  markup as the building-outline popup (buildPopupHtml — see section 4)
 *  once the cell data resolves. */
async function openBuildingPopupById(b) {
  const categories = (state.meta && state.meta.categories) || {};
  const catInfo = b.cat ? categories[b.cat] : null;
  const catLabelHtml = catInfo
    ? `${escapeHtml(catInfo.emoji || "")} ${escapeHtml(catLabel(b.cat))}`
    : t("popup.noCategory");

  const popup = L.popup({ maxWidth: 280 })
    .setLatLng(getCoords().toLatLng(b.x, b.y))
    .setContent(`<div class="popup-title">${catLabelHtml}</div><div class="popup-empty">${t("popup.loading")}</div>`)
    .openOn(state.map);

  const full = await fetchBuildingById(b);
  // setContent() on a popup the user already closed is a harmless no-op in Leaflet.
  popup.setContent(full
    ? buildPopupHtml(full)
    : `<div class="popup-title">${catLabelHtml}</div><div class="popup-empty">${t("popup.roomsEmpty")}</div>`);
}

function updateIconsVisibility() {
  const zoom = state.map.getZoom();
  const shouldShowZoom = state.allMarkersVisible && zoom >= state.iconsMinZoom;
  for (const cat of Object.keys(state.categoryLayers)) {
    const layer = state.categoryLayers[cat];
    // In spoiler mode the category filter is disabled (otherwise it would reveal categories).
    const wanted = shouldShowZoom && (state.spoilersOn || state.categoryChecked[cat]);
    const has = state.iconsRoot.hasLayer(layer);
    if (wanted && !has) state.iconsRoot.addLayer(layer);
    if (!wanted && has) state.iconsRoot.removeLayer(layer);
  }
}

// ---------------------------------------------------------------------------
// 6. towns — town labels from meta.towns
// ---------------------------------------------------------------------------
function buildTownsLayer() {
  state.townsLayer = L.layerGroup();
  const towns = (state.meta && state.meta.towns) || [];
  const cf = getCoords();
  for (const t of towns) {
    const icon = L.divIcon({
      className: "town-label",
      html: escapeHtml(t.name),
      iconSize: null,
      iconAnchor: [0, 0],
    });
    const marker = L.marker(cf.toLatLng(t.x, t.y), {
      icon,
      interactive: false,
      keyboard: false,
    });
    state.townsLayer.addLayer(marker);
  }
}

function updateTownsVisibility() {
  const zoom = state.map.getZoom();
  const shouldShow = zoom <= state.townsMaxZoom;
  if (shouldShow && !state.townsVisible) {
    state.townsLayer.addTo(state.map);
    state.townsVisible = true;
  } else if (!shouldShow && state.townsVisible) {
    state.map.removeLayer(state.townsLayer);
    state.townsVisible = false;
  }
}

// ---------------------------------------------------------------------------
// 7. chips — row of category chips + search dropdown (town/category)
//    + dropdown "Layers" panel
//    (building outlines / street names / markers on map / spoilers).
// ---------------------------------------------------------------------------

/** Build the chip row once (after meta.json loads). Clicking a chip —
 *  toggle state.categoryChecked[cat], clicking the "All" chip — toggle all. */
function initChips() {
  const categories = (state.meta && state.meta.categories) || {};
  // Default "enabled" for every catId from meta.json, up front — so the chips
  // render fully before buildings_index.json even loads.
  for (const cat of Object.keys(categories)) {
    if (state.categoryChecked[cat] === undefined) state.categoryChecked[cat] = true;
  }

  const catIds = Object.keys(CATEGORY_STYLE).filter((c) => categories[c]);
  // In case a catId is in meta.json but missing from CATEGORY_STYLE — don't lose the category.
  for (const c of Object.keys(categories)) if (!catIds.includes(c)) catIds.push(c);

  const box = document.getElementById("chips");
  if (!box) return;
  box.innerHTML = "";

  const allChip = document.createElement("div");
  allChip.className = "chip chip-all frost lift";
  allChip.textContent = t("chips.all");
  allChip.addEventListener("click", toggleAllCategories);
  box.appendChild(allChip);

  for (const cat of catIds) {
    const st = catStyle(cat);
    const chip = document.createElement("div");
    chip.className = "chip frost lift" + (state.categoryChecked[cat] ? "" : " off");
    chip.dataset.cat = cat;
    chip.innerHTML = `<span class="mini" style="background:${st.color}"><svg><use href="#${st.glyph}"/></svg></span><span class="lbl">${escapeHtml(catLabel(cat))}</span>`;
    chip.addEventListener("click", () => {
      const next = !state.categoryChecked[cat];
      state.categoryChecked[cat] = next;
      chip.classList.toggle("off", !next);
      updateIconsVisibility();
    });
    box.appendChild(chip);
  }

  // Mouse wheel — horizontal scroll of the row (otherwise on desktop the row
  // can't be scrolled: it has no vertical scroll, and the scrollbar is hidden).
  box.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      box.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Per-chip edge fade (see updateChipsEdgeFade() below): a mask-image on the
  // container itself would flatten .chip's backdrop-filter frost into a
  // single composited layer, so each chip fades individually instead.
  box.addEventListener("scroll", scheduleChipsEdgeFade, { passive: true });
  window.addEventListener("resize", scheduleChipsEdgeFade);
  scheduleChipsEdgeFade();

  updateSpoilerUI();
}

// rAF-throttle handle for updateChipsEdgeFade(), shared across scroll/resize
// callers so bursts of events only trigger one recompute per frame.
let chipsFadeRaf = null;

/** Schedule a single updateChipsEdgeFade() on the next animation frame,
 *  coalescing bursts of scroll/resize events. */
function scheduleChipsEdgeFade() {
  if (chipsFadeRaf !== null) return;
  chipsFadeRaf = requestAnimationFrame(() => {
    chipsFadeRaf = null;
    updateChipsEdgeFade();
  });
}

/** Per-chip edge fade for #chips — a mask-image on the container itself would
 *  break backdrop-filter frost on .chip (see initChips()), so each .chip
 *  fades its own opacity to 0 as its center approaches the container's
 *  visible left/right edge, fully opaque once clear of the fade zones. */
function updateChipsEdgeFade() {
  const box = document.getElementById("chips");
  if (!box) return;
  const rect = box.getBoundingClientRect();
  if (!rect.width) return;
  // The fade is a "there is more content" affordance, not decoration:
  // an edge dims chips ONLY while more chips are hidden beyond it. When the
  // row is scrolled all the way to an end (or doesn't overflow at all),
  // that side must show its chips at full opacity — otherwise the last chip
  // looks missing and the user can't tell whether the row continues.
  const EPS = 2;
  const canScrollLeft = box.scrollLeft > EPS;
  const canScrollRight = box.scrollLeft < box.scrollWidth - box.clientWidth - EPS;
  // "mask": gradient mask on the CHIP ITSELF — unlike a mask on the container
  // (which turns the container into a backdrop root and blinds descendants'
  // backdrop-filter), an element's own mask is applied to its final composite
  // (glass included), so the frost survives and the edge dissolves smoothly.
  // "opacity": fallback mode — fade the whole chip by its visible fraction.
  const CHIP_FADE_MODE = "mask";
  const FADE = 36; // px, width of the dissolve ramp inside the chip
  for (const chip of box.querySelectorAll(".chip")) {
    const cr = chip.getBoundingClientRect();
    if (!cr.width) continue;
    // Only chips that actually CROSS an edge need a mask; chips fully outside
    // are clipped by the container's overflow anyway.
    const clippedLeft = canScrollLeft && cr.left < rect.left - 1 && cr.right > rect.left + 1;
    const clippedRight = canScrollRight && cr.right > rect.right + 1 && cr.left < rect.right - 1;

    if (CHIP_FADE_MODE === "mask") {
      let mask = "";
      if (clippedLeft && clippedRight) {
        const l = rect.left - cr.left;
        const r = rect.right - cr.left;
        mask = `linear-gradient(90deg, transparent ${l}px, #000 ${l + FADE}px, #000 ${r - FADE}px, transparent ${r}px)`;
      } else if (clippedRight) {
        const edge = rect.right - cr.left; // container edge in chip-local x
        mask = `linear-gradient(90deg, #000 ${Math.max(edge - FADE, 0)}px, transparent ${edge}px)`;
      } else if (clippedLeft) {
        const edge = rect.left - cr.left;
        mask = `linear-gradient(90deg, transparent ${edge}px, #000 ${Math.min(edge + FADE, cr.width)}px)`;
      }
      chip.style.webkitMaskImage = mask;
      chip.style.maskImage = mask;
      chip.style.opacity = "";
    } else {
      let op = 1;
      if (clippedLeft || clippedRight) {
        const visible = Math.min(cr.right, rect.right) - Math.max(cr.left, rect.left);
        op = Math.pow(clamp(visible / cr.width, 0, 1), 1.5);
      }
      chip.style.opacity = String(op);
      chip.style.webkitMaskImage = "";
      chip.style.maskImage = "";
    }
  }
}

/** Sync the visual chip state (.off) with state.categoryChecked. */
function updateChipStates() {
  const box = document.getElementById("chips");
  if (!box) return;
  for (const chip of box.querySelectorAll(".chip[data-cat]")) {
    chip.classList.toggle("off", !state.categoryChecked[chip.dataset.cat]);
  }
}

/** "All" chip: if all categories are currently enabled — disable all, otherwise enable all. */
function toggleAllCategories() {
  if (state.spoilersOn) return;
  const cats = Object.keys(state.categoryChecked);
  const allOn = cats.every((c) => state.categoryChecked[c]);
  for (const c of cats) state.categoryChecked[c] = !allOn;
  updateChipStates();
  updateIconsVisibility();
}

/** Reset the category filter (all enabled) — called when the search is cleared. */
function resetCategoryFilter() {
  for (const c of Object.keys(state.categoryChecked)) state.categoryChecked[c] = true;
  updateChipStates();
  updateIconsVisibility();
}

/** Enable only one category (click on a search suggestion). */
function selectOnlyCategory(catId) {
  for (const c of Object.keys(state.categoryChecked)) state.categoryChecked[c] = c === catId;
  updateChipStates();
  updateIconsVisibility();
  state.searchFilterActive = true;
}

// ---------------------------------------------------------------------------
// 7a. search — "/" focuses it, dropdown of suggestions for towns (meta.towns) and
//     categories (meta.categories). We don't do item search — a groundwork for a
//     future "expert mode".
// ---------------------------------------------------------------------------
function searchMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { towns: [], cats: [] };
  const towns = ((state.meta && state.meta.towns) || []).filter((tw) => tw.name.toLowerCase().includes(q)).slice(0, 6);
  const categories = (state.meta && state.meta.categories) || {};
  // Match both against the current language's translation and always against en (searching
  // in Latin script is convenient regardless of the active interface language).
  const cats = Object.keys(categories)
    .filter((c) => catLabel(c).toLowerCase().includes(q) || catLabel(c, "en").toLowerCase().includes(q))
    .slice(0, 8);
  return { towns, cats };
}

// Index of the keyboard-highlighted .sug-row (-1 = none). Reset whenever the
// list is rebuilt (renderSuggest) or the dropdown closes (closeSearch) — see
// initSearch()'s keydown handler for ArrowUp/ArrowDown/Enter.
let suggestActiveIndex = -1;

function getSuggestRows() {
  const box = document.getElementById("search-suggest");
  return box ? Array.from(box.querySelectorAll(".sug-row")) : [];
}

/** Move the keyboard highlight to row `idx` (wraps around), scrolling it into view. */
function setSuggestActive(idx) {
  const rows = getSuggestRows();
  if (!rows.length) { suggestActiveIndex = -1; return; }
  suggestActiveIndex = ((idx % rows.length) + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle("active", i === suggestActiveIndex));
  rows[suggestActiveIndex].scrollIntoView({ block: "nearest" });
}

function renderSuggest(query) {
  const box = document.getElementById("search-suggest");
  if (!box) return;
  suggestActiveIndex = -1; // the list is being rebuilt — drop the old highlight
  const { towns, cats } = searchMatches(query);
  if (!towns.length && !cats.length) {
    box.innerHTML = `<div class="sug-empty">${t("search.empty")}</div>`;
    box.classList.remove("hidden");
    return;
  }
  let html = "";
  if (towns.length) {
    html += `<div class="sug-section-label">${t("search.towns")}</div>`;
    html += towns.map((tw) => `<div class="sug-row" data-kind="town" data-x="${tw.x}" data-y="${tw.y}">
        <span class="sug-icon"><svg><use href="#g-flag"/></svg></span>${escapeHtml(tw.name)}
      </div>`).join("");
  }
  if (cats.length) {
    html += `<div class="sug-section-label">${t("search.cats")}</div>`;
    html += cats.map((c) => {
      const st = catStyle(c);
      const label = catLabel(c);
      return `<div class="sug-row" data-kind="cat" data-cat="${escapeHtml(c)}">
          <span class="sug-icon cat" style="background:${st.color}"><svg><use href="#${st.glyph}"/></svg></span>${escapeHtml(label)}
        </div>`;
    }).join("");
  }
  box.innerHTML = html;
  box.classList.remove("hidden");
  box.querySelectorAll(".sug-row").forEach((row) => {
    row.addEventListener("click", () => {
      if (row.dataset.kind === "town") {
        const wx = parseFloat(row.dataset.x);
        const wy = parseFloat(row.dataset.y);
        const targetZoom = Math.max(state.map.getZoom(), state.iconsMinZoom + 3);
        state.map.setView(getCoords().toLatLng(wx, wy), targetZoom);
      } else if (row.dataset.kind === "cat") {
        selectOnlyCategory(row.dataset.cat);
      }
      closeSearch(true);
    });
  });
}

function closeSearch(clearInput) {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-suggest");
  const card = document.querySelector(".search-card");
  suggestActiveIndex = -1;
  if (box) box.classList.add("hidden");
  if (clearInput && input) {
    input.value = "";
    if (card) card.classList.remove("has-query");
  }
  if (input) input.blur();
}

function initSearch() {
  const input = document.getElementById("search-input");
  const card = document.querySelector(".search-card");
  const clearBtn = document.getElementById("search-clear");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value;
    if (card) card.classList.toggle("has-query", q.length > 0);
    if (!q.trim()) {
      document.getElementById("search-suggest").classList.add("hidden");
      if (state.searchFilterActive) {
        resetCategoryFilter();
        state.searchFilterActive = false;
      }
      return;
    }
    renderSuggest(q);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) renderSuggest(input.value);
  });

  input.addEventListener("keydown", (e) => {
    const box = document.getElementById("search-suggest");
    const suggestOpen = !!box && !box.classList.contains("hidden");

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Always prevent default while focus is in the input, so the arrow
      // keys never pan the map underneath — even if the dropdown is closed.
      e.preventDefault();
      if (!suggestOpen) return;
      setSuggestActive(suggestActiveIndex + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter" && suggestOpen) {
      const rows = getSuggestRows();
      if (!rows.length) return;
      e.preventDefault();
      rows[suggestActiveIndex >= 0 ? suggestActiveIndex : 0].click();
      return;
    }
    if (e.key === "Escape") closeSearch(true);
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      closeSearch(true);
      if (state.searchFilterActive) {
        resetCategoryFilter();
        state.searchFilterActive = false;
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (!card || card.contains(e.target)) return;
    document.getElementById("search-suggest").classList.add("hidden");
  });

  // The "/" key focuses search (if the user isn't typing in another field).
  // e.code === "Slash" — the same PHYSICAL key on Cyrillic layouts,
  // where e.key gives "." or "," instead of "/".
  document.addEventListener("keydown", (e) => {
    if ((e.key !== "/" && e.code !== "Slash") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.searchVisible) return; // search is hidden by the toggle — the hotkey is inactive
    const active = document.activeElement;
    const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (typing) return;
    e.preventDefault();
    input.focus();
  });
}

function initOutlinesToggle() {
  const setVisual = initToggleRow("layer-row-outlines", state.showBuildingOutlines, (next) => {
    state.showBuildingOutlines = next;
    updateCells();
  });
  window._setOutlinesVisual = setVisual; // in case of programmatic sync (not needed right now)
}

/** "Basemap: collage" toggle (row hidden in topdown, like layer-row-outlines) —
 *  on = the legacy third-party collage (with IDW correction, no floors, and the
 *  "different map revision" disclaimer back); off (default) = our own pzmap2dzi
 *  render. Switching basemap while in iso mode recreates the map (same pattern as
 *  switchMode()) so the whole DZI/collage tile stack + zoom range is rebuilt
 *  cleanly, while keeping the world position the user was looking at. */
function initBasemapToggle() {
  let setVisual = null;
  setVisual = initToggleRow("layer-row-basemap", state.isoBasemap === "collage", (next) => {
    const wanted = next ? "collage" : "own";
    if (wanted === "own" && !state.renderMeta) { if (setVisual) setVisual(!next); return; } // no own-render data — ignore
    if (wanted === "collage" && !state.isoMeta) { if (setVisual) setVisual(!next); return; } // no collage data — ignore

    let centerWorld = null, zoom = 0;
    if (state.map && state.mode === "iso") {
      centerWorld = getCoords().toWorld(state.map.getCenter());
      zoom = state.map.getZoom();
    }

    state.isoBasemap = wanted;
    store.set("pz.isoBasemap", wanted);

    if (state.map && state.mode === "iso") {
      state.map.remove();
      initMap("iso", { x: centerWorld.x, y: centerWorld.y, zoom });
      writeHash();
    } else {
      updateModeUI(); // keep the disclaimer/floor UI in sync even while in topdown
    }
  });
}

/** "Search" toggle: show/hide the search card (chips move up to take its place). */
function initSearchVisibilityToggle() {
  const apply = () => document.body.classList.toggle("search-hidden", !state.searchVisible);
  apply();
  initToggleRow("layer-row-search", state.searchVisible, (next) => {
    state.searchVisible = next;
    store.set("pz.searchVisible", next);
    apply();
  });
}

/** "Category chips" toggle: show/hide the whole chip row. */
function initChipsVisibilityToggle() {
  const apply = () => {
    document.body.classList.toggle("chips-hidden", !state.chipsVisible);
    scheduleChipsEdgeFade();
  };
  apply();
  initToggleRow("layer-row-chips", state.chipsVisible, (next) => {
    state.chipsVisible = next;
    store.set("pz.chipsVisible", next);
    apply();
  });
}

/** "Chips without labels" toggle: compact chip row mode (icon circles only). */
function initCompactChipsToggle() {
  const apply = () => {
    const box = document.getElementById("chips");
    if (box) box.classList.toggle("compact", !!state.chipsCompact);
    // Compact mode changes every chip's width (labels collapse), which
    // shifts what sits in the edge fade zones — recompute after the
    // max-width transition on .lbl settles.
    setTimeout(scheduleChipsEdgeFade, 250);
  };
  apply();
  initToggleRow("layer-row-compactchips", state.chipsCompact, (next) => {
    state.chipsCompact = next;
    store.set("pz.chipsCompact", next);
    apply();
  });
}

/** Generic binding for a toggle row (.switch) in the "Layers" dropdown panel. */
function initToggleRow(rowId, initial, onToggle) {
  const row = document.getElementById(rowId);
  if (!row) return null;
  const sw = row.querySelector(".switch");
  const setVisual = (v) => { if (sw) sw.classList.toggle("on", !!v); };
  setVisual(initial);
  row.addEventListener("click", () => {
    const next = !(sw && sw.classList.contains("on"));
    setVisual(next);
    onToggle(next);
  });
  return setVisual;
}

/** "Layers" button in the right-hand stack — opens/closes the dropdown panel. */
function initLayersPanel() {
  const btn = document.getElementById("layers-btn");
  const panel = document.getElementById("layers-panel");
  if (!btn || !panel) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
    btn.classList.toggle("seg-on", !panel.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("hidden")) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    panel.classList.add("hidden");
    btn.classList.remove("seg-on");
  });
}

// ---------------------------------------------------------------------------
// 7a. about — "About this map" modal, opened from the row at the bottom of
//     the "Layers" panel. BUILD_INFO is a placeholder for map/build metadata;
//     it's shaped like the fields a future data/meta.json would carry
//     (gameBuild/buildId/dataDate), so pointing this at real data later is a
//     one-line change in updateAboutBuildInfo() below.
// ---------------------------------------------------------------------------
const BUILD_INFO = {
  gameBuild: "Build 42 (unstable)",
  buildId: "24574865",
  dataDate: "2026-08-08",
};

/** Fill in the "Map data" section of the modal from BUILD_INFO (re-run on
 *  every open so a language switch while the modal is closed is picked up). */
function updateAboutBuildInfo() {
  const gameLine = document.getElementById("about-build-line");
  const dateLine = document.getElementById("about-date-line");
  if (gameLine) gameLine.textContent = t("about.gameline", { game: BUILD_INFO.gameBuild, buildId: BUILD_INFO.buildId });
  if (dateLine) dateLine.textContent = t("about.dateline", { date: BUILD_INFO.dataDate });
}

function isAboutModalOpen() {
  const overlay = document.getElementById("about-overlay");
  return !!(overlay && !overlay.classList.contains("hidden"));
}

function openAboutModal() {
  const overlay = document.getElementById("about-overlay");
  if (!overlay) return;
  updateAboutBuildInfo();
  overlay.classList.remove("hidden");
}

function closeAboutModal() {
  const overlay = document.getElementById("about-overlay");
  if (overlay) overlay.classList.add("hidden");
}

/** "About this map" row + modal: opens on click, closes via the ✕ button,
 *  a click on the overlay itself (outside the card), or Escape. */
function initAboutModal() {
  const row = document.getElementById("about-row");
  const overlay = document.getElementById("about-overlay");
  const modal = document.getElementById("about-modal");
  const closeBtn = document.getElementById("about-close");
  if (!row || !overlay || !modal || !closeBtn) return;

  row.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this bubble to the "Layers" panel's outside-click handler
    openAboutModal();
  });
  closeBtn.addEventListener("click", closeAboutModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAboutModal(); // click outside the card = on the overlay itself
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isAboutModalOpen()) closeAboutModal();
  });
}

/** Permanent attribution line (bottom-right corner, see .map-attribution in
 *  style.css). The container is pointer-events:none so plain text passes
 *  clicks through to the map underneath; only the <a> links opt back in via
 *  pointer-events:auto, and here we also stop their clicks from bubbling so
 *  they never nudge/drag the map. */
function initAttribution() {
  const el = document.getElementById("attribution");
  if (!el) return;
  el.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (e) => e.stopPropagation());
    a.addEventListener("mousedown", (e) => e.stopPropagation());
  });
}

// ---------------------------------------------------------------------------
// 8. status — bottom-left status pill: "x · y · cell · floor" (tabular-nums
//    for a fixed-width look as the digits change).
// ---------------------------------------------------------------------------
let lastStatusWorld = null; // {wx, wy} last cursor position — needed so updateFloorUI() can update the pill without mousemove

function fmtNum(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

function updateStatusBar() {
  const el = document.getElementById("status");
  if (!el) return;
  const cellLabel = t("status.cell");
  const floorLabel = t("status.floor");
  let coordsHtml = `x <b>—</b> · y <b>—</b> · ${cellLabel} <b>—, —</b>`;
  if (lastStatusWorld) {
    const { wx, wy } = lastStatusWorld;
    let cellPart = "—, —";
    if (state.meta) {
      const cx = Math.floor(wx / state.meta.cellSize);
      const cy = Math.floor(wy / state.meta.cellSize);
      cellPart = `${cx}, ${cy}`;
    }
    coordsHtml = `x <b>${fmtNum(wx)}</b> · y <b>${fmtNum(wy)}</b> · ${cellLabel} <b>${cellPart}</b>`;
  }
  el.innerHTML = `${coordsHtml} · ${floorLabel} <b>${state.floor}</b>`;
}

/** No-op: the status pill doesn't display a loaded-cell counter; kept as a
 *  hook so existing call sites don't need to special-case loading. */
function updateStatusLoaded() {}

function initStatusBar() {
  updateStatusBar();
  state.map.on("mousemove", (e) => {
    const w = getCoords().toWorld(e.latlng);
    lastStatusWorld = { wx: Math.round(w.x), wy: Math.round(w.y) };
    updateStatusBar();
  });
}

// ---------------------------------------------------------------------------
// 9. hash — #m,x,y,zoom[,px,py] in the URL (m = i|t; x,y — world tiles; zoom —
//    zoom of the CURRENT mode; px,py — optional pinned point ("pin")).
//    Old 3-part hashes (#x,y,zoom) are interpreted as top-down.
//    The 4-part hash keeps working without a pin; the 6-part one carries a pin.
// ---------------------------------------------------------------------------
function parseHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  let parts = h.split(",");

  // The mk:<base64url> segment — markers passed via the link (see encodeMarkersParam).
  // We extract it before parsing coordinates: it can appear as the last part
  // of any hash variant. base64url contains no commas.
  let mk = null;
  parts = parts.filter((p) => {
    if (p.startsWith("mk:")) { mk = p.slice(3); return false; }
    return true;
  });

  if (parts.length === 3) {
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return mk ? { mode: null, mk } : null;
    return { mode: "topdown", x: nums[0], y: nums[1], zoom: nums[2], pin: null, mk };
  }

  if (parts.length === 4 || parts.length === 6) {
    const modeChar = parts[0];
    const nums = parts.slice(1).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return mk ? { mode: null, mk } : null;
    const result = { mode: modeChar === "i" ? "iso" : "topdown", x: nums[0], y: nums[1], zoom: nums[2], pin: null, mk };
    if (parts.length === 6) {
      result.pin = { x: nums[3], y: nums[4] };
    }
    return result;
  }

  return mk ? { mode: null, mk } : null;
}

/* Markers-in-the-link: the marker data lives in the URL itself, so the
   recipient doesn't need to download a file. JSON -> UTF-8 -> base64url. */
function encodeMarkersParam(markers) {
  const compact = markers.map((m) => ({ x: m.x, y: m.y, name: m.name, icon: m.icon }));
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeMarkersParam(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Duplicate = a marker already exists within 2 tiles (name/icon don't matter:
 *  same spot — same find). */
function isDuplicateMarker(m, list) {
  return list.some((e) => Math.abs(e.x - m.x) <= 2 && Math.abs(e.y - m.y) <= 2);
}

/** Accept markers from the hash's mk segment: dedup, prompt, merge, redraw. */
function consumeSharedMarkers(mkStr) {
  if (!mkStr) return;
  let incoming;
  try {
    incoming = decodeMarkersParam(mkStr);
  } catch (e) {
    showToast(t("toast.linkReadFail"));
    return;
  }
  if (!Array.isArray(incoming)) return;
  const valid = incoming
    .filter((m) => m && Number.isFinite(+m.x) && Number.isFinite(+m.y))
    .map((m) => ({
      id: "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      x: +m.x,
      y: +m.y,
      name: typeof m.name === "string" ? m.name.slice(0, 60) : t("markers.default"),
      icon: typeof m.icon === "string" ? m.icon.slice(0, 4) : MARKER_ICONS[0],
    }));
  if (!valid.length) return;

  const fresh = [];
  let dups = 0;
  for (const m of valid) {
    if (isDuplicateMarker(m, state.markers) || isDuplicateMarker(m, fresh)) dups++;
    else fresh.push(m);
  }
  if (!fresh.length) {
    showToast(t("toast.allDup", { n: dups }));
    return;
  }
  const dupNote = dups ? t("confirm.dupNote", { n: dups }) : "";
  if (!confirm(t("confirm.addMarkers", { n: fresh.length, dupNote }))) return;
  state.markers.push(...fresh);
  store.set("pz.markers", state.markers);
  buildMarkersLayer();
  updateMarkersVisibility();
  refreshMarkerPanel();
  showToast(dups
    ? t("toast.addedWithDups", { n: fresh.length, m: dups })
    : t("toast.added", { n: fresh.length }));
}

// A manual hash change (or navigating to a link with a hash on the open page)
// doesn't reload the page — we react to it ourselves.
window.addEventListener("hashchange", () => {
  if (state.hashSuspend || !state.map) return;
  const h = parseHash();
  if (!h) return;

  if (h.mk) consumeSharedMarkers(h.mk);
  if (h.mode === null) return; // the hash contained only markers, no coordinates

  state.pin = h.pin;

  let targetMode = h.mode;
  if (targetMode === "iso" && !state.isoMeta && !state.renderMeta) targetMode = "topdown"; // no iso data at all — don't switch

  if (targetMode !== state.mode) {
    state.map.remove();
    initMap(targetMode, { x: h.x, y: h.y, zoom: h.zoom });
    return;
  }

  state.hashSuspend = true;
  state.map.setView(getCoords().toLatLng(h.x, h.y), h.zoom);
  state.hashSuspend = false;
  updatePinMarker();
});

const writeHash = throttleRaf(() => {
  if (state.hashSuspend || !state.map) return;
  const center = getCoords().toWorld(state.map.getCenter());
  const zoom = state.map.getZoom();
  const m = state.mode === "iso" ? "i" : "t";
  const hash = `#${m},${Math.round(center.x)},${Math.round(center.y)},${zoom}`;
  history.replaceState(null, "", hash);
});

/** Link to a specific world point (6-part hash) for the "Copy link" button. */
function shareLinkFor(wx, wy) {
  const zoom = state.map.getZoom();
  const m = state.mode === "iso" ? "i" : "t";
  const rx = Math.round(wx);
  const ry = Math.round(wy);
  const hash = `#${m},${rx},${ry},${zoom},${rx},${ry}`;
  return location.origin + location.pathname + hash;
}

// ---------------------------------------------------------------------------
// 10. mode — "Isometric" / "Scheme" switcher
// ---------------------------------------------------------------------------
function initModeSwitch() {
  const btn = document.getElementById("mode-cube-btn");
  if (btn) btn.addEventListener("click", () => switchMode(state.mode === "iso" ? "topdown" : "iso"));
}

function updateModeUI() {
  const cubeBtn = document.getElementById("mode-cube-btn");
  if (cubeBtn) {
    cubeBtn.classList.toggle("seg-on", state.mode === "iso");
    cubeBtn.title = state.mode === "iso" ? t("mode.toScheme") : t("mode.toIso");
  }

  const outlinesRow = document.getElementById("layer-row-outlines");
  if (outlinesRow) outlinesRow.style.display = state.mode === "iso" ? "flex" : "none";

  // Basemap switcher only makes sense in iso, and only when both basemaps are
  // actually available (nothing to switch to/from otherwise) — the collage is
  // also fully opt-in via PZMAP_CONFIG.collageAvailable (see init()).
  const basemapRow = document.getElementById("layer-row-basemap");
  if (basemapRow) {
    const collageAvailable = !!(window.PZMAP_CONFIG && window.PZMAP_CONFIG.collageAvailable);
    basemapRow.style.display = (collageAvailable && state.mode === "iso" && state.renderMeta && state.isoMeta) ? "flex" : "none";
  }

  // The "different map revision" disclaimer is about the legacy collage only —
  // our own render is an exact projection, no disclaimer needed for it.
  const disclaimer = document.getElementById("iso-disclaimer");
  if (disclaimer) disclaimer.style.display = (state.mode === "iso" && state.isoBasemap === "collage") ? "block" : "none";

  renderCompass();
  updateFloorUI();
}

/** Compass legend: 4 cardinal directions at the angles of the CURRENT projection.
 *  In the PZ world x grows east, y grows south. In topdown, north is up.
 *  In isometric, px=(x-y), py=(x+y)/2, so the north vector (−y) on screen
 *  = (+1, −0.5): north goes up-and-to-the-right (~63° clockwise from vertical). */
function renderCompass() {
  const el = document.getElementById("compass");
  if (!el) return;
  // Two-letter labels (uk locale) are smaller than one-letter ones (en locale: N/E/S/W) —
  // see #compass .pt.sm in style.css, to avoid overflowing the 48px circle.
  const sizeCls = state.lang === "uk" ? " sm" : "";
  const pts = state.mode === "iso"
    ? [[t("compass.n"), 63.4, "n"], [t("compass.e"), 116.6, ""], [t("compass.s"), 243.4, ""], [t("compass.w"), 296.6, ""]]
    : [[t("compass.n"), 0, "n"], [t("compass.e"), 90, ""], [t("compass.s"), 180, ""], [t("compass.w"), 270, ""]];
  const R = 17; // radius for placing the letters inside the 48px circle
  el.innerHTML = `<span class="dot"></span>` + pts.map(([ch, deg, cls]) => {
    const a = (deg * Math.PI) / 180;
    const x = 50 + (R * Math.sin(a) / 48) * 100;
    const y = 50 - (R * Math.cos(a) / 48) * 100;
    return `<span class="pt ${cls}${sizeCls}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">${escapeHtml(ch)}</span>`;
  }).join("");
}

/** Mode switch on button click: full map recreation. */
function switchMode(newMode) {
  if (!state.map || newMode === state.mode) return;
  if (newMode === "iso" && !state.isoMeta && !state.renderMeta) return; // no iso basemap data at all

  const centerWorld = getCoords().toWorld(state.map.getCenter());
  const curZoom = state.map.getZoom();
  // Zoom correspondence between modes (see isoTdZoomOffset()): step by step ±1,
  // exact equivalence is not required.
  const newZoom = Math.round(
    newMode === "iso" ? curZoom + isoTdZoomOffset() : curZoom - isoTdZoomOffset()
  );

  state.map.remove();
  initMap(newMode, { x: centerWorld.x, y: centerWorld.y, zoom: newZoom });
  writeHash();
}

// ---------------------------------------------------------------------------
// 11. spoilers — spoiler mode: unvisited buildings shown as "?", the category
//     panel is locked, marks are stored in localStorage 'pz.revealed'.
// ---------------------------------------------------------------------------
function openSpoilerPopup(b) {
  const html = `<div class="popup-title">${t("spoiler.title")}</div>
    <div class="popup-actions">
      <button data-pz-action="reveal-building" data-id="${escapeHtml(b.id)}">${t("spoiler.mark")}</button>
    </div>`;
  L.popup({ maxWidth: 240 })
    .setLatLng(getCoords().toLatLng(b.x, b.y))
    .setContent(html)
    .openOn(state.map);
}

function revealBuilding(id) {
  if (!id || state.revealedSet.has(id)) return;
  state.revealedSet.add(id);
  store.set("pz.revealed", [...state.revealedSet]);
  if (state.map) state.map.closePopup();
  buildIconsLayers();
}

function setSpoilers(on) {
  state.spoilersOn = !!on;
  store.set("pz.spoilers", state.spoilersOn);
  buildIconsLayers(); // rebuilds the icons
  updateSpoilerUI(); // syncs the toggle in the "Layers" panel + the chip lock
}

function resetRevealed() {
  state.revealedSet = new Set();
  store.set("pz.revealed", []);
  buildIconsLayers();
}

function updateSpoilerUI() {
  const row = document.getElementById("layer-row-spoilers");
  if (row) {
    const sw = row.querySelector(".switch");
    if (sw) sw.classList.toggle("on", state.spoilersOn);
  }

  const chips = document.getElementById("chips");
  if (chips) chips.classList.toggle("locked", state.spoilersOn);

  const resetBtn = document.getElementById("spoilers-reset");
  const showAllBtn = document.getElementById("spoilers-showall");
  if (resetBtn) resetBtn.style.display = state.spoilersOn ? "" : "none";
  if (showAllBtn) showAllBtn.style.display = state.spoilersOn ? "" : "none";
}

function initSpoilerControls() {
  const row = document.getElementById("layer-row-spoilers");
  if (row) {
    row.addEventListener("click", () => setSpoilers(!state.spoilersOn));
  }

  const showAllBtn = document.getElementById("spoilers-showall");
  if (showAllBtn) showAllBtn.addEventListener("click", () => setSpoilers(false));

  const resetBtn = document.getElementById("spoilers-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (confirm(t("spoiler.confirmReset"))) resetRevealed();
    });
  }

  updateSpoilerUI();
}

// ---------------------------------------------------------------------------
// 12. share — click on an empty map spot -> popup with coordinates,
//     "Copy link" / "Place marker" buttons, plus rendering of the
//     pinned point (red "X") that came in via the link hash.
// ---------------------------------------------------------------------------
let sharePopupRef = null;

function onMapClick(e) {
  // A right click while the "+ Add" one-shot mode is active just cancels it —
  // it does not also open the coordinates popup.
  if (state.addingMarker) { exitAddingMarkerMode(); return; }
  const w = getCoords().toWorld(e.latlng);
  sharePopupRef = L.popup({ maxWidth: 260 })
    .setLatLng(e.latlng)
    .setContent(buildSharePopupHtml(w.x, w.y))
    .openOn(state.map);
}

function buildSharePopupHtml(wx, wy) {
  const rx = Math.round(wx);
  const ry = Math.round(wy);
  return `<div class="popup-title">x: ${rx}, y: ${ry}</div>
    <div class="popup-actions">
      <button data-pz-action="copy-link" data-x="${wx}" data-y="${wy}">${t("share.copyLink")}</button>
      <button data-pz-action="place-marker" data-x="${wx}" data-y="${wy}">${t("share.placeMarker")}</button>
    </div>`;
}

function buildMarkerFormHtml(wx, wy) {
  const options = MARKER_ICONS.map((ic) => `<option value="${ic}">${ic}</option>`).join("");
  return `<div class="popup-title">${t("markerForm.title")}</div>
    <div class="marker-form">
      <input type="text" class="marker-name-input" placeholder="${escapeHtml(t("markerForm.namePlaceholder"))}" maxlength="60">
      <select class="marker-icon-select">${options}</select>
      <div class="popup-actions">
        <button data-pz-action="save-marker" data-x="${wx}" data-y="${wy}">${t("markerForm.save")}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 12a. add-marker mode — one-shot mode entered via the bottom pill's
//      "+ Add" button: the next LEFT click on the map opens the same
//      name+icon form as the share popup (buildMarkerFormHtml) right at the
//      clicked point, instead of whatever building/icon/marker is under the
//      cursor. Escape or a right click cancels it. See initAddingMarkerMode()
//      for the click interception (a capture-phase listener on #map, so it
//      runs before Leaflet's own per-layer click/popup handlers).
// ---------------------------------------------------------------------------
function enterAddingMarkerMode() {
  if (state.addingMarker) return;
  state.addingMarker = true;
  document.body.classList.add("adding-marker");
  showToast(t("markers.addHint"));
}

function exitAddingMarkerMode() {
  if (!state.addingMarker) return;
  state.addingMarker = false;
  document.body.classList.remove("adding-marker");
}

/** Capture-phase click on #map: while add-marker mode is active, swallow the
 *  click before it reaches Leaflet's own layer handlers (buildings, rooms,
 *  icons and custom markers all open their own popup on click) and open the
 *  marker-creation form at the clicked point instead. */
function initAddingMarkerMode() {
  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.addEventListener("click", (e) => {
      if (!state.addingMarker) return;
      e.stopPropagation();
      e.preventDefault();
      const latlng = state.map.mouseEventToLatLng(e);
      const w = getCoords().toWorld(latlng);
      exitAddingMarkerMode();
      L.popup({ maxWidth: 260 })
        .setLatLng(latlng)
        .setContent(buildMarkerFormHtml(w.x, w.y))
        .openOn(state.map);
    }, true);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.addingMarker) exitAddingMarkerMode();
  });
}

/** Unified click delegation for buttons inside popups (data-pz-action=...). */
function initActionDelegation() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pz-action]");
    if (!btn) return;
    handlePzAction(btn.getAttribute("data-pz-action"), btn);
  });
}

function handlePzAction(action, btn) {
  switch (action) {
    case "copy-link": {
      const wx = parseFloat(btn.dataset.x);
      const wy = parseFloat(btn.dataset.y);
      const url = shareLinkFor(wx, wy);
      const original = btn.textContent;
      copyTextToClipboard(url).then((ok) => {
        btn.textContent = ok ? t("share.copied") : t("share.copyFail");
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
      break;
    }
    case "place-marker": {
      const wx = parseFloat(btn.dataset.x);
      const wy = parseFloat(btn.dataset.y);
      if (sharePopupRef) sharePopupRef.setContent(buildMarkerFormHtml(wx, wy));
      break;
    }
    case "save-marker": {
      const container = btn.closest(".leaflet-popup-content");
      const nameInput = container && container.querySelector(".marker-name-input");
      const iconSelect = container && container.querySelector(".marker-icon-select");
      const name = ((nameInput && nameInput.value) || "").trim().slice(0, 60) || t("markers.default");
      const icon = (iconSelect && iconSelect.value) || MARKER_ICONS[0];
      const wx = parseFloat(btn.dataset.x);
      const wy = parseFloat(btn.dataset.y);
      addCustomMarker(wx, wy, name, icon);
      if (state.map) state.map.closePopup();
      break;
    }
    case "delete-marker": {
      const marker = state.markers.find((m) => m.id === btn.dataset.id);
      const name = marker ? marker.name : t("markers.default");
      if (!confirm(t("markers.confirmDelete", { name }))) break;
      deleteCustomMarker(btn.dataset.id);
      break;
    }
    case "reveal-building": {
      revealBuilding(btn.dataset.id);
      break;
    }
  }
}

/** Red semi-transparent "X" at the pinned (shared) point. */
function updatePinMarker() {
  if (!state.pinLayer) return;
  state.pinLayer.clearLayers();
  if (!state.pin) return;
  const icon = L.divIcon({
    className: "poi-wrap",
    html: `<span class="pin-beacon"><span class="pin-wave"></span><span class="pin-wave w2"></span><span class="pin-core"><svg><use href="#g-x"/></svg></span></span>`,
    iconSize: [56, 56],
    iconAnchor: [28, 28],
  });
  const marker = L.marker(getCoords().toLatLng(state.pin.x, state.pin.y), {
    icon,
    interactive: false,
    keyboard: false,
  });
  state.pinLayer.addLayer(marker);
}

// ---------------------------------------------------------------------------
// 13. markers — custom user markers (localStorage 'pz.markers').
//     Rendered on top of everything in both modes; "My markers" checkbox.
// ---------------------------------------------------------------------------
function buildCustomMarkerPopupHtml(m) {
  return `<div class="popup-title">${escapeHtml(m.icon)} ${escapeHtml(m.name)}</div>
    <div class="popup-actions">
      <button data-pz-action="delete-marker" data-id="${escapeHtml(m.id)}">${t("markers.delete")}</button>
    </div>`;
}

function buildMarkersLayer() {
  // buildMarkersLayer() is called on every add/delete/import (it's the single
  // rebuild entry point — see refreshMarkerPanel()'s comment) and always
  // replaces state.markersLayer with a brand-new layer group. Without
  // detaching the previous group from the map first, its old markers
  // (including ones just deleted) would stay stuck on the map forever,
  // orphaned once state.markersLayer stops pointing at them.
  if (state.markersLayer && state.map && state.map.hasLayer(state.markersLayer)) {
    state.map.removeLayer(state.markersLayer);
  }
  state.markersLayer = L.layerGroup();
  const cf = getCoords();
  for (const m of state.markers) {
    const icon = L.divIcon({
      className: "poi-wrap",
      html: `<span class="poi-badge custom">${escapeHtml(m.icon || MARKER_ICONS[0])}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const marker = L.marker(cf.toLatLng(m.x, m.y), {
      icon,
      interactive: true,
      keyboard: false,
      bubblingMouseEvents: false,
    });
    marker.bindPopup(() => buildCustomMarkerPopupHtml(m), { maxWidth: 240 });
    state.markersLayer.addLayer(marker);
  }
  refreshMarkerPanel();
}

function updateMarkersVisibility() {
  if (!state.markersLayer || !state.map) return;
  const has = state.map.hasLayer(state.markersLayer);
  const wanted = state.markersVisible && state.allMarkersVisible;
  if (wanted && !has) state.markersLayer.addTo(state.map);
  if (!wanted && has) state.map.removeLayer(state.markersLayer);
}

function addCustomMarker(x, y, name, icon) {
  const m = {
    id: "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    x, y, name, icon,
  };
  state.markers.push(m);
  store.set("pz.markers", state.markers);
  buildMarkersLayer();
  updateMarkersVisibility();
}

function deleteCustomMarker(id) {
  state.markers = state.markers.filter((m) => m.id !== id);
  store.set("pz.markers", state.markers);
  if (state.map) state.map.closePopup();
  buildMarkersLayer();
  updateMarkersVisibility();
}

/** Master toggle "Markers on map": hides category icons/"?",
 *  custom markers and the "X" pin all at once. Doesn't touch town/street labels. */
function updateAllMarkersVisibility() {
  updateIconsVisibility();
  updateMarkersVisibility();
  if (state.pinLayer) {
    const has = state.map.hasLayer(state.pinLayer);
    if (state.allMarkersVisible && !has) state.pinLayer.addTo(state.map);
    if (!state.allMarkersVisible && has) state.map.removeLayer(state.pinLayer);
  }
}

function initAllMarkersToggle() {
  initToggleRow("layer-row-allmarkers", state.allMarkersVisible, (next) => {
    state.allMarkersVisible = next;
    store.set("pz.allMarkers", state.allMarkersVisible);
    updateAllMarkersVisibility();
  });
}

// ---------------------------------------------------------------------------
// 13a. mk-panel — bottom dark "Markers · N" pill + expandable
//      card with the list of actual markers (state.markers), a "Show"
//      toggle (state.markersVisible), and Add/Import/Export buttons.
// ---------------------------------------------------------------------------
/** Toast notification text at the bottom of the screen (reuses the frost-dark style). */
function showToast(msg, ms) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  root.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast frost-dark";
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms || 2600);
}

/** The marker list in the expanded panel + the counter on the pill. Called from
 *  buildMarkersLayer() (the single entry point for add/delete/import/initMap). */
function refreshMarkerPanel() {
  const countEl = document.getElementById("mk-count");
  if (countEl) countEl.textContent = String(state.markers.length);

  const list = document.getElementById("mk-list");
  if (!list) return;

  if (!state.markers.length) {
    list.innerHTML = `<div class="mk-empty">${t("markers.emptyList")}</div>`;
    return;
  }

  const showOnMapTitle = escapeHtml(t("markers.showOnMap"));
  const deleteTitle = escapeHtml(t("markers.delete"));
  list.innerHTML = state.markers.map((m) => `
    <div class="mk-row" data-id="${escapeHtml(m.id)}" title="${showOnMapTitle}">
      <span class="em-badge">${escapeHtml(m.icon || MARKER_ICONS[0])}</span>
      <span class="t"><b>${escapeHtml(m.name)}</b><i>x ${fmtNum(m.x)} · y ${fmtNum(m.y)}</i></span>
      <button class="del" data-pz-action="delete-marker" data-id="${escapeHtml(m.id)}" title="${deleteTitle}"><svg><use href="#g-x"/></svg></button>
    </div>`).join("");

  list.querySelectorAll(".mk-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return; // deletion is handled via data-pz-action delegation
      const m = state.markers.find((mm) => mm.id === row.dataset.id);
      if (m) flyToMarker(m);
    });
  });
}

/** Fly to a marker (the current zoom is preserved). */
function flyToMarker(m) {
  state.map.setView(getCoords().toLatLng(m.x, m.y), state.map.getZoom());
}

function initMarkerPanel() {
  const pill = document.getElementById("mk-pill");
  const panel = document.getElementById("mk-panel");
  if (pill && panel) {
    pill.addEventListener("click", () => {
      panel.classList.toggle("hidden");
      pill.classList.toggle("open");
    });
  }

  const vis = document.getElementById("mk-vis");
  if (vis) {
    const sw = vis.querySelector(".switch");
    if (sw) sw.classList.toggle("on", state.markersVisible);
    vis.addEventListener("click", () => {
      state.markersVisible = !state.markersVisible;
      if (sw) sw.classList.toggle("on", state.markersVisible);
      updateMarkersVisibility();
    });
  }

  const addBtn = document.getElementById("mk-add");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (panel) panel.classList.add("hidden");
      if (pill) pill.classList.remove("open");
      enterAddingMarkerMode();
    });
  }

  const shareBtn = document.getElementById("mk-share");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      if (!state.markers.length) {
        showToast(t("markers.noneToShare"));
        return;
      }
      const center = getCoords().toWorld(state.map.getCenter());
      const m = state.mode === "iso" ? "i" : "t";
      const url = `${location.origin}${location.pathname}#${m},${Math.round(center.x)},${Math.round(center.y)},${state.map.getZoom()},mk:${encodeMarkersParam(state.markers)}`;
      const ok = await copyTextToClipboard(url);
      showToast(ok
        ? t("toast.linkCopied", { n: state.markers.length })
        : t("toast.linkCopyFail"));
    });
  }

  const exportBtn = document.getElementById("mk-export");
  const importBtn = document.getElementById("mk-import");
  const importInput = document.getElementById("mk-import-input");
  if (exportBtn) exportBtn.addEventListener("click", doExport);
  if (importBtn && importInput) {
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      if (file) doImportFile(file);
      importInput.value = "";
    });
  }

  refreshMarkerPanel();
}

// ---------------------------------------------------------------------------
// 14. streets — street names (data/streets.json).
//     Data is loaded once (eagerly, see init()); lines/labels are
//     rebuilt on every initMap() (latLng depends on the mode).
//     In topdown, lines are ALWAYS drawn at a sufficient zoom (Apple Maps
//     style), the "Street names" checkbox there only controls the labels.
//     In iso mode, the "Street names" checkbox controls both lines and labels
//     (the iso basemap is an image, the vector streets are an optional overlay
//     on top of it). Labels — only at close zoom, for streets with their
//     midpoint in the viewport, ~80 max.
// ---------------------------------------------------------------------------
async function loadStreetsData() {
  if (state.streetsRaw) return;
  const data = await fetchJson(`${appBase()}data/streets.json`);
  if (!data || !Array.isArray(data.streets)) {
    state.streetsRaw = [];
    return;
  }
  state.streetsRaw = data.streets;
  buildStreetsLineLayer();
  if (state.map) updateStreetsVisibility();
}

/** Street line width in pixels at the current zoom, from the world width s.w. */
function streetWeightPx(w, zoom) {
  const ref = state.mode === "iso" ? isoThreshold(ISO_CELLS_MIN_ZOOM_COLLAGE) : (state.worldZoom + STREETS_TOPDOWN_MIN_ZOOM_OFFSET);
  const rel = Math.max(0, zoom - ref);
  const scale = Math.pow(1.4, rel);
  return clamp(((w || 6) / 8) * 2.2 * scale, 1.4, 22);
}

/** Rebuild street lines for the current mode (latLng) — called on
 *  initMap()/after data loads. The geometry is built once; a subsequent
 *  theme/zoom change updates the existing polylines via setStyle
 *  (updateStreetsTheme / updateStreetLineWidths) without recomputing coordinates. */
function buildStreetsLineLayer() {
  state.streetsLinesLayer = L.layerGroup();
  state.streetLineEntries = [];
  const raw = state.streetsRaw;
  if (!raw) return;
  const cf = getCoords();
  const th = currentTheme();
  const topdown = state.mode === "topdown";
  for (const s of raw) {
    if (!Array.isArray(s.pts) || s.pts.length < 2) continue;
    const latlngs = s.pts.map(([x, y]) => cf.toLatLng(x, y));
    if (topdown) {
      // Outline (wider, below) + a white (dark-gray in the dark theme) line on top.
      const outline = L.polyline(latlngs, {
        renderer: state.renderer,
        color: th.streetStroke,
        weight: 4,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      });
      const main = L.polyline(latlngs, {
        renderer: state.renderer,
        color: th.streetFill,
        weight: 2,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      });
      state.streetsLinesLayer.addLayer(outline);
      state.streetsLinesLayer.addLayer(main);
      state.streetLineEntries.push({ w: s.w, outline, main });
    } else {
      // iso: a thin neutral overlay line on top of the collage (no theme/width changes).
      const line = L.polyline(latlngs, {
        renderer: state.renderer,
        color: "#9aa0aa",
        weight: 1,
        opacity: 0.45,
        interactive: false,
      });
      state.streetsLinesLayer.addLayer(line);
    }
  }
  updateStreetLineWidths();
}

/** Update street line widths (topdown) for the current zoom — a cheap setStyle. */
function updateStreetLineWidths() {
  if (!state.map || state.mode !== "topdown" || !state.streetLineEntries || !state.streetLineEntries.length) return;
  const zoom = state.map.getZoom();
  // At the moment the layer is first built (buildStreetsLineLayer is called before
  // map.setView in initMap) the map has no view yet -> getZoom() === undefined;
  // skip it, the actual width will be set by the first onMapChange() after setView.
  if (!Number.isFinite(zoom)) return;
  for (const e of state.streetLineEntries) {
    const mw = streetWeightPx(e.w, zoom);
    e.main.setStyle({ weight: mw });
    e.outline.setStyle({ weight: mw + 3 });
  }
}

/** Update street line colors (topdown) for the current theme — a cheap setStyle,
 *  without recreating the geometry (called from redrawForTheme()). */
function updateStreetsTheme() {
  if (!state.streetLineEntries || !state.streetLineEntries.length) return;
  const th = currentTheme();
  for (const e of state.streetLineEntries) {
    e.outline.setStyle({ color: th.streetStroke });
    e.main.setStyle({ color: th.streetFill });
  }
}

function streetLabelZoomOk(zoom) {
  if (state.mode === "iso") return zoom >= isoThreshold(ISO_STREET_LABEL_MIN_ZOOM_COLLAGE);
  return zoom >= state.worldZoom + 6;
}

/** Middle segment of a street polyline (by point index), for the label and rotation angle. */
function pickMidSegment(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let i = Math.floor((n - 1) / 2);
  if (i < 0) i = 0;
  if (i >= n - 1) i = n - 2;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  return { p1, p2, mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
}

function updateStreetLabels() {
  if (!state.streetLabelsLayer) return;
  state.streetLabelsLayer.clearLayers();
  if (!state.streetsVisible || !state.streetsRaw || !state.streetsRaw.length) return;
  const zoom = state.map.getZoom();
  if (!streetLabelZoomOk(zoom)) return;

  const bounds = state.map.getBounds();
  const cf = getCoords();
  const candidates = [];
  for (const s of state.streetsRaw) {
    const seg = pickMidSegment(s.pts);
    if (!seg) continue;
    const midLatLng = cf.toLatLng(seg.mid[0], seg.mid[1]);
    if (!bounds.contains(midLatLng)) continue;
    candidates.push({ s, seg, midLatLng });
  }

  const trimmed = candidates.slice(0, 80);
  for (const c of trimmed) {
    const p1px = state.map.latLngToLayerPoint(cf.toLatLng(c.seg.p1[0], c.seg.p1[1]));
    const p2px = state.map.latLngToLayerPoint(cf.toLatLng(c.seg.p2[0], c.seg.p2[1]));
    let angle = (Math.atan2(p2px.y - p1px.y, p2px.x - p1px.x) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    const icon = L.divIcon({
      className: "street-label",
      html: `<span style="transform:rotate(${angle.toFixed(1)}deg)">${escapeHtml(c.s.n)}</span>`,
      iconSize: null,
      iconAnchor: [0, 0],
    });
    const marker = L.marker(c.midLatLng, { icon, interactive: false, keyboard: false });
    state.streetLabelsLayer.addLayer(marker);
  }
}

function updateStreetsVisibility() {
  if (!state.streetsLinesLayer || !state.map) return;
  const zoom = state.map.getZoom();
  const hasData = !!(state.streetsRaw && state.streetsRaw.length);
  const has = state.map.hasLayer(state.streetsLinesLayer);
  // topdown: lines are always visible at a sufficient zoom (the checkbox here — labels only);
  // iso: lines follow the checkbox too (see loadStreetsData()'s comment above).
  const wanted = state.mode === "topdown"
    ? hasData && zoom >= state.worldZoom + STREETS_TOPDOWN_MIN_ZOOM_OFFSET
    : state.streetsVisible && hasData;
  if (wanted && !has) state.streetsLinesLayer.addTo(state.map);
  if (!wanted && has) state.map.removeLayer(state.streetsLinesLayer);
  if (wanted && state.mode === "topdown") updateStreetLineWidths();
  updateStreetLabels();
}

function initStreetsToggle() {
  initToggleRow("layer-row-streets", state.streetsVisible, async (next) => {
    state.streetsVisible = next;
    if (!state.streetsRaw) {
      await loadStreetsData(); // this rebuilds the lines and updates visibility itself
    }
    updateStreetsVisibility();
  });
}

// ---------------------------------------------------------------------------
// 14b. basemap — water/forest for the topdown basemap ("Scheme"), Apple Maps style.
//     Sources: data/worldmap_water.json, data/worldmap_forest.json,
//     format {"features":[{"t":.., "pts":[[x,y],...]}]}. The files might not
//     exist on disk yet (prepared separately) — fetchJson silently returns null on 404,
//     the layer just stays empty in that case.
//     Drawn ONLY in topdown (the iso basemap is a photorealistic collage, we don't
//     touch it), with a separate canvas renderer in its own pane with a lower
//     zIndex than overlayPane (where buildings/streets/icons live) — this guarantees
//     "water and forest below buildings" regardless of layer add order.
// ---------------------------------------------------------------------------
async function loadWaterData() {
  if (state.waterRaw) return;
  const data = await fetchJson(`${appBase()}data/worldmap_water.json`);
  state.waterRaw = (data && Array.isArray(data.features)) ? data.features : [];
  if (state.map && state.mode === "topdown") {
    buildWaterLayer();
    attachBasemapLayer(state.waterLayer);
  }
}

async function loadForestData() {
  if (state.forestRaw) return;
  const data = await fetchJson(`${appBase()}data/worldmap_forest.json`);
  state.forestRaw = (data && Array.isArray(data.features)) ? data.features : [];
  if (state.map && state.mode === "topdown") {
    buildForestLayer();
    attachBasemapLayer(state.forestLayer);
  }
}

/** World polygon points -> latLng (topdown only, coords directly). */
function basemapPolygonLatLngs(pts) {
  return pts.map(([x, y]) => coords.toLatLng(x, y));
}

function buildWaterLayer() {
  state.waterLayer = L.layerGroup();
  state.waterPolygons = [];
  const th = currentTheme();
  for (const f of state.waterRaw || []) {
    if (!f || !Array.isArray(f.pts) || f.pts.length < 3) continue;
    const poly = L.polygon(basemapPolygonLatLngs(f.pts), {
      renderer: state.basemapRenderer,
      stroke: false,
      fillColor: th.water,
      fillOpacity: 1,
      interactive: false,
    });
    state.waterPolygons.push(poly);
    state.waterLayer.addLayer(poly);
  }
}

function buildForestLayer() {
  state.forestLayer = L.layerGroup();
  state.forestPolygons = [];
  const th = currentTheme();
  for (const f of state.forestRaw || []) {
    if (!f || !Array.isArray(f.pts) || f.pts.length < 3) continue;
    const poly = L.polygon(basemapPolygonLatLngs(f.pts), {
      renderer: state.basemapRenderer,
      stroke: false,
      fillColor: th.forest,
      fillOpacity: 1,
      interactive: false,
    });
    state.forestPolygons.push(poly);
    state.forestLayer.addLayer(poly);
  }
}

function attachBasemapLayer(layer) {
  if (layer && state.map && !state.map.hasLayer(layer)) layer.addTo(state.map);
}

/** Update water/forest colors for the current theme — a cheap setStyle (see redrawForTheme()). */
function updateBasemapTheme() {
  const th = currentTheme();
  for (const p of state.waterPolygons || []) p.setStyle({ fillColor: th.water });
  for (const p of state.forestPolygons || []) p.setStyle({ fillColor: th.forest });
}

// ---------------------------------------------------------------------------
// 15. floors — floor selector (▲ / number / ▼), range -1..7, default 0.
//     Topdown: changes which floor's rooms are drawn (unchanged).
//     Iso "own": also (re)stacks the DZI floor tile layers — see updateIsoTileStack().
//     Iso "collage": disabled (that basemap has no floor data).
// ---------------------------------------------------------------------------

/** DZI layer indices that should be mounted for a given floor, mirroring
 *  render/gen/html/pzmap/map.js Map.setBaseLayer():
 *    floor >= 0  -> layer0 (ground) .. layer{floor}, stacked
 *    floor < 0   -> their viewer stacks EVERY layer from minlayer up through
 *                   `floor` (no ground layer at all — basements are viewed in
 *                   isolation). That can mean 30+ simultaneous DZI pyramids;
 *                   we cap it at MAX_ISO_TILE_LAYERS and keep the levels
 *                   closest to the viewed floor (deepest relevant content). */
const MAX_ISO_TILE_LAYERS = 10;
function isoWantedLayers(floor) {
  const m = state.renderMeta;
  const layers = [];
  if (floor >= 0) {
    for (let i = 0; i <= floor && i < m.maxlayer; i++) layers.push(i);
  } else {
    const lo = Math.max(m.minlayer, floor - (MAX_ISO_TILE_LAYERS - 1));
    for (let i = lo; i <= floor; i++) layers.push(i);
  }
  return layers;
}

/** Mount/unmount DZI floor layers so exactly isoWantedLayers(state.floor) is on
 *  the map — only the delta (added/removed layers) touches the DOM/network. */
function updateIsoTileStack() {
  if (!state.map || state.mode !== "iso" || state.isoBasemap !== "own" || !state.renderMeta) return;
  if (!state.isoLayers) state.isoLayers = new Map();
  const wanted = new Set(isoWantedLayers(state.floor));

  // Blurry backdrop safety net: a single low-native-zoom layer0 DZI layer
  // mounted once beneath the sharp floor stack, and never unmounted on floor
  // changes (only a full map recreation, e.g. mode/basemap switch, drops it).
  // Leaflet upscales its coarse tiles to fill gaps while the matching sharp
  // tiles are still loading, instead of leaving blank holes. See "3" in the
  // tile-smoothness pass this function is part of.
  if (!state.isoBackdropLayer) {
    const backdropNativeZoom = Math.max(0, state.renderMeta.maxNativeZoom - 5);
    state.isoBackdropLayer = new DziTileLayer("", {
      pzBase: state.renderMeta.basePath,
      pzLayer: 0,
      maxNativeZoom: backdropNativeZoom,
      maxZoom: state.renderMeta.maxZoom,
      bounds: coordsIso.imageBounds(),
      zIndex: 900, // below the sharp stack's 1000+idx
      keepBuffer: 2,
      updateWhenIdle: false,
      updateWhenZooming: true,
    });
    state.isoBackdropLayer.addTo(state.map);
  }

  for (const [idx, layer] of state.isoLayers) {
    if (!wanted.has(idx)) {
      state.map.removeLayer(layer);
      state.isoLayers.delete(idx);
    }
  }
  for (const idx of wanted) {
    if (state.isoLayers.has(idx)) continue;
    const layer = new DziTileLayer("", {
      pzBase: state.renderMeta.basePath,
      pzLayer: idx,
      maxNativeZoom: state.renderMeta.maxNativeZoom,
      maxZoom: state.renderMeta.maxZoom,
      minZoom: 0,
      bounds: coordsIso.imageBounds(),
      zIndex: 1000 + idx, // keeps stacking order correct across incremental add/remove
      keepBuffer: 4,
      updateWhenIdle: false,
      updateWhenZooming: true,
    });
    layer.addTo(state.map);
    state.isoLayers.set(idx, layer);
  }
}

function setFloor(n) {
  const clamped = clamp(n, -1, 7);
  if (clamped === state.floor) return;
  state.floor = clamped;
  updateFloorUI();
  if (state.mode === "topdown") {
    refreshCellsForFloor();
  } else if (state.mode === "iso" && state.isoBasemap === "own") {
    updateIsoTileStack();
    refreshCellsForFloor(); // room outlines, if "Building outlines" is on — see effectiveFloor()
  }
}

function updateFloorUI() {
  const label = document.getElementById("floor-value");
  const up = document.getElementById("floor-up");
  const down = document.getElementById("floor-down");
  const panel = document.getElementById("floor-selector");
  if (!label || !up || !down) return;

  label.textContent = String(state.floor);
  const floorsDisabled = state.mode === "iso" && state.isoBasemap === "collage";
  up.disabled = floorsDisabled || state.floor >= 7;
  down.disabled = floorsDisabled || state.floor <= -1;

  if (panel) {
    panel.classList.toggle("disabled", floorsDisabled);
    panel.title = floorsDisabled ? t("floor.isoHint") : "";
  }
  updateStatusBar();
}

/** +/- buttons in the top-right stack (the first ctrl-stack group) —
 *  duplicate the built-in Leaflet zoom-control, which is hidden via CSS
 *  (.leaflet-control-zoom{display:none}) in favor of the "glass" UI.
 *  Bound once (the buttons aren't recreated on mode/map changes),
 *  state.map is read at click time — always current. */
function initZoomButtons() {
  const inBtn = document.getElementById("zoom-in-btn");
  const outBtn = document.getElementById("zoom-out-btn");
  if (inBtn) inBtn.addEventListener("click", () => state.map && state.map.zoomIn());
  if (outBtn) outBtn.addEventListener("click", () => state.map && state.map.zoomOut());
}

function initFloorSelector() {
  const up = document.getElementById("floor-up");
  const down = document.getElementById("floor-down");
  if (up) up.addEventListener("click", () => setFloor(state.floor + 1));
  if (down) down.addEventListener("click", () => setFloor(state.floor - 1));
  updateFloorUI();
}

// ---------------------------------------------------------------------------
// 16. save — save export/import (markers, marks, spoilers, floor).
// ---------------------------------------------------------------------------
function doExport() {
  const payload = {
    version: 1,
    markers: state.markers,
    revealed: [...state.revealedSet],
    spoilers: state.spoilersOn,
    floor: state.floor,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pzmap-save.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importSaveData(data) {
  if (!data || typeof data !== "object") return;

  if (Array.isArray(data.markers)) {
    const existingIds = new Set(state.markers.map((m) => m.id));
    let importedDups = 0;
    for (const m of data.markers) {
      if (!m || typeof m !== "object") continue;
      if (typeof m.x !== "number" || typeof m.y !== "number") continue;
      if (isDuplicateMarker(m, state.markers)) { importedDups++; continue; }
      let id = typeof m.id === "string" && m.id ? m.id : null;
      if (!id || existingIds.has(id)) {
        id = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      }
      existingIds.add(id);
      state.markers.push({
        id,
        x: m.x,
        y: m.y,
        name: typeof m.name === "string" ? m.name.slice(0, 60) : t("markers.default"),
        icon: typeof m.icon === "string" ? m.icon : MARKER_ICONS[0],
      });
    }
    store.set("pz.markers", state.markers);
    if (importedDups) showToast(t("toast.importDup", { n: importedDups }));
  }

  if (Array.isArray(data.revealed)) {
    for (const id of data.revealed) {
      if (typeof id === "string") state.revealedSet.add(id);
    }
    store.set("pz.revealed", [...state.revealedSet]);
  }

  if (typeof data.spoilers === "boolean") {
    state.spoilersOn = data.spoilers;
    store.set("pz.spoilers", state.spoilersOn);
  }

  if (typeof data.floor === "number" && Number.isFinite(data.floor)) {
    state.floor = clamp(Math.round(data.floor), -1, 7);
  }

  updateFloorUI();
  buildMarkersLayer();
  updateMarkersVisibility();
  buildIconsLayers(); // accounts for spoilers/revealed, also updates the filter panel
  if (state.mode === "topdown") {
    refreshCellsForFloor();
  } else if (state.mode === "iso" && state.isoBasemap === "own") {
    updateIsoTileStack();
    refreshCellsForFloor();
  }
}

function doImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(String(reader.result));
    } catch (e) {
      alert(t("import.badJson"));
      return;
    }
    importSaveData(data);
  };
  reader.onerror = () => alert(t("import.readFail"));
  reader.readAsText(file);
}

// Export/import are now triggered from the bottom markers pill (#mk-export/
// #mk-import/#mk-import-input) — see initMarkerPanel() in section 13a.

// ---------------------------------------------------------------------------
// 16b. onboarding — a short first-visit tour driven by ONBOARDING_STEPS
//     (localStorage 'pz.onboarded'). Each step with a `target` selector gets
//     pulsing rings (#onboarding-overlay) + a callout (#onboarding-callout)
//     pointing at it, a step counter ("1/3") and a small skip (✕) button; the
//     final step (target: null) is a centered plaque instead. Both the
//     overlay and the callout are position:fixed with coordinates computed
//     from the target's getBoundingClientRect(), since e.g. #layers-btn sits
//     inside .ctrl-group{overflow:hidden}, where the pulsing rings would
//     otherwise be clipped. A step advances on: a click on its target, any
//     click outside the callout, or a per-step timeout (20s for target
//     steps, 8s for the final one). Skipping or finishing the last step both
//     mark pz.onboarded='1' — the tour is then never shown again.
//     A map drag (pointerdown -> move -> mouseup) also fires a "click" on
//     mouseup, which would otherwise be mistaken for an outside click and
//     skip a step — see onOnboardingOutsideClick's drag-distance check.
// ---------------------------------------------------------------------------
const ONBOARDING_KEY = "pz.onboarded";
const ONBOARDING_STEP_MS = 20000;
const ONBOARDING_FINAL_MS = 8000;
const ONBOARDING_DRAG_THRESHOLD_PX = 6;
const ONBOARDING_STEPS = [
  { target: "#layers-btn", key: "onb.layers", placement: "left" },
  { target: "#mk-pill", key: "onb.markers", placement: "top" },
  { target: null, key: "onb.goodluck" }, // final step: no target, centered plaque
];

let onboardingIndex = -1;         // current index into ONBOARDING_STEPS, -1 = not running
let onboardingTimerId = null;
let onboardingTargetEl = null;
let onboardingTargetClickHandler = null;
let onboardingPointerDownPos = null; // {x,y} from the last pointerdown — used to detect a drag

function isOnboarded() {
  try { return localStorage.getItem(ONBOARDING_KEY) === "1"; } catch (e) { return true; }
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch (e) { /* private mode/quota — not critical */ }
}

/** Pulsing rings — sized/positioned over the current step's target rect. */
function positionOnboardingOverlay(rect) {
  const overlay = document.getElementById("onboarding-overlay");
  if (!overlay) return;
  overlay.style.left = rect.left + "px";
  overlay.style.top = rect.top + "px";
  overlay.style.width = rect.width + "px";
  overlay.style.height = rect.height + "px";
}

/** Callout position + arrow direction for the current step's placement
 *  ('left' next to the target, 'top' above the target, or centered when the
 *  step has no target at all — the final "good luck" step). */
function positionOnboardingCallout(step, rect) {
  const callout = document.getElementById("onboarding-callout");
  const arrow = document.getElementById("onboarding-arrow");
  if (!callout) return;
  callout.classList.remove("place-left", "place-top", "place-center");
  callout.style.top = callout.style.left = callout.style.right = callout.style.bottom = "";

  if (!step.target) {
    callout.classList.add("place-center");
    callout.style.top = "50%";
    callout.style.left = "50%";
    if (arrow) arrow.classList.add("hidden");
    return;
  }
  if (arrow) arrow.classList.remove("hidden");
  if (step.placement === "top") {
    callout.classList.add("place-top");
    callout.style.left = (rect.left + rect.width / 2) + "px";
    callout.style.bottom = (window.innerHeight - rect.top + 14) + "px";
    if (arrow) { arrow.classList.remove("arrow-right"); arrow.classList.add("arrow-down"); }
  } else {
    callout.classList.add("place-left");
    callout.style.top = (rect.top + rect.height / 2) + "px";
    callout.style.right = (window.innerWidth - rect.left + 14) + "px";
    if (arrow) { arrow.classList.remove("arrow-down"); arrow.classList.add("arrow-right"); }
  }
}

/** Re-run positioning for whichever step is currently shown (window resize). */
function positionCurrentOnboardingStep() {
  if (onboardingIndex < 0 || onboardingIndex >= ONBOARDING_STEPS.length) return;
  const step = ONBOARDING_STEPS[onboardingIndex];
  const rect = onboardingTargetEl ? onboardingTargetEl.getBoundingClientRect() : null;
  if (rect) positionOnboardingOverlay(rect);
  positionOnboardingCallout(step, rect);
}

/** Records where the current gesture started (mouse or touch, via Pointer
 *  Events) so onOnboardingOutsideClick can tell a map drag from a real click. */
function onOnboardingPointerDown(e) {
  onboardingPointerDownPos = { x: e.clientX, y: e.clientY };
}

function onOnboardingOutsideClick(e) {
  if (onboardingTargetEl && onboardingTargetEl.contains(e.target)) return; // the target's own click handler advances instead
  const callout = document.getElementById("onboarding-callout");
  if (callout && callout.contains(e.target)) return; // e.g. the skip button
  // A map drag (mousedown -> move -> mouseup) also fires a "click" on release —
  // if the pointer moved more than the threshold since it went down, this is a
  // drag, not a click: ignore it instead of advancing the tour.
  if (onboardingPointerDownPos) {
    const dx = e.clientX - onboardingPointerDownPos.x;
    const dy = e.clientY - onboardingPointerDownPos.y;
    onboardingPointerDownPos = null;
    if (Math.hypot(dx, dy) > ONBOARDING_DRAG_THRESHOLD_PX) return;
  }
  advanceOnboarding();
}

/** Tear down the currently visible step's timer/listeners (called before
 *  showing the next step, and when the tour ends/is skipped). */
function clearOnboardingStepListeners() {
  if (onboardingTimerId) { clearTimeout(onboardingTimerId); onboardingTimerId = null; }
  document.removeEventListener("click", onOnboardingOutsideClick, true);
  document.removeEventListener("pointerdown", onOnboardingPointerDown, true);
  window.removeEventListener("resize", positionCurrentOnboardingStep);
  if (onboardingTargetEl && onboardingTargetClickHandler) {
    onboardingTargetEl.removeEventListener("click", onboardingTargetClickHandler);
  }
  onboardingTargetEl = null;
  onboardingTargetClickHandler = null;
  onboardingPointerDownPos = null;
}

function showOnboardingStep(idx) {
  clearOnboardingStepListeners();
  onboardingIndex = idx;
  const step = ONBOARDING_STEPS[idx];
  const overlay = document.getElementById("onboarding-overlay");
  const callout = document.getElementById("onboarding-callout");
  const stepEl = document.getElementById("onboarding-step");
  const textEl = document.getElementById("onboarding-text");
  if (!overlay || !callout) return;

  const targetEl = step.target ? document.querySelector(step.target) : null;
  if (step.target && !targetEl) { advanceOnboarding(); return; } // target missing from the DOM — skip it gracefully

  if (textEl) textEl.textContent = t(step.key);
  if (stepEl) stepEl.textContent = `${idx + 1}/${ONBOARDING_STEPS.length}`;

  overlay.classList.toggle("hidden", !targetEl);
  callout.classList.remove("hidden");
  onboardingTargetEl = targetEl;
  positionCurrentOnboardingStep();
  requestAnimationFrame(() => callout.classList.add("show"));

  if (targetEl) {
    onboardingTargetClickHandler = () => advanceOnboarding();
    targetEl.addEventListener("click", onboardingTargetClickHandler);
  }
  document.addEventListener("click", onOnboardingOutsideClick, true);
  document.addEventListener("pointerdown", onOnboardingPointerDown, true);
  window.addEventListener("resize", positionCurrentOnboardingStep);
  onboardingTimerId = setTimeout(advanceOnboarding, step.target ? ONBOARDING_STEP_MS : ONBOARDING_FINAL_MS);
}

function advanceOnboarding() {
  const next = onboardingIndex + 1;
  if (next >= ONBOARDING_STEPS.length) { endOnboarding(); return; }
  showOnboardingStep(next);
}

function endOnboarding() {
  clearOnboardingStepListeners();
  onboardingIndex = -1;
  const overlay = document.getElementById("onboarding-overlay");
  const callout = document.getElementById("onboarding-callout");
  if (callout) callout.classList.remove("show");
  if (overlay) overlay.classList.add("hidden");
  setTimeout(() => { if (callout) callout.classList.add("hidden"); }, 260);
  markOnboarded();
}

function initOnboarding() {
  if (isOnboarded()) return;
  const skipBtn = document.getElementById("onboarding-skip");
  if (skipBtn) skipBtn.addEventListener("click", (e) => { e.stopPropagation(); endOnboarding(); });
  setTimeout(() => showOnboardingStep(0), 1200);
}

// ---------------------------------------------------------------------------
// 17. init — map creation/recreation
// ---------------------------------------------------------------------------
function onMapChange() {
  updateCells();
  updateIconsVisibility();
  updateTownsVisibility();
  updateStreetsVisibility(); // topdown: recomputes line visibility/width by zoom + labels
  writeHash();
}

/**
 * Fully (re)creates L.map in the given mode.
 * @param {"iso"|"topdown"} mode
 * @param {{x:number,y:number,zoom:number}|null} initial — world position +
 *   zoom of the CURRENT (new) mode; null => default view (whole world/collage).
 */
function initMap(mode, initial) {
  state.mode = mode;
  state.renderer = L.canvas({ padding: 0.5 });
  state.cellCache = new Map();
  state.cellsVisible = false;
  state.townsVisible = false;
  state.categoryLayers = {};
  wantedRange = { cxMin: 0, cxMax: -1, cyMin: 0, cyMax: -1 };
  // L.map("map", ...) below tears down and replaces any previous map instance,
  // so any layer reference tied to it (e.g. the backdrop layer from "3") is
  // stale — drop it and let updateIsoTileStack() mount a fresh one.
  state.isoBackdropLayer = null;

  // Mode class on <body> — used in CSS only for the neutral #map background
  // in iso (the theme/UI don't depend on the mode, see style.css).
  document.body.classList.toggle("mode-iso", mode === "iso");
  document.body.classList.toggle("mode-topdown", mode === "topdown");

  const map = L.map("map", {
    crs: L.CRS.Simple,
    renderer: state.renderer,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
    minZoom: mode === "iso" ? 0 : -10,
  });
  state.map = map;
  map.attributionControl.setPrefix("");

  state.cellsRoot = L.layerGroup().addTo(map);
  state.iconsRoot = L.layerGroup().addTo(map);

  let initialLatLng = null;
  let initialZoom = null;

  if (mode === "iso") {
    // "own" falls back to "collage" if the own-render metadata failed to load
    // (see init()) — defensive, initBasemapToggle() already prevents picking
    // "own" in that case, but a stale localStorage value could still do it.
    if (state.isoBasemap === "own" && !state.renderMeta) state.isoBasemap = "collage";
    const usingOwn = state.isoBasemap === "own";

    const bounds = coordsIso.imageBounds();
    const maxZ = usingOwn ? state.renderMeta.maxZoom : 10;
    state.isoLayers = new Map();
    if (usingOwn) {
      updateIsoTileStack(); // mounts layer0..state.floor (see "15. floors")
    } else {
      L.tileLayer(resolveSiteUrl(state.isoMeta.tileUrl), {
        maxNativeZoom: state.isoMeta.maxNativeZoom,
        maxZoom: 10,
        minZoom: 0,
        noWrap: true,
        tileSize: 256,
        bounds,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: true,
      }).addTo(map);
    }
    map.setMaxZoom(maxZ);
    map.setMaxBounds(bounds.pad(0.2));

    // Don't allow zooming out past "the whole map fits the viewport": the own
    // render's pyramid goes down to a useless 1px level 0, and far below the
    // fit zoom maxBounds starts shoving the view center around.
    const fitZoom = map.getBoundsZoom(bounds, false);
    const minZ = Math.max(0, Math.min(fitZoom, maxZ - 1));
    map.setMinZoom(minZ);
    // At full zoom-out, center the whole map instead of leaving it wherever
    // the maxBounds clamp happened to shove it (looks broken on tall viewports).
    map.on("zoomend", () => {
      if (map.getZoom() <= minZ) map.panTo(bounds.getCenter(), { animate: true });
    });

    state.iconsMinZoom = isoThreshold(ISO_ICONS_MIN_ZOOM_COLLAGE);
    state.townsMaxZoom = isoThreshold(ISO_TOWNS_MAX_ZOOM_COLLAGE);

    if (initial) {
      initialLatLng = coordsIso.toLatLng(initial.x, initial.y);
      initialZoom = clamp(initial.zoom, minZ, maxZ);
    }
  } else {
    const worldBounds = coords.bboxToBounds(0, 0, state.meta.worldW, state.meta.worldH);
    // The zoom at which the whole world is visible — the base for relative thresholds.
    state.worldZoom = map.getBoundsZoom(worldBounds, false);
    // +4, not less: at worldZoom+2 ~1000 cells fall into the viewport and the map
    // downloads the entire data/cells directory at once.
    state.cellsMinZoom = state.worldZoom + 4;
    state.iconsMinZoom = state.worldZoom + 1;
    state.townsMaxZoom = state.worldZoom + 3;

    map.setMinZoom(state.worldZoom);
    map.setMaxZoom(state.worldZoom + 9);
    map.setMaxBounds(worldBounds.pad(0.25));

    if (initial) {
      initialLatLng = coords.toLatLng(initial.x, initial.y);
      initialZoom = clamp(initial.zoom, state.worldZoom, state.worldZoom + 9);
    }
  }

  // Water/forest — topdown only, a separate pane below overlayPane (buildings/streets/icons).
  if (mode === "topdown") {
    map.createPane("pzBasemapPane");
    map.getPane("pzBasemapPane").style.zIndex = 350;
    state.basemapRenderer = L.canvas({ pane: "pzBasemapPane", padding: 0.5 });
    if (state.waterRaw) buildWaterLayer(); else { state.waterLayer = null; state.waterPolygons = []; }
    if (state.forestRaw) buildForestLayer(); else { state.forestLayer = null; state.forestPolygons = []; }
  } else {
    state.basemapRenderer = null;
    state.waterLayer = null;
    state.forestLayer = null;
    state.waterPolygons = [];
    state.forestPolygons = [];
  }

  buildTownsLayer();

  // Pin (point sharing), custom markers, streets — rebuilt for the mode.
  state.pinLayer = L.layerGroup();
  if (state.allMarkersVisible) state.pinLayer.addTo(map);
  buildMarkersLayer();
  state.streetsLinesLayer = L.layerGroup();
  state.streetLabelsLayer = L.layerGroup().addTo(map);
  if (state.streetsRaw) buildStreetsLineLayer();

  state.hashSuspend = true;
  if (initial) {
    map.setView(initialLatLng, initialZoom);
  } else if (mode === "iso") {
    map.fitBounds(coordsIso.imageBounds());
  } else {
    map.fitBounds(coords.bboxToBounds(0, 0, state.meta.worldW, state.meta.worldH));
  }
  state.hashSuspend = false;

  initStatusBar();
  updateModeUI();

  // Debug access from the browser console.
  window.PZ = { map, state, coords, coordsIso, buildRenderMeta };

  map.on("moveend", onMapChange);
  map.on("zoomend", onMapChange);
  // Right-click — "copy link / place marker" popup (left-click is reserved for
  // buildings/markers; Leaflet itself suppresses the browser context menu).
  map.on("contextmenu", onMapClick);

  if (mode === "topdown") {
    attachBasemapLayer(state.waterLayer);
    attachBasemapLayer(state.forestLayer);
  }

  updateCells();
  updateTownsVisibility();
  updateMarkersVisibility();
  updateStreetsVisibility();
  updatePinMarker();
  buildIconsLayers(); // uses buildingsIndexRaw if already loaded
}

async function init() {
  state.spoilersOn = store.get("pz.spoilers", true);
  state.revealedSet = new Set(store.get("pz.revealed", []));
  state.markers = store.get("pz.markers", []);
  state.allMarkersVisible = store.get("pz.allMarkers", true);
  state.chipsCompact = store.get("pz.chipsCompact", false);
  state.searchVisible = store.get("pz.searchVisible", true);
  state.chipsVisible = store.get("pz.chipsVisible", true);

  const collageAvailable = !!(window.PZMAP_CONFIG && window.PZMAP_CONFIG.collageAvailable);
  const [meta, isoMeta, renderInfo] = await Promise.all([
    fetchJson(`${appBase()}data/meta.json`),
    collageAvailable ? fetchJson(`${appBase()}data/iso_meta.json`) : Promise.resolve(null),
    fetchJson(`${tileBase()}map_info.json`),
  ]);
  state.meta = meta || {
    // a reasonable fallback if meta.json hasn't been built by the backend pipeline yet
    cellSize: 256, cellsX: 78, cellsY: 63,
    worldW: 19968, worldH: 16128,
    categories: {}, towns: [], stats: {},
  };
  state.isoMeta = isoMeta;
  state.renderMeta = renderInfo ? buildRenderMeta(renderInfo) : null;

  state.isoBasemap = store.get("pz.isoBasemap", "own");
  if (state.isoBasemap === "own" && !state.renderMeta) state.isoBasemap = "collage";
  if (state.isoBasemap === "collage" && !state.isoMeta && state.renderMeta) state.isoBasemap = "own";

  initModeSwitch();
  initThemeControls();
  initZoomButtons();
  initChips();
  initSearch();
  initLayersPanel();
  initAboutModal();
  initAttribution();
  initOutlinesToggle();
  initBasemapToggle();
  initCompactChipsToggle();
  initSearchVisibilityToggle();
  initChipsVisibilityToggle();
  initSpoilerControls();
  initStreetsToggle();
  initMarkerPanel();
  initAllMarkersToggle();
  initFloorSelector();
  initActionDelegation();
  initAddingMarkerMode();
  initLangSwitch();
  initOnboarding();

  const fromHash = parseHash();
  let mode = fromHash && fromHash.mode ? fromHash.mode : "iso"; // isometric — default mode
  if (mode === "iso" && !state.isoMeta && !state.renderMeta) mode = "topdown"; // no iso data at all — fallback
  state.pin = fromHash && fromHash.pin ? fromHash.pin : null;

  const initial = fromHash && fromHash.mode ? { x: fromHash.x, y: fromHash.y, zoom: fromHash.zoom } : null;

  initMap(mode, initial);

  // Markers passed in the link (mk: segment) — after map initialization,
  // once the layers and the marker panel already exist.
  if (fromHash && fromHash.mk) consumeSharedMarkers(fromHash.mk);

  // buildings_index/streets/water/forest are loaded once, in parallel with the
  // initial cell rendering; each will build/attach its own layer
  // on completion (see loadBuildingsIndex/loadStreetsData/loadWaterData/loadForestData).
  loadBuildingsIndex();
  loadStreetsData();
  loadWaterData();
  loadForestData();
}

document.addEventListener("DOMContentLoaded", init);
