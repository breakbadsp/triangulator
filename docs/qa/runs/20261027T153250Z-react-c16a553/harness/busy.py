import ctypes,threading,time
libc=ctypes.CDLL(None)
def worker(i):
 libc.prctl(15,('qa-worker-%02d'%i).encode(),0,0,0)
 x=0
 while True:x=(x+1)%10000019
for i in range(20):threading.Thread(target=worker,args=(i,),daemon=True).start()
while True:time.sleep(1)
