"""Refresh the run table and the current rows for executed cases."""
import json
from pathlib import Path
import re

run = Path(__file__).resolve().parents[1]
qa = run.parents[1]
cases = qa / 'test-cases.md'
text = cases.read_text()
definitions = []
for section in re.split(r'(?=^## QA-)', text, flags=re.M)[1:]:
    case = re.match(r'## (QA-\d+):', section).group(1)
    revision = re.search(r'^- (?:Case revision|Revision): (\d+)', section, re.M)
    definitions.append((case, int(revision.group(1)) if revision else 1))
definitions += [(case, 1) for case in re.findall(r'^\| (QA-\d+) \|', (qa / 'bug-lab-cases.md').read_text(), re.M)]
definitions.sort()
results = json.loads((run / 'evidence/results.json').read_text())
rows = ['| Case | Revision | Status | Observation |', '| --- | ---: | --- | --- |']
for case, revision in definitions:
    result = results.get(case, {'status': 'NOT_RUN', 'observation': 'Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run.'})
    rows.append(f'| {case} | {revision} | {result["status"]} | {result["observation"]} |')
index = run / 'index.md'
index.write_text(index.read_text().split('<!-- case-results -->')[0] + '<!-- case-results -->\n\n' + '\n'.join(rows) + '\n')
relative = run.relative_to(qa)
for case, result in results.items():
    row = f'| {case} | {result["status"]} | dev-f5a611b (CI, el9-x86_64) | [Run]({relative}/index.md) | [Evidence]({relative}/evidence/observations.json) |'
    text = re.sub(rf'^\| {case} \|.*$', lambda _: row, text, flags=re.M)
cases.write_text(text)
print(f'{len(definitions)} selected; {len(results)} executed.')
