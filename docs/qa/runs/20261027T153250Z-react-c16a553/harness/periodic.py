import ctypes,json,threading,time
from pathlib import Path
libc=ctypes.CDLL(None);counts={};blocked=threading.Event()
def worker(name,seconds):
 libc.prctl(15,name.encode(),0,0,0);counts[name]=0
 while True:
  if name=='MsgP-fast' and Path('/qa/periodic-stop').exists():blocked.wait()
  counts[name]+=1;time.sleep(seconds)
for n,t in [('MsgP-fast',1),('MsgP-peer',1),('PrdDist-main',2),('PrdDist-peer',2),('Control-idle',1)]:threading.Thread(target=worker,args=(n,t),daemon=True).start()
while True:
 Path('/qa/periodic-counters.json').write_text(json.dumps({'at':time.time(),'counts':counts}));time.sleep(.2)
