"""Synthetic TTGT/TMON/TVMA/TSIO input. No HTTP response substitution."""
import socket,struct,time,json,sys
from pathlib import Path
ROOT=Path('/tmp/triangulator-memory-api-followup')
HEADER=struct.Struct('<4sBBBBQIH2xQQII'); RECORD=struct.Struct('<IBBHQQQQQQQ16s32s'); ANNOUNCE=struct.Struct('<4sBB2xQIIQQQII32s64s');MEM=struct.Struct('<4sBBBBQIH2xQQIIQH6x');REG=struct.Struct('<QQIBB2x40s');TSIO=struct.Struct('<4sI7Q4I2Q2I5Q16x')
seq=int(time.time()*100) % 4294967296
socks=[]
for ip in ['127.0.0.1','127.0.0.2']:
 s=socket.socket(type=socket.SOCK_DGRAM);s.bind((ip,0));socks.append(s)
def send(data,host=0):socks[host].sendto(data,('127.0.0.1',19672))
def target(session,id,host,pid):
 send(ANNOUNCE.pack(b'TTGT',1,0,session,pid,5000,1,1000000,1000000000,5000,0,id.encode(),('wire-'+str(host)).encode()),host)
 send(HEADER.pack(b'TMON',2,0,0,1,session,seq,1,time.monotonic_ns(),time.time_ns(),1000,pid)+RECORD.pack(pid,ord('S'),0,0,seq,0,0,seq,0,0,0,b'wire-fixture',b'nanosleep'),host)
def memory(flags=0,delta=0,missing=False,session=9001):
 global seq
 seq+=1;target(session,'default',0,50);wall=time.time_ns();mono=time.monotonic_ns();base=0x20000000000000
 regions=[(base,base+4096+delta,1,3,3,b'[heap]'),(base+0x10000-delta,base+0x18000,1,4,3,b'[stack]'),(base+0x20000,base+0x21000,1,1,3,b''),(base+0x23000,base+0x24000,1,1,3,b'')]
 summary=[65536,65536,4096+delta,32768+delta,4096,4096,4096,0,0,0,2**64-1,8388608,1048576,4,1,1,1]
 send(MEM.pack(b'TVMA',1,1,0,2,session,seq,17,mono,wall,1000,50,1,flags)+struct.pack('<17Q',*summary))
 if not missing:send(MEM.pack(b'TVMA',1,2,1,2,session,seq,len(regions),mono,wall,1000,50,1,flags)+b''.join(REG.pack(*r) for r in regions))
def socket_snapshot(sequence,host,pid,observer,total):
 target(9201+host,'default' if host==0 else 'billing',host,pid)
 wall=time.time_ns()
 for index in [0,1]:send(TSIO.pack(b'TSIO',1,observer,sequence,(sequence+10)*10**9,wall,10**9,123,0,pid,index,2,1,123000 if index else 0,456 if index else 0,pid if index else 0,1 if index else 0,total if index else 0,0,sequence if index else 0,0,0),host)
if __name__=='__main__':
 mode=sys.argv[1]
 if mode=='memory':memory(int(sys.argv[2]),int(sys.argv[3]),len(sys.argv)>4)
 if mode=='socket':
  for seq in range(3):
   socket_snapshot(seq,0,50,91,100*seq);socket_snapshot(seq,1,50,92,1000*seq);time.sleep(1)
 if mode=='socket-one':socket_snapshot(3,1,50,92,3000)
 if mode=='announce':
  for i in range(3):target(9001,'default',0,50);target(9002,'billing',1,50);time.sleep(.2)
