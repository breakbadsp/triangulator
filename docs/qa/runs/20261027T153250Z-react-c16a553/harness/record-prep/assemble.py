#!/usr/bin/env python3
"""Assemble the QA record for run c16a553 from finished result artifacts.

Audit only by default. With --write --run-dir DIR, write DIR/observations.json,
DIR/index.md, DIR/evidence/ (failure screenshots and logs) and DIR/harness/
(scripts and fixture inputs). Never edits the repository, the scratch results,
or the current-result rows and README. Reads all inputs fresh on every run.

Usage:
  python3 assemble.py                       # audit only
  python3 assemble.py --write --run-dir DIR # write (aborts if verdicts missing)
"""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(os.environ.get('SOURCE_ROOT', '/home/daksh/.local/state/triangulator/qa-c16a553')).resolve()
WORKTREE = pathlib.Path(os.environ.get('SOURCE_WORKTREE', '/home/daksh/src/triangulator')).resolve()
RUN = {
    'start_utc': '2026-10-27T15:32:50Z',
    'end_utc': '2026-10-28T02:08:42Z',
    'source_url': 'https://github.com/breakbadsp/triangulator',
    'revision_url': 'https://github.com/breakbadsp/triangulator/commit/c16a55383c4bc6a219c270aa4f7cf9b55c97e45a',
    'workflow_url': 'https://github.com/breakbadsp/triangulator/actions/runs/40505148793',
    'evidence_loss': 'Restarting browser/driver2.mjs overwrote the original browser-continuation.json at 01:34 UTC. Root results notes, qa-020-continuation-failure.png, browser-observations.json, and QA-032/033 counter and schedstat files remain. Current continuation contains QA-089 correction and supplementary QA-032/033 responses.',
    'requested_head': 'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a',
    'workflow': '40505148793',
    'tier': 'Full; 116 cases at c16a553 definitions. QA-007 revision 3 was executed; current revision 4 remains NOT_RUN.',
    'application_urls': ['http://127.0.0.1:19401', 'http://127.0.0.1:19481', 'http://127.0.0.1:19411'],
    'fixture': {'source_revision': 'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a', 'source': 'bug-lab/bugbench.c', 'command': 'cc -O2 -static -pthread bug-lab/bugbench.c -o bugbench', 'compiler': 'GCC 16.2.1 20260810', 'sha256': '52f9421c6f67876a346d77b9b22eb93044025e56f6b267ed2fdb234219cfa237'},
    'sampling_deviation': 'Sequential bug-lab cases used 5 Hz thread samples, 2 s resource, 5 s memory and 1 s recordings. The documented values are 2 Hz, 2 s, 5 s and 5 s. QA-032 used configured 10 Hz. Child configurations are in their source records.',
    'budget': 'The run exceeded 150 tool calls. Full scope, usage-limit interruptions and corrected invalid fixtures increased the run length. No case status depends on this target.',
    'version': 'dev-c16a553',
    'platform': 'Main: AlmaLinux 9.8 (EL9) and AlmaLinux 8.10 (EL8), rootless Podman. Host: Omarchy Linux 7.2.8.',
    'browser': 'Chromium 155.0.8059.84 (fallback). Default viewport 1280x800. Child matrices record other widths.',
    'initial_browser': 'T3 Chrome 152: two snapshot timeouts at 15 s.',
    'build_vs_runtime': 'Build: make check and sanitizer targets compile from source in the checkout. '
                        'Runtime: EL8/EL9 tests use downloaded package tarballs, checked by sha256.',
}
# Child-group results later in this list override earlier rows for the same ID.
SOURCES = [
    ('root', 'results.json'),
    ('static', 'static-tests/results-final.json'),
    ('memory', 'memory-tests/results-final.json'),
    ('replay', 'replay-tests/results-final.json'),
    ('help-layout', 'help-layout-tests/results-final.json'),
    ('fleet', 'fleet-final/results-final.json'),
    ('controls', 'controls-final/results-final.json'),
    ('ui', 'ui-final/results-final.json'),
    ('compat', 'compat-checks/results-final.json'),
    ('fleet-correction', 'fleet-correction.json'),
    ('sampler-restart', 'qa098-restart.json'),
]
# QA-022 is reused from the validated v2 static run only.
REUSED = ('static-v2', 'static-tests/results-v2.json')
REUSED_IDS = {'QA-022'}
BLOCKED_BROWSER_IDS = {'QA-118', 'QA-119', 'QA-120'}
KNOWN = {'PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN'}
DETAIL_WORDS = re.compile(r'note|observ|step|scenario|expect|evidence', re.I)
ID = re.compile(r'^QA-\d{3}$')
PATH = re.compile(r'\.(png|log|json|txt|html|py|sh|js|cjs|mjs|toml)$')
KEYWORD = re.compile(r'fail|invalid|wrong-target|missing-recovery|retry|attempt|crash', re.I)
EXCLUDE = {'node_modules', 'chromium', 'zoom-profile', 'final-zoom-profile', 'install',
           'bugbench', 'artifacts', 'record-prep', '.git'}
