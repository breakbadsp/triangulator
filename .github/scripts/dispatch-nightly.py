#!/usr/bin/env python3
"""Submit the full nightly workflows once per IST date, after 03:00."""

import argparse
from datetime import datetime, time, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = "breakbadsp/triangulator"
WORKFLOWS = ("sanitizers.yml", "almalinux-user-test.yml", "release-package.yml")
IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_STATE = Path.home() / ".local/state/triangulator/nightly-dispatch.json"


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"gh exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def pages(endpoint, *args):
    return json.loads(gh("api", "--method", "GET", endpoint,
                         "--paginate", "--slurp", "-f", "per_page=100", *args))


def existing_run(workflow, day):
    start = datetime.combine(day, time(), IST).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    interval = f"{start:%Y-%m-%dT%H:%M:%SZ}..{end - timedelta(seconds=1):%Y-%m-%dT%H:%M:%SZ}"
    runs = pages(f"repos/{REPO}/actions/workflows/{workflow}/runs",
                 "-f", "branch=master", "-f", f"created={interval}")
    for page in runs:
        for run in page["workflow_runs"]:
            if run["head_branch"] != "master":
                continue
            if datetime.fromisoformat(run["created_at"].replace("Z", "+00:00")).astimezone(IST).date() != day:
                continue
            event = run["event"]
            if event == "schedule":
                return run["html_url"]
            if event != "workflow_dispatch":
                continue
            # Sanitizers and packaging have no lean inputs. AlmaLinux lean runs
            # have only version 8; the version 9 job proves a full matrix.
            if workflow == "almalinux-user-test.yml":
                jobs = pages(f"repos/{REPO}/actions/runs/{run['id']}/jobs")
                if not any(job["name"] == "AlmaLinux 9"
                           for page in jobs for job in page["jobs"]):
                    continue
            return run["html_url"]
    return None


def save(path, state):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(state, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def dispatch(path, dry_run, now):
    state = json.loads(path.read_text()) if path.exists() else {}
    # Reject damaged or incompatible state rather than submit duplicate builds.
    if not isinstance(state, dict) or any(
        not isinstance(records, dict) or any(
            workflow not in WORKFLOWS or not isinstance(record, dict)
            or record.get("status") not in {"pending", "submitted", "observed"}
            for workflow, record in records.items())
        for records in state.values()
    ):
        raise ValueError("invalid dispatch state")
    day = now.date()
    records = state.setdefault(day.isoformat(), {})
    failed = False
    for workflow in WORKFLOWS:
        record = records.get(workflow)
        if record and record["status"] in {"submitted", "observed"}:
            print(f"SKIP {workflow}: {day} {record['status']}")
            continue
        try:
            url = existing_run(workflow, day)
            if url:
                print(f"SKIP {workflow}: existing full run {url}")
                if not dry_run:
                    records[workflow] = {"status": "observed", "url": url}
                    save(path, state)
                continue
            if record:
                print(f"UNCERTAIN {workflow}: pending submission; no full run found. "
                      "Inspect GitHub and state manually; no automatic retry.", file=sys.stderr)
                failed = True
                continue
            if dry_run:
                print(f"WOULD DISPATCH {workflow}: master, full defaults, {day}")
                continue
            records[workflow] = {"status": "pending", "recorded_at": now.isoformat()}
            save(path, state)  # Durable write-ahead record, before any submission.
            try:
                gh("workflow", "run", workflow, "--repo", REPO, "--ref", "master")
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                raise RuntimeError(f"UNCERTAIN submission; inspect GitHub; no automatic retry: {error}") from error
            records[workflow]["status"] = "submitted"
            save(path, state)
            print(f"DISPATCHED {workflow}: master, full defaults, {day}")
        except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
            print(f"ERROR {workflow}: {error}", file=sys.stderr)
            failed = True
    return int(failed)


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    args = parser.parse_args(argv)
    now = (now or datetime.now(IST)).astimezone(IST)
    if now.time() < time(3):
        print(f"SKIP all: {now.isoformat()} is before 03:00 Asia/Kolkata")
        return 0
    try:
        if args.dry_run:
            return dispatch(args.state_path, True, now)
        args.state_path.parent.mkdir(parents=True, exist_ok=True)
        with args.state_path.with_suffix(args.state_path.suffix + ".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("another dispatcher holds the process lock") from None
            return dispatch(args.state_path, False, now)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
