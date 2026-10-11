#!/usr/bin/env python3
"""Summarize the manual QA results table.

Usage: scripts/qa_summary.py [--check] [--write-readme] [--github-summary]

Reads the current-result table in docs/qa/test-cases.md and prints a Markdown
summary. --check also verifies that every case definition has a row, that run
and evidence links exist, and that the README summary is current.
--write-readme rewrites the README summary block. --github-summary appends the
summary to the GitHub Actions job summary.
"""
import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "docs" / "qa" / "test-cases.md"
BUG_LAB = ROOT / "docs" / "qa" / "bug-lab-cases.md"
README = ROOT / "README.md"
STATUSES = ("PASSED", "FAILED", "BLOCKED", "NOT_RUN")
START, END = "<!-- qa-summary:start -->", "<!-- qa-summary:end -->"
ROW = re.compile(r"^\| (QA-\d+) \| (\w+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$")
LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def read_rows():
    rows = []
    for line in CASES.read_text().splitlines():
        match = ROW.match(line)
        if match:
            rows.append(tuple(cell.strip() for cell in match.groups()))
    return rows


def defined_ids():
    ids = set(re.findall(r"^## (QA-\d+):", CASES.read_text(), re.M))
    ids |= set(re.findall(r"^\| (QA-\d+) \|", BUG_LAB.read_text(), re.M))
    return ids


def render(rows):
    by_status = {status: [] for status in STATUSES}
    for case, status, *_ in rows:
        by_status.setdefault(status, []).append(case)
    lines = ["| Status | Cases | Case IDs |", "| --- | ---: | --- |"]
    for status in STATUSES:
        ids = "" if status == "PASSED" else ", ".join(by_status[status])
        lines.append(f"| {status} | {len(by_status[status])} | {ids or '-'} |")
    lines.append(f"| **Total** | **{len(rows)}** | |")
    return "\n".join(lines)


def check(rows):
    errors = []
    seen = set()
    for case, status, _, run, evidence in rows:
        if case in seen:
            errors.append(f"{case}: duplicate row")
        seen.add(case)
        if status not in STATUSES:
            errors.append(f"{case}: unknown status {status}")
        for cell in (run, evidence):
            for target in LINK.findall(cell):
                if not (CASES.parent / target).exists():
                    errors.append(f"{case}: missing link target {target}")
        if status == "NOT_RUN" and (run != "-" or evidence != "-"):
            errors.append(f"{case}: NOT_RUN row must not link a run")
        if status != "NOT_RUN" and run == "-":
            errors.append(f"{case}: {status} row has no run link")
    for case in sorted(defined_ids() - seen):
        errors.append(f"{case}: defined but missing from the current-result table")
    for case in sorted(seen - defined_ids()):
        errors.append(f"{case}: result row has no case definition")
    return errors


def readme_block(rows):
    return f"{START}\n{render(rows)}\n{END}"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--write-readme", action="store_true")
    parser.add_argument("--github-summary", action="store_true")
    args = parser.parse_args()
    rows = read_rows()
    if not rows:
        print("no result rows found in docs/qa/test-cases.md", file=sys.stderr)
        return 1
    summary = render(rows)
    print(summary)
    status = 0
    text = README.read_text()
    if START not in text or END not in text:
        print(f"README.md lacks the {START} block", file=sys.stderr)
        return 1
    expected = re.sub(f"{START}.*{END}", lambda _: readme_block(rows), text, flags=re.S)
    if args.write_readme:
        README.write_text(expected)
    if args.check:
        errors = check(rows)
        if expected != text and not args.write_readme:
            errors.append("README.md QA summary is stale; run scripts/qa_summary.py --write-readme")
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        status = 1 if errors else 0
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if args.github_summary and path:
        with open(path, "a") as out:
            out.write("## Manual QA results\n\n" + summary + "\n")
    return status


if __name__ == "__main__":
    sys.exit(main())
