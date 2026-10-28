import os,ctypes,time
for name,count in [('qa-two',2),('qa-many',25)]:
 for i in range(count):
  if os.fork()==0:
   ctypes.CDLL(None).prctl(15,name.encode(),0,0,0)
   time.sleep(99999);os._exit(0)
