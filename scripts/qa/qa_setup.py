#!/usr/bin/env python3
"""Install packages in an isolated TRIANGULATOR_HOME and run owned fixtures.

Usage:
  qa_setup.py start --root DIR --packages DIR [--fixtures N] [--platform TEXT]
  qa_setup.py stop --root DIR

`start` writes DIR/state.json and returns. `stop` ends only the processes
that state.json names.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import tarfile
from pathlib import Path


def set_key(text, key, value):
    line = f'{key} = {value}'
    if re.search(rf'^{key}\s*=', text, re.M):
        return re.sub(rf'^{key}\s*=.*$', lambda _: line, text, flags=re.M)
    return text + '\n' + line + '\n'


def free_ports():
    sockets = []
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        item = socket.socket(socket.AF_INET, kind)
        item.bind(('127.0.0.1', 0))
        sockets.append(item)
    ports = [item.getsockname()[1] for item in sockets]
    for item in sockets:
        item.close()
    return ports


def install(packages, root, platform):
    archives = []
    for component in ('sampler', 'collector'):
        found = [a for a in packages.glob(f'triangulator-{component}-*.tar.gz') if platform in a.name]
        if len(found) != 1:
            raise SystemExit(f'Expected one {component} package matching "{platform}"; found {len(found)}.')
        archive = found[0]
        subprocess.run(['sha256sum', '-c', archive.name + '.sha256'], cwd=packages, check=True)
        archives.append({'component': component, 'filename': archive.name,
                         'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
        with tarfile.open(archive) as package:
            package.extractall(root, filter='data')
    return archives


def start(args):
    root = Path(args.root).resolve()
    home = root / 'triangulator'
    if home.exists():
        raise SystemExit('The isolated installation already exists.')
    root.mkdir(parents=True, exist_ok=True)
    archives = install(Path(args.packages), root, args.platform)
    http, udp = free_ports()
    fixtures = [subprocess.Popen(['sleep', '86400'], start_new_session=True) for _ in range(args.fixtures)]
    config = home / 'config'
    config.mkdir(exist_ok=True)
    collector = (home / 'templates/collector.toml').read_text()
    for key, value in (('udp_host', '"127.0.0.1"'), ('udp_port', udp), ('http_port', http),
                       ('sampler_ip', '"127.0.0.1"'), ('max_live_samples', 10000)):
        collector = set_key(collector, key, value)
    sampler = (home / 'templates/sampler.toml').read_text()
    sampler = re.sub(r'^target_process = .*\n', f'target_pid = {fixtures[0].pid}\n', sampler, flags=re.M)
    sampler = re.sub(r'\d+\.\d+\.\d+\.\d+:9400', f'127.0.0.1:{udp}', sampler)
    sampler = set_key(sampler, 'memory_interval_s', 5)
    (config / 'collector.toml').write_text(collector)
    (config / 'sampler.toml').write_text(sampler)
    env = dict(os.environ, TRIANGULATOR_HOME=str(home))
    subprocess.run([str(home / 'scripts/start.sh')], env=env, check=True)
    state = {'root': str(root), 'home': str(home), 'http_port': http, 'udp_port': udp,
             'url': f'http://127.0.0.1:{http}', 'fixture_pids': [p.pid for p in fixtures],
             'archives': archives, 'version': (home / 'VERSION').read_text().strip()}
    (root / 'state.json').write_text(json.dumps(state, indent=2))
    print(json.dumps(state, indent=2))


def stop(args):
    root = Path(args.root).resolve()
    state = json.loads((root / 'state.json').read_text())
    env = dict(os.environ, TRIANGULATOR_HOME=state['home'])
    subprocess.run([str(Path(state['home']) / 'scripts/stop.sh')], env=env, check=False)
    for pid in state['fixture_pids']:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


parser = argparse.ArgumentParser(description=__doc__)
sub = parser.add_subparsers(dest='command', required=True)
up = sub.add_parser('start')
up.add_argument('--root', required=True)
up.add_argument('--packages', required=True)
up.add_argument('--fixtures', type=int, default=2)
up.add_argument('--platform', default='', help='text the package filename must contain, such as el9')
up.set_defaults(run=start)
down = sub.add_parser('stop')
down.add_argument('--root', required=True)
down.set_defaults(run=stop)
args = parser.parse_args()
args.run(args)
