import os
import http.client
import json
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
from pathlib import Path

from wire import decode, receive_tick

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import sampler_control  # noqa: E402

NAMED = "import sys, time; open('/proc/self/comm', 'w').write(sys.argv[1]); time.sleep(60)"


def start_named(name):
    """A process whose comm is name, so name lookups see only test processes."""
    process = subprocess.Popen([sys.executable, "-c", NAMED, name])
    deadline = time.monotonic() + 5
    while Path(f"/proc/{process.pid}/comm").read_text().strip() != name:
        if time.monotonic() > deadline:
            raise AssertionError(f"process {process.pid} did not rename itself")
        time.sleep(0.01)
    return process


def stop(*processes):
    for process in processes:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)


class ConfigTextTests(unittest.TestCase):
    def test_replace_setting_keeps_position_comments_and_line_endings(self):
        pattern = re.compile(r"\s*target_(?:process|pid)\s*=")
        text = '# target\r\ntarget_process = "old"\r\n# target_pid = 1234\r\nrate_hz = 1\r\n'
        self.assertEqual(sampler_control.replace_setting(text, pattern, "target_pid = 7"),
                         '# target\r\ntarget_pid = 7\r\n# target_pid = 1234\r\nrate_hz = 1\r\n')
        # Duplicates go; a missing key is appended after the last line.
        self.assertEqual(sampler_control.replace_setting("target_pid = 1\nx = 2\ntarget_process = y", pattern,
                                                         "target_pid = 3"), "target_pid = 3\nx = 2\n")
        self.assertEqual(sampler_control.replace_setting("rate_hz = 1", pattern, "target_pid = 3"),
                         "rate_hz = 1\ntarget_pid = 3\n")

    def test_read_setting_follows_the_sampler_rules(self):
        text = '# collector = "1.1.1.1:1"\ncollector = "127.0.0.1:9#00" # note\ntarget_process = a\\q\n'
        self.assertEqual(sampler_control.read_setting(text, "collector"), "127.0.0.1:9#00")
        self.assertEqual(sampler_control.read_setting(text, "target_process"), "a\\q")
        self.assertIsNone(sampler_control.read_setting(text, "rate_hz"))

    def test_target_tables_preserve_globals_and_validate_set_changes(self):
        text = 'collector="127.0.0.1:9400"\nrate_hz=5\ntarget_pid=123\n# keep global note\n'
        with mock.patch.object(sampler_control, "require_process"):
            updated = sampler_control.change_target_set(text, {"action": "add", "id": "orders", "target": "456"})
        self.assertIn('# keep global note', updated)
        self.assertNotIn('target_pid=', updated)
        self.assertEqual(sampler_control.configured_targets(updated),
                         [{"id": "default", "target": "123"}, {"id": "orders", "target": "456"}])
        reduced = sampler_control.change_target_set(updated, {"action": "remove", "id": "orders", "target": "456"})
        self.assertEqual(sampler_control.configured_targets(reduced), [{"id": "default", "target": "123"}])
        for body in ({"action": "remove", "id": "default"},
                     {"action": "add", "id": "default", "target": "456"},
                     {"action": "add", "id": "../escape", "target": "456"}):
            with self.assertRaises(sampler_control.ControlError):
                sampler_control.change_target_set(reduced, body)
        with self.assertRaisesRegex(sampler_control.ControlError, "selector changed"):
            sampler_control.change_target_set(updated, {"action": "remove", "id": "orders", "target": "999"})

    def test_global_rate_is_inserted_before_target_tables(self):
        text = 'collector="127.0.0.1:9400"\n[[target]]\nid="orders"\npid=123\n'
        updated = sampler_control.replace_setting(text, re.compile(r"\s*rate_hz\s*="), "rate_hz = 2")
        self.assertLess(updated.index("rate_hz"), updated.index("[[target]]"))
        self.assertEqual(sampler_control.configured_targets(updated), [{"id": "orders", "target": "123"}])


