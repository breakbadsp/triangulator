import ctypes
import os
import sys
import threading


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    ready = threading.Barrier(26)
    release = threading.Event()

    def set_name(name):
        if libc.prctl(15, name.encode(), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_NAME)")

    def worker(index):
        set_name(f"worker ) ( {index}")
        ready.wait(timeout=5)
        release.wait()

    name = f"tmon-{os.getpid()}"
    set_name(name)
    threads = [threading.Thread(target=worker, args=(index,)) for index in range(25)]
    for thread in threads:
        thread.start()
    ready.wait(timeout=5)
    print(name, flush=True)
    sys.stdin.readline()
    release.set()
    for thread in threads:
        thread.join()
    print("released", flush=True)
    sys.stdin.readline()


if __name__ == "__main__":
    main()
