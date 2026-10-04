#!/usr/bin/env python3
"""Run the Python and C++ collectors side by side on the same sampler data.

A UDP tee forwards every sampler datagram to both collectors, each with its
own dashboard and data directory. A live table compares their CPU, memory
and dashboard latency, and checks that they agree on threads and states. The C++
collector does no alerting, so open alerts are compared only when both report them.

Usage: scripts/compare.py [--rate-hz N] [--target-process NAME | --target-pid PID]
                          [--synthetic-threads N] [--duration SECONDS]
Settings come from config/local/{sampler,collector}.toml (run scripts/start.sh
once to create them). Alert delivery (webhook, SMTP, dead-man) is removed from
the comparison configs so alerts are not sent twice. Ctrl-C stops everything.

--synthetic-threads N replaces the real sampler with a generator that sends
N fake threads (10% busy at 100% CPU, the rest idle) for load testing.
--duration stops after that many seconds; a summary table is printed at the
end and saved to .run/compare/summary.md.
"""
import argparse
import json
import os
import random
import statistics
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import tomllib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from triangulator.protocol import HEADER, RECORD  # noqa: E402
RUN = ROOT / ".run/compare"
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def set_keys(text, values):
    """Replace or add top-level `key = value` lines (before the first [table])."""
    lines = text.splitlines()
    head_end = next((index for index, line in enumerate(lines) if line.lstrip().startswith("[")), len(lines))
    head = [line for line in lines[:head_end]
            if not any(re.match(rf"\s*{key}\s*=", line) for key in values)]
    return "\n".join([f"{key} = {value}" for key, value in values.items()] + head + lines[head_end:]) + "\n"


def toml_key(key):
    return key if re.fullmatch(r"[A-Za-z0-9_-]+", key) else json.dumps(key)


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value:
            return "nan"
        if value in (float("inf"), float("-inf")):
            return "inf" if value > 0 else "-inf"
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{toml_key(key)} = {toml_value(item)}" for key, item in value.items()) + "}"
    raise ValueError(f"cannot write {type(value).__name__} values to TOML")


def dump_toml(table, prefix=()):
    """TOML text for a parsed config: scalars, arrays, tables and arrays of tables."""
    def is_table_array(value):
        return isinstance(value, list) and value and all(isinstance(item, dict) for item in value)

    lines = [f"{toml_key(key)} = {toml_value(value)}" for key, value in table.items()
             if not isinstance(value, dict) and not is_table_array(value)]
    for key, value in table.items():
        path = (*prefix, key)
        name = ".".join(toml_key(part) for part in path)
        if isinstance(value, dict):
            lines += ["", f"[{name}]", dump_toml(value, path).rstrip("\n")]
        elif is_table_array(value):
            for item in value:
                lines += ["", f"[[{name}]]", dump_toml(item, path).rstrip("\n")]
    return "\n".join(lines).lstrip("\n") + "\n"


def comparison_config(text, values):
    """The collector config for a comparison run: text parsed as TOML, alert
    delivery removed (webhook_url, deadman_url, [alerts.smtp]) wherever and
    however it was written, and the given top-level values set."""
    config = tomllib.loads(text)
    config.pop("deadman_url", None)
    alerts = config.get("alerts")
    if isinstance(alerts, dict):
        alerts.pop("webhook_url", None)
        alerts.pop("smtp", None)
    config.update(values)
    result = dump_toml(config)
    check = tomllib.loads(result)
    if "deadman_url" in check or {"webhook_url", "smtp"} & set(check.get("alerts", {})):
        raise RuntimeError("alert delivery is still configured")
    return result


