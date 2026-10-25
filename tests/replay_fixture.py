#!/usr/bin/env python3
"""Seed deterministic recording and resource day files for browser proof.

The real collector reads the files. No production endpoint is added.
"""
import argparse
import datetime
import json
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-port", type=int, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--seed", type=Path, required=True)
    args = parser.parse_args()
    seed = json.loads(args.seed.read_text())
    data = args.directory / "data"
    replay = data / "replay"
    replay.mkdir(parents=True)
    for snapshot in seed["snapshots"]:
        timestamp = snapshot["recorded_at"]
        day = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).date().isoformat()
        with sqlite3.connect(replay / f"{day}.sqlite3") as db:
            db.execute("CREATE TABLE IF NOT EXISTS process_snapshot (ts REAL PRIMARY KEY NOT NULL, snapshot TEXT NOT NULL)")
            db.execute("INSERT OR REPLACE INTO process_snapshot VALUES (?,?)", (timestamp, json.dumps(snapshot)))
    for row in seed["resources"]:
        day = datetime.datetime.fromtimestamp(row["ts"], datetime.timezone.utc).date().isoformat()
        with sqlite3.connect(data / f"{day}.sqlite3") as db:
            db.execute("CREATE TABLE IF NOT EXISTS resource_sample (ts REAL, session TEXT, sequence INTEGER, pid INTEGER, elapsed_s REAL, rss_bytes REAL, fd_open INTEGER)")
            db.execute("INSERT INTO resource_sample VALUES (:ts,:session,:sequence,:pid,:elapsed_s,:rss_bytes,:fd_open)", row)
    config = args.directory / "collector.toml"
    with socket.socket(type=socket.SOCK_DGRAM) as probe:
        probe.bind(("127.0.0.1", 0))
        udp_port = probe.getsockname()[1]
    config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={args.http_port}\ndata_dir="{data}"\nreplay_interval_s=0\n')
    collector = subprocess.Popen([ROOT / "build/triangulator-collector", config], stdout=subprocess.DEVNULL)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        while collector.poll() is None:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        collector.terminate()
        try:
            collector.wait(timeout=5)
        except subprocess.TimeoutExpired:
            collector.kill()
            collector.wait()
    if collector.returncode not in (0, -signal.SIGTERM):
        raise SystemExit(collector.returncode)


if __name__ == "__main__":
    main()
