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
            for run in report['runs']:
                self.assertEqual(len(set(run['thread_ids'])), 101)
                self.assertEqual(run['ticks'], len(run['samples']))
                self.assertEqual(run['thread_records'], 101 * run['ticks'])
                self.assertGreater(run['delivered_records_per_s'], 1010)
                self.assertGreater(run['sampler_cpu_percent'], 10)
                self.assertGreaterEqual(run['elapsed_s'], 6)
                sequences = [run['first_sample'][0]] + [row[0] for row in run['samples']]
                self.assertEqual(sequences, list(range(sequences[0], sequences[-1] + 1)))
        self.assertEqual(children.read_text(), before)
