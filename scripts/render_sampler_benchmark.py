#!/usr/bin/env python3
"""Render the sampler benchmark page from a complete measurement matrix."""

import argparse
import html
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]


def percentile(values, percent):
    return sorted(values)[max(0, math.ceil(len(values) * percent / 100) - 1)]


def summarize(report):
    if not report.get("complete"):
        raise ValueError("the benchmark report is incomplete")
    if report["thread_counts"] != [100, 300, 500] or report["rates_hz"] != [1, 2, 5, 10]:
        raise ValueError("the page requires 100, 300, 500 threads at 1, 2, 5, 10 Hz")
    expected = {(count, rate, repeat) for count in report["thread_counts"]
                for rate in report["rates_hz"] for repeat in range(1, report["repeats"] + 1)}
    actual = [(run["target_threads"], run["rate_hz"], run["repeat"]) for run in report["runs"]]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("missing or duplicate benchmark trials")
    cells = []
    for rate in report["rates_hz"]:
        for count in report["thread_counts"]:
            runs = [run for run in report["runs"]
                    if run["rate_hz"] == rate and run["target_threads"] == count]
            latency = [value for run in runs for value in run["latency_ms"]]
            if not latency or any(not math.isfinite(value) or value < 0 for value in latency):
                raise ValueError("invalid latency observations")
            if any(len(run["latency_ms"]) != run["thread_ticks"] for run in runs):
                raise ValueError("sample count differs from latency observations")
            mean = lambda name: statistics.mean(run[name] for run in runs)
            cells.append({
                "threads": count, "hz": rate, "p50": statistics.median(latency),
                "p95": percentile(latency, 95), "max": max(latency),
                "records_s": mean("thread_records_per_s"), "actual_hz": mean("observed_rate_hz"),
                "cpu": mean("sampler_cpu_percent"), "rss": mean("sampler_rss_mean_mib"),
                "rss_max": max(run["sampler_rss_max_mib"] for run in runs),
                "samples": len(latency), "records": sum(run["thread_records"] for run in runs),
                "p50_run_min": min(run["latency_p50_ms"] for run in runs),
                "p50_run_max": max(run["latency_p50_ms"] for run in runs),
                "workload_cpu": mean("workload_cpu_percent"),
            })
    return cells


def rows(cells):
    return "\n".join(
        f'<tr data-hz="{c["hz"]}"><th scope="row">{c["threads"]}</th><td>{c["hz"]} Hz</td>'
        f'<td>{c["p50"]:.3f}</td><td>{c["p95"]:.3f}</td><td>{c["max"]:.3f}</td>'
        f'<td>{c["records_s"]:,.1f}</td><td>{c["cpu"]:.3f}</td><td>{c["rss"]:.2f}</td>'
        f'<td>{c["samples"]}</td></tr>' for c in cells)


