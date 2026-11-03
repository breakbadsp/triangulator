"""Verify capacity safety, comparison rules, and real full-path measurements."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import benchmark_capacity as capacity


class CapacityTests(unittest.TestCase):
    def test_production_binary_cannot_disable_budget(self):
        with self.assertRaisesRegex(RuntimeError, 'separate capacity'):
            capacity.require_capacity_binary(capacity.ROOT / 'build/triangulator-sampler')
        capacity.require_capacity_binary(capacity.BINARY)

    def test_active_sampler_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / '123'
            task.mkdir()
            (task / 'comm').write_text('triangulator-sa\n')
            (task / 'exe').symlink_to(capacity.BINARY)
            with patch.object(capacity, 'Path', return_value=root):
                with self.assertRaisesRegex(RuntimeError, 'another sampler'):
                    capacity.check_no_sampler()

    def test_comparison_rejects_incompatible_results(self):
        report = dict(schema_version=1, method='continuous', threads=101, duration_s=6,
                      warmup_s=1, repeats=2, build_options='c++ -O2', cpu_model='cpu',
                      kernel='linux', allowed_cpus=[0, 1], complete=True,
                      workload_source_sha256='target', receiver_source_sha256='receiver',
                      runs=[{'delivered_records_per_s': 100}, {'delivered_records_per_s': 200}])
        baseline = dict(report, runs=[{'delivered_records_per_s': 100}])
        self.assertEqual(capacity.comparison(report, baseline)['change_percent'], 50)
        for key in ('complete', 'threads', 'build_options', 'method', 'allowed_cpus'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                capacity.comparison(report, dict(baseline, **{key: None}))

    def test_latency_summary_uses_nearest_rank(self):
        summary = capacity.latency_summary([float(value) for value in range(100, 0, -1)])
        self.assertEqual(summary, {'p50_ms': 50, 'p95_ms': 95, 'p99_ms': 99, 'max_ms': 100})

    def test_comparison_reports_latency_when_both_runs_have_it(self):
        report = dict(schema_version=1, method='continuous', threads=101, duration_s=6,
                      warmup_s=1, repeats=2, build_options='c++ -O2', cpu_model='cpu',
                      kernel='linux', allowed_cpus=[0], complete=True,
                      workload_source_sha256='target', receiver_source_sha256='receiver')

        def runs(*p95):
            return [{'delivered_records_per_s': 100, 'latency': {'p95_ms': value}} for value in p95]
        result = capacity.comparison(dict(report, runs=runs(3, 5, 4)), dict(report, runs=runs(2, 2)))
        self.assertEqual(result['latency_p95_change_percent'], 100)
        self.assertEqual(result['baseline_median_latency_p95_ms'], 2)
        # A baseline recorded before latency existed still compares throughput.
        old = dict(report, runs=[{'delivered_records_per_s': 100}])
        self.assertNotIn('latency_p95_change_percent', capacity.comparison(dict(report, runs=runs(3)), old))

    def test_summary_shows_throughput_latency_cpu_and_rss(self):
        report = dict(threads=100, repeats=2, duration_s=35, warmup_s=5, median_records_per_s=150000,
                      min_records_per_s=149000, max_records_per_s=151000,
                      latency=dict(median_p50_ms=0.6, median_p95_ms=0.7, median_p99_ms=0.9, max_ms=7.2),
                      sampler_cpu_percent=dict(median=98.5, max=99.1), sampler_peak_rss_mib=12.5,
                      comparison=dict(change_percent=-1.5, latency_p95_change_percent=3))
        text = '\n'.join(capacity.format_report(report, 'out.json'))
        for expected in ('150000.0 thread records/s', 'p95 0.700 ms', 'worst 7.200 ms',
                         '98.5% of one core', '12.5 MiB', '-1.50%', '+3.00%'):
            self.assertIn(expected, text)

    def test_peak_rss_reads_the_kernel_high_water_mark(self):
        self.assertGreater(capacity.peak_rss_mib(os.getpid()), 1)

    def test_baseline_without_usable_runs_is_rejected(self):
        report = dict(schema_version=1, method='continuous', threads=101, duration_s=6,
                      warmup_s=1, repeats=2, build_options='c++ -O2', cpu_model='cpu',
                      kernel='linux', allowed_cpus=[0], complete=True,
                      workload_source_sha256='target', receiver_source_sha256='receiver')
        for runs in (None, [], [{}], [{'delivered_records_per_s': 0}]):
            with self.subTest(runs=runs), self.assertRaisesRegex(ValueError, 'no usable runs'):
                capacity.check_baseline(report, dict(report, runs=runs))

    def test_incompatible_baseline_fails_before_any_run(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / 'baseline.json'
            baseline.write_text(json.dumps(dict(complete=True, threads=-1, runs=[])))
            output = Path(directory) / 'out.json'
            argv = ['benchmark_capacity.py', '--baseline', str(baseline), '--output', str(output)]
            with patch.object(sys, 'argv', argv), patch.object(capacity, 'trial') as trial, \
                    patch.object(capacity, 'exclusive_host') as host:
                with self.assertRaisesRegex(ValueError, 'differs'):
                    capacity.main()
            trial.assert_not_called()
            host.assert_not_called()
            self.assertFalse(output.exists())

    def test_long_run_requires_resource_and_memory_map_samples(self):
        from collections import Counter
        capacity.require_scheduled_work(Counter(TMON=9), 30)  # shorter than the memory interval
        capacity.require_scheduled_work(Counter(TRES=1, TVMA=1), 35)
        for missing in (Counter(TRES=1), Counter(TVMA=1), Counter(TMON=9)):
            with self.subTest(missing=missing), self.assertRaisesRegex(RuntimeError, 'missing'):
                capacity.require_scheduled_work(missing, 35)

    def test_invalid_duration_starts_no_workload(self):
        result = subprocess.run([sys.executable, str(Path(capacity.__file__)), '--duration', 'nan'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)

    def test_baseline_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / 'baseline.json'
            baseline.write_text('saved baseline')
            result = subprocess.run([sys.executable, str(Path(capacity.__file__)),
                                     '--baseline', str(baseline), '--output', str(baseline)],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(baseline.read_text(), 'saved baseline')

    def test_real_capacity_beyond_budget_window(self):
        # Opt in on a free host: this uses one busy workload thread and one sampler.
        if os.environ.get('TRIANGULATOR_TEST_CAPACITY') != '1':
            self.skipTest('set TRIANGULATOR_TEST_CAPACITY=1 on a host without a sampler')
        children = Path(f'/proc/self/task/{os.getpid()}/children')
        before = children.read_text()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'capacity.json'
            result = subprocess.run([sys.executable, str(Path(capacity.__file__)), '--threads', '101',
                                     '--duration', '6', '--warmup', '1', '--repeats', '2',
                                     '--output', str(output)], capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertTrue(report['complete'])
            self.assertEqual(len(report['runs']), 2)
            self.assertEqual(report['sampler_peak_rss_mib'], max(run['sampler_peak_rss_mib'] for run in report['runs']))
            self.assertGreater(report['sampler_cpu_percent']['median'], 10)
            self.assertEqual(report['latency']['max_ms'], max(run['latency']['max_ms'] for run in report['runs']))
            for run in report['runs']:
                self.assertEqual(len(set(run['thread_ids'])), 101)
                self.assertEqual(run['ticks'], len(run['samples']))
                self.assertEqual(run['thread_records'], 101 * run['ticks'])
                self.assertGreater(run['delivered_records_per_s'], 1010)
                self.assertGreater(run['sampler_cpu_percent'], 10)
                self.assertGreater(run['sampler_peak_rss_mib'], 0)
                latency = run['latency']
                self.assertTrue(0 < latency['p50_ms'] <= latency['p95_ms'] <= latency['p99_ms'] <= latency['max_ms'])
                self.assertEqual(latency['max_ms'], max(row[2] for row in run['samples']))
                self.assertGreaterEqual(run['elapsed_s'], 6)
                sequences = [run['first_sample'][0]] + [row[0] for row in run['samples']]
                self.assertEqual(sequences, list(range(sequences[0], sequences[-1] + 1)))
        self.assertEqual(children.read_text(), before)
