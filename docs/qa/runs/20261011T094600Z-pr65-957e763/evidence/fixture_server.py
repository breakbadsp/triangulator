import json, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
ROOT=Path('/tmp/pr65-qa-runtime')
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  state=json.loads((ROOT/'state.json').read_text())
  route=self.path.split('?')[0]
  if route=='/': body=(ROOT/'share/dashboard.html').read_bytes(); mime='text/html'
  else:
   live=json.loads((ROOT/'live.json').read_text()); layout=json.loads((ROOT/'map.json').read_text())
   now=time.time(); live['health']['last_seen']=now
   session=state.get('session','fixture'); pid=state.get('pid',101)
   live['health'].update(session=session,pid=pid)
   live['memory'].update(pid=pid,updated=state.get('stamp',now),layout_id=session+':'+str(state.get('layout',1)),stale=state.get('stale',False))
   live['memory']['flags'].update(maps_partial=state.get('partial',False),regions_truncated=state.get('truncated',False))
   live['resources'].update(session=session,pid=state.get('resource_pid',pid),updated=now,ts=now,stale=state.get('resource_stale',False))
   live['resources']['limits']['page_size']=state.get('page',4096)
   base=2**60; size=state.get('heap',1048576); stack=state.get('stack',0)
   def region(start,end,kind,name): return dict(start=hex(start),end=hex(end),size=end-start,vmas=1,kind=kind,permissions='rw-p',name=name)
   regions=[region(base,base+size,'heap','[heap]'),region(base+1179648,base+1245184,'file','/tmp/neighbor'),region(base+2097152,base+2162688,'anonymous',''),region(base+2293760,base+2359296,'anonymous',''),region(base+16777216-stack,base+16908288,'stack','[stack]')]
   if state.get('no_neighbor'): regions=[r for r in regions if r['kind']!='file']
   if state.get('gap_only'): regions=[region(base,base+65536,'anonymous',''),region(base+196608,base+262144,'anonymous','')]
   layout.update(id=live['memory']['layout_id'],pid=pid,updated=now,regions=regions,flags=live['memory']['flags'])
   if state.get('delayed'): layout['id']=session+':old'
   live['memory']['values'].update(vm_size_bytes=sum(x['size'] for x in regions),vm_stack_bytes=131072+stack,vma_count=5)
   value={'/api/live':live,'/api/memory-map':layout,'/api/resources':{'rows':[]},'/api/replay':{'available':False},'/api/socket-io':{'available':False}}.get(route,{'available':False})
   body=json.dumps(value).encode(); mime='application/json'
  self.send_response(200); self.send_header('Content-Type',mime);self.end_headers();self.wfile.write(body)
 def log_message(self,*args): pass
ThreadingHTTPServer(('127.0.0.1',19652),Handler).serve_forever()
