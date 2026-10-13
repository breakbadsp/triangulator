"""Check the target-impact probes, their summaries, and a run against the real sampler."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import benchmark_target_impact as impact


def probe(buckets, max_ns, slow_total_ns=0):
    return {"samples": sum(buckets), "max_ns": max_ns, "slow_total_ns": slow_total_ns,
            "over_10us": 0, "over_100us": 0, "over_1ms": 0, "over_10ms": 0, "buckets": buckets}


class SummaryTests(unittest.TestCase):
    def test_percentile_is_the_bucket_upper_bound_capped_at_the_maximum(self):
        # Bucket 3 holds 4..7 ns; bucket 10 holds 512..1023 ns.
        buckets = [0] * 65
        buckets[3] = 98
        buckets[10] = 2
        data = probe(buckets, max_ns=700)
        self.assertEqual(impact.percentile_ns(data, 50), 8)
        self.assertEqual(impact.percentile_ns(data, 98), 8)
        self.assertEqual(impact.percentile_ns(data, 99), 700)
        self.assertEqual(impact.percentile_ns(data, 100), 700)

    def test_zero_durations_have_a_zero_percentile(self):
        buckets = [0] * 65
        buckets[0] = 5
        self.assertEqual(impact.percentile_ns(probe(buckets, max_ns=0), 99), 0)

    def test_merge_adds_counts_and_keeps_the_largest_maximum(self):
        first, second = [0] * 65, [0] * 65
        first[2], second[2], second[5] = 1, 2, 3
        merged = impact.merge([probe(first, 3, 40), probe(second, 20, 60)])
        self.assertEqual(merged["samples"], 6)
        self.assertEqual(merged["max_ns"], 20)
        self.assertEqual(merged["slow_total_ns"], 100)
        self.assertEqual(merged["buckets"][2], 3)
        self.assertEqual(merged["buckets"][5], 3)

    def test_an_inconsistent_histogram_is_rejected(self):
        broken = probe([1] + [0] * 64, 1)
        broken["samples"] = 2
        with self.assertRaisesRegex(RuntimeError, "inconsistent"):
            impact.check_probe(broken)

    def test_cpus_need_one_per_role_and_must_be_allowed(self):
        allowed = sorted(impact.ALLOWED_CPUS)
        with self.assertRaisesRegex(ValueError, "one per role"):
            impact.choose_cpus(allowed[:2])
        with self.assertRaisesRegex(ValueError, "one per role"):
            impact.choose_cpus([max(allowed) + 1] * len(impact.ROLES))
        self.assertEqual(impact.choose_cpus([allowed[0]] * len(impact.ROLES)),
                         [allowed[0]] * len(impact.ROLES))


class VictimTests(unittest.TestCase):
    def run_victim(self, threads, duration_s, cpu):
        victim = subprocess.Popen(
            [str(impact.VICTIM), str(threads), str(duration_s), *[str(cpu)] * 4],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(victim.communicate)
        self.addCleanup(victim.kill)
        self.assertEqual(victim.stdout.readline().strip(), f"{threads} threads ready")
        return victim

    def test_probes_report_and_the_thread_set_stays_constant(self):
        cpu = min(impact.ALLOWED_CPUS)
        victim = self.run_victim(20, 1, cpu)
        threads = Path(f"/proc/{victim.pid}/task")
        before = {path.name for path in threads.iterdir()}
        self.assertEqual(len(before), 20)
        victim.stdin.write("go\n")
        victim.stdin.flush()
        report = json.loads(victim.stdout.readline())
        probes = {name: impact.check_probe(report[name]) for name in impact.PROBES}
        self.assertGreater(probes["spin"]["samples"], 1000)
        self.assertGreaterEqual(probes["wake"]["samples"], 100)
        self.assertGreater(probes["lock"]["samples"], 100)
        self.assertGreater(probes["mmap"]["samples"], 100)
        # The sampler needs the same threads before, during, and after the probes.
        self.assertEqual({path.name for path in threads.iterdir()}, before)

    def test_closing_stdin_before_the_start_line_does_not_hang(self):
        victim = self.run_victim(10, 1, -1)
        victim.stdin.close()
        self.assertEqual(victim.wait(timeout=10), 0)

    def test_bad_arguments_are_rejected(self):
        result = subprocess.run([str(impact.VICTIM), "4", "1", "-1", "-1", "-1", "-1"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("usage", result.stderr)


class DriverTests(unittest.TestCase):
    def test_real_sampler_against_the_victim(self):
        cpu = min(impact.ALLOWED_CPUS)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "impact.json"
            result = subprocess.run(
                [sys.executable, str(Path(impact.__file__)), "--scenarios", "off", "apart-10hz",
                 "--threads", "50", "--duration", "2", "--warmup", "0.3", "--repeats", "1",
                 "--cpus", *[str(cpu)] * len(impact.ROLES), "--output", str(output)],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertTrue(report["complete"])
            rows = {row["scenario"]: row for row in report["summary"]}
            self.assertEqual(set(rows), {"off", "apart-10hz"})
            self.assertNotIn("sampler", rows["off"])
            self.assertGreater(rows["apart-10hz"]["sampler"]["cpu_percent"], 0)
            self.assertGreater(rows["apart-10hz"]["sampler"]["burst_max_ms"], 0)
            for row in rows.values():
                self.assertEqual(row["probe_seconds"], 2)
                self.assertEqual(set(row["probes"]), set(impact.PROBES))
            for name in ("Spin probe", "Wake probe", "Lock probe", "Mmap probe", "apart-10hz"):
                self.assertIn(name, result.stdout)

    def test_too_few_cpus_are_reported_before_any_run(self):
        result = subprocess.run(
            [sys.executable, str(Path(impact.__file__)), "--cpus", str(min(impact.ALLOWED_CPUS))],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("one per role", result.stderr)


if __name__ == "__main__":
    unittest.main()