class TargetLookupTests(unittest.TestCase):
    def test_thread_ids_and_missing_pids_are_rejected(self):
        release = threading.Event()
        thread = threading.Thread(target=release.wait)
        thread.start()
        try:
            self.assertTrue(Path(f"/proc/{thread.native_id}/stat").exists())
            with self.assertRaisesRegex(sampler_control.ControlError, f"thread ID of process {os.getpid()}"):
                sampler_control.require_process(thread.native_id)
        finally:
            release.set()
            thread.join()
        sampler_control.require_process(os.getpid())
        with self.assertRaisesRegex(sampler_control.ControlError, "no running process"):
            sampler_control.require_process(2**31 - 1)

    def test_names_must_be_unique(self):
        name = f"tc-{os.getpid()}"
        first = start_named(name)
        try:
            self.assertEqual(sampler_control.unique_process_named(name), first.pid)
            second = start_named(name)
            try:
                with self.assertRaisesRegex(sampler_control.ControlError, str(sorted([first.pid, second.pid]))):
                    sampler_control.unique_process_named(name)
                # The dashboard lists the matching processes so the user can pick one.
                with self.assertRaises(sampler_control.AmbiguousNameError) as caught:
                    sampler_control.unique_process_named(name)
                candidates = caught.exception.candidates
                self.assertEqual([item["pid"] for item in candidates], sorted([first.pid, second.pid]))
                self.assertEqual(caught.exception.total, 2)
                for item in candidates:
                    self.assertTrue(item["user"] and item["command"], item)
                    self.assertLessEqual(abs(item["started_at"] - time.time()), 600, item)
            finally:
                stop(second)
        finally:
            stop(first)


