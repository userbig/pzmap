#!/usr/bin/env python3
"""
serve.py - threaded static HTTP server for the pzmap project root.

Usage:
    python serve.py [port]

Defaults to port 8000 if no argument is given. Serves the project root
(the directory this file lives in), so paths like /web/index.html,
/render/gen/html/map_data/base/map_info.json and /data/meta.json all
resolve the same way they do under a plain `python -m http.server`.

Cache-Control policy (set per request path prefix):
    /render/   -> public, max-age=604800, immutable
                  (rendered DZI tiles are build output; a re-render always
                  goes to a fresh render/ tree, so these never change in place)
    /web/vendor/ -> public, max-age=604800
                  (third-party libs, versioned by their own file names)
    /data/     -> no-cache
                  (generated data files get rebuilt frequently during dev)
    /web/      -> no-cache
                  (actively edited during development)
    (anything else falls back to no-cache)

Logging is quiet: only non-200 responses are logged, to avoid spamming the
console with a line per tile request.
"""

import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class QuietCachingHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Only log non-200 responses (errors, 404s, etc.) - tile-heavy pages
        # would otherwise spam the console with hundreds of lines per pan/zoom.
        status = str(args[1]) if len(args) > 1 else ""
        if not status.startswith("200"):
            super().log_message(format, *args)

    def end_headers(self):
        self.send_header("Cache-Control", self._cache_control_for(self.path))
        super().end_headers()

    @staticmethod
    def _cache_control_for(path):
        if path.startswith("/render/"):
            return "public, max-age=604800, immutable"
        if path.startswith("/web/vendor/"):
            return "public, max-age=604800"
        if path.startswith("/data/"):
            return "no-cache"
        if path.startswith("/web/"):
            return "no-cache"
        return "no-cache"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), QuietCachingHandler)
    print(f"Serving {sys.path[0] or '.'} at http://localhost:{port}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