HARNESS_DIRS = ['static-tests', 'memory-tests', 'replay-tests', 'help-layout-tests',
                'fleet-final', 'controls-final', 'ui-final', 'compat-checks', 'browser', 'scripts', 'fixtures']
SCRIPT_SUFFIX = {'.py', '.sh', '.js', '.cjs', '.mjs', '.c'}
INPUT_SUFFIX = {'.json', '.toml'}
MAX_INPUT_BYTES = 1_000_000


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def excluded(path):
    try:
        parts = set(path.relative_to(ROOT).parts)
    except ValueError:
        return True
    return bool(parts & EXCLUDE)


def case_map(data, only=None):
    """Return {ID: record} from a root dict, a cases/results dict, or a list with id."""
    found = {}
    if isinstance(data, dict):
        found.update({k: v for k, v in data.items() if ID.match(k)})
        for key in ('cases', 'results'):
            block = data.get(key)
            if isinstance(block, dict):
                found.update({k: v for k, v in block.items() if ID.match(k)})
            elif isinstance(block, list):
                found.update({str(v['id']): v for v in block
                              if isinstance(v, dict) and ID.match(str(v.get('id', '')))})
    if only is not None:
        found = {k: v for k, v in found.items() if k in only}
    return found


def verdict(record):
    value = record.get('status') if isinstance(record, dict) else None
    return value.strip().upper() if isinstance(value, str) and value.strip() else None


def paths_in(value):
    if isinstance(value, str):
        if PATH.search(value) and not re.search(r'\s', value):
            yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from paths_in(item)
    elif isinstance(value, list):
        for item in value:
            yield from paths_in(item)


def resolve(text, base):
    for candidate in (base / text, ROOT / text, ROOT / 'fleet-final' / text, WORKTREE / text):
        if candidate.is_file():
            return candidate.resolve()
    return None


def load_sources():
    sources, rows = {}, collections.defaultdict(list)
    for name, rel in SOURCES + [REUSED]:
        path = ROOT / rel
        if not path.is_file():
            sources[name] = {'path': rel, 'present': False}
            continue
        data = json.loads(path.read_text())
        sources[name] = {'path': rel, 'present': True, 'sha256': sha(path), 'data': data}
        only = REUSED_IDS if name == REUSED[0] else None
        for case_id, record in case_map(data, only).items():
            rows[case_id].append({'source': name, 'status': verdict(record), 'record': record})
    return sources, rows


def collect_evidence(sources, rows):
    """Return (resolved path -> row statuses, missing (source, case, text) tuples)."""
    refs = collections.defaultdict(set)
    missing = set()
    for name, src in sources.items():
        if not src['present']:
            continue
        base = (ROOT / src['path']).parent
        for text in sorted(set(paths_in(src['data']))):
            if '://' in text:
                continue  # product URLs are not files
            hit = resolve(text, base)
            if hit is None:
                missing.add((name, '-', text))
            else:
                refs[hit]  # keep referenced paths even without a case status
    for case_id, hist in rows.items():
        for row in hist:
            base = (ROOT / sources[row['source']]['path']).parent
            for text in set(paths_in(row['record'])):
                hit = resolve(text, base)
                if hit is not None:
                    refs[hit].add(row['status'])
    return refs, missing


def browser_blocked():
    path = ROOT / 'browser-observations.json'
    out = []
    for index, obs in enumerate(json.loads(path.read_text()).get('observations', [])):
        result = obs.get('result') if isinstance(obs, dict) else None
        lab = result.get('labResults') if isinstance(result, dict) else None
        if not isinstance(lab, dict):
            continue
        for case_id in sorted(BLOCKED_BROWSER_IDS & set(lab)):
            entry = lab[case_id] if isinstance(lab[case_id], dict) else {}
            out.append({'source': 'browser-observations.json', 'observation_index': index,
                        'at': obs.get('at'), 'case': case_id,
                        'status': entry.get('status'), 'note': entry.get('note'),
                        'reason': 'Original browser crash. Blocked attempt, not a verdict.'})
    return out


