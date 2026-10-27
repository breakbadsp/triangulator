#!/usr/bin/env python3
"""Unattended QA-060 sweep: fixed rate and budget pairs, fixed windows.

Usage: qa_cpu_sweep.py --root DIR --out sweep.json [--window 60] [--ceiling 120]
DIR is a qa_setup.py root. Each phase restarts only the sampler with one
rate and budget, polls /api/targets, and stops at the window or the ceiling.
"""
import argparse
import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path

PAIRS = [(5.0, 1.0), (5.0, 0.5), (5.0, 0.1), (1.0, 0.1), (10.0, 0.1), (1.0, 0.01)]
MIN_RATE_HZ = 0.2  # sampler/budget.hpp floor
RECOVERY_FACTOR = 0.6  # sampler/budget.hpp: rate rises only below this share of the budget

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--window', type=float, default=60, help='seconds to observe each phase')
parser.add_argument('--ceiling', type=float, default=120, help='hard wall-clock limit for each phase')
args = parser.parse_args()

state = json.loads((Path(args.root) / 'state.json').read_text())
home = Path(state['home'])
env = dict(os.environ, TRIANGULATOR_HOME=str(home))
config = home / 'config/sampler.toml'
original = config.read_text()


def set_key(text, key, value):
    return re.sub(rf'^{key}\s*=.*$', f'{key} = {value}', text, flags=re.M) if re.search(rf'^{key}\s*=', text, re.M) else text + f'\n{key} = {value}\n'


def poll():
    with urllib.request.urlopen(state['url'] + '/api/targets', timeout=5) as response:
        body = json.load(response)
    targets = body['targets'] if isinstance(body, dict) else body
    live = [t for t in targets if t.get('sampler_cpu_pct') is not None]
    return live[0] if live else None


def phase(rate, budget):
    config.write_text(set_key(set_key(original, 'rate_hz', rate), 'cpu_budget_pct', budget))
    subprocess.run([str(home / 'scripts/stop.sh'), 'sampler'], env=env, check=False, timeout=30)
    subprocess.run([str(home / 'scripts/start.sh'), 'sampler', str(config)], env=env, check=True, timeout=30)
    started = time.monotonic()
    samples, timed_out = [], False
    while time.monotonic() - started < args.window:
        if time.monotonic() - started > args.ceiling:
            timed_out = True
            break
        time.sleep(5)
        try:
            item = poll()
        except OSError:
            continue
        if item:
            samples.append({'t': round(time.monotonic() - started), 'cpu_pct': item['sampler_cpu_pct'],
                            'effective_hz': item['effective_rate_hz'], 'throttled': item['throttled']})
    last = samples[-1] if samples else None
    return {'rate_hz': rate, 'budget_pct': budget, 'timed_out': timed_out, 'samples': samples,
            'min_rate_exceeds_budget': bool(last and last['effective_hz'] <= MIN_RATE_HZ and last['cpu_pct'] > budget),
            'recovery_blocked': bool(last and last['throttled'] and last['cpu_pct'] >= RECOVERY_FACTOR * budget)}


try:
    phases = [phase(rate, budget) for rate, budget in PAIRS]
finally:
    config.write_text(original)
    subprocess.run([str(home / 'scripts/stop.sh'), 'sampler'], env=env, check=False, timeout=30)
Path(args.out).write_text(json.dumps({'window_s': args.window, 'ceiling_s': args.ceiling, 'phases': phases}, indent=1))
print(f'{len(phases)} phases written to {args.out}.')
