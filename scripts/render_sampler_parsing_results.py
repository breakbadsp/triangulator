#!/usr/bin/env python3
"""Render the recorded parser and sampler benchmarks as an SVG.

The parser means come from `parser-means.json`, a summary of the Hyperfine
runs, so the raw result files are not kept in the repository.
"""
import argparse
import html
import json
from pathlib import Path
import statistics


def render(directory):
    parser = json.loads((directory / "parser-means.json").read_text())
    rows = [(name, parser[key]["before_s"], parser[key]["after_s"], count)
            for name, key, count in (("Thread stat", "stat", 1_000_000),
                                     ("Number · short", "number-short", 10_000_000),
                                     ("Number · mixed", "number-mixed", 10_000_000),
                                     ("Scheduler counters", "schedstat", 3_000_000),
                                     ("I/O counters", "io", 3_000_000))]
    overall = json.loads((directory / "sampler-multi-comparison.json").read_text())["results"]
    before = statistics.mean(row["cpu_percent"] for row in overall if row["label"] == "before")
    after = statistics.mean(row["cpu_percent"] for row in overall if row["label"] == "after")
    profiles = json.loads((directory / "profile-measurements.json").read_text())["results"]
    profile_before = statistics.mean(row["cpu_percent"] for row in profiles if row["label"] == "before")
    profile_after = statistics.mean(row["cpu_percent"] for row in profiles if row["label"] == "after")
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="710" viewBox="0 0 1200 710" role="img" aria-labelledby="title desc">',
             '<title id="title">Sampler parsing benchmarks</title>',
             '<desc id="desc">Isolated parser time reductions and whole-sampler CPU before and after.</desc>',
             '<rect width="1200" height="710" rx="18" fill="#101922"/>',
             '<g font-family="system-ui, sans-serif" fill="#eaf1ef">',
             '<text x="48" y="57" fill="#9ce5b9" font-size="14" font-weight="700" letter-spacing="2">TRIANGULATOR / PERFORMANCE</text>',
             '<text x="48" y="104" font-size="31" font-weight="700">Parser microbenchmarks</text>',
             '<text x="48" y="135" fill="#a9b9c2" font-size="17">Reduction in mean wall time per call · Hyperfine · 15 runs</text>',
             '<text x="48" y="176" fill="#a9b9c2" font-size="14">FUNCTION</text>',
             '<text x="340" y="176" fill="#a9b9c2" font-size="14">FASTER · 0–40%</text>',
             '<text x="805" y="176" fill="#a9b9c2" font-size="14">BEFORE → AFTER (ns / call)</text>']
    for index, (name, original, changed, count) in enumerate(rows):
        y = 204 + index * 55
        improvement = 100 * (1 - changed / original)
        width = max(0, improvement / 40 * 380)
        parts += [f'<text x="48" y="{y + 17}" font-size="18">{html.escape(name)}</text>',
                  f'<rect x="340" y="{y}" width="380" height="22" rx="5" fill="#263743"/>',
                  f'<rect x="340" y="{y}" width="{width:.1f}" height="22" rx="5" fill="#76dca8"/>',
                  f'<text x="735" y="{y + 17}" font-size="17" font-weight="700" fill="#9ce5b9">{improvement:.1f}%</text>',
                  f'<text x="805" y="{y + 17}" font-size="17">{original / count * 1e9:.1f} → {changed / count * 1e9:.1f}</text>']
    parts += ['<line x1="48" y1="500" x2="1152" y2="500" stroke="#3b4d57"/>',
              '<text x="48" y="542" font-size="24" font-weight="700">Whole sampler · 16 × 50 threads · 5 Hz</text>',
              f'<text x="48" y="579" font-size="21" fill="#9ce5b9">12 s trials: {before:.3f}% → {after:.3f}% of one core</text>',
              f'<text x="48" y="610" font-size="21" fill="#9ce5b9">30 s profiles: {profile_before:.3f}% → {profile_after:.3f}% of one core</text>',
              '<text x="48" y="640" fill="#a9b9c2" font-size="16">Three 12 s trials and two 30 s profiles per build. Host was not isolated.</text>',
              '<text x="48" y="682" fill="#a9b9c2" font-size="14">Buffer reuse was tested separately and rejected: it was slower in both comparisons.</text>',
              '</g></svg>']
    return "\n".join(parts) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=Path("results/sampler-parsing"))
    args = parser.parse_args()
    (args.directory / "summary.svg").write_text(render(args.directory))


if __name__ == "__main__":
    main()