def make_check_meta():
    def logmeta(path):
        return {'path': str(path), 'exists': path.is_file(),
                'sha256': sha(path) if path.is_file() else None}
    meta = {'initial_make_check': logmeta(ROOT / 'make-check.log'),
            'sanitizers_log': logmeta(ROOT / 'sanitizers.log')}
    retry = ROOT / 'checks-retry' / 'results.json'
    if retry.is_file():
        data = json.loads(retry.read_text())
        meta['retry'] = data
        meta['retry_logs'] = [logmeta(pathlib.Path(c['log'])) for c in data.get('commands', [])
                              if isinstance(c, dict) and 'log' in c]
    return meta


def harness_files():
    picks = [p for p in ROOT.glob('*.py')] + [p for p in ROOT.glob('*.sh')]
    picks.extend([ROOT / 'record-prep' / 'assemble.py', ROOT / 'record-prep' / 'update_rows.py'])
    for directory in HARNESS_DIRS:
        for path in (ROOT / directory).rglob('*'):
            if not path.is_file() or excluded(path):
                continue
            is_input = path.suffix in INPUT_SUFFIX and (
                {'fixture', 'fixtures'} & set(path.parts) or path.name.startswith('seed'))
            if path.suffix in SCRIPT_SUFFIX or is_input:
                picks.append(path)
    return sorted({p for p in picks if p.is_file() and (not excluded(p) or p.parent == ROOT / 'record-prep')
                   and p.stat().st_size <= MAX_INPUT_BYTES})


def evidence_files(refs):
    picks = set()
    for path, statuses in refs.items():
        if excluded(path):
            continue
        if path.suffix == '.png' and (any(s != 'PASSED' for s in statuses) or KEYWORD.search(path.name)):
            picks.add(path)
        elif path.suffix in ('.log', '.txt'):
            picks.add(path)
    for path in (ROOT / 'fleet-final').glob('QA-089-first.png'):
        picks.add(path.resolve())
    for path in ROOT.rglob('*.png'):
        if not excluded(path) and KEYWORD.search(path.name):
            picks.add(path.resolve())
    explicit = [ROOT / 'make-check.log', ROOT / 'sanitizers.log', *ROOT.glob('QA-*.log'),
                *(ROOT / 'checks-retry').glob('*.log'), *(ROOT / 'record-prep').glob('final-make-check*.log')]
    picks.update(p.resolve() for p in explicit if p.is_file())
    return sorted(picks)


