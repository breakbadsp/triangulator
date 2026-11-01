"""A sampler whose stderr nobody reads keeps sampling.

The stderr pipe is full before the sampler starts. An invalid configuration
edit then makes the sampler warn inside its loop. A blocking write would stop
every tick there.
"""

import fcntl
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("SAMPLER_BINARY", ROOT / "build/triangulator-sampler"))


def ticks(receiver, seconds):
    count = 0
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            if receiver.recv(65536)[:4] == b"TMON":
                count += 1
        except socket.timeout:
            pass
    return count


class FullStderrTests(unittest.TestCase):
    def test_warning_to_a_full_stderr_pipe_does_not_stop_ticks(self):
        read_end, write_end = os.pipe()
        flags = fcntl.fcntl(write_end, fcntl.F_GETFL)
        fcntl.fcntl(write_end, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        try:
            while True:
                os.write(write_end, b"x" * 4096)
        except BlockingIOError:
            pass
        fcntl.fcntl(write_end, fcntl.F_SETFL, flags)
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(0.2)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "sampler.toml"
            config.write_text(f'target_pid = {os.getpid()}\nrate_hz = 10\n'
                              f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
            sampler = subprocess.Popen([str(BINARY), str(config)], stdout=subprocess.DEVNULL,
                                       stderr=write_end)
            os.close(write_end)
            try:
                self.assertGreater(ticks(receiver, 1.5), 5, "the sampler did not start")
                config.write_text("rate_hz = not a number\n")
                time.sleep(0.5)
                self.assertGreater(ticks(receiver, 2), 10,
                                   "ticks stopped after a warning to a full stderr")
                self.assertIsNone(sampler.poll())
            finally:
                sampler.kill()
                sampler.wait()
                os.close(read_end)
                receiver.close()


if __name__ == "__main__":
    unittest.main()
