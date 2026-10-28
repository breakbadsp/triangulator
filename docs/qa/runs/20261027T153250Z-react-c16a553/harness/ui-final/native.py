import ctypes,os,socket,sys,time
ctypes.CDLL(None).prctl(15,b'qa-ui-native',0,0,0)
if '--restricted' in sys.argv: ctypes.CDLL(None).prctl(4,0,0,0,0)
os.sched_setaffinity(0,{2,3})
sockets=[]
for i in range(48):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));sockets.append(s)
blocks=[]
while True:
 if len(blocks)<240:blocks.append(bytearray(524288))
 for i,s in enumerate(sockets):s.sendto(b'x'*100, sockets[(i+1)%len(sockets)].getsockname())
 time.sleep(1)
