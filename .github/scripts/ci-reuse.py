#!/usr/bin/env python3
"""Reuse a passing PR run when its build and test inputs have not changed."""

import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlencode


def git(*arguments):
    return subprocess.run(["git", *arguments], check=True, capture_output=True).stdout


def inputs(revision):
    entries = []
    for entry in git("ls-tree", "-r", "-z", revision).split(b"\0"):
        if not entry:
            continue
        path = entry.split(b"\t", 1)[1]
        # Tests can use Markdown fixtures. Keep those in the input set.
        if path.startswith(b"docs/") or (path.endswith(b".md") and not path.startswith(b"tests/")):
            continue
        entries.append(entry)
    return entries


def reusable(previous, head, base):
    if inputs(previous) != inputs(head):
        return False
    # The earlier run must also cover the current base's code and tests.
    ancestor = git("merge-base", previous, base).decode().strip()
    return inputs(ancestor) == inputs(base)


def passing_run(event):
    repository = os.environ["GITHUB_REPOSITORY"]
    query = urlencode({"event": "pull_request", "status": "success", "per_page": 50,
                       "branch": event["pull_request"]["head"]["ref"]})
    endpoint = f"repos/{repository}/actions/workflows/almalinux-user-test.yml/runs?{query}"
    result = subprocess.run(["gh", "api", endpoint], check=True, capture_output=True, text=True)
    for run in json.loads(result.stdout)["workflow_runs"]:
        if run["conclusion"] != "success" or not any(
                pr["number"] == event["number"] for pr in run["pull_requests"]):
            continue
        try:
            if reusable(run["head_sha"], event["pull_request"]["head"]["sha"],
                        event["pull_request"]["base"]["sha"]):
                return run
        except subprocess.CalledProcessError:
            # A force-pushed commit can be absent from the checkout.
            continue
    return None


def main():
    run_tests = True
    if os.environ["GITHUB_EVENT_NAME"] == "pull_request":
        try:
            event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            previous = passing_run(event)
            if previous:
                run_tests = False
                print(f"Reusing passing build and test inputs: {previous['html_url']}")
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            print(f"Cannot verify a passing run; run the full checks: {error}", file=sys.stderr)
    if run_tests:
        print("Run the full checks: no reusable passing input set.")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"run_tests={str(run_tests).lower()}\n")


if __name__ == "__main__":
    main()
