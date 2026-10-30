#!/usr/bin/env python3
"""Run source-built scout MCP checks and optional isolated bugbench fixtures.

Usage: python3 scripts/qa/qa_scout_mcp.py --root /tmp/unique-run
Raw MCP replies and component logs remain under root.
Use --bugbench only as PID 1 under unshare --user --map-root-user --pid
--fork --mount-proc. Use a systemd user service with Delegate=yes for cgroups.
Cgroup setup failure blocks only the two constrained fixtures.
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


def run_bugbench(root, env, udp, http, start, stop, tool, selected=None):
    """Exercise real fixtures in a caller-owned PID namespace with private proc."""
    import signal
    import urllib.request
    if os.getpid() != 1:
        raise RuntimeError('Run inside an isolated PID namespace')
    def save(name, data):
        (root / name).write_text(json.dumps(data, indent=2))
    def payload(reply):
        return json.loads(reply['result']['content'][0]['text'])
    def fleet():
        return json.load(urllib.request.urlopen(f'http://127.0.0.1:{http}/api/fleet'))
    cg = Path('/sys/fs/cgroup') / Path('/proc/self/cgroup').read_text().strip().split('::')[1].lstrip('/')
    if cg.name == 'control':
        cg = cg.parent
    constrained = None
    try:
        control = cg / 'control'
        control.mkdir(exist_ok=True)
        for pid in (cg / 'cgroup.procs').read_text().split():
            if pid != '0':
                (control / 'cgroup.procs').write_text(pid)
        (cg / 'cgroup.subtree_control').write_text('+cpu +memory')
        constrained = cg
    except OSError as error:
        (root / 'cgroup-error.txt').write_text(str(error))
    subprocess.run(['gcc', '-O2', '-Wall', '-Wextra', '-pthread', str(REPO / 'bug-lab/bugbench.c'), '-o', str(root / 'bugbench')], check=True)
    sampler_config = root / 'sampler.toml'
    def configure(pid):
        sampler_config.write_text(f'target_pid={pid}\nrate_hz=2\ncollector="127.0.0.1:{udp}"\nresource_interval_s=2\nmemory_interval_s=5\n')
    configure(1)
    sampler = start([REPO / 'build/triangulator-sampler', sampler_config], 'sampler')
    scenarios = 'healthy cpu-spin cpu-oversub cpu-throttle yield-storm lock-convoy deadlock mem-leak mem-oom vm-bloat fd-leak disk-sync major-faults tcp-slow udp-drop close-wait listen-full thread-churn thread-leak stopped'.split()
    results = []
    for index, name in enumerate(scenarios):
        row = {'case': f'QA-{101+index}', 'scenario': name, 'started': time.time(), 'observations': []}
        results.append(row)
        if selected and name not in selected:
            results.pop()
            continue
        print('START ' + name, flush=True)
        if name in ('cpu-throttle', 'mem-oom') and constrained is None:
            row.update(status='BLOCKED', reason='Cannot create delegated cgroup limits')
            save('observations.json', results)
            continue
        app = None
        try:
            group = None
            if name in ('cpu-throttle', 'mem-oom'):
                group = constrained / name
                group.mkdir(exist_ok=True)
                if name == 'cpu-throttle':
                    (group / 'cpu.max').write_text('50000 100000')
                else:
                    for key, value in [('memory.high', '167772160'), ('memory.max', '251658240'), ('memory.swap.max', '0')]:
                        (group / key).write_text(value)
            def limits():
                # Limit CPU fixtures to two CPUs without changing host affinity.
                os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
                if group:
                    (group / 'cgroup.procs').write_text(str(os.getpid()))
            hold = 165 if name == 'thread-leak' else 70
            app = start([root / 'bugbench', 'healthy' if name == 'stopped' else name, str(hold+30)], name, preexec_fn=limits)
            configure(app.pid)
            sampler.send_signal(signal.SIGHUP)
            for elapsed in range(1, hold+1):
                time.sleep(1)
                if name == 'stopped' and elapsed == 45:
                    app.send_signal(signal.SIGSTOP)
                if elapsed % 10 == 0 or elapsed == hold:
                    obs = {'elapsed': elapsed, 'time': time.time(), 'status': payload(tool('status_now')), 'fixture_exit': app.poll()}
                    try:
                        obs['proc_status'] = Path(f'/proc/{app.pid}/status').read_text()
                        obs['schedstat'] = Path(f'/proc/{app.pid}/schedstat').read_text()
                    except FileNotFoundError:
                        pass
                    row['observations'].append(obs)
                    save(name + '-fleet.json', fleet())
                    save('observations.json', results)
            row['incidents'] = payload(tool('list_incidents', window={'start': row['started'], 'end': time.time()}))
            for incident in row['incidents'].get('incidents', [])[:3]:
                tool('get_incident', id=incident['id'])
            if group:
                row['cgroup'] = {key: (group / key).read_text() for key in ('cpu.stat', 'memory.events', 'memory.current')}
            if name == 'stopped':
                app.send_signal(signal.SIGCONT)
                time.sleep(5)
                row['resumed'] = payload(tool('status_now'))
            row['status'] = 'OBSERVED'
        except Exception as error:
            row.update(status='BLOCKED', reason=str(error))
        finally:
            if app:
                if app.poll() is None:
                    app.send_signal(signal.SIGCONT)
                stop(app)
            row['ended'] = time.time()
            save('observations.json', results)
            print('END ' + name + ' ' + row['status'], flush=True)
    stop(sampler)


def check_history(root):
    """Query recorded fixture windows after collection, with no sampler."""
    config = root / 'history.toml'
    config.write_text((root / 'collector.toml').read_text().replace('enabled=false', 'enabled=true'))
    replies = []
    history_sampler = None
    with (root / 'history-collector.log').open('w') as log:
        collector = subprocess.Popen([str(REPO / 'build/triangulator-collector'), str(config)], stdout=log, stderr=log)
        try:
            time.sleep(2)
            if os.getpid() == 1:
                sampler_config = root / 'history-sampler.toml'
                sampler_config.write_text('target_pid=1\nrate_hz=2\ncollector=\"127.0.0.1:' + str(json.loads((root / 'identity.json').read_text())['udp_port']) + '\"\n')
                history_sampler = subprocess.Popen([str(REPO / 'build/triangulator-sampler'), str(sampler_config)], stdout=log, stderr=log)
                time.sleep(4)
            with (root / 'history-serve.log').open('w') as err:
                server = subprocess.Popen(['node', str(REPO / 'build/tri-scout.mjs'), 'serve', '--config', str(config)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True, bufsize=1)
                try:
                    def call(method, params):
                        request = {'jsonrpc': '2.0', 'id': len(replies)+1, 'method': method, 'params': params}
                        server.stdin.write(json.dumps(request)+'\n')
                        server.stdin.flush()
                        if not select.select([server.stdout], [], [], 30)[0]:
                            raise RuntimeError('History MCP timeout')
                        reply = json.loads(server.stdout.readline())
                        replies.append({'request': request, 'reply': reply})
                        (root / 'history-mcp.json').write_text(json.dumps(replies, indent=2))
                    call('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'qa-history', 'version': '1'}})
                    rows = json.loads((root / 'observations.json').read_text())
                    control = {'start': rows[0]['started'], 'end': rows[0]['ended']}
                    for row in rows:
                        if not row['observations']:
                            continue
                        window = {'start': row['started'], 'end': row['ended']}
                        base = {'target': socket.gethostname()+'/default', 'metric': 'cpu_pct'}
                        for name, extra in [('timeseries', {'window': window}), ('top_threads', {'window': window, 'n': 3}), ('compare', {'window_a': control, 'window_b': window})]:
                            call('tools/call', {'name': name, 'arguments': {**base, **extra}})
                finally:
                    server.terminate()
                    server.wait(timeout=10)
        finally:
            if history_sampler is not None:
                history_sampler.terminate()
                history_sampler.wait(timeout=10)
            collector.terminate()
            collector.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--history-only', action='store_true')
    parser.add_argument('--bugbench', action='store_true')
    parser.add_argument('--scenarios', nargs='+')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.history_only:
        check_history(root)
        return
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
        if args.bugbench:
            run_bugbench(root, env, udp, http, start, stop, tool, args.scenarios)
        if args.bugbench:
            for row in json.loads((root / 'observations.json').read_text()):
                if not row['observations']:
                    continue
                window = {'start': row['started'], 'end': row['ended']}
                tool('timeseries', target=socket.gethostname() + '/default', metric='cpu_pct', window=window)
                tool('top_threads', target=socket.gethostname() + '/default', metric='cpu_pct', window=window, n=3)
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
