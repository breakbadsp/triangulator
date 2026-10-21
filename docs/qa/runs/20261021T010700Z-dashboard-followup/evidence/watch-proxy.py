"""Test-only reverse proxy. Change /tmp/triangulator-dashboard-followup/proxy-mode."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import time

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        mode_path = Path('/tmp/triangulator-dashboard-followup/proxy-mode')
        mode = mode_path.read_text().strip() if mode_path.exists() else ''
        if self.path.startswith('/api/watches') and self.command == 'GET':
            if mode == 'missing':
                self.send_error(404, 'QA endpoint unavailable')
                return
            if mode == 'delay':
                time.sleep(4)
        data = self.rfile.read(int(self.headers.get('Content-Length', '0'))) if self.command == 'POST' else None
        headers = dict(self.headers)
        headers.pop('Host', None)
        headers['Host'] = '127.0.0.1:19571'
        if 'Origin' in headers:
            headers['Origin'] = 'http://127.0.0.1:19571'
        request = Request('http://127.0.0.1:19571' + self.path, data=data, headers=headers, method=self.command)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        body = response.read()
        self.send_response(response.status)
        for name, value in response.headers.items():
            if name.lower() not in ['connection', 'transfer-encoding', 'content-length']:
                self.send_header(name, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(('127.0.0.1', 19573), Handler).serve_forever()