def infographic(cells, report):
    chosen = [c for c in cells if c["hz"] == 10]
    cards = []
    for index, cell in enumerate(chosen):
        x = 40 + index * 296
        cards.append(f'''<g transform="translate({x},104)">
<rect width="280" height="180" rx="16" fill="#151d28" stroke="#303b49"/>
<text x="22" y="36" font-size="15" fill="#bec8d6">{cell['threads']} native threads</text>
<text x="22" y="92" font-size="44" font-weight="700" fill="#d0fc92">{cell['p50']:.2f}<tspan font-size="19" fill="#bec8d6"> ms</tspan></text>
<text x="22" y="119" font-size="13" fill="#bec8d6">Median complete-sample latency</text>
<text x="22" y="154" font-size="15" fill="#f7fafc">{cell['records_s']:,.0f} records/s · {cell['cpu']:.2f}% CPU</text>
</g>''')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="344" viewBox="0 0 960 344" role="img" aria-labelledby="title desc">
<title id="title">Triangulator sampler: measured at 10 Hz</title>
<desc id="desc">100, 300, and 500 native threads. Median latency and delivered thread records per second. CPU is a percentage of one core. One busy target thread; all others sleep.</desc>
<rect width="960" height="344" rx="20" fill="#0c121b"/>
<g font-family="system-ui,sans-serif">
<text x="40" y="42" font-size="12" letter-spacing="2" fill="#d0fc92">TRIANGULATOR / SAMPLER BENCHMARK</text>
<text x="40" y="78" font-size="25" font-weight="650" fill="#f7fafc">Every thread. A few milliseconds.</text>
{''.join(cards)}
<text x="40" y="316" font-size="13" fill="#bec8d6">10 Hz · Linux · {report['repeats']} × {report['duration_s']:g} s per case · Loopback UDP · Host-specific results</text>
</g></svg>'''


def native_section(report):
    if not report.get("complete"):
        raise ValueError("the sampling-loop report is incomplete")
    cells = [row for row in report["summary"] if row["threads"] in (100, 300, 500)]
    if {row["threads"] for row in cells} != {100, 300, 500}:
        raise ValueError("the sampling-loop report is missing required thread counts")
    for row in cells:
        expected = row["thread_records"] * 1e9 / row["total_sampling_ns"]
        if not math.isclose(expected, row["throughput_threads_s"], rel_tol=1e-9):
            raise ValueError("sampling-loop throughput differs from recorded totals")
    cells.sort(key=lambda row: row["threads"])

    def graph(capacity):
        maximum, step = ((math.ceil(max(row["throughput_threads_s"] for row in cells) / 30000) * 30000, 30000)
                         if capacity else (math.ceil(max(row["p99_tick_us"] for row in cells) / 1000) + 1, 1))
        x = lambda count: 56 + count / 500 * 430
        y = lambda value: 250 - value / maximum * 215
        parts = ['<svg class="chart" viewBox="0 0 510 300" role="img" aria-label="'
                 + ('Sampling-loop records per second' if capacity else 'Sampling-loop p50 and p99 latency in milliseconds')
                 + '; exact values are in the following table.">']
        for value in range(0, maximum + 1, step):
            label = f"{value // 1000}k" if capacity and value else str(value)
            parts.append(f'<line x1="56" x2="486" y1="{y(value)}" y2="{y(value)}" class="grid-line"/>'
                         f'<text x="45" y="{y(value)+4}" text-anchor="end">{label}</text>')
        series = [("throughput_threads_s", "#83bfff", False)] if capacity else [
            ("p50_tick_us", "#d0fc92", False), ("p99_tick_us", "#ffd095", True)]
        for field, color, dashed in series:
            values = [(row["threads"], row[field] if capacity else row[field] / 1000) for row in cells]
            path = " ".join(f'{"M" if index == 0 else "L"}{x(count)},{y(value)}'
                            for index, (count, value) in enumerate(values))
            parts.append(f'<path d="{path}" stroke="{color}" class="series {"tail" if dashed else "selected"}"/>')
            for count, value in values:
                parts.append(f'<circle cx="{x(count)}" cy="{y(value)}" r="4.8" fill="{color}" class="point"/>')
                if not dashed:
                    label = f"{value / 1000:.1f}k" if capacity else f"{value:.2f}"
                    parts.append(f'<text x="{x(count)}" y="{y(value)-12}" text-anchor="'
                                 f'{"end" if count == 500 else "middle"}" class="point-label">{label}</text>')
        for count in (0, 100, 300, 500):
            parts.append(f'<text x="{x(count)}" y="274" text-anchor="middle">{count}</text>')
        parts.append('<text x="271" y="297" text-anchor="middle">Native target threads</text></svg>')
        return "".join(parts)

    table = "".join(
        f'<tr><th scope="row">{row["threads"]}</th><td>{row["throughput_threads_s"]:,.0f}</td>'
        f'<td>{row["p50_tick_us"]/1000:.3f}</td><td>{row["p99_tick_us"]/1000:.3f}</td>'
        f'<td>{row["mean_tick_us"]/1000:.3f}</td><td>{row["ticks"]:,}</td></tr>' for row in cells)
    return f'''<section class="section-rule" aria-labelledby="native-title">