class Tee(threading.Thread):
    """Forwards each datagram from the sampler to every collector port."""

    def __init__(self, port, targets):
        super().__init__(name="udp-tee", daemon=True)
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        self.receiver.bind(("127.0.0.1", port))
        self.sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sender.bind(("127.0.0.1", 0))
        self.targets = [("127.0.0.1", target) for target in targets]
        self.datagrams = 0

    def run(self):
        while True:
            try:
                data = self.receiver.recv(2048)
            except OSError:
                return
            self.datagrams += 1
            for target in self.targets:
                try:
                    self.sender.sendto(data, target)
                except OSError:
                    pass


class SyntheticSampler(threading.Thread):
    """Sends sampler datagrams for p_threads fake threads, like the real sampler."""

    def __init__(self, port, threads, rate_hz):
        super().__init__(name="synthetic-sampler", daemon=True)
        self.address = ("127.0.0.1", port)
        self.threads = threads
        self.interval = 1 / rate_hz
        self.stopped = threading.Event()
        self.returncode = None

    def poll(self):
        return None

    def terminate(self):
        self.stopped.set()

    def wait(self, timeout=None):
        self.join(timeout)

    def run(self):
        session = random.getrandbits(64)
        ticks_per_sample = round(CLOCK_TICKS * self.interval)
        chunks = (self.threads + 9) // 10
        sequence = 0
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.bind(("127.0.0.1", 0))
            next_tick = time.monotonic()
            while not self.stopped.is_set():
                monotonic, wall = time.monotonic_ns(), time.time_ns()
                records = []
                for index in range(self.threads):
                    busy = index % 10 == 0
                    records.append(RECORD.pack(
                        100000 + index, ord("R" if busy else "S"), 0, index % 8,
                        sequence * ticks_per_sample if busy else sequence // 50, 0,
                        sequence * 1000, sequence, 0, 0, 0,
                        f"worker-{index}".encode()[:15].ljust(16, b"\0"),
                        (b"" if busy else b"futex_do_wait").ljust(32, b"\0")))
                for chunk in range(chunks):
                    body = records[chunk * 10:(chunk + 1) * 10]
                    header = HEADER.pack(b"TMON", 2, 0, chunk, chunks, session, sequence, len(body),
                                         monotonic, wall, round(self.interval * 1000), os.getpid())
                    sender.sendto(header + b"".join(body), self.address)
                sequence += 1
                next_tick += self.interval
                self.stopped.wait(max(0.0, next_tick - time.monotonic()))


