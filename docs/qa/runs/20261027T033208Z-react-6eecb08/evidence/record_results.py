"""Refresh this run's case table and its two executed current-result rows."""
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
results = {
    'QA-001': ('PASSED', 'Both checksums passed. Package startup needed no compiler. The browser showed sleep, PID 33895, fresh sample clocks, one thread, resources, memory data, and recordings.'),
    'QA-002': ('FAILED', 'Manage targets Help covered the confirmation button. The browser click timed out. The second target was not added.'),
}
rows = ['| Case | Revision | Status | Observation |', '| --- | ---: | --- | --- |']
for case, revision in definitions:
    status, observation = results.get(case, ('NOT_RUN', 'Not attempted: stopped at blocking Sanity failure QA-002.'))
    rows.append(f'| {case} | {revision} | {status} | {observation} |')
index = run / 'index.md'
report = index.read_text()
marker = '<!-- case-results -->'
index.write_text(report.split(marker)[0] + marker + '\n\n' + '\n'.join(rows) + '\n')
relative = run.relative_to(qa)
for case, (status, _) in results.items():
    evidence = 'qa002-help-covers-submit.png' if case == 'QA-002' else 'observations.json'
    row = f'| {case} | {status} | dev-6eecb08 (CI, el8-x86_64) | [Run]({relative}/index.md) | [Evidence]({relative}/evidence/{evidence}) |'
    text = re.sub(rf'^\| {case} \|.*$', lambda _: row, text, flags=re.M)
cases.write_text(text)
print(f'{len(definitions)} selected: 1 PASSED, 1 FAILED, {len(definitions) - 2} NOT_RUN')
