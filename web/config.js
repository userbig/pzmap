// PZ Map runtime configuration. Loaded before app.js (see index.html) so
// appBase()/tileBase() there can read it. Static file, no build step.
window.PZMAP_CONFIG = {
  // "auto" = derive the site root from location.pathname up to "/web/" —
  // works for a root deploy, a GitHub Pages project subpath (e.g.
  // /pzmap/web/), or a domain alias serving the same tree. Set an explicit
  // string (e.g. "/pzmap/") to override the auto-detection.
  base: "auto",

  // Prefix for the "own" render's DZI tiles (render/gen/html/map_data/base/).
  // null = resolve locally under `base` above; in production this points at
  // the bucket/CDN serving the tiles, e.g. "https://tiles.pzmap.net/base/".
  tileBase: 'https://tiles.pzmap.net/base/',

  // The legacy third-party collage basemap isn't distributed with this
  // public repo/release. Leave false unless you also have your own
  // data/iso_meta.json and render/iso/ tiles.
  collageAvailable: false,
};
