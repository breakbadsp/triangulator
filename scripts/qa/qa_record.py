#!/usr/bin/env python3
"""Write a run record and update only the current-result rows that a run executed.

Usage: qa_record.py --run-dir docs/qa/runs/ID --results results.json --label "source abc123"
results.json maps a case to {"status": "PASSED", "observation": "..."}.
"""
import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / 'docs/qa/test-cases.md'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run-dir', required=True)
parser.add_argument('--results', required=True)
parser.add_argument('--label', required=True, help='tested version shown in the current-result row')
parser.add_argument('--evidence', default='evidence/results.json', help='evidence path relative to the run directory')
args = parser.parse_args()

run = Path(args.run_dir).resolve()
results = json.loads(Path(args.results).read_text())
text = CASES.read_text()
revisions = {}
for section in re.split(r'(?=^## QA-)', text, flags=re.M)[1:]:
    case = re.match(r'## (QA-\d+):', section).group(1)
    found = re.search(r'^- (?:Case revision|Revision): (\d+)', section, re.M)
    revisions[case] = found.group(1) if found else '1'
rows = ['| Case | Revision | Status | Observation |', '| --- | ---: | --- | --- |']
rows += [f'| {c} | {revisions.get(c, "?")} | {r["status"]} | {r["observation"]} |' for c, r in sorted(results.items())]
run.mkdir(parents=True, exist_ok=True)
now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
(run / 'index.md').write_text(f'# QA run {run.name}\n\n- Time: {now}\n- Version: {args.label}\n\n' + '\n'.join(rows) + '\n')
rel = run.relative_to(CASES.parent)
for case, result in results.items():
    row = f'| {case} | {result["status"]} | {args.label} | [Run]({rel}/index.md) | [Evidence]({rel}/{args.evidence}) |'
    text, count = re.subn(rf'^\| {case} \|.*$', lambda _: row, text, flags=re.M)
    if count != 1:
        raise SystemExit(f'{case}: expected one current-result row, found {count}.')
CASES.write_text(text)
subprocess.run(['python3', str(ROOT / 'scripts/qa_summary.py'), '--write-readme', '--check'], check=True)
print(f'{len(results)} rows updated.')
