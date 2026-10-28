import ctypes,os,socket,sys,time
os.sched_setaffinity(0,{2,3})
if '--deleted' in sys.argv:os.unlink(sys.executable)
if '--restricted' in sys.argv:ctypes.CDLL(None).prctl(4,0,0,0,0)
ctypes.CDLL(None).prctl(15,b'qa-ui-native',0,0,0)
sockets=[]
for i in range(48):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));sockets.append(s)
open('/qa/ui-final/native-ready','w').write(str(os.getpid()))
blocks=[]
while True:
 if len(blocks)<3072:
  blocks.extend(bytearray(65536) for _ in range(16))
 for i,s in enumerate(sockets[:-4]):s.sendto(b'x'*100,sockets[(i+1)%44].getsockname())
 time.sleep(1)