class Collector:
    def __init__(self, name, command, udp_port, http_port, base_config):
        self.name = name
        self.url = f"http://127.0.0.1:{http_port}"
        config = comparison_config(base_config, {
            "udp_host": "127.0.0.1", "udp_port": udp_port, "http_host": "127.0.0.1",
            "http_port": http_port, "sampler_ip": "127.0.0.1",
            "data_dir": str(RUN / f"data-{name}")})
        self.config_path = RUN / f"collector-{name}.toml"
        self.config_path.write_text(config)
        self.log = open(RUN / f"collector-{name}.log", "ab")
        self.process = subprocess.Popen([*command, str(self.config_path)], cwd=ROOT,
                                        stdout=self.log, stderr=subprocess.STDOUT)
        self.last_cpu = None
        self.live = {}

    def cpu_seconds(self):
        fields = Path(f"/proc/{self.process.pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / CLOCK_TICKS

    def memory(self):
        """Resident and proportional set size in bytes (PSS shares libraries fairly)."""
        rss = int(Path(f"/proc/{self.process.pid}/statm").read_text().split()[1]) * PAGE_SIZE
        try:
            rollup = Path(f"/proc/{self.process.pid}/smaps_rollup").read_text()
            pss = int(re.search(r"^Pss:\s+(\d+) kB", rollup, re.M).group(1)) * 1024
        except (OSError, AttributeError):
            pss = None
        return rss, pss

    def os_threads(self):
        return len(list(Path(f"/proc/{self.process.pid}/task").iterdir()))

    def sample(self, now):
        cpu = self.cpu_seconds()
        rate = None
        if self.last_cpu is not None:
            rate = (cpu - self.last_cpu[1]) / (now - self.last_cpu[0]) * 100
        self.last_cpu = (now, cpu)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(self.url + "/api/live", timeout=2) as response:
                body = response.read()
            latency = (time.perf_counter() - started) * 1000
            self.live = json.loads(body)
        except (OSError, ValueError):
            body, latency, self.live = b"", None, {}
        rss, pss = self.memory()
        return {"cpu": cpu, "rate": rate, "rss": rss, "pss": pss, "threads": self.os_threads(),
                "latency": latency, "size": len(body)}

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.log.close()


def fmt(value, unit="", digits=1):
    if value is None:
        return "-"
    return f"{value:.{digits}f}{unit}"


def megabytes(value):
    return "-" if value is None else f"{value / 1048576:.1f} MB"


def agreement(left, right):
    """Differences between two /api/live payloads, as short strings."""
    if not left or not right:
        return ["waiting for both dashboards"]
    problems = []
    left_threads = {item["tid"]: item for item in left.get("threads", [])}
    right_threads = {item["tid"]: item for item in right.get("threads", [])}
    if left_threads.keys() != right_threads.keys():
        problems.append(f"thread sets differ ({len(left_threads.keys() ^ right_threads.keys())} tids)")
    states = sum(left_threads[tid]["state"] != right_threads[tid]["state"]
                 for tid in left_threads.keys() & right_threads.keys())
    if states:
        problems.append(f"{states} threads show a different latest state")

    def alerts(live):
        return {(item["rule"], item["group"], item["tid"]) for item in live["alerts"]}

    # The C++ core collector does no alerting and sends no "alerts" list.
    if "alerts" not in left or "alerts" not in right:
        return problems
    difference = alerts(left) ^ alerts(right)
    if difference:
        problems.append("open alerts differ: " + ", ".join(f"{rule}/{tid}" for rule, _group, tid in sorted(difference)))
    return problems


def render(collectors, stats, tee, started, args):
    python, cpp = stats
    rows = [
        ("CPU now", fmt(python["rate"], "%"), fmt(cpp["rate"], "%")),
        ("CPU total", fmt(python["cpu"], " s", 2), fmt(cpp["cpu"], " s", 2)),
        ("Memory (RSS)", megabytes(python["rss"]), megabytes(cpp["rss"])),
        ("Memory (PSS)", megabytes(python["pss"]), megabytes(cpp["pss"])),
        ("OS threads", python["threads"], cpp["threads"]),
        ("/api/live latency", fmt(python["latency"], " ms", 2), fmt(cpp["latency"], " ms", 2)),
        ("/api/live size", f"{python['size'] / 1024:.1f} KB", f"{cpp['size'] / 1024:.1f} KB"),
    ]
    for label, key in (("Threads tracked", None), ("Open alerts", "alerts")):
        values = []
        for collector in collectors:
            live = collector.live
            if key is None:
                values.append(len(live.get("threads", [])))
            else:
                values.append(len(live[key]) if key in live else "-")
        rows.append((label, *values))
    for label, key, formatter in (("Packet loss", "packet_loss_pct", lambda value: fmt(value, "%")),
                                  ("Bad/dup/late packets", None, None),
                                  ("Raw samples in memory", "raw_samples", str)):
        values = []
        for collector in collectors:
            health = collector.live.get("health", {})
            if key is None:
                values.append(f"{health.get('bad_packets', '-')}/{health.get('duplicates', '-')}/{health.get('late_packets', '-')}")
            else:
                values.append(formatter(health.get(key)) if key in health else "-")
        rows.append((label, *values))
    elapsed = int(time.monotonic() - started)
    lines = ["\x1b[H\x1b[2J" if sys.stdout.isatty() else "",
             f"Triangulator collector comparison · {elapsed // 60}m{elapsed % 60:02d}s · "
             f"{tee.datagrams} datagrams forwarded · sampler {args.rate_hz or 'config'} Hz",
             f"Dashboards: Python {collectors[0].url}   C++ {collectors[1].url}", "",
             f"{'':24}{'Python':>16}{'C++':>16}"]
    lines += [f"{label:24}{str(left):>16}{str(right):>16}" for label, left, right in rows]
    problems = agreement(collectors[0].live, collectors[1].live)
    lines += ["", "Agreement: " + ("threads, states (and open alerts where both report them) match" if not problems else "; ".join(problems)),
              "", f"Logs and configs in {RUN.relative_to(ROOT)}/. Ctrl-C to stop."]
    print("\n".join(lines), flush=True)


def summarize(history, agreed, checked, elapsed, args, tee):
    """Markdown table of the whole run: averages, peaks and agreement."""
    def column(samples):
        timed = [item for item in samples if item["latency"] is not None]
        latencies = sorted(item["latency"] for item in timed)
        first, last = samples[0], samples[-1]
        cpu = (last["cpu"] - first["cpu"]) / max(1e-9, last["time"] - first["time"]) * 100
        return {
            "Average CPU": f"{cpu:.2f}%",
            "Peak CPU (one refresh)": fmt(max((item["rate"] for item in samples if item["rate"] is not None), default=None), "%"),
            "CPU time used": f"{last['cpu']:.2f} s",
            "Peak RSS": megabytes(max(item["rss"] for item in samples)),
            "Peak PSS": megabytes(max((item["pss"] or 0) for item in samples)),
            "/api/live median latency": fmt(statistics.median(latencies) if latencies else None, " ms", 2),
            "/api/live p95 latency": fmt(latencies[int(len(latencies) * 0.95)] if latencies else None, " ms", 2),
            "/api/live size (last)": f"{last['size'] / 1024:.1f} KB",
            "Threads tracked (last)": last["tracked"],
            "Packet loss (last)": fmt(last["loss"], "%"),
        }

    python, cpp = column(history["python"]), column(history["cpp"])
    source = (f"synthetic sampler, {args.synthetic_threads} threads" if args.synthetic_threads
              else "real sampler")
    lines = [f"Run: {source}, {args.rate_hz or 'config'} Hz, {elapsed:.0f} s, "
             f"{tee.datagrams} datagrams to each collector",
             "", "| Measure | Python | C++ |", "|---|---:|---:|"]
    lines += [f"| {label} | {python[label]} | {cpp[label]} |" for label in python]
    lines += [f"| Refreshes where threads and states matched | {agreed}/{checked} | |"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rate-hz", type=float, help="override the sampler rate (0.2..10)")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--target-process", help="override the sampler's target process name")
    target.add_argument("--target-pid", type=int, help="override the sampler's target pid")
    parser.add_argument("--port", type=int, default=9500,
                        help="first of the ports used (tee, collector UDP, dashboards); default 9500")
    parser.add_argument("--refresh", type=float, default=2.0, help="seconds between table updates")
    parser.add_argument("--synthetic-threads", type=int, metavar="N",
                        help="send N fake threads instead of running the real sampler (1..2550)")
    parser.add_argument("--duration", type=float, help="stop after this many seconds and print a summary")
    args = parser.parse_args()
    # Check every argument before anything starts, so a bad value cannot leave
    # collectors running and holding the ports.
    if args.synthetic_threads is not None and not 1 <= args.synthetic_threads <= 2550:
        parser.error("--synthetic-threads must be 1..2550")
    if args.rate_hz is not None and not 0.2 <= args.rate_hz <= 10:
        parser.error("--rate-hz must be 0.2..10")
    if args.refresh <= 0 or (args.duration is not None and args.duration <= 0):
        parser.error("--refresh and --duration must be positive")
    if not 1024 <= args.port <= 65535 - 12:
        parser.error(f"--port must be 1024..{65535 - 12}")

    sampler_base = ROOT / "config/local/sampler.toml"
    collector_base = ROOT / "config/local/collector.toml"
    for path in (sampler_base, collector_base):
        if not path.exists():
            parser.error(f"{path.relative_to(ROOT)} is missing; run scripts/start.sh once to create it")
    subprocess.run(["make", "-C", str(ROOT), "--no-print-directory", "-s"], check=True)

    shutil.rmtree(RUN, ignore_errors=True)
    RUN.mkdir(parents=True)
    tee_port, python_udp, cpp_udp, python_http, cpp_http = (args.port + offset for offset in (0, 1, 2, 11, 12))

    sampler_values = {"collector": f'"127.0.0.1:{tee_port}"'}
    if args.rate_hz:
        sampler_values["rate_hz"] = args.rate_hz
    sampler_text = sampler_base.read_text()
    if args.target_process or args.target_pid:
        sampler_text = "\n".join(line for line in sampler_text.splitlines()
                                 if not re.match(r"\s*target_(process|pid)\s*=", line))
        if args.target_process:
            sampler_values["target_process"] = json.dumps(args.target_process)
        else:
            sampler_values["target_pid"] = args.target_pid
    sampler_config = RUN / "sampler.toml"
    sampler_config.write_text(set_keys(sampler_text, sampler_values))

    base = collector_base.read_text()
    try:
        comparison_config(base, {})
    except (tomllib.TOMLDecodeError, ValueError, RuntimeError) as error:
        parser.error(f"{collector_base.relative_to(ROOT)}: {error}")
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    history = {"python": [], "cpp": []}
    agreed = checked = 0
    collectors, sampler = [], None
    sampler_log = open(RUN / "sampler.log", "ab")
    started = time.monotonic()
    tee = Tee(tee_port, (python_udp, cpp_udp))
    tee.start()
    # Everything started from here on is stopped in the finally block, even if
    # a later step fails.
    try:
        collectors.append(Collector("python", [sys.executable, "-B", "-m", "triangulator"],
                                    python_udp, python_http, base))
        collectors.append(Collector("cpp", [str(ROOT / "build/triangulator-collector")],
                                    cpp_udp, cpp_http, base))
        if args.synthetic_threads:
            sampler = SyntheticSampler(tee_port, args.synthetic_threads, args.rate_hz or 1.0)
            sampler.start()
        else:
            sampler = subprocess.Popen([str(ROOT / "build/triangulator-sampler"), str(sampler_config)],
                                       stdout=sampler_log, stderr=subprocess.STDOUT)
        started = time.monotonic()
        while not stopping.is_set():
            for process, name in ((sampler, "sampler"), *((item.process, item.name) for item in collectors)):
                if process.poll() is not None:
                    raise SystemExit(f"{name} exited (status {process.returncode}); see {RUN}/")
            now = time.monotonic()
            stats = [collector.sample(now) for collector in collectors]
            for collector, item in zip(collectors, stats):
                item.update(time=now, tracked=len(collector.live.get("threads", [])),
                            loss=collector.live.get("health", {}).get("packet_loss_pct"))
                history[collector.name].append(item)
            if collectors[0].live and collectors[1].live:
                checked += 1
                agreed += not agreement(collectors[0].live, collectors[1].live)
            render(collectors, stats, tee, started, args)
            if args.duration and now - started >= args.duration:
                break
            stopping.wait(args.refresh)
    except KeyboardInterrupt:
        pass
    finally:
        if sampler is not None and sampler.poll() is None:
            sampler.terminate()
            sampler.wait(timeout=5)
        sampler_log.close()
        for collector in collectors:
            collector.stop()
        print("Stopped sampler and collectors.")
    if len(history["python"]) >= 2:
        summary = summarize(history, agreed, checked, time.monotonic() - started, args, tee)
        (RUN / "summary.md").write_text(summary)
        print("\n" + summary)


if __name__ == "__main__":
    main()
