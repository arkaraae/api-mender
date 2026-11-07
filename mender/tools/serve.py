#!/usr/bin/env python3
"""Mender Studio dev server.

Serves the mender/ folder and forwards API calls for the Studio. Browsers refuse to call most
APIs from another site (CORS), so when the Studio runs from this server it sends those calls to
/__proxy and this server makes the request instead.

    python3 mender/tools/serve.py          # http://127.0.0.1:4173
    python3 mender/tools/serve.py 8080     # another port

It listens on 127.0.0.1 only and refuses proxy requests that come from other websites.
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_REQUEST = {"host", "origin", "referer", "cookie", "connection", "content-length", "accept-encoding", "user-agent"}
SKIP_RESPONSE = {"transfer-encoding", "connection", "content-encoding", "content-length", "set-cookie", "keep-alive"}


def tls_context():
    context = ssl.create_default_context()
    # Python from python.org ships without root certificates on macOS; the system bundle has them.
    if os.path.exists("/etc/ssl/cert.pem"):
        context.load_verify_locations("/etc/ssl/cert.pem")
    return context


TLS = tls_context()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), format % args))

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return True

    def proxy(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/__proxy":
            return False
        # Only this server's own pages may use the proxy; a page on another site may not.
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            return self.reply(403, {"error": "The proxy only answers pages served by this server."})
        query = urllib.parse.parse_qs(parsed.query)
        if "ping" in query:
            return self.reply(200, {"ok": True})
        target = (query.get("url") or [""])[0]
        if not target.startswith(("http://", "https://")):
            return self.reply(400, {"error": "Pass the address to call as ?url=https://..."})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in SKIP_REQUEST and not key.lower().startswith("sec-")
        }
        headers["User-Agent"] = "mender-studio-dev-proxy"
        request = urllib.request.Request(target, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30, context=TLS) as response:
                status, answer_headers, payload = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            status, answer_headers, payload = error.code, error.headers, error.read()
        except Exception as error:  # DNS failure, refused connection, timeout, bad certificate
            return self.reply(502, {"error": "Could not reach %s: %s" % (target, error)})
        self.send_response(status)
        for key, value in answer_headers.items():
            if key.lower() not in SKIP_RESPONSE:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Mender-Proxy", "1")
        self.end_headers()
        self.wfile.write(payload)
        return True

    def do_GET(self):
        if not self.proxy():
            super().do_GET()

    def other(self):
        if not self.proxy():
            self.send_error(405, "Only /__proxy accepts this method")

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = other


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Mender Studio: http://127.0.0.1:%d  (tests: /tests/)" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
