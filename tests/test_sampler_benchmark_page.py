"""Check pooled statistics and reject incomplete published benchmark data."""

import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("renderer", ROOT / "scripts/render_sampler_benchmark.py")
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


class BenchmarkPageTests(unittest.TestCase):
    def report(self):
        runs = []
        for rate in (1, 2, 5, 10):
            for count in (100, 300, 500):
                for repeat, values in enumerate(([1.0], [3.0, 4.0, 9.0]), 1):
                    runs.append({
                        "target_threads": count, "rate_hz": rate, "repeat": repeat,
                        "latency_ms": values, "thread_ticks": len(values),
                        "thread_records_per_s": count * rate,
                        "observed_rate_hz": rate, "sampler_cpu_percent": repeat,
                        "sampler_rss_mean_mib": 2, "sampler_rss_max_mib": 3,
                        "thread_records": count * len(values),
                        "latency_p50_ms": renderer.statistics.median(values),
                        "workload_cpu_percent": 100,
                    })
        return {"complete": True, "thread_counts": [100, 300, 500],
                "rates_hz": [1, 2, 5, 10], "repeats": 2, "runs": runs}

    def test_percentiles_pool_samples_instead_of_averaging_trials(self):
        cells = renderer.summarize(self.report())
        self.assertEqual(len(cells), 12)
        for cell in cells:
            self.assertEqual(cell["p50"], 3.5)
            self.assertEqual(cell["p95"], 9)
            self.assertEqual(cell["cpu"], 1.5)
            self.assertEqual(cell["samples"], 4)
            self.assertEqual(cell["records"], 4 * cell["threads"])
            self.assertEqual(cell["p50_run_min"], 1)
            self.assertEqual(cell["p50_run_max"], 4)
        self.assertIn('<td>3.500</td><td>9.000</td>', renderer.rows(cells))

    def test_incomplete_duplicate_and_missing_trials_are_rejected(self):
        for mutate in (lambda r: r.update(complete=False),
                       lambda r: r["runs"].pop(),
                       lambda r: r["runs"].append(copy.deepcopy(r["runs"][0]))):
            report = self.report()
            mutate(report)
            with self.assertRaises(ValueError):
                renderer.summarize(report)

    def test_invalid_observations_are_rejected(self):
        for value in (float("nan"), float("inf"), -1):
            report = self.report()
            report["runs"][0]["latency_ms"][0] = value
            with self.assertRaisesRegex(ValueError, "invalid latency"):
                renderer.summarize(report)

    def test_sample_count_must_match(self):
        report = self.report()
        report["runs"][0]["thread_ticks"] += 1
        with self.assertRaisesRegex(ValueError, "sample count"):
            renderer.summarize(report)

    def test_rendered_snapshot_escapes_metadata_and_keeps_exact_data(self):
        import json
        report = self.report()
        report.update(cpu_model="<test host>", kernel="test", measured_at_utc="2026-10-12T00:00:00Z",
                      duration_s=30, warmup_s=5, source_commit="test", sampler_sha256="test",
                      build_options="test </script><script>bad()</script>", allowed_cpus=[0], machine="test")
        page = renderer.render_page(report)
        self.assertIn("&lt;test host&gt;", page)
        self.assertNotIn("@@", page)
        start = page.index('<script id="benchmark-data" type="application/json">')
        encoded = page[start:].split(">", 1)[1].split("</script>", 1)[0]
        snapshot = json.loads(encoded)
        self.assertEqual(snapshot["cells"], renderer.summarize(report))
        self.assertNotIn("</script>", encoded)
        self.assertEqual(snapshot["meta"]["build_options"], report["build_options"])

    def test_committed_page_and_infographic_match_the_renderer(self):
        import json
        report = json.loads((ROOT / "docs/sampler-benchmark.json").read_text())
        sampling = json.loads((ROOT / "docs/sampling-performance.json").read_text())
        self.assertEqual((ROOT / "docs/sampler-benchmark.html").read_text(),
                         renderer.render_page(report, sampling),
                         "run scripts/render_sampler_benchmark.py")
        self.assertEqual((ROOT / "docs/assets/sampler-benchmark.svg").read_text(),
                         renderer.infographic(renderer.summarize(report), report),
                         "run scripts/render_sampler_benchmark.py")
