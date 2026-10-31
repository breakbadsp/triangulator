"""Run the real sampler against safe, named process fixtures and real UDP."""
import os
import json
import sys
from pathlib import Path
import signal
import socket
import struct
import subprocess
import tempfile
import time
import unittest

from test_sampler_control import start_named, stop
from test_multitarget import CollectorCase
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
        self.releases = []

    def write(self, rules, atomic=False, rate=10):
        text = (f'collector="127.0.0.1:{self.receiver.getsockname()[1]}"\n'
                f'rate_hz={rate}\ncpu_budget_pct=100\nresource_interval_s=0\nmemory_interval_s=0\n' + rules)
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
                    self.releases.append((key, fields[5]))
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

    def test_direct_children_follow_their_parent(self):
        parent_name = f'{self.name}p'
        shell = self.directory / parent_name
        shell.symlink_to('/bin/sh')
        parent = subprocess.Popen([shell, '-c', 'sleep 60 & sleep 60 & wait'])
        self.addCleanup(stop, parent)
        self.write(f'process_names=["{parent_name}"]\n')
        self.start()
        self.until(lambda: {'sleep', 'sleep.2'} <= set(self.latest))
        orphans = [self.latest[key]['pid'] for key in ('sleep', 'sleep.2')]
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid in orphans
                                 if Path(f'/proc/{pid}').exists()])
        self.assertTrue(all(self.latest[key]['flags'] & 6 == 4 for key in ('sleep', 'sleep.2')),
                        'a child refuses Remove of its own name')
        parent.kill()
        parent.wait()
        self.until(lambda: not {'sleep', 'sleep.2'} & set(self.latest))

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

    def test_capacity_grow_shrink_keeps_survivors_and_releases_old_sessions(self):
        children = [self.child() for _ in range(3)]
        rules = f'process_patterns=["{self.name}*"]\n'
        self.write(rules + 'max_targets=2\n')
        self.start()
        self.until(lambda: len(self.latest) == 2)
        before = {k: v['session'] for k, v in self.latest.items()}
        self.write(rules + 'max_targets=3\n')
        self.until(lambda: len(self.latest) == 3)
        for key, session in before.items():
            self.assertEqual(self.latest[key]['session'], session)
        removed = next((k, v['session']) for k, v in self.latest.items()
                       if v['pid'] == children[2].pid)
        self.write(rules + 'max_targets=2\n')
        self.until(lambda: removed in self.releases)
        self.assertNotIn(removed[0], self.latest)
        for key, session in before.items():
            self.assertEqual(self.latest[key]['session'], session)

    def test_capacity_shrink_releases_removed_original_session(self):
        children = [self.child() for _ in range(3)]
        rules = f'process_patterns=["{self.name}*"]\n'
        self.write(rules + 'max_targets=3\n')
        self.start()
        self.until(lambda: len(self.latest) == 3)
        before = {k: v.copy() for k, v in self.latest.items()}
        removed = next((k, v['session']) for k, v in before.items()
                       if v['pid'] == children[2].pid)
        self.write(rules + 'max_targets=2\n')
        self.until(lambda: removed in self.releases)
        for key, value in before.items():
            if key != removed[0]:
                self.assertEqual(self.latest[key]['session'], value['session'])

    def rename_child(self, destination):
        code = ("import signal,sys,time; "
                "signal.signal(signal.SIGUSR1, lambda *_: open('/proc/self/comm','w').write(sys.argv[2])); "
                "open('/proc/self/comm','w').write(sys.argv[1]); time.sleep(60)")
        child = subprocess.Popen([sys.executable, '-c', code, self.name, destination])
        self.addCleanup(stop, child)
        deadline = time.monotonic() + 3
        while Path(f'/proc/{child.pid}/comm').read_text().strip() != self.name:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        return child

    def test_rename_to_selected_name_keeps_identity_and_session(self):
        child = self.rename_child("renamed-worker")
        self.write(f'process_names=["{self.name}"]\nprocess_patterns=["renamed-*"]\n')
        self.start()
        self.until(lambda: self.latest.get(self.name, {}).get('pid') == child.pid)
        session = self.latest[self.name]['session']
        child.send_signal(signal.SIGUSR1)
        self.until(lambda: self.latest[self.name]['flags'] & 6 == 4)
        self.assertEqual(self.latest[self.name]['session'], session)
        self.write('process_patterns=["renamed-*"]\n')
        self.receive(1.2)
        self.assertEqual(self.latest[self.name]['session'], session)

    def test_rename_to_unselected_name_releases_session(self):
        child = self.rename_child("unselected")
        self.write(f'process_patterns=["{self.name}*"]\n')
        self.start()
        self.until(lambda: self.latest.get(self.name, {}).get('pid') == child.pid)
        session = self.latest[self.name]['session']
        child.send_signal(signal.SIGUSR1)
        self.until(lambda: (self.name, session) in self.releases)
        self.assertNotIn(self.name, self.latest)

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


class DiscoveryCollectorReloadTests(CollectorCase):
    MAX_TARGETS = 2

    def test_full_collector_rule_and_global_reload_releases_original_session(self):
        names = [f'r199-{os.getpid()}-{suffix}' for suffix in ('a', 'b', 'c')]
        for name in names:
            self.addCleanup(stop, start_named(name))
        config = self.directory / 'sampler.toml'
        def write(selected, rate):
            config.write_text(f'collector="127.0.0.1:{self.udp_port}"\n'
                              f'rate_hz={rate}\ncpu_budget_pct=100\n'
                              'resource_interval_s=0\nmemory_interval_s=0\nmax_targets=2\n'
                              f'process_names={json.dumps(selected)}\n')
        write(names[:2], 10)
        sampler = subprocess.Popen([ROOT / 'build/triangulator-sampler', config],
                                   stderr=subprocess.DEVNULL)
        self.addCleanup(stop, sampler)
        def ids():
            return {key.split('/')[-1] for key in self.targets()}
        self.wait_for(lambda: ids() == set(names[:2]))
        write([names[0], names[2]], 5)
        self.wait_for(lambda: ids() == {names[0], names[2]})


if __name__ == '__main__':
    unittest.main()
