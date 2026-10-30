#!/usr/bin/env python3
"""Run source-built scout MCP checks without starting a sampler.

Usage: python3 scripts/qa/qa_scout_mcp.py --root /tmp/unique-run
Raw MCP replies and component logs remain under root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import time

REPO = Path(__file__).resolve().parents[2]



def port(kind):
    with socket.socket(type=kind) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    # Do not disturb another host sampler.
    active = []
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                if (entry / 'exe').resolve().name == 'triangulator-sampler':
                    active.append(entry.name)
            except OSError:
                pass
    if active:
        (root / 'sampler-blocker.json').write_text(json.dumps(active))
        print('Existing sampler blocks scenario collection: ' + str(active), flush=True)
    env = dict(os.environ, TRIANGULATOR_HOME=str(root), BUG_LAB_DIR=str(root / 'scratch'))
    udp, http = port(socket.SOCK_DGRAM), port(socket.SOCK_STREAM)
    config = root / 'collector.toml'
    config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp}\nhttp_host="127.0.0.1"\nhttp_port={http}\ndata_dir="{root}/data"\nreplay_interval_s=1\n[scout]\nenabled=true\n')
    identity = {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'http_port': http, 'udp_port': udp, 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'platform': subprocess.check_output(['uname', '-a'], text=True).strip(), 'started': time.time(), 'hashes': {str(p): hashlib.sha256((REPO / p).read_bytes()).hexdigest() for p in ['build/tri-scout.mjs', 'build/triangulator-sampler', 'build/triangulator-collector', 'bug-lab/bugbench.c']}}
    (root / 'identity.json').write_text(json.dumps(identity, indent=2))
    owned = []
    logs = []
    def start(argv, label, **kw):
        log = (root / (label + '.log')).open('w')
        logs.append(log)
        p = subprocess.Popen([str(x) for x in argv], env=env, stderr=log, stdout=log, **kw)
        owned.append(p)
        return p
    def stop(p):
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
    mcp = None
    calls = []
    def call(method, params=None):
        request = {'jsonrpc': '2.0', 'id': len(calls) + 1, 'method': method, 'params': params or {}}
        mcp.stdin.write(json.dumps(request) + '\n')
        mcp.stdin.flush()
        if not select.select([mcp.stdout], [], [], 20)[0]:
            raise RuntimeError('MCP response timeout')
        line = mcp.stdout.readline()
        reply = json.loads(line) if line else {'exit': mcp.poll()}
        calls.append({'time': time.time(), 'request': request, 'reply': reply})
        (root / 'mcp.json').write_text(json.dumps(calls, indent=2))
        return reply
    def tool(name, **kw):
        return call('tools/call', {'name': name, 'arguments': kw})
    try:
        start([REPO / 'build/triangulator-collector', config], 'collector')
        time.sleep(2)
        mcp_log = (root / 'serve.log').open('w')
        logs.append(mcp_log)
        mcp = subprocess.Popen(['node', str(REPO / 'build/tri-scout.mjs'), 'serve', '--config', str(config)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=mcp_log, text=True, bufsize=1)
        owned.append(mcp)
        call('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'qa-scout-bugbench', 'version': '1'}})
        call('tools/list')
        tool('list_incidents', window={'start': 0, 'end': time.time()})
        scanner = start(['node', REPO / 'build/tri-scout.mjs', 'scan', '--config', config], 'scan')
        time.sleep(3)
        if scanner.poll() is not None:
            raise RuntimeError('Scanner exited early')
        tool('status_now')
        tool('list_targets')
        tool('list_incidents', window={'start': 0, 'end': time.time()})
        tool('list_incidents', window={'start': 2, 'end': 1})
        tool('get_incident', id='invalid')
        tool('timeseries', target='', metric='invalid', window={'start': 2, 'end': 1})
        config.write_text(config.read_text().replace('enabled=true', 'enabled=false'))
        try:
            tool('status_now')
        except Exception as error:
            (root / 'switch.txt').write_text(str(error))
        scanner.wait(timeout=10)
        (root / 'scanner-exit.txt').write_text(str(scanner.returncode))
        mcp.wait(timeout=10)
        (root / 'switch-exit.txt').write_text(str(mcp.returncode))
    finally:
        for p in reversed(owned):
            stop(p)
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()
