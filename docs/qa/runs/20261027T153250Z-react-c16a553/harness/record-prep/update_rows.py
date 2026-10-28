#!/usr/bin/env python3
"""Update current results only when the executed case revision still applies."""
import argparse
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('run_dir', type=Path)
parser.add_argument('--write', action='store_true')
args = parser.parse_args()
run = args.run_dir.resolve()
qa = run.parent.parent
report = json.loads((run / 'observations.json').read_text())
assert not report['missing_ids'], 'Run has missing verdicts'
updated, retained = [], []
for name in ('test-cases.md',):
    path = qa / name
    text = path.read_text()
    revisions = {}
    for section in re.split(r'(?=^## QA-)', text, flags=re.M)[1:]:
        case = re.match(r'## (QA-\d+):', section).group(1)
        match = re.search(r'^- (?:Case revision|Revision): (\d+)', section, re.M)
        revisions[case] = int(match.group(1)) if match else 1
    def replace(match):
        case = match.group(1)
        if case not in report['cases']:
            return match.group(0)
        result = report['cases'][case]
        revision = revisions.get(case, 1)
        if revision != result['revision']:
            retained.append({'case': case, 'tested_revision': result['revision'], 'current_revision': revision})
            return match.group(0)
        status = result['status']
        assert status in ('PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN')
        updated.append(case)
        relative = run.relative_to(qa)
        return f'| {case} | {status} | dev-c16a553 (CI) | [Run]({relative}/index.md) | [Evidence]({relative}/observations.json) |'
    changed = re.sub(r'^\| (QA-\d+) \|.*$', replace, text, flags=re.M)
    if args.write:
        path.write_text(changed)
print(json.dumps({'updated': len(updated), 'retained': retained, 'write': args.write}))
