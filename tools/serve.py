"""Local dev server: serves the app with caching disabled.

The browser otherwise keeps stale ES modules (e.g. an old controls.js next to a new app.js)
even after a hard reload. Usage: python3 tools/serve.py [port]  (default 8000)
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    print(f'PowerUp: http://localhost:{PORT}/')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