def audit():
    inv = json.loads((ROOT / 'package-inventory.json').read_text())
    expected = inv['cases']
    sources, rows = load_sources()
    refs, missing_evidence = collect_evidence(sources, rows)

    selected, cases = {}, {}
    for case_id, meta in sorted(expected.items()):
        hist = rows.get(case_id, [])
        last = hist[-1] if hist else None
        status = last['status'] if last else None
        selected[case_id] = status
        cases[case_id] = {
            'revision': meta['revision'], 'status': status,
            'selected_source': last['source'] if last else None,
            # Full records stay in sources[<name>].data; history points at them.
            'history': [{'source': r['source'], 'status': r['status'],
                         'evidence': sorted(set(paths_in(r['record'])))} for r in hist],
        }

    missing = sorted(c for c, s in selected.items() if s is None)
    extra = sorted(set(rows) - set(expected))
    conflicts, suspicious = [], []
    for case_id in sorted(expected):
        hist = rows.get(case_id, [])
        statuses = {r['status'] for r in hist if r['status']}
        if len(statuses) > 1 and case_id != 'QA-089':
            conflicts.append({'case': case_id, 'selected': selected[case_id],
                              'rows': [(r['source'], r['status']) for r in hist],
                              'failure_superseded': 'FAILED' in statuses and selected[case_id] != 'FAILED'})
        status = selected[case_id]
        if status is not None and status not in KNOWN:
            suspicious.append({'case': case_id, 'reason': 'unknown status vocabulary', 'status': status})
        if status in ('PASSED', 'FAILED') and last_detail_missing(rows.get(case_id, [])):
            suspicious.append({'case': case_id, 'reason': 'verdict without note or observations',
                               'status': status})

    packages = []
    for pk in inv['packages']:
        path = pathlib.Path(pk['path'])
        try:
            path = ROOT / path.relative_to('/home/daksh/.local/state/triangulator/qa-c16a553')
        except ValueError:
            pass
        actual = sha(path) if path.is_file() else None
        packages.append({'filename': pk['filename'], 'component': pk.get('component'),
                         'platform': pk.get('platform'), 'version': pk.get('version'),
                         'source_url': pk.get('source_url') or (f"https://github.com/breakbadsp/triangulator/releases/download/v0.1.0/{pk['filename']}" if pk.get('baseline') and pk.get('version') == '0.1.0' else None), 'path': str(path),
                         'inventory_sha256': pk.get('sha256'), 'sha256': actual,
                         'sha256_match': actual is not None and actual == pk.get('sha256'),
                         'checksum_file_match': pk.get('checksum_file_match')})

    blockers, failures = [], []
    invalid_root = json.loads((ROOT / 'invalid-attempts.json').read_text())
    invalid = [{'source': 'invalid-attempts.json', **e} for e in invalid_root] + browser_blocked()
    for name, src in sources.items():
        if not src['present'] or not isinstance(src['data'], dict):
            continue
        for key, value in src['data'].items():
            if value and 'blocker' in key.lower():
                blockers.append({'source': name, 'key': key, 'value': value})
            if value and key in ('failures', 'productFailures'):
                failures.append({'source': name, 'key': key, 'count': len(value)})
            if key in ('invalidAttempts', 'invalid_attempts', 'invalid_or_interrupted_attempts') and isinstance(value, list):
                invalid += [{'source': name, **(e if isinstance(e, dict) else {'value': e})} for e in value]

    return {
        'expected': expected, 'sources': sources, 'cases': cases, 'selected': selected,
        'missing': missing, 'extra': extra, 'conflicts': conflicts, 'suspicious': suspicious,
        'resolved_harness_conflict': {'case': 'QA-089', 'reason': 'Prior FAILED attempts auto-dismissed an unhandled native confirmation. The corrected execution accepted it; prior attempts are invalid, not confirmed product failures.', 'history': rows.get('QA-089', [])},
        'missing_evidence': sorted(missing_evidence), 'packages': packages,
        'blockers': blockers, 'failures': failures, 'invalid': invalid,
        'make_check': make_check_meta(), 'refs': refs,
        'counts': dict(sorted(collections.Counter(s or 'MISSING' for s in selected.values()).items())),
    }


def last_detail_missing(hist):
    if not hist:
        return True
    record = hist[-1]['record']
    return not any(value for key, value in record.items()
                   if key != 'status' and DETAIL_WORDS.search(key))


def print_audit(result):
    print(f"Inventory cases: {len(result['expected'])}")
    print('Counts:', result['counts'])
    print('Missing verdicts:', ', '.join(result['missing']) or 'none')
    print('Extra IDs (not in inventory):', ', '.join(result['extra']) or 'none')
    print('Resolved harness conflict: QA-089 (prior native confirmation was auto-dismissed; invalid attempts retained)')
    print('Conflicts:', ', '.join(c['case'] for c in result['conflicts']) or 'none')
    print('Suspicious:', '; '.join(f"{s['case']} {s['reason']}" for s in result['suspicious']) or 'none')
    present = sum(1 for s in result['sources'].values() if s['present'])
    print(f"Sources present: {present}/{len(result['sources'])}; "
          f"absent: {', '.join(n for n, s in result['sources'].items() if not s['present']) or 'none'}")
    print(f"Evidence references missing: {len(result['missing_evidence'])}")
    for source, _, text in result['missing_evidence'][:10]:
        print(f'  missing: {source}: {text}')
    print(f"Packages sha256 match: {sum(p['sha256_match'] for p in result['packages'])}/{len(result['packages'])}")
    print(f"Invalid attempts (not verdicts): {len(result['invalid'])}; "
          f"blockers: {len(result['blockers'])}; failure lists: {len(result['failures'])}")


