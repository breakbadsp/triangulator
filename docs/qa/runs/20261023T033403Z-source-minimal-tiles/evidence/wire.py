import socket,struct,time,json
from pathlib import Path
H=struct.Struct('<4sBBBBQIH2xQQII');R=struct.Struct('<IBBHQQQQQQQ16s32s');A=struct.Struct('<4sBB2xQIIQQQII32s64s')
s=socket.socket(type=socket.SOCK_DGRAM);seq=0
while True:
 seq+=1
 mode=Path('/tmp/tri-minimal-qa/mode').read_text().strip() if Path('/tmp/tri-minimal-qa/mode').exists() else 'live'
 for i,(id,name,state) in enumerate([('spin','same-name','R'),('wait','same-name','D'),('healthy','idle','S'),('absent','absent','A'),('this-is-a-long-target-identity','long-proc-name','R'),('nodata','nodata','N')]):
  if mode=='empty':continue
  session=88100+i;pid=8800+i;mono=time.monotonic_ns();wall=time.time_ns();host='qa-host-with-a-long-name-abcdefghijklmnopqrstuvwxyz' if i==4 else 'qa-host'
  if mode=='silent' and i==0:continue
  s.sendto(A.pack(b'TTGT',1,1 if i==4 else 0,session,0 if state=='A' else pid,1000,0 if state=='A' else 100,seq*1000000,seq*1000000000,5000,100,id.encode(),host.encode()),('127.0.0.1',19780))
  if state=='N':continue
  data=H.pack(b'TMON',2,1 if state=='A' else 0,0,1,session,seq,0 if state=='A' else 1,mono,wall,1000,0 if state=='A' else pid)
  if state!='A':data+=R.pack(pid,ord(state),0,0,seq*100 if state=='R' else 1,0,seq*100000000 if state=='D' else 0,seq,0,0,0,name.encode(),b'io_schedule' if state=='D' else b'nanosleep' if state=='S' else b'')
  s.sendto(data,('127.0.0.1',19780))
  p=bytearray(840);struct.pack_into('<4sBBBBQQQQQ6IQiH2x',p,0,b'TPIN',1,2,1,0,session,mono,wall,100,wall-3600*10**9,pid,1,1000,1000,1000,1000,0,0,0)
  command=('/opt/qa/'+name+' --long-argument-for-wrapping abcdefghijklmnopqrstuvwxyz').encode();p[88:88+len(command)]=command
  p[472:472+12]=b'/usr/bin/qa\0';p[632:632+5]=b'/tmp\0';p[792:796]=b'0-3\0'
  s.sendto(p,('127.0.0.1',19780))
 time.sleep(1)
