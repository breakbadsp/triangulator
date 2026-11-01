"""Real sampler runs: a full stderr pipe, and a target that changes.

The stderr pipe is full before the sampler starts. An invalid configuration
edit then makes the sampler warn inside its loop. A blocking write would stop
every tick there.

A target that runs exec and chdir keeps its PID and start time. The
process info that the sampler sends must follow the change.
"""

import fcntl
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
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


# Offsets in common/process_wire.hpp: Packet.
EXE = slice(472, 632)
CWD = slice(632, 792)
CHANGING_TARGET = """
import os, sys, time
print("ready", flush=True)
sys.stdin.readline()
os.chdir(sys.argv[1])
os.execv(sys.argv[2], ["sleep", "60"])
"""


def text(field):
    return field.split(b"\0", 1)[0].decode()


class ProcessInfoTests(unittest.TestCase):
    def test_exec_and_chdir_show_in_the_next_process_info(self):
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(0.5)
        with tempfile.TemporaryDirectory() as directory, \
                tempfile.TemporaryDirectory() as moved:
            # A copy with its own name: on some systems sleep is a link to a
            # multi-call binary, so its exe name would not be "sleep".
            program = Path(moved) / "exec-target"
            shutil.copy(shutil.which("sleep"), program)
            target = subprocess.Popen([sys.executable, "-c", CHANGING_TARGET, moved,
                                       str(program)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      text=True, cwd=directory)
            self.assertEqual(target.stdout.readline().strip(), "ready")
            config = Path(directory) / "sampler.toml"
            config.write_text(f'target_pid = {target.pid}\nrate_hz = 10\n'
                              f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
            sampler = subprocess.Popen([str(BINARY), str(config)], stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
            try:
                seen = []
                changed = False
                end = time.monotonic() + 25
                while time.monotonic() < end and len(seen) < 2:
                    try:
                        data = receiver.recv(65536)
                    except socket.timeout:
                        continue
                    if data[:4] != b"TPIN":
                        continue
                    seen.append((text(data[EXE]), text(data[CWD])))
                    if not changed:
                        target.stdin.write("go\n")
                        target.stdin.flush()
                        changed = True
                self.assertEqual(len(seen), 2, "two process-info datagrams")
                self.assertNotEqual(Path(seen[0][0]).name, "exec-target")
                self.assertEqual(seen[0][1], str(Path(directory).resolve()))
                self.assertEqual(Path(seen[1][0]).name, "exec-target")
                self.assertEqual(seen[1][1], str(Path(moved).resolve()))
            finally:
                sampler.kill()
                sampler.wait()
                target.kill()
                target.wait()
                receiver.close()


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


class RegularFileStderrTests(unittest.TestCase):
    def test_invalid_edit_warning_is_in_a_regular_file_log_while_running(self):
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(0.2)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "sampler.toml"
            log = Path(directory) / "sampler.log"
            config.write_text(f'target_pid = {os.getpid()}\nrate_hz = 10\n'
                              f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
            with log.open("wb") as log_file:
                sampler = subprocess.Popen([str(BINARY), str(config)],
                                           stdout=subprocess.DEVNULL, stderr=log_file)
            try:
                self.assertGreater(ticks(receiver, 1.5), 5, "the sampler did not start")
                config.write_text("rate_hz = not a number\n")
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not log.read_bytes():
                    time.sleep(0.1)
                self.assertIn(b"invalid configuration", log.read_bytes())
                self.assertIsNone(sampler.poll())
            finally:
                sampler.kill()
                sampler.wait()
                receiver.close()


if __name__ == "__main__":
    unittest.main()
