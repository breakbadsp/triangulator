"""Opt-in end-to-end test of the real BPF source, not synthetic TSIO data."""
import json
import os
import select
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port(kind):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@unittest.skipUnless(os.environ.get('TRIANGULATOR_BPF_TESTS') == '1',
                     'requires an explicit privileged BPF test environment')
class SocketKernelTests(unittest.TestCase):
    def test_socket_paths_thread_attribution_and_completion_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            udp = free_port(socket.SOCK_DGRAM)
            http = free_port(socket.SOCK_STREAM)
            config = root / 'collector.toml'
            config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp}\n'
                               f'http_host="127.0.0.1"\nhttp_port={http}\n'
                               f'data_dir="{root}/data"\nstore_raw=false\n')
            processes = []
            try:
                collector = subprocess.Popen([str(ROOT / 'build/triangulator-collector'), str(config)],
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(collector)
                target = subprocess.Popen([str(ROOT / 'build/socket-target')], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(target)
                self.assertTrue(select.select([target.stdout], [], [], 5)[0])
                self.assertEqual(target.stdout.readline(), b'ready\n')
                sampler = subprocess.Popen([str(ROOT / 'build/triangulator-socket-sampler'), str(target.pid),
                                             f'127.0.0.1:{udp}', str(ROOT / 'build/socket.bpf.o'),
                                             str(ROOT / 'build/socket-target'), 'TriangulatorMessageProcessed'],
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(sampler)
                deadline = time.monotonic() + 10
                connected = False
                while time.monotonic() < deadline:
                    if sampler.poll() is not None:
                        self.fail(sampler.stderr.read().decode())
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{http}/api/socket-io?pid={target.pid}', timeout=3) as response:
                            initial = json.load(response)
                        if initial.get('available') and initial.get('messages_enabled'):
                            connected = True
                            break
                    except OSError:
                        pass
                    time.sleep(.1)
                self.assertTrue(connected, 'BPF source did not attach')
                target.stdin.write(b's')
                target.stdin.flush()
                self.assertTrue(select.select([target.stdout], [], [], 10)[0])
                done = target.stdout.readline().split()
                self.assertEqual(done[0], b'done')
                partial = int(done[1])
                sampler.terminate()
                self.assertEqual(sampler.wait(timeout=5), 0)
                deadline = time.monotonic() + 5
                data = None
                while time.monotonic() < deadline:
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{http}/api/socket-io?pid={target.pid}', timeout=3) as response:
                            data = json.load(response)
                        if data.get('stopped'):
                            break
                    except OSError:
                        pass
                    time.sleep(.05)
                self.assertTrue(data and data.get('stopped'), data)
                self.assertEqual(data['losses'], '0')
                self.assertEqual(data['totals']['input']['total'], str(6 * 56 + 4 + partial))
                self.assertEqual(data['totals']['output']['total'], str(6 * 56 + 8 + partial))
                self.assertEqual(data['totals']['receives']['total'], str(6 * 7 + 3))
                self.assertEqual(data['totals']['sends']['total'], str(6 * 7 + 3))
                self.assertEqual(data['totals']['messages']['total'], str(6 * 7))
                self.assertEqual({row['kind_id'] for row in data['rows']}, {1, 2, 3, 4, 5, 6})
                marker_rows = [row for row in data['rows'] if row['kind_id'] == 6]
                self.assertEqual(len(marker_rows), 2, 'existing worker must have its own marker counts')
                self.assertEqual(sorted(row['metrics']['messages']['total'] for row in marker_rows), ['35', '7'])
                target.stdin.write(b'q')
                target.stdin.flush()
                self.assertEqual(target.wait(timeout=5), 0)
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)
