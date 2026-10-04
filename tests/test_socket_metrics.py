"""Exercise TSIO ingestion, day storage, restart and the actual HTTP report."""
import json
import socket
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIRE = struct.Struct('<4sI7Q4I2Q2I5Q16x')


def packet(sequence, index=0, count=2, *, observer=99, tid=51, kind=1,
           input_bytes=0, output_bytes=0, messages=0, flags=1, losses=0,
           wall=None):
    return WIRE.pack(b'TSIO', 1, observer, sequence, (sequence + 10) * 10**9,
                     int((wall or time.time()) * 10**9), 10 * 10**9, 123, losses,
                     50, index, count, flags,
                     123000 if index else 0, (456 if kind != 6 else 0) if index else 0,
                     tid if index else 0, kind if index else 0,
                     input_bytes, output_bytes, sequence if index and kind != 6 else 0,
                     sequence if index and kind != 6 else 0, messages)


def free_port(kind):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class SocketIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.udp = free_port(socket.SOCK_DGRAM)
        self.http = free_port(socket.SOCK_STREAM)
        self.config = self.root / 'collector.toml'
        self.config.write_text(f'udp_host="127.0.0.1"\nudp_port={self.udp}\n'
                               f'http_host="127.0.0.1"\nhttp_port={self.http}\n'
                               f'data_dir="{self.root}/data"\nstore_raw=false\n')
        self.process = None
        self.binary = ROOT / "build/triangulator-collector"
        self.addCleanup(self.stop)
        self.sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.sender.close)
        self.start()

    def start(self):
        self.process = subprocess.Popen([str(self.binary), str(self.config)],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.wait_for(lambda: self.fetch('/api/live').get('health'))

    def stop(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
            output, errors = self.process.communicate(timeout=5)
            self.assertEqual(self.process.returncode, 0, errors.decode())
        self.process = None

    def fetch(self, path='/api/socket-io?pid=50', wait_for_report=True):
        deadline = time.monotonic() + 5
        while True:
            with urllib.request.urlopen(f'http://127.0.0.1:{self.http}{path}', timeout=3) as response:
                data = json.load(response)
            if not wait_for_report or not data.get('loading') or time.monotonic() >= deadline:
                return data
            time.sleep(.05)

    def wait_for(self, function):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                result = function()
                if result is not None and result is not False:
                    return result
            except (OSError, KeyError, ValueError):
                pass
            time.sleep(.05)
        self.fail('collector did not reach expected state')

    def send(self, *packets):
        for data in packets:
            self.sender.sendto(data, ('127.0.0.1', self.udp))

    def snapshot(self, seq, value, **kwargs):
        wall = time.time()
        self.send(packet(seq, wall=wall, **kwargs),
                  packet(seq, 1, input_bytes=value, output_bytes=value // 2, wall=wall, **kwargs))

    def test_dashboard_serves_socket_entrypoint(self):
        # The binary embeds the page. Check the served artifact, so an omitted
        # dashboard commit cannot silently publish an API without its UI.
        with urllib.request.urlopen(f'http://127.0.0.1:{self.http}/', timeout=3) as response:
            page = response.read().decode()
        self.assertIn('id="socket-panel"', page)
        self.assertIn('data-socket-metric="messages"', page)
        self.assertIn("fetch('/api/socket-io?pid='", page)

    def test_storage_rates_loss_duplicates_reordering_restart(self):
        self.assertFalse(self.fetch()['available'])
        self.snapshot(0, 0)
        self.snapshot(1, 100)
        self.snapshot(2, 100)
        self.wait_for(lambda: self.fetch().get('rate_windows') == 2)
        data = self.fetch()
        self.assertEqual(data['totals']['input']['total'], '100')
        self.assertEqual(data['totals']['input']['average'], 50)
        self.assertEqual(data['totals']['input']['minimum'], 0)
        self.assertEqual(data['totals']['input']['maximum'], 100)
        self.assertEqual(data['totals']['messages']['total'], '0')
        # Newest incomplete tick must not erase the previous totals.
        self.send(packet(3))
        time.sleep(.6)
        self.assertEqual(self.fetch()['totals']['input']['total'], '100')
        # A duplicate with altered data must not overwrite the stored record.
        self.send(packet(2, 1, input_bytes=99999))
        # Sequence 4 is entirely missing, then out-of-order complete sequence 5.
        wall = time.time()
        self.send(packet(5, 1, input_bytes=700, wall=wall), packet(5, wall=wall))
        self.wait_for(lambda: self.fetch().get('totals', {}).get('input', {}).get('total') == '700')
        self.assertIsNone(self.fetch()['totals']['input']['current'])
        # Socket observations persist even when proc raw storage is disabled.
        self.stop()
        databases = list((self.root / 'data').glob('*.sqlite3'))
        with sqlite3.connect(databases[0]) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM raw_sample').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM socket_observation').fetchone()[0], 9)
        self.start()
        self.assertEqual(self.fetch()['totals']['input']['total'], '700')
        self.snapshot(6, 750, losses=2)
        self.wait_for(lambda: self.fetch().get('lower_bound'))
        self.assertIsNone(self.fetch()['totals']['input']['average'])
        self.assertIsNone(self.fetch()['totals']['input']['current'])

    def test_marker_session_identity_and_invalid_wire(self):
        self.snapshot(0, 9007199254740993, flags=0)
        self.wait_for(lambda: self.fetch().get('available'))
        self.assertEqual(self.fetch()['totals']['input']['total'], '9007199254740993')
        self.assertIsNone(self.fetch()['totals']['messages']['total'])
        wall = time.time()
        self.send(packet(0, count=2, observer=100, wall=wall),
                  packet(0, 1, observer=100, kind=6, messages=12, wall=wall))
        self.wait_for(lambda: self.fetch().get('observer') == '100')
        self.assertEqual(self.fetch()['totals']['messages']['total'], '12')
        self.assertEqual(self.fetch()['totals']['input']['total'], '0')
        self.assertEqual(self.fetch('/api/socket-io?pid=50&observer=99')['totals']['input']['total'], '9007199254740993')
        self.assertFalse(self.fetch('/api/socket-io?pid=51')['available'])
        for path in ('/api/socket-io?pid=-1', '/api/socket-io?observer=bad'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.fetch(path)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        invalid = bytearray(packet(1))
        invalid[4] = 2
        self.send(bytes(invalid), packet(2)[:-1], packet(3, count=99999))
        self.wait_for(lambda: self.fetch('/api/live').get('health', {}).get('bad_packets', 0) >= 3)
        self.assertEqual(self.fetch()['totals']['messages']['total'], '12')

    def test_day_boundary_partial_snapshot(self):
        self.snapshot(0, 0)
        self.snapshot(1, 125)
        self.wait_for(lambda: self.fetch().get('rate_windows') == 1)
        self.stop()
        current = list((self.root / 'data').glob('*.sqlite3'))[0]
        previous = current.with_name(time.strftime('%Y-%m-%d', time.gmtime(time.time() - 86400)) + '.sqlite3')
        # Simulate packet receipt straddling midnight: one part in each day file.
        with sqlite3.connect(current) as source, sqlite3.connect(previous) as destination:
            source.backup(destination)
            destination.execute('DELETE FROM socket_observation WHERE sequence=1 AND part=1')
            destination.commit()
            source.execute('DELETE FROM socket_observation WHERE sequence=0 OR part=0')
            source.commit()
        self.start()
        data = self.fetch('/api/socket-io?pid=50&observer=99')
        self.assertEqual(data['totals']['input']['total'], '125')
        self.assertEqual(data['rate_windows'], 1)

    def test_report_helper_timeout_does_not_stop_ingestion(self):
        self.stop()
        binaries = self.root / 'bin'
        binaries.mkdir()
        self.binary = binaries / 'triangulator-collector'
        shutil.copyfile(ROOT / 'build/triangulator-collector', self.binary)
        self.binary.chmod(0o755)
        # Missing helper yields an unavailable report, not a collector crash.
        self.start()
        missing = self.fetch()
        self.assertFalse(missing['available'])
        self.assertTrue(missing['refresh_error'])
        helper = binaries / 'triangulator-socket-report'
        helper.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(10)\n')
        helper.chmod(0o755)
        self.snapshot(0, 17)
        started = time.monotonic()
        slow_path = '/api/socket-io?pid=50&observer=99'
        self.assertTrue(self.fetch(slow_path, wait_for_report=False)['loading'])
        self.assertIn('health', self.fetch('/api/live'))
        self.assertLess(time.monotonic() - started, .5, 'slow helper must not block dashboard HTTP')
        result = self.fetch(slow_path)
        self.assertFalse(result['available'])
        self.assertTrue(result['refresh_error'])
        self.assertLess(time.monotonic() - started, 4.5)
        self.assertEqual(Path(f'/proc/{self.process.pid}/task/{self.process.pid}/children').read_text().strip(), '')
        # The main loop continued flushing UDP observations during the report.
        with sqlite3.connect(next((self.root / 'data').glob('*.sqlite3'))) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM socket_observation').fetchone()[0], 2)
        self.assertIn('health', self.fetch('/api/live'))
