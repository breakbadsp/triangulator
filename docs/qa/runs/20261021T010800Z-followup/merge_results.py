"""Merge the reviewed follow-up manifests into the current QA result table."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[4]
STATUSES = {"PASSED", "FAILED", "BLOCKED", "NOT_RUN"}


def read_results(paths):
    results = {}
    for path in paths:
        for row in json.loads(Path(path).read_text()):
            case = row["case_id"]
            if not re.fullmatch(r"QA-\d{3}", case) or case in results:
                raise ValueError(f"Invalid or duplicate case: {case}")
            if row["status"] not in STATUSES or not isinstance(row["revision"], int):
                raise ValueError(f"Invalid status or revision: {case}")
            if row["revision"] < 1 or any(c in row["package"] for c in "|\r\n"):
                raise ValueError(f"Invalid revision or package: {case}")
            for field in ("run", "evidence"):
                target = (ROOT / row[field]).resolve()
                if not target.is_relative_to(ROOT) or not target.is_file():
                    raise ValueError(f"Missing {field} for {case}: {row[field]}")
            results[case] = row
    return results


def merge(document, results):
    found = set()
    lines = []
    for line in document.splitlines():
        match = re.match(r"\| (QA-\d{3}) \|", line)
        if match and match[1] in results:
            case = match[1]
            if case in found:
                raise ValueError(f"Duplicate current-result row: {case}")
            found.add(case)
            row = results[case]
            run = Path(row["run"]).relative_to("docs/qa")
            evidence = Path(row["evidence"]).relative_to("docs/qa")
            line = (f"| {case} | {row['status']} | {row['package']} | "
                    f"[Run]({run}) | [Evidence]({evidence}) |")
        lines.append(line)
    if found != results.keys():
        raise ValueError(f"Cases missing from the table: {sorted(results.keys() - found)}")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", nargs="+")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    results = read_results(arguments.manifests)
    target = ROOT / "docs/qa/test-cases.md"
    before = target.read_text()
    after = merge(before, results)
    print(json.dumps(dict(sorted(Counter(r["status"] for r in results.values()).items()))))
    if arguments.write:
        target.write_text(after)
    if arguments.check and after != before:
        parser.error("The current-result table differs from the reviewed manifests.")


if __name__ == "__main__":
    main()
