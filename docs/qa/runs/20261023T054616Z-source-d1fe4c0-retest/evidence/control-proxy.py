"""QA-only transparent proxy. No sampler. No production data writes.
Returns enabled local control for dialog checks. Fails one live request for No data.
Mode JSON can select an already running collector and enable these two overrides.
"""
import json, urllib.request, urllib.error
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
MODE=Path('/tmp/tri-scalable-qa-mode.json')
class Handler(BaseHTTPRequestHandler):
 def reply(self,status,raw,kind='application/json'):
  if not isinstance(raw,bytes):raw=json.dumps(raw).encode()
  self.send_response(status);self.send_header('Content-Type',kind);self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  mode=json.loads(MODE.read_text())
  if mode.get('control') and self.path=='/api/targets/control':return self.reply(200,{'enabled':True,'host':'rack01','targets':[{'id':'api-gateway-01','target':'4001'},{'id':'api-gateway-09','target':'4009'}]})
  if mode.get('nodata') and self.path.startswith('/api/live?') and 'nginx-63' in self.path:return self.reply(503,{'error':'QA fixture: one live view unavailable'})
  try:
   with urllib.request.urlopen(f"http://127.0.0.1:{mode['port']}"+self.path) as response:self.reply(response.status,response.read(),response.headers.get('Content-Type','application/json'))
  except urllib.error.HTTPError as error:self.reply(error.code,error.read())
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  if self.path=='/api/targets' and body.get('check'):return self.reply(200,{'targets':[],'message':'QA validation only. Cancel confirmation.'})
  self.reply(403,{'error':'QA fixture prohibits monitoring changes'})
 def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',19865),Handler).serve_forever()
