"""Install the downloaded CI packages in an isolated test directory."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import time

root = Path('/tmp/triangulator-qa-react-full-7365dd0')
downloads = root / 'downloads'
home = root / 'triangulator'
if home.exists():
    raise SystemExit('The isolated installation already exists.')
archives = []
for component in ('sampler', 'collector'):
    archive, = downloads.glob(f'triangulator-{component}-*-el9-*.tar.gz')
    subprocess.run(['sha256sum', '-c', archive.name + '.sha256'], cwd=downloads, check=True)
    archives.append({'component': component, 'filename': archive.name,
                     'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
    with tarfile.open(archive) as package:
        package.extractall(root, filter='data')
config = home / 'config'
config.mkdir(exist_ok=True)
sockets = []
for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
    item = socket.socket(socket.AF_INET, kind)
    item.bind(('127.0.0.1', 0))
    sockets.append(item)
http, udp = [item.getsockname()[1] for item in sockets]
fixtures = [subprocess.Popen(['sleep', '86400']) for _ in range(2)]
collector = (home / 'templates/collector.toml').read_text()
for before, after in [('udp_host = "0.0.0.0"', 'udp_host = "127.0.0.1"'),
                      ('udp_port = 9400', f'udp_port = {udp}'),
                      ('http_port = 9401', f'http_port = {http}'),
                      ('sampler_ip = "10.0.0.10"', 'sampler_ip = "127.0.0.1"'),
                      ('max_live_samples = 1000000', 'max_live_samples = 10000')]:
    collector = collector.replace(before, after)
sampler = (home / 'templates/sampler.toml').read_text()
sampler = sampler.replace('target_process = "ghostty"', f'target_pid = {fixtures[0].pid}')
sampler = sampler.replace('10.0.0.5:9400', f'127.0.0.1:{udp}').replace('127.0.0.1:9400', f'127.0.0.1:{udp}')
sampler = sampler.replace('memory_interval_s = 30', 'memory_interval_s = 5')
(config / 'collector.toml').write_text(collector)
(config / 'sampler.toml').write_text(sampler)
for item in sockets:
    item.close()
env = dict(os.environ, TRIANGULATOR_HOME=str(home))
subprocess.run([str(home / 'scripts/start.sh')], env=env, check=True)
state = {'root': str(root), 'home': str(home), 'http_port': http, 'udp_port': udp,
         'url': f'http://127.0.0.1:{http}', 'fixture_pids': [p.pid for p in fixtures],
         'archives': archives, 'version': (home / 'VERSION').read_text().strip(),
         'processes': {p.stem: int(p.read_text()) for p in (home / 'run').glob('*.pid')}}
(root / 'state.json').write_text(json.dumps(state, indent=2))
print(json.dumps(state, indent=2), flush=True)
try:
    while True:
        time.sleep(60)
finally:
    subprocess.run([str(home / 'scripts/stop.sh')], env=env, check=False)
    for fixture in fixtures:
        fixture.terminate()
