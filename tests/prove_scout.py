#!/usr/bin/env python3
"""Prove scanner/collector read concurrency. Run make scout and make all first."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def port(kind):
    with socket.socket(type=kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    with tempfile.TemporaryDirectory(prefix="scout-concurrency-") as directory:
        home = Path(directory)
        data = home / "data"
        udp, http = port(socket.SOCK_DGRAM), port(socket.SOCK_STREAM)
        config = home / "collector.toml"
        config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp}\nhttp_port={http}\n'
                          f'data_dir="{data}"\nreplay_interval_s=1\n[scout]\nenabled=true\n')
        config.write_text(config.read_text().replace("enabled=true", "enabled=false"))
        disabled = subprocess.run(["node", ROOT / "build/tri-scout.mjs", "scan", "--config", config],
                                  env={**os.environ, "TRIANGULATOR_HOME": str(home)},
                                  capture_output=True, text=True, timeout=5)
        assert disabled.returncode == 2, disabled.stderr
        assert not data.exists(), "disabled scan created data files"
        config.write_text(config.read_text().replace("enabled=false", "enabled=true"))
        processes = []
        with (home / "collector.log").open("w+") as log:
            try:
                collector = subprocess.Popen([ROOT / "build/triangulator-collector", config], stdout=log, stderr=log)
                processes.append(collector)
                target = subprocess.Popen(["sleep", "60"])
                processes.append(target)
                sampler_config = home / "sampler.toml"
                sampler_config.write_text(f'target_pid={target.pid}\nrate_hz=10\ncollector="127.0.0.1:{udp}"\nresource_interval_s=1\n')
                sampler = subprocess.Popen([ROOT / "build/triangulator-sampler", sampler_config], stdout=subprocess.DEVNULL, stderr=log)
                processes.append(sampler)
                with (home / "scout.log").open("w+") as scout_log:
                    scanner = subprocess.Popen(["node", ROOT / "build/tri-scout.mjs", "scan", "--config", config], env={**os.environ, "TRIANGULATOR_HOME": str(home)}, stdout=subprocess.DEVNULL, stderr=scout_log)
                    processes.append(scanner)
                    observations = []
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        assert collector.poll() is None, "collector exited"
                        assert scanner.poll() is None, "scanner exited"
                        store = data / "scout/incidents.sqlite3"
                        if store.exists():
                            with sqlite3.connect(f'file:{store}?mode=ro', uri=True) as db:
                                row = db.execute("SELECT max(ts) FROM cursor").fetchone()
                                if row and row[0] is not None:
                                    observations.append(row[0])
                        if observations and max(observations) - min(observations) >= 4:
                            break
                        time.sleep(0.1)
                    assert observations and max(observations) - min(observations) >= 4, observations
                    config.write_text(config.read_text().replace("enabled=true", "enabled=false"))
                    assert scanner.wait(timeout=5) == 2
                    scout_log.seek(0)
                    scout_text = scout_log.read()
                    assert "tri-scout scan:" not in scout_text, scout_text
                collector.terminate()
                collector.wait(timeout=5)
                log.seek(0)
                text = log.read()
                assert not any(word in text.lower() for word in ("error", "failed", "locked", "busy")), text
                resource_rows = 0
                for path in data.rglob("*.sqlite3"):
                    if path.parent.name in ("replay", "scout"):
                        continue
                    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
                        resource_rows += db.execute("SELECT count(*) FROM resource_sample").fetchone()[0]
                assert resource_rows >= 4, resource_rows
                print(json.dumps({"result": "PASS", "cursor_progress_s": max(observations) - min(observations), "resource_rows": resource_rows, "collector_write_errors": 0, "switch_off_exit": scanner.returncode}))
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)


if __name__ == "__main__":
    main()