def write_run(result, run_dir):
    out = run_dir.resolve()
    evidence_dir, harness_dir = out / 'evidence', out / 'harness'
    copied = []
    for path in evidence_files(result['refs']):
        dest = evidence_dir / path.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        copied.append(str(dest.relative_to(out)))
    harness_copied = []
    for path in harness_files():
        dest = harness_dir / path.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        harness_copied.append(str(dest.relative_to(out)))
    data = {
        'run': RUN,
        'record_validation': {p.name: json.loads(p.read_text()) for p in (ROOT / 'record-prep').glob('*.json')},
        'referenced_observations': {str(p.relative_to(ROOT)): json.loads(p.read_text()) for p in result['refs'] if p.suffix == '.json' and p.is_relative_to(ROOT) and not excluded(p)},
        'supplementary_observations': {str(p.relative_to(ROOT)): json.loads(p.read_text()) for p in [ROOT / 'browser-observations.json', ROOT / 'browser-continuation.json', *ROOT.glob('periodic-*.json')] if p.is_file()},
        'counts': result['counts'],
        'missing_ids': result['missing'],
        'conflicts': result['conflicts'],
        'resolved_harness_conflict': result['resolved_harness_conflict'],
        'suspicious': result['suspicious'],
        'missing_evidence': [list(t) for t in result['missing_evidence']],
        'packages': result['packages'],
        'blockers': result['blockers'],
        'failures': result['failures'],
        'invalid_attempts': result['invalid'],
        'make_check': result['make_check'],
        'cases': result['cases'],
        'sources': {n: {k: v for k, v in s.items()} for n, s in result['sources'].items()},
        'copied_evidence': copied,
        'copied_harness': harness_copied,
    }
    (out / 'observations.json').write_text(
        json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    lines = ['# QA record c16a553', '',
             f"- Run start UTC: {RUN['start_utc']}; workflow {RUN['workflow']}; version {RUN['version']}",
             f"- Requested head: [{RUN['requested_head']}]({RUN['revision_url']}); [workflow]({RUN['workflow_url']})",
             f"- End UTC: {RUN['end_utc'] or 'not recorded'}",
             f"- Evidence loss: {RUN['evidence_loss']}",
             f"- Platform: {RUN['platform']}",
             f"- Browser: {RUN['browser']} Initial: {RUN['initial_browser']}",
             f"- Build vs runtime: {RUN['build_vs_runtime']}",
             f"- Packages: " + ', '.join(f"{p['filename']} ({'ok' if p['sha256_match'] else 'MISMATCH'})"
                                       for p in result['packages']),
             *[f"- [{p['filename']}]({p['source_url']}): SHA256 {p['inventory_sha256']}" for p in result['packages'] if p['source_url']],
             f"- Counts: {result['counts']}",
             f"- Missing verdicts: {', '.join(result['missing']) or 'none'}",
             f"- Conflicts: {', '.join(c['case'] for c in result['conflicts']) or 'none'}",
             f"- Invalid attempts (not verdicts): {len(result['invalid'])}", '', '## Cases']
    for case_id, case in sorted(result['cases'].items()):
        row = result['sources'].get(case['selected_source'], {}).get('data', {})
        record = case_map(row).get(case_id, {})
        note = next((record[k] for k in ('note', 'notes', 'error', 'errors', 'observations', 'observed_expectations') if record.get(k)), '') if isinstance(record, dict) else ''
        if isinstance(note, list):
            note = note[0] if note else ''
        if not isinstance(note, str):
            note = json.dumps(note, ensure_ascii=False)
        note = ' '.join(note.split())[:240].replace('|', r'\|')
        lines.append(f"- {case_id} rev {case['revision']} {case['status'] or 'MISSING'}: {note} [record](observations.json)")
    (out / 'index.md').write_text('\n'.join(lines) + '\n')
    print(f'Wrote {out}: observations.json, index.md, {len(copied)} evidence files, '
          f'{len(harness_copied)} harness files')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--write', action='store_true', help='write observations.json, index.md, evidence, harness')
    parser.add_argument('--run-dir', type=pathlib.Path, help='output directory for --write')
    args = parser.parse_args()
    if args.write and not args.run_dir:
        parser.error('--write requires --run-dir')
    if args.run_dir and not args.write:
        parser.error('--run-dir requires --write')
    result = audit()
    print_audit(result)
    if not args.write:
        return 0
    if result['missing'] or len(result['expected']) != 116:
        print('Refusing to write: case verdicts are missing. Rerun after all results exist.', file=sys.stderr)
        return 2
    write_run(result, args.run_dir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
