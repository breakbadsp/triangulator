import ctypes, os, signal, threading, time, json
libc = ctypes.CDLL(None)
blocked = threading.Event()
stop_waking = threading.Event()
counters = {}
def worker(name, period, stoppable=False):
    libc.prctl(15, name.encode(), 0, 0, 0)
    counters[name] = 0
    while True:
        time.sleep(period)
        counters[name] += 1
        if stoppable and stop_waking.is_set():
            blocked.wait()
def suspend(_sig, _frame):
    stop_waking.set()
signal.signal(signal.SIGUSR1, suspend)
for args in [('MsgP-fast',1,True),('MsgP-peer',1),('PrdDist-main',2),('PrdDist-peer',2),('Control-idle',1)]:
    threading.Thread(target=worker,args=args,daemon=True).start()
while True:
    with open('/tmp/tri-qa/counters.json','w') as f:
        json.dump({'unix':time.time(),'pid':os.getpid(),'counters':counters,'stop_requested':stop_waking.is_set()},f)
    time.sleep(1)
