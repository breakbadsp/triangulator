"""Run the real sampler against safe, named process fixtures and real UDP."""
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import tempfile
import time
import unittest

from test_sampler_control import start_named, stop
from wire import decode

ROOT = Path(__file__).resolve().parents[1]
ANNOUNCE = struct.Struct('<4sBBBBQIIQQQII32s64s')


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.path = self.directory / 'sampler.toml'
        self.receiver = socket.socket(type=socket.SOCK_DGRAM)
        self.addCleanup(self.receiver.close)
        self.receiver.bind(('127.0.0.1', 0))
        self.receiver.settimeout(0.1)
        self.name = f'd199-{os.getpid()}'
        self.latest = {}
        self.ticks = {}

    def write(self, rules, atomic=False):
        text = (f'collector="127.0.0.1:{self.receiver.getsockname()[1]}"\n'
                'rate_hz=10\ncpu_budget_pct=100\nresource_interval_s=0\nmemory_interval_s=0\n' + rules)
        path = self.path.with_suffix('.new') if atomic else self.path
        path.write_text(text)
        if atomic:
            path.replace(self.path)

    def start(self):
        self.sampler = subprocess.Popen([ROOT / 'build/triangulator-sampler', self.path],
                                        stderr=subprocess.DEVNULL)
        self.addCleanup(stop, self.sampler)

    def child(self, name=None):
        child = start_named(name or self.name)
        self.addCleanup(stop, child)
        return child

    def receive(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.assertIsNone(self.sampler.poll(), 'sampler exited')
            try:
                data = self.receiver.recv(65536)
            except TimeoutError:
                continue
            if data[:4] == b'TTGT':
                fields = ANNOUNCE.unpack(data)
                key = fields[-2].split(b'\0')[0].decode()
                self.assertTrue(key, 'announcements must not expose unused slots')
                if fields[3] & 1:
                    if key in self.latest and self.latest[key]['session'] == fields[5]:
                        del self.latest[key]
                else:
                    self.latest[key] = dict(session=fields[5], pid=fields[6],
                                            flags=fields[3], excluded=fields[4])
            elif data[:4] == b'TMON':
                packet = decode(data)
                self.ticks[packet.session] = packet

    def until(self, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.receive(0.1)
            if predicate():
                return
        self.fail(f'discovery condition failed: {self.latest}')

    def test_arrivals_overlap_reload_invalid_replace_exit_restart_and_sighup(self):
        both = f'process_names=["{self.name}"]\nprocess_patterns=["{self.name}*"]\n'
        self.write(both)
        self.start()
        self.until(lambda: self.latest.get(self.name, {}).get('pid') == 0)
        first, second = self.child(), self.child()
        self.until(lambda: {v['pid'] for v in self.latest.values()} == {first.pid, second.pid})
        original = {k: (v['pid'], v['session']) for k, v in self.latest.items()}
        self.write(f'process_patterns=["{self.name}*"]\n', atomic=True)
        self.until(lambda: all(v['flags'] & 6 == 4 for v in self.latest.values()))
        self.assertEqual(original, {k: (v['pid'], v['session']) for k, v in self.latest.items()})
        self.write(both)
        self.until(lambda: all(v['flags'] & 6 == 6 for v in self.latest.values()))
        self.path.write_text('process_names=["bad"\n')
        self.receive(1.2)
        self.assertEqual(original, {k: (v['pid'], v['session']) for k, v in self.latest.items()})
        for index in range(1000):
            (self.directory / f"event-{index}").write_text("event")
        self.write(f'process_names=["{self.name}","d199-wait"]\n', atomic=True)
        self.until(lambda: 'd199-wait' in self.latest)
        for key, identity in original.items():
            self.assertEqual(identity, (self.latest[key]['pid'], self.latest[key]['session']))
        self.sampler.send_signal(signal.SIGHUP)
        self.receive(1.2)
        for key, identity in original.items():
            self.assertEqual(identity[1], self.latest[key]['session'])
        stop(first)
        self.until(lambda: not any(v['pid'] == first.pid for v in self.latest.values()))
        third = self.child()
        self.until(lambda: third.pid in {v['pid'] for v in self.latest.values()})
        self.assertTrue(all(v['session'] != original[self.name][1]
                            for v in self.latest.values() if v['pid'] == third.pid))
        # Exactly one sampling thread, including reload and churn.
        self.assertEqual(len(list(Path(f'/proc/{self.sampler.pid}/task').iterdir())), 1)

    def test_capacity_and_empty_reload(self):
        children = [self.child() for _ in range(3)]
        self.write(f'process_patterns=["{self.name}*"]\nmax_targets=2\n')
        self.start()
        self.until(lambda: len(self.latest) == 2 and all(v['excluded'] == 1 for v in self.latest.values()))
        self.assertEqual({v['pid'] for v in self.latest.values()}, {p.pid for p in children[:2]})
        before = {k: v['session'] for k, v in self.latest.items()}
        extra = self.child()
        self.receive(1.2)
        self.assertEqual(before, {k: v['session'] for k, v in self.latest.items()})
        self.assertNotIn(extra.pid, {v['pid'] for v in self.latest.values()})
        self.write('process_names=[]\nmax_targets=2\n')
        self.until(lambda: not self.latest)
        self.write(f'process_names=["{self.name}"]\nmax_targets=2\n')
        self.until(lambda: len(self.latest) == 2)
        self.write('process_names=[]\nmax_targets=2\n')
        self.until(lambda: not self.latest)
        self.write(f'target_pid={children[0].pid}\n')
        self.until(lambda: set(self.latest) == {'default'})
        self.assertEqual(self.latest['default']['flags'], 0)
        self.write(f'process_names=["{self.name}"]\nmax_targets=2\n')
        self.until(lambda: len(self.latest) == 2 and 'default' not in self.latest)

    def test_directory_watch_recovery(self):
        self.write('process_names=["d199-before"]\n')
        self.start()
        self.until(lambda: 'd199-before' in self.latest)
        moved = self.directory / 'old'
        moved.mkdir()
        self.path.replace(moved / self.path.name)
        # Move the watched directory itself, then recreate the configured path.
        old_directory = self.directory.with_name(self.directory.name + '-moved')
        self.directory.rename(old_directory)
        self.addCleanup(lambda: __import__('shutil').rmtree(old_directory))
        self.directory.mkdir()
        self.write('process_names=["d199-after"]\n')
        self.until(lambda: 'd199-after' in self.latest, timeout=13)
        self.receive(10.5)
        self.write('process_names=["d199-recovered"]\n')
        self.until(lambda: 'd199-recovered' in self.latest)


if __name__ == '__main__':
    unittest.main()
