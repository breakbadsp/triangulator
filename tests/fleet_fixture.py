#!/usr/bin/env python3
"""Run an isolated collector with many announced targets for Targets overview QA.

Usage: python3 tests/fleet_fixture.py [--targets 20|50|64] [--http-port N]

The script starts build/triangulator-collector with max_targets=64 on free
local ports and a temporary data directory. It sends deterministic sampler
announcements and ticks over UDP, with no real sampler, so each target gets a
fixed assessment:

- absent, critical: the tick reports no target process;
- silent, critical: the target is announced but sends no tick, so its
  live view says the sampler is silent;
- kernel, serious: the main thread stays in uninterruptible kernel wait;
- stopped, warning: the main thread is stopped;
- sleep, healthy: the main thread sleeps.

The real collector cannot produce the No data level for an announced
target: every announced target has a live view. No data shows only when the
page cannot read a live view. Node tests in tests/dashboard_test.js cover it,
and a browser check can make one /api/live request fail.

Identities include long hosts and IDs, and the same process name on several
hosts. The script prints the overview URL and the kind and expected level of
each target, sends a tick each second, and on Ctrl-C or SIGTERM stops the
collector and deletes the data directory.
"""
import argparse
import json
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

from test_multitarget import announce
from wire import HEADER, RECORD, TARGET_ABSENT

ROOT = Path(__file__).resolve().parents[1]
KINDS = ["absent", "kernel", "stopped", "sleep", "sleep", "silent"]
LEVELS = {"absent": "critical", "silent": "critical", "kernel": "serious", "stopped": "warning", "sleep": "good"}
STATES = {"kernel": "D", "stopped": "T", "sleep": "S"}
NAMES = ["postgres", "api-gateway", "worker", "nginx"]


def free_port(kind):
    with socket.socket(type=kind) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def targets(count):
    """Deterministic targets: (session, pid, host, id, name, kind)."""
    result = []
    for index in range(count):
        # Every fourth host name is long enough to wrap on a narrow tile.
        host = f"rack{index % 8:02d}" + (".storage-cluster-eu-west.example.internal" if index % 4 == 0 else "")
        target_id = f"{NAMES[index % len(NAMES)]}-{index:02d}" + ("-primary-replica-shard" if index % 5 == 0 else "")
        result.append((1000 + index, 4000 + index, host, target_id[:31], NAMES[index % len(NAMES)], KINDS[index % len(KINDS)]))
    return result


def tick(session, pid, name, state, sequence):
    if pid is None:
        return HEADER.pack(b"TMON", 2, TARGET_ABSENT, 0, 1, session, sequence, 0,
                           time.monotonic_ns(), time.time_ns(), 1000, 0)
    header = HEADER.pack(b"TMON", 2, 0, 0, 1, session, sequence, 1,
                         time.monotonic_ns(), time.time_ns(), 1000, pid)
    record = RECORD.pack(pid, ord(state), 0, 0, 0, 0, 0, sequence, 0, 0, 0, name.encode(), b"nanosleep")
    return header + record


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--targets", type=int, default=64, choices=range(1, 65), metavar="1..64")
    parser.add_argument("--http-port", type=int, default=0, help="default: a free port")
    args = parser.parse_args()
    http_port, udp_port = args.http_port or free_port(socket.SOCK_STREAM), free_port(socket.SOCK_DGRAM)
    with tempfile.TemporaryDirectory(prefix="tri-fleet-fixture-") as directory:
        config = Path(directory) / "collector.toml"
        config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={http_port}\n'
                          f'data_dir="{directory}/data"\nmax_targets=64\nmax_live_samples=2000\n'
                          'sampler_ips=["127.0.0.1"]\n')
        collector = subprocess.Popen([ROOT / "build/triangulator-collector", config], stdout=subprocess.DEVNULL)
        signal.signal(signal.SIGTERM, signal.default_int_handler)
        sender = socket.socket(type=socket.SOCK_DGRAM)
        fleet = targets(args.targets)
        try:
            base = f"http://127.0.0.1:{http_port}"
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/api/targets", timeout=1).close()
                    break
                except OSError:
                    time.sleep(0.05)
            sequence = 0
            while collector.poll() is None:
                for session, pid, host, target_id, name, kind in fleet:
                    # Announce again now and then, as a sampler does, so a lost datagram heals.
                    if sequence % 10 == 0:
                        sender.sendto(announce(session, target_id, host, 0 if kind == "absent" else pid), ("127.0.0.1", udp_port))
                    if kind != "silent":
                        sender.sendto(tick(session, None if kind == "absent" else pid, name, STATES.get(kind), sequence), ("127.0.0.1", udp_port))
                if sequence == 0:
                    print(json.dumps({"url": base + "/", "pid": collector.pid, "data_dir": directory,
                                      "targets": {f"{host}/{target_id}": [kind, LEVELS[kind]] for _, _, host, target_id, _, kind in fleet}}, indent=1), flush=True)
                sequence += 1
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            sender.close()
            collector.terminate()
            collector.wait(timeout=10)


if __name__ == "__main__":
    main()
