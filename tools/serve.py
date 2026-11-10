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


class Server(http.server.ThreadingHTTPServer):
    # the default listen backlog of 5 overflows when the browser fetches 50+ ES modules at once:
    # macOS then resets the extra connections and the app starts half-loaded (ERR_CONNECTION_RESET)
    request_queue_size = 128


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    print(f'PowerUp: http://localhost:{PORT}/')
    Server(('127.0.0.1', PORT), handler).serve_forever()