class ScriptTests(unittest.TestCase):
    """Runs the scripts from a copy of the repo reached through a symlink."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.real = Path(directory.name) / "real"
        for part in ("build", "scripts", "config", "runtime/config", "runtime/run"):
            (self.real / part).mkdir(parents=True)
        self.runtime = self.real / "runtime"
        environment = mock.patch.dict(os.environ, {"TRIANGULATOR_HOME": str(self.runtime)})
        environment.start()
        self.addCleanup(environment.stop)
        shutil.copy2(ROOT / "build/triangulator-sampler", self.real / "build")
        for script in ("sampler_control.py", "set-target.sh", "set-rate.sh"):
            shutil.copy2(ROOT / "scripts" / script, self.real / "scripts")
        self.link = Path(directory.name) / "link"
        self.link.symlink_to(self.real)
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.receiver.close)
        self.receiver.bind(("127.0.0.1", 0))
        self.receiver.settimeout(3)
        self.port = self.receiver.getsockname()[1]
        self.target = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, self.target)

    def start_sampler(self, config):
        # Like scripts/start.sh run through the symlink: the kernel still
        # reports the resolved executable path.
        sampler = subprocess.Popen([str(self.link / "build/triangulator-sampler"), str(config)],
                                   stderr=subprocess.DEVNULL)
        self.addCleanup(stop, sampler)
        (self.runtime / "run/sampler.pid").write_text(f"{sampler.pid}\n")
        return sampler

    def run_script(self, *arguments):
        return subprocess.run([str(self.link / "scripts" / arguments[0]), *arguments[1:]],
                              capture_output=True, text=True, timeout=15)

    def receive_until(self, predicate):
        for _ in range(30):
            value = decode(receive_tick(self.receiver))
            if predicate(value):
                return value
        self.fail("the sampler did not apply the reload")

    def start_dashboard(self, http_host="127.0.0.1", udp_host="127.0.0.1", extra=""):
        shutil.copy2(ROOT / "build/triangulator-collector", self.real / "build")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        config = self.runtime / "config/collector.toml"
        # The integration tests receive through the collector instead.
        self.receiver.close()
        config.write_text(f'udp_host = "{udp_host}"\nudp_port = {self.port}\n'
                          f'http_host = "{http_host}"\nhttp_port = {port}\n'
                          f'data_dir = "{self.real / "data"}"\n{extra}')
        collector = subprocess.Popen([str(self.real / "build/triangulator-collector"), str(config)],
                                     stderr=subprocess.DEVNULL)
        self.addCleanup(stop, collector)
        self.collector = collector
        self.dashboard = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                self.api("/api/live")
                return
            except OSError:
                self.assertIsNone(collector.poll(), "collector exited")
                time.sleep(0.02)
        self.fail("dashboard did not start")

    def api(self, path, body=None, headers=None):
        request = urllib.request.Request(self.dashboard + path,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers or {})
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def wait_live(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, live = self.api("/api/live")
            if predicate(live.get("health", {})):
                return live["health"]
            time.sleep(0.05)
        self.fail("dashboard did not report the new target")

    def test_dashboard_adds_and_removes_targets_without_resetting_the_default(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid={self.target.pid}\nrate_hz=5\ncollector="127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        first = self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, control = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertEqual(control["targets"], [{"id": "default", "target": str(self.target.pid)}])
        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        change = {"action": "add", "id": "other", "target": str(other.pid)}
        original = config.read_text()
        self.assertEqual(self.api("/api/targets", change)[0], 403)
        self.assertEqual(config.read_text(), original)
        headers = {"X-Triangulator": "1"}
        # A check validates an add and changes nothing.
        status, result = self.api("/api/targets", {**change, "check": True}, headers)
        self.assertEqual(status, 200, result)
        self.assertNotIn("message", result)
        status, result = self.api("/api/targets", {**change, "target": "999999999", "check": True}, headers)
        self.assertEqual((status, result.get("error")), (400, "no running process with PID 999999999"))
        status, result = self.api("/api/targets", {**change, "action": "remove", "check": True}, headers)
        self.assertEqual(status, 400, result)
        self.assertEqual(config.read_text(), original)
        status, result = self.api("/api/targets", change, headers)
        self.assertEqual(status, 200, result)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if {target["id"] for target in entries} == {"default", "other"}:
                break
            time.sleep(0.05)
        self.assertEqual({target["id"] for target in entries}, {"default", "other"})
        default = next(target for target in entries if target["id"] == "default")
        self.assertEqual(default["session"], first["session"])
        status, result = self.api("/api/targets", {**change, "action": "remove", "key": f"{os.uname().nodename}/other"}, headers)
        self.assertEqual(status, 200, result)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if [target["id"] for target in entries] == ["default"]:
                break
            time.sleep(0.05)
        self.assertEqual([target["id"] for target in entries], ["default"])
        self.assertEqual(entries[0]["session"], first["session"])
        self.assertEqual(self.api("/api/targets", {"action": "remove", "id": "default", "key": f"{os.uname().nodename}/default"}, headers)[0], 400)
        self.assertEqual(sampler_control.configured_targets(config.read_text()),
                         [{"id": "default", "target": str(self.target.pid)}])
        # The legacy single-target API must work on the converted config too.
        self.assertIn("[[target]]", config.read_text())
        self.assertEqual(self.api("/api/target")[1], {"enabled": True, "target": str(self.target.pid)})
        legacy = {"Content-Type": "application/json", "X-Triangulator": "1"}
        status, result = self.api("/api/target", {"target": str(other.pid)}, legacy)
        self.assertEqual(status, 200, result)
        self.assertEqual(sampler_control.configured_targets(config.read_text()),
                         [{"id": "default", "target": str(other.pid)}])
        self.assertEqual(self.api("/api/target")[1]["target"], str(other.pid))

    def test_discovery_rule_remove_is_persistent_and_preserves_other_names(self):
        self.start_dashboard()
        name = f"ui-{os.getpid()}"
        children = [start_named(name), start_named(name)]
        self.addCleanup(stop, *children)
        config = self.runtime / "config/sampler.toml"
        base = f'collector="127.0.0.1:{self.port}"\nrate_hz=10\n'
        rules = f'process_names=["{name}","ui-absent"]\n'
        config.write_text(base + rules + f'process_patterns=["{name}*"]\n')
        sampler = self.start_sampler(config)
        deadline = time.monotonic() + 5
        entries = []
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if len(entries) == 3:
                break
            time.sleep(0.04)
        self.assertEqual(len(entries), 3)
        selected = next(item for item in entries if item["pid"] == children[0].pid)
        absent = next(item for item in entries if item["id"] == "ui-absent")
        headers = {"X-Triangulator": "1"}
        remove = {"action": "remove", "key": selected["key"], "id": selected["id"], "rule": name}
        original = config.read_text()
        self.assertEqual(self.api("/api/targets", remove, headers)[0], 409)
        self.assertEqual(config.read_text(), original)
        config.write_text(base + rules)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if all(not item.get("other_rule_selected") for item in entries):
                break
            time.sleep(0.05)
        self.assertEqual(self.api("/api/targets", {**remove, "rule": "other-rule"}, headers)[0], 409)
        status, result = self.api("/api/targets", remove, headers)
        self.assertEqual(status, 200, result)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if len(entries) == 1:
                break
            time.sleep(0.05)
        self.assertEqual([item["id"] for item in entries], ["ui-absent"])
        self.assertEqual(entries[0]["session"], absent["session"])
        self.assertNotIn(name, config.read_text())
        add = {"action": "add", "target": name}
        self.assertEqual(self.api("/api/targets", add, headers)[0], 200)
        stop(sampler)
        self.start_sampler(config)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if {item["pid"] for item in entries} == {0, *(p.pid for p in children)}:
                break
            time.sleep(0.05)
        self.assertEqual({item["pid"] for item in entries}, {0, *(p.pid for p in children)})

    def test_renamed_instance_remove_never_edits_another_rule(self):
        # The ID names the rule that admitted the process. After a rename,
        # another exact name selects it, so no Remove may change the config.
        self.start_dashboard()
        alpha, beta = f"ra-{os.getpid()}", f"rb-{os.getpid()}"
        code = ("import signal,sys,time; "
                "signal.signal(signal.SIGUSR1, lambda *_: open('/proc/self/comm','w').write(sys.argv[2])); "
                "open('/proc/self/comm','w').write(sys.argv[1]); time.sleep(60)")
        child = subprocess.Popen([sys.executable, "-c", code, alpha, beta])
        self.addCleanup(stop, child)
        config = self.runtime / "config/sampler.toml"
        base = f'collector="127.0.0.1:{self.port}"\nrate_hz=10\n'
        config.write_text(base + f'process_names=["{alpha}"]\n')
        self.start_sampler(config)

        def target(predicate):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                entries = self.api("/api/targets")[1]["targets"]
                found = [item for item in entries if item["pid"] == child.pid]
                if found and predicate(found[0]):
                    return found[0]
                time.sleep(0.05)
            self.fail(f"no matching target in {entries}")

        admitted = target(lambda item: item["id"] == alpha and item.get("rule") == alpha)
        headers = {"X-Triangulator": "1"}
        remove = {"action": "remove", "key": admitted["key"], "id": alpha}
        config.write_text(base + f'process_names=["{alpha}","{beta}"]\n')
        time.sleep(0.5)
        child.send_signal(signal.SIGUSR1)
        while Path(f"/proc/{child.pid}/comm").read_text().strip() != beta:
            time.sleep(0.01)
        for rules in ([alpha, beta], [beta]):
            config.write_text(base + "process_names=[" + ",".join(f'"{n}"' for n in rules) + "]\n")
            # One discovery pass reads the new name.
            time.sleep(1.5)
            original = config.read_text()
            for rule in (alpha, beta):
                status, result = self.api("/api/targets", {**remove, "rule": rule}, headers)
                self.assertEqual(status, 409, result)
                self.assertEqual(config.read_text(), original)
            renamed = target(lambda item: True)
            self.assertEqual((renamed["id"], renamed["session"], renamed.get("rule")),
                             (alpha, admitted["session"], None))

    def test_cli_target_ids_add_remove_and_global_rate(self):
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'collector="127.0.0.1:{self.port}"\n[[target]]\nid="orders"\npid={self.target.pid}\n')
        self.start_sampler(config)
        self.receive_until(lambda packet: packet.pid == self.target.pid)
        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        changed = self.run_script("set-target.sh", "orders", str(other.pid))
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn(f'[[target]] id = "orders", pid = {other.pid}', changed.stdout)
        self.receive_until(lambda packet: packet.pid == other.pid)
        added = self.run_script("set-target.sh", "--add", "billing", str(self.target.pid))
        self.assertEqual(added.returncode, 0, added.stderr)
        self.assertEqual({item["id"] for item in sampler_control.configured_targets(config.read_text())}, {"orders", "billing"})
        rate = self.run_script("set-rate.sh", "2")
        self.assertEqual(rate.returncode, 0, rate.stderr)
        self.assertLess(config.read_text().index("rate_hz"), config.read_text().index("[[target]]"))
        self.receive_until(lambda packet: packet.interval_ms == 500)
        removed = self.run_script("set-target.sh", "--remove", "billing")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(sampler_control.configured_targets(config.read_text()), [{"id": "orders", "target": str(other.pid)}])

    def test_dashboard_changes_ipv4_sampler_target_on_dual_stack_collector(self):
        # IPv4 samples and target control both work through an IPv6 wildcard listener.
        self.start_dashboard(udp_host="::")
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"enabled": True, "target": str(self.target.pid)})
        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        status, data = self.api("/api/target", {"target": str(other.pid)}, {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == other.pid)

    def test_target_control_refuses_a_remote_sender_list(self):
        self.start_dashboard(extra='sampler_ips = ["10.0.0.2"]\n')
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        status, data = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        change = {"action": "add", "id": "other", "target": "1"}
        status, data = self.api("/api/targets", change, {"X-Triangulator": "1"})
        self.assertEqual(status, 400)
        self.assertTrue(data["enabled"])

    def test_sixth_target_over_capacity_is_refused_until_a_slot_frees(self):
        # QA-078. The collector holds five targets; a sixth must not disturb them.
        self.start_dashboard(extra="max_targets = 5\n")
        config = self.runtime / "config/sampler.toml"
        others = [subprocess.Popen(["sleep", "60"]) for _ in range(6)]
        for other in others:
            self.addCleanup(stop, other)
        tables = "".join(f'[[target]]\nid = "t{index}"\npid = {process.pid}\n'
                         for index, process in enumerate([self.target] + others[:4]))
        config.write_text(f'rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n{tables}')
        sampler = self.start_sampler(config)
        headers = {"X-Triangulator": "1"}

        def ids():
            return sorted(entry["id"] for entry in self.api("/api/targets")[1]["targets"])

        def wait_ids(expected):
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline and ids() != expected:
                time.sleep(0.05)
            self.assertEqual(ids(), expected)

        five = [f"t{index}" for index in range(5)]
        wait_ids(five)
        sessions = {entry["id"]: entry["session"] for entry in self.api("/api/targets")[1]["targets"]}
        sixth = {"action": "add", "id": "t5", "target": str(others[4].pid)}
        # The add is refused with a clear error, and the five targets stay.
        for body in (sixth, {**sixth, "check": True}):
            status, data = self.api("/api/targets", body, headers)
            self.assertEqual(status, 409, data)
            self.assertIn("limit of 5 targets", data["error"])
        time.sleep(2)
        self.assertEqual(ids(), five)
        targets = self.api("/api/targets")[1]
        self.assertEqual(targets["capacity_drops"], 0)
        self.assertEqual({entry["id"]: entry["session"] for entry in targets["targets"]}, sessions)
        self.assertEqual(self.api("/api/targets", {"action": "remove", "id": "t4", "key": f"{os.uname().nodename}/t4"}, headers)[0], 200)
        wait_ids(["t0", "t1", "t2", "t3"])
        # Two adds back to back at four targets. The paused sampler cannot
        # reload, so the collector still publishes four targets when the
        # second add arrives; the configured count must refuse it.
        seventh = {"action": "add", "id": "t6", "target": str(others[5].pid)}
        os.kill(sampler.pid, signal.SIGSTOP)
        try:
            self.assertEqual(self.api("/api/targets", sixth, headers)[0], 200)
            for body in (seventh, {**seventh, "check": True}):
                status, data = self.api("/api/targets", body, headers)
                self.assertEqual(status, 409, data)
                self.assertIn("limit of 5 targets", data["error"])
        finally:
            os.kill(sampler.pid, signal.SIGCONT)
        wait_ids(["t0", "t1", "t2", "t3", "t5"])
        self.assertEqual(self.api("/api/targets")[1]["capacity_drops"], 0)
        after = {entry["id"]: entry["session"] for entry in self.api("/api/targets")[1]["targets"]}
        for name in ("t0", "t1", "t2", "t3"):
            self.assertEqual(after[name], sessions[name])

    def test_dashboard_changes_pid_name_and_absent_target(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        initial = self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"enabled": True, "target": str(self.target.pid)})
        headers = {"Content-Type": "application/json", "X-Triangulator": "1"}
        original = config.read_text()
        for target in ("0", str(2**31 - 1), 'a"b', "too-long-process-name", "a\u0000b"):
            status, data = self.api("/api/target", {"target": target}, headers)
            self.assertEqual(status, 400, data)
            self.assertIn("error", data)
            self.assertEqual(config.read_text(), original)

        name = f"ui-{os.getpid()}"
        other = start_named(name)
        self.addCleanup(stop, other)
        duplicate = start_named(name)
        self.addCleanup(stop, duplicate)
        status, data = self.api("/api/target", {"target": name}, headers)
        self.assertEqual(status, 400)
        self.assertIn("multiple processes", data["error"])
        self.assertEqual(config.read_text(), original)
        stop(duplicate)
        status, data = self.api("/api/target", {"target": name}, headers)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["target"], name)
        changed = self.wait_live(lambda health: health.get("pid") == other.pid)
        self.assertNotEqual(changed["session"], initial["session"])
        self.assertIn(f'target_process = "{name}"', config.read_text())

        status, data = self.api("/api/target", {"target": str(self.target.pid)}, headers)
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target", {"target": "ui-absent-name"}, headers)
        self.assertEqual(status, 200, data)
        self.assertIn("Waiting", data["message"])
        self.wait_live(lambda health: health.get("target_absent") is True)

    def test_dashboard_named_target_follows_restart_and_survives_reopening(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        sampler = self.start_sampler(config)
        name = f"uir-{os.getpid()}"
        first = start_named(name)
        self.addCleanup(stop, first)
        status, data = self.api("/api/target", {"target": name}, {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == first.pid)
        stop(first)
        self.wait_live(lambda health: health.get("target_absent") is True)
        second = start_named(name)
        self.addCleanup(stop, second)
        self.assertNotEqual(first.pid, second.pid)
        self.wait_live(lambda health: health.get("pid") == second.pid)
        # Reopening the form (including after a page reload) reads the selector
        # from disk, rather than replacing the name with the current PID.
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data["target"], name)
        self.assertIn(f'target_process = "{name}"', config.read_text())
        stop(sampler)
        original = config.read_text()
        status, data = self.api("/api/target", {"target": str(self.target.pid)},
                                {"X-Triangulator": "1"})
        self.assertEqual(status, 400)
        self.assertIn("not running", data["error"])
        self.assertEqual(config.read_text(), original)

    def test_dashboard_control_is_hidden_without_the_optional_helper(self):
        self.start_dashboard()
        (self.real / "scripts/sampler_control.py").unlink()
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        status, _ = self.api("/api/target", {"target": "x"}, {"X-Triangulator": "1"})
        self.assertEqual(status, 403)

    def test_dashboard_requires_local_same_origin_write_and_live_sampler(self):
        self.start_dashboard()
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        self.assertIn("not running", data["error"])
        config = self.runtime / "config/sampler.toml"
        original = f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n'
        config.write_text(original)
        self.start_sampler(config)
        for headers in ({}, {"X-Triangulator": "1", "Origin": "https://other.example"}):
            status, _ = self.api("/api/target", {"target": "ui-absent-name"}, headers)
            self.assertEqual(status, 403)
            self.assertEqual(config.read_text(), original)
        headers = {"X-Triangulator": "1", "Origin": self.dashboard}
        for body in ({}, {"target": 123}, {"target": ""}, {"target": "x" * 65}):
            status, _ = self.api("/api/target", body, headers)
            self.assertEqual(status, 400)
            self.assertEqual(config.read_text(), original)
        # A pidfile can exist for a sampler sending to another collector.
        config.write_text(original.replace(str(self.port), str(self.port + 1)))
        status, data = self.api("/api/target", {"target": "ui-absent-name"}, headers)
        self.assertEqual(status, 400)
        self.assertIn("different collector", data["error"])
        self.assertEqual(config.read_text(), original.replace(str(self.port), str(self.port + 1)))

    def test_network_control_is_opt_in_and_sampler_stays_local(self):
        self.start_dashboard(http_host="0.0.0.0")
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid={self.target.pid}\ncollector="127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        self.wait_live(lambda health: health.get("pid") == self.target.pid)
        # A wildcard listener still accepts a loopback client.
        self.assertTrue(self.api("/api/targets/control")[1]["enabled"])
        with socket.socket(type=socket.SOCK_DGRAM) as route:
            route.connect(("192.0.2.1", 9))
            address = route.getsockname()[0]
        self.assertFalse(address.startswith("127."))
        def remote(path, body=None):
            client = http.client.HTTPConnection("127.0.0.1", int(self.dashboard.rsplit(":", 1)[1]),
                                                source_address=(address, 0), timeout=10)
            try:
                client.request("POST" if body else "GET", path,
                               json.dumps(body) if body else None,
                               {"X-Triangulator": "1"})
                response = client.getresponse()
                return response.status, json.loads(response.read())
            finally:
                client.close()
        original = config.read_text()
        for path, body in (("/api/target", {"target": "d199-network"}),
                           ("/api/targets", {"action": "add", "id": "net", "target": "d199-network"})):
            self.assertEqual(remote(path, body)[0], 403)
            self.assertEqual(config.read_text(), original)
        collector_config = self.runtime / "config/collector.toml"
        # Collector settings apply at startup. Restart the test collector with opt-in.
        collector = self.collector
        stop(collector)
        collector_config.write_text(collector_config.read_text() + "network_target_control=true\n")
        self.collector = subprocess.Popen([self.real / "build/triangulator-collector", collector_config],
                                         stderr=subprocess.DEVNULL)
        self.addCleanup(stop, self.collector)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                enabled = remote("/api/targets/control")[1].get("enabled")
                if enabled:
                    break
            except OSError:
                pass
            time.sleep(0.03)
        self.assertTrue(enabled)
        self.assertEqual(remote("/api/targets", {"action": "add", "id": "net", "target": "d199-network"})[0], 200)
        self.assertIn('d199-network', config.read_text())

    def test_dashboard_reads_split_body_and_rejects_oversized_requests(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        port = int(self.dashboard.rsplit(":", 1)[1])
        # A speculative browser connection sends no request; close it silently.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
            connection.shutdown(socket.SHUT_WR)
            self.assertEqual(connection.recv(4096), b"")

        def raw_request(headers, body=b""):
            with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
                connection.sendall(b"POST /api/target HTTP/1.0\r\nX-Triangulator: 1\r\n" +
                                   headers + b"\r\n\r\n")
                if body:
                    # Separate network writes exercise the HTTP body reader.
                    time.sleep(0.02)
                    connection.sendall(body[:4])
                    time.sleep(0.02)
                    connection.sendall(body[4:])
                response = b""
                while chunk := connection.recv(4096):
                    response += chunk
            status = int(response.split(b" ", 2)[1])
            body = response.split(b"\r\n\r\n", 1)[1]
            # The HTTP library rejects bad framing with an empty body.
            return status, json.loads(body) if body else None

        original = config.read_text()
        for headers, expected in ((b"Content-Length: 16385", 413), (b"Content-Length: -1", 400),
                                  (b"Content-Length: 3\r\nContent-Length: 4", 400),
                                  (b"Transfer-Encoding: chunked", 400)):
            status, _ = raw_request(headers)
            self.assertEqual(status, expected, headers)
            self.assertEqual(config.read_text(), original)
        body = json.dumps({"target": "ui-split-body"}).encode()
        status, data = raw_request(f"Content-Length: {len(body)}".encode(), body)
        self.assertEqual(status, 200, data)
        self.assertIn('target_process = "ui-split-body"', config.read_text())

    def test_rate_and_target_reload_in_place(self):
        config = self.runtime / "config/sampler.toml"
        # Unquoted collector: valid for the sampler, invalid TOML.
        original = (f"# Process to sample.\ntarget_pid = {self.target.pid}\n# target_process = \"x\"\n"
                    f"# Samples per second.\nrate_hz = 10\ncollector = 127.0.0.1:{self.port}\n")
        config.write_text(original)
        self.start_sampler(self.link / "runtime/config/sampler.toml")
        first = self.receive_until(lambda value: value.pid == self.target.pid)
        self.assertEqual(first.interval_ms, 100)

        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertEqual(config.read_text(), original.replace("rate_hz = 10", "rate_hz = 5.0"))
        self.receive_until(lambda value: value.interval_ms == 200)

        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        changed = self.run_script("set-target.sh", str(other.pid))
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn(f"\ntarget_pid = {other.pid}\n# target_process", config.read_text())
        self.receive_until(lambda value: value.pid == other.pid)

        # A name with a backslash is fine for the sampler, though not for TOML.
        changed = self.run_script("set-target.sh", "a\\q")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn("No process named a\\q is running", changed.stdout)
        self.assertIn('\ntarget_process = "a\\q"\n# target_process', config.read_text())
        self.assertNotIn("target_pid", config.read_text())
        self.receive_until(lambda value: value.flags & 1)

    def test_rejected_changes_leave_the_config_unchanged(self):
        config = self.runtime / "config/sampler.toml"
        # Just under the sampler's 16 KiB limit (with lines under its 1023-byte limit).
        original = f"target_pid = {self.target.pid}\ncollector = \"127.0.0.1:{self.port}\"\n"
        padding = 16383 - len(original) - 10
        original += ("#" * 99 + "\n") * (padding // 100) + "#" * (padding % 100) + "\n"
        config.write_text(original)
        self.start_sampler(config)
        self.receive_until(lambda value: value.pid == self.target.pid)

        name = f"tc-{os.getpid()}"
        first, second = start_named(name), start_named(name)
        self.addCleanup(stop, first, second)
        release = threading.Event()
        thread = threading.Thread(target=release.wait)
        thread.start()
        try:
            for arguments, error in ((("set-target.sh", name), "multiple processes"),
                                     (("set-target.sh", str(thread.native_id)), "thread ID"),
                                     (("set-target.sh", 'a"b'), "quotes"),
                                     (("set-rate.sh", "99"), "between 0.2 and 10"),
                                     (("set-rate.sh", "nan"), "between 0.2 and 10"),
                                     # Adds a key past the 16 KiB limit.
                                     (("set-rate.sh", "0.30000000000000004"), "16 KiB")):
                changed = self.run_script(*arguments)
                self.assertEqual(changed.returncode, 1, arguments)
                self.assertIn(error, changed.stderr)
                self.assertEqual(config.read_text(), original)
        finally:
            release.set()
            thread.join()
        self.assertEqual(sorted(path.name for path in config.parent.iterdir()), ["sampler.toml"])

    def test_tracked_example_config_is_not_edited(self):
        config = self.real / "config/sampler.toml"
        original = f"target_pid = {self.target.pid}\nrate_hz = 1.0\ncollector = \"127.0.0.1:{self.port}\"\n"
        config.write_text(original)
        self.start_sampler(config)
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 1)
        self.assertIn("tracked example file", changed.stderr)
        self.assertEqual(config.read_text(), original)

    def test_stale_pidfile_and_other_programs_are_refused(self):
        changed = self.run_script("set-rate.sh", "5")
        self.assertIn("not running", changed.stderr)
        (self.runtime / "run/sampler.pid").write_text(f"{self.target.pid}\n")
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 1)
        self.assertIn("not this repo's sampler", changed.stderr)
        self.assertIsNone(self.target.poll(), "the other program must not be signalled")


if __name__ == "__main__":
    unittest.main()
