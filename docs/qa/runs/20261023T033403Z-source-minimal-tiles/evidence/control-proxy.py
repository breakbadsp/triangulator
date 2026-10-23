import json,time,urllib.request,urllib.parse,importlib.util,os,ctypes
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ROOT=Path('/home/daksh/.t3/worktrees/triangulator/fleet-minimal-tiles')
spec=importlib.util.spec_from_file_location('control',ROOT/'scripts/sampler_control.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
config=Path('/tmp/tri-minimal-qa/managed.toml');config.write_text('collector = "127.0.0.1:19780"\n'+''.join(f'[[target]]\nid="{i}"\nprocess="{i}"\n' for i in ['spin','wait','healthy']))
children=[]
for i in range(22):
 pid=os.fork()
 if pid==0:
  ctypes.CDLL(None).prctl(15,b'qa-twin',0,0,0);time.sleep(3600);os._exit(0)
 children.append(pid)
Path('/tmp/tri-minimal-qa/twins.json').write_text(json.dumps(children))
class H(BaseHTTPRequestHandler):
 def reply(self,status,value):
  raw=json.dumps(value).encode() if not isinstance(value,bytes) else value
  self.send_response(status);self.send_header('Content-Type','text/html' if raw.startswith(b'<!') else 'application/json');self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  mode=Path('/tmp/tri-minimal-qa/proxy-mode').read_text().strip() if Path('/tmp/tri-minimal-qa/proxy-mode').exists() else ''
  if self.path=='/api/targets/control':return self.reply(200,{'enabled':True,'host':'qa-host','targets':c.configured_targets(config.read_text())})
  if self.path.startswith('/api/targets') and mode=='empty':return self.reply(200,{'targets':[]})
  if self.path.startswith('/api/live') and 'nodata' in self.path:return self.reply(404,{'error':'fixture: no live view'})
  if self.path.startswith('/api/live') and mode=='down':return self.reply(503,{'error':'fixture down'})
  try:
   with urllib.request.urlopen('http://127.0.0.1:19781'+self.path) as r: raw=r.read()
   if self.path.startswith('/api/live') and 'healthy' in self.path and mode=='warning':
    d=json.loads(raw);d['health']['packet_loss_pct']=10;raw=json.dumps(d).encode()
   self.reply(200,raw)
  except Exception as e:self.reply(503,{'error':str(e)})
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path!='/api/targets':return self.reply(404,{})
  check=body.pop('check',False)
  try:
   changed=c.change_target_set(config.read_text(),body,8)
   if not check:config.write_text(changed)
   self.reply(200,{'targets':c.configured_targets(config.read_text()),'message':'Fixture saved; no sampler reload'})
  except Exception as e:self.reply(400,{'error':str(e),'candidates':getattr(e,'candidates',None),'total':getattr(e,'total',None)})
 def log_message(self,*args):pass
try:ThreadingHTTPServer(('127.0.0.1',19782),H).serve_forever()
finally:
 for pid in children:os.kill(pid,15)
