"""Record this package run and update only its executed current results."""
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
results = {
    'QA-001': ('PASSED', 'EL9 sampler and collector checksums passed. Package scripts started both programs without a compiler. Chromium showed sleep PID 210053, one fresh thread, resource data, memory data, and recordings.'),
    'QA-002': ('PASSED', 'Added owned PID 210054 as qa-second, accepted the shared-change confirmation, opened its tile, and reloaded. Both targets remained live. Add target remained the hit target after hover.'),
    'QA-003': ('PASSED', 'Empty input showed Please fill out this field. PID 999999999 showed no running process with PID 999999999 without confirmation. Reload retained only the two saved targets.'),
    'QA-005': ('FAILED', 'Recorded history presets replace the live custom history interval. Return to Live restores the map window and closes the drawer but does not restore the custom history inputs. Reproduced once. The remaining expectations were not completed.'),
}
state = json.loads((run / 'evidence/state.json').read_text())
observations = {
    'source_revision': '7365dd0ef99649fbad818330ce821c6bc552b1a3',
    'version': 'dev-7365dd0', 'platform': 'EL9 archives on Arch Linux x86_64, Linux 7.2.8-9-omarchy',
    'browser': 'Chromium 155.0.8059.84, headless', 'viewport': {'width': 1280, 'height': 713},
    'url': state['url'], 'packages': state['archives'],
    'package_source': 'https://github.com/breakbadsp/triangulator/actions/runs/40480672866',
    'el8': {'checksums': 'PASSED', 'runtime': 'NOT_RUN', 'sampler_sha256': '0f21f453d8c76fb6f416bd50ba46432da273141b1e25bcc98dec2de1d62ac43f', 'collector_sha256': '884f1c4a4404f6f4573affc3ae946d311da80e8eb6db16970a5cd7efa2e77f38'},
    'browser_limit': 'preview_open returned: The calling provider no longer owns an active thread run. Used local Chromium. The first QA-002 attempt lost CDP control after disconnecting with a confirmation open; persistent CDP control completed the retry.',
    'results': {case: {'status': status, 'observation': observation} for case, (status, observation) in results.items()},
    'qa005_attempts': [
        {'live_custom': ['2026-10-27T14:02:17', '2026-10-27T15:03:17'], 'recorded_preset': ['2026-10-27T14:48:28', '2026-10-27T15:03:28'], 'returned_live': ['2026-10-27T14:48:28', '2026-10-27T15:03:28']},
        {'live_custom': ['2026-10-27T14:49:56', '2026-10-27T15:05:56'], 'recorded_preset': ['2026-10-27T14:50:58', '2026-10-27T15:05:58'], 'returned_live': ['2026-10-27T14:50:58', '2026-10-27T15:05:58'], 'reopened_live_drawer': ['2026-10-27T14:51:46', '2026-10-27T15:06:46']},
    ],
}
(run / 'evidence/observations.json').write_text(json.dumps(observations, indent=2) + '\n')
rows = ['| Case | Revision | Status | Observation |', '| --- | ---: | --- | --- |']
for case, revision in definitions:
    status, observation = results.get(case, ('NOT_RUN', 'Stopped at Sanity failure QA-005.'))
    rows.append(f'| {case} | {revision} | {status} | {observation} |')
index = run / 'index.md'
report = index.read_text()
index.write_text(report.split('<!-- case-results -->')[0] + '<!-- case-results -->\n\n' + '\n'.join(rows) + '\n')
relative = run.relative_to(qa)
for case, (status, _) in results.items():
    row = f'| {case} | {status} | dev-7365dd0 (CI, el9-x86_64) | [Run]({relative}/index.md) | [Evidence]({relative}/evidence/observations.json) |'
    text = re.sub(rf'^\| {case} \|.*$', lambda _: row, text, flags=re.M)
cases.write_text(text)
print(f'{len(definitions)} selected: 3 PASSED, 1 FAILED, {len(definitions)-4} NOT_RUN')
