"""Check that the benchmark measures real sampler output at all four rates."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from wire import Packet

import benchmark_sampler


class SamplerBenchmarkTests(unittest.TestCase):
    def test_real_busy_target_and_all_rates(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results.json"
            result = subprocess.run(
                [sys.executable, str(Path(benchmark_sampler.__file__)),
                 "--threads", "500", "--duration", "2", "--warmup", "0.2", "--repeats", "1",
                 "--output", str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["thread_counts"], [500])
            self.assertEqual(report["busy_threads"], 1)
            self.assertTrue(report["complete"])
            self.assertEqual([run["rate_hz"] for run in report["runs"]], [1, 2, 5, 10])
            for run in report["runs"]:
                self.assertGreater(run["sampler_cpu_percent"], 0)
                self.assertGreater(run["workload_cpu_percent"], 0)
                self.assertGreater(run["sampler_rss_mean_mib"], 0)
                self.assertGreaterEqual(run["sampler_rss_max_mib"], run["sampler_rss_mean_mib"])
                self.assertGreaterEqual(run["rss_observations"], 3)
                self.assertGreaterEqual(run["thread_ticks"], 2)
                self.assertIn("late_ticks", run)
                self.assertIn("latencies_over_period", run)
                self.assertAlmostEqual(run["observed_rate_hz"], run["rate_hz"], delta=0.1 * run["rate_hz"])
                self.assertIn(f"| 500 | {run['rate_hz']} Hz |", result.stdout)
                self.assertEqual(len(run["latency_ms"]), run["thread_ticks"])
                self.assertGreater(run["latency_p50_ms"], 0)
                self.assertGreaterEqual(run["latency_p95_ms"], run["latency_p50_ms"])
                self.assertAlmostEqual(run["thread_records_per_s"], 500 * run["rate_hz"],
                                       delta=50 * run["rate_hz"])

    def test_failed_sampler_stops_the_workload(self):
        # The trial context must reap its workload even when sampling fails.
        children = Path("/proc/self/task") / str(os.getpid()) / "children"
        before = children.read_text()
        with self.assertRaisesRegex(RuntimeError, "exited before the next sample"):
            benchmark_sampler.trial(Path("/bin/false"), 1, 2, 0)
        self.assertEqual(children.read_text(), before)

    def test_nonfinite_duration_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(Path(benchmark_sampler.__file__)), "--duration", "nan"],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("duration must be at least 2", result.stderr)

    def test_thread_matrix_and_partial_packet(self):
        # 101 threads exercises the ceiling division and the last partial packet.
        for count in (100, 101, 300):
            with self.subTest(threads=count):
                run = benchmark_sampler.trial(benchmark_sampler.ROOT / "build/triangulator-sampler",
                                              10, 2, 0.2, count)
                self.assertEqual(run["target_threads"], count)
                self.assertEqual(run["thread_records"], count * run["thread_ticks"])

    def stream(self, packets, thread_count=11):
        # Kernel arrival timestamps must define latency even if userspace
        # receives a packet much later. No receiver wall clock is consulted.
        class Receiver:
            def recvmsg(self, *_):
                return (b"TMON", [(benchmark_sampler.socket.SOL_SOCKET,
                                  benchmark_sampler.SO_TIMESTAMPNS_NEW,
                                  benchmark_sampler.TIMESPEC.pack(2, 4_000_000))], 0, None)
        stream = benchmark_sampler.SampleStream(Receiver(), 1, 1, set(range(1, thread_count + 1)))
        decoder = patch.object(benchmark_sampler, "decode", side_effect=packets)
        return stream, decoder

    def packet(self, chunk=0, sequence=0):
        tids = range(1, 11) if chunk == 0 else [11]
        return Packet(0, chunk, 2, 1, sequence, (sequence + 1) * 10**9,
                      2 * 10**9, 1000, 1, tuple(SimpleNamespace(tid=tid) for tid in tids))

    def test_kernel_timestamp_and_complete_sample(self):
        stream, decoder = self.stream([self.packet(), self.packet(chunk=1)])
        with decoder:
            self.assertIsNone(stream.receive())
            _, latency_ms = stream.receive()
        self.assertEqual(latency_ms, 4)

    def test_incomplete_duplicate_and_lost_ticks_are_rejected(self):
        scenarios = [
            ([self.packet(), self.packet(sequence=1)], "incomplete"),
            ([self.packet(), self.packet()], "duplicate"),
            ([self.packet(), self.packet(chunk=1), self.packet(sequence=2),
              self.packet(chunk=1, sequence=2)], "lost"),
            ([self.packet(), replace(self.packet(chunk=1), wall_ns=2 * 10**9 + 1)], "incomplete"),
            ([self.packet(), replace(self.packet(chunk=1), records=(SimpleNamespace(tid=12),))], "thread IDs"),
        ]
        for packets, message in scenarios:
            with self.subTest(message=message):
                stream, decoder = self.stream(packets)
                with decoder, self.assertRaisesRegex(RuntimeError, message):
                    for _ in packets:
                        stream.receive()

    def test_late_tick_is_counted_not_rejected(self):
        stream, decoder = self.stream([self.packet(), self.packet(chunk=1),
                                      replace(self.packet(sequence=1), monotonic_ns=5 * 10**9),
                                      replace(self.packet(chunk=1, sequence=1), monotonic_ns=5 * 10**9)])
        with decoder:
            samples = [stream.receive() for _ in range(4)]
        packets = [sample[0] for sample in samples if sample]
        self.assertEqual(len(packets), 2)
        # Gap 4 s at 1 Hz exceeds 1.5 periods. Latencies of 1 s and over count too.
        self.assertEqual(benchmark_sampler.count_late(packets, [4, 1000], 1), (1, 1))
        self.assertEqual(benchmark_sampler.count_late(packets, [4, 999], 1), (1, 0))

    def test_clock_going_backwards_is_rejected(self):
        stream, decoder = self.stream([self.packet(), self.packet(chunk=1),
                                      replace(self.packet(sequence=1), monotonic_ns=10**9),
                                      replace(self.packet(chunk=1, sequence=1), monotonic_ns=10**9)])
        with decoder:
            stream.receive()
            stream.receive()
            stream.receive()
            with self.assertRaisesRegex(RuntimeError, "did not advance"):
                stream.receive()

    def test_invalid_target_count(self):
        for value in ("0", "501", "-1", "100x"):
            result = subprocess.run([str(benchmark_sampler.TARGET), value],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("thread count must be", result.stderr)