<div class="section-top"><div><div class="eyebrow">Sampling loop / No frequency limit</div>
<h2 id="native-title">About {round(statistics.mean(row["throughput_threads_s"] for row in cells)/10000)*10000:,} thread records per second.</h2></div></div>
<p class="hint">A separate benchmark (<code>make benchmark-sampling</code>) times the production thread-reading functions in a continuous loop.
Each count has {report['iterations'] * report['repeats']:,} timed batches. This measures the sampling path before UDP delivery.</p>
<div class="chart-grid"><div class="panel"><h3>Sampling-path latency</h3>
<p class="panel-sub">Milliseconds per batch · production /proc functions</p>{graph(False)}
<div class="legend"><span><i style="--color:var(--green)"></i>p50</span><span><i style="--color:var(--orange)"></i>p99</span></div></div>
<div class="panel"><h3>Sampling-path throughput</h3><p class="panel-sub">Thread records per second · continuous loop</p>{graph(True)}
<p class="chart-note">Total records divided by total timed sampling duration.</p></div></div>
<div class="table-wrap"><table><caption>Direct sampling-loop results from <code>build/sampling-performance.json</code>. UDP, auxiliary sampling, and collector work are outside this measurement.</caption>
<thead><tr><th scope="col">Threads</th><th scope="col">Records/s</th><th scope="col">p50 · ms</th><th scope="col">p99 · ms</th><th scope="col">Mean · ms</th><th scope="col">Batches</th></tr></thead><tbody>{table}</tbody></table></div>
<details><summary>Sampling-loop method and evidence</summary><p>The timed batch calls FindTarget, Rescan, and TakeSample,
then retains each complete thread record. It reuses cached file descriptors. CLOCK_MONOTONIC measures each batch.
The loop has no sampling-frequency limit. Percentiles use nearest rank across all {report['repeats']} repeats.</p>
<p>The continuous loop has different cache and scheduling conditions from the frequency-controlled sampler.
The difference between these latency values and UDP delivery latency cannot be attributed to UDP alone.
These values do not establish full sampler or collector capacity.</p>
<pre><code>make benchmark-sampling</code></pre>
<p><a href="sampling-performance.json">Recorded sampling-loop baseline</a> ·
<a href="../tests/benchmark_sampling.cpp">Timed C++ path</a> · <a href="../tests/benchmark_sampling.py">Driver</a></p></details>
</section>'''


def render_page(report, sampling_report=None):
    cells = summarize(report)
    snapshot = {"meta": {key: value for key, value in report.items() if key != "runs"}, "cells": cells}
    template = (ROOT / "scripts/sampler_benchmark_template.html").read_text()
    replacements = {
        "DATA": json.dumps(snapshot, separators=(",", ":")).replace("<", "\\u003c"),
        "ROWS": rows(cells), "HOST": html.escape(report["cpu_model"]),
        "KERNEL": html.escape(report["kernel"]), "DATE": html.escape(report["measured_at_utc"][:10]),
        "DURATION": str(report["duration_s"]), "WARMUP": str(report["warmup_s"]),
        "REPEATS": str(report["repeats"]), "COMMIT": html.escape(report["source_commit"]),
        "HASH": html.escape(report["sampler_sha256"]), "BUILD": html.escape(report["build_options"]),
        "SAMPLES": f'{sum(c["samples"] for c in cells):,}',
        "RECORDS": f'{sum(c["records"] for c in cells):,}',
        "RUNS": str(len(report["runs"])),
        "CPUS": str(len(report["allowed_cpus"])), "MACHINE": html.escape(report["machine"]),
        "NATIVE_SECTION": native_section(sampling_report) if sampling_report is not None else "",
        "SESSION_NOTE": (
            '<p class="hint">The matrix used two measurement sessions. An interrupted turn stopped the first session '
            'after 31 trials. The five missing trials resumed with identical sampler, workload, and driver hashes. '
            'Each trial retained its own warm-up and measurement window. The raw JSON records the interruption.</p>'
            if report.get("resumed_at_utc") else ""
        ),
    }
    for key, value in replacements.items():
        template = template.replace("@@" + key + "@@", value)
    return template


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, nargs="?", default=ROOT / "build/sampler-benchmark.json")
    parser.add_argument("--sampling-report", type=Path, help="optional sampling-loop JSON")
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    sampling_report = json.loads(args.sampling_report.read_text()) if args.sampling_report else None
    output = ROOT / "build"
    output.mkdir(exist_ok=True)
    (output / "sampler-benchmark.json").write_text(args.report.read_text())
    if args.sampling_report:
        (output / "sampling-performance.json").write_text(args.sampling_report.read_text())
    (output / "sampler-benchmark.html").write_text(render_page(report, sampling_report))
    (output / "sampler-benchmark.svg").write_text(infographic(summarize(report), report))
    print("Rendered build/sampler-benchmark.html and build/sampler-benchmark.svg")


if __name__ == "__main__":
    main()
