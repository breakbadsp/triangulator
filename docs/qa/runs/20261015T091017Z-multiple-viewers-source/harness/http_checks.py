"""Reproduce supplemental HTTP checks. This is not a browser test."""

import argparse
import concurrent.futures
import hashlib
import http.client
import json
import platform
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time


def free_port(kind):
    with socket.socket(socket.AF_INET, kind) as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def request(port, path="/api/live", body=None, timeout=12):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    started = time.monotonic()
    try:
        headers = {"Content-Type": "application/json", "X-Triangulator": "1"}
        connection.request("GET" if body is None else "POST", path,
                           None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        payload = response.read()
        return {"status": response.status, "seconds": time.monotonic() - started,
                "bytes": len(payload), "data": json.loads(payload)}
    finally:
        connection.close()


def load(port, viewers, rounds=6):
    barrier = threading.Barrier(viewers)

    def viewer(index):
        observations = []
        barrier.wait()
        for iteration in range(rounds):
            started = time.monotonic()
            try:
                result = request(port, timeout=3)
                observations.append({key: result[key] for key in ("status", "seconds", "bytes")})
            except (OSError, http.client.HTTPException) as error:
                observations.append({"error": str(error), "seconds": time.monotonic() - started})
            time.sleep(max(0, 1 - (time.monotonic() - started)))
        return observations

    with concurrent.futures.ThreadPoolExecutor(max_workers=viewers) as pool:
        observations = [item for batch in pool.map(viewer, range(viewers)) for item in batch]
    elapsed = sorted(item["seconds"] for item in observations)
    return {"viewers": viewers, "rounds": rounds, "requests": len(observations),
            "errors": [item for item in observations if item.get("status") != 200],
            "median_ms": elapsed[len(elapsed) // 2] * 1000,
            "p95_ms": elapsed[int((len(elapsed) - 1) * 0.95)] * 1000,
            "max_ms": max(elapsed) * 1000, "response_bytes": observations[0].get("bytes")}


def slow_connection(port, mode):
    before = request(port)["data"]["health"]
    with socket.create_connection(("127.0.0.1", port), timeout=2) as slow:
        if mode != "empty":
            slow.sendall(b"GET /api/live HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ")
        time.sleep(0.2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            probe = pool.submit(request, port)
            if mode == "drip":
                for _ in range(7):
                    slow.sendall(b"x")
                    time.sleep(1)
                still_waiting = not probe.done()
                slow.close()
            else:
                still_waiting = None
            result = probe.result(timeout=12)
    after = result["data"]["health"]
    return {"mode": mode, "other_viewer_seconds": result["seconds"],
            "status": result["status"], "probe_waiting_after_7s": still_waiting,
            "health_before": before, "health_after": after}


def watch_conflict(port):
    original = request(port, "/api/watches")["data"]
    rules_a = [{"prefix": "worker-a", "wake_ms": 500}]
    rules_b = [{"prefix": "worker-b", "wake_ms": 1000}]
    saved_a = request(port, "/api/watches", {"rules": rules_a})
    stale_b = request(port, "/api/watches", {"rules": rules_b})
    final = request(port, "/api/watches")
    request(port, "/api/watches/reset", {})
    return {"initial": original, "first_writer": saved_a,
            "second_writer_with_old_state": stale_b, "final": final}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--port", type=int, help="Use an existing isolated runtime. Skip settings writes.")
    parser.add_argument("--runtime-revision", help="Source revision of the existing runtime.")
    args = parser.parse_args()
    if args.port and not args.runtime_revision:
        parser.error("--port requires --runtime-revision")
    root = args.root.resolve()
    processes = []
    with tempfile.TemporaryDirectory(prefix="triangulator-multi-http-") as directory:
        directory = Path(directory)
        port = args.port or free_port(socket.SOCK_STREAM)
        try:
            if not args.port:
                udp = free_port(socket.SOCK_DGRAM)
                target = subprocess.Popen(["python3", str(root / "tests/sampler_target.py")],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                processes.append(target)
                target.stdout.readline()
                collector_config = directory / "collector.toml"
                collector_config.write_text(
                    f'udp_host="127.0.0.1"\nudp_port={udp}\nhttp_host="127.0.0.1"\n'
                    f'http_port={port}\ndata_dir="{directory}/data"\nstore_raw=false\n'
                    'replay_interval_s=1\nmax_live_samples=10000\n')
                sampler_config = directory / "sampler.toml"
                sampler_config.write_text(f'target_pid={target.pid}\nrate_hz=5\n'
                                          f'collector="127.0.0.1:{udp}"\nresource_interval_s=1\n')
                for name, config in (("collector", collector_config), ("sampler", sampler_config)):
                    processes.append(subprocess.Popen([str(root / f"build/triangulator-{name}"), str(config)],
                                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for _ in range(50):
                try:
                    initial = request(port)
                    if initial["data"].get("threads"):
                        break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("No live threads arrived")
            output = {"source_revision": args.runtime_revision or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
                      "mode": "existing runtime" if args.port else "source build",
                      "platform": platform.platform(), "port": port,
                      "threads": len(initial["data"]["threads"]),
                      "collector_sha256": None if args.port else hashlib.sha256((root / "build/triangulator-collector").read_bytes()).hexdigest(),
                      "load": [load(port, count) for count in (2, 10, 25, 50)],
                      "slow_connections": [slow_connection(port, mode) for mode in ("empty", "partial", "drip")]}
            if not args.port:
                output["watch_conflict"] = watch_conflict(port)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(output, indent=2) + "\n")
            print(json.dumps({"threads": output["threads"], "load": output["load"],
                              "slow_connections": [{key: value for key, value in item.items() if not key.startswith("health_")}
                                                   for item in output["slow_connections"]]}, indent=2))
        finally:
            for process in reversed(processes):
                process.terminate()
            for process in reversed(processes):
                process.wait(timeout=15)


if __name__ == "__main__":
    main()
