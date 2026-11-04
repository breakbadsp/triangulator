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
        pattern = re.compile(r"\s*rate_hz\s*=")
        text = '# rate\r\nrate_hz = 1\r\n# rate_hz = 9\r\ncollector = "x"\r\n'
        self.assertEqual(sampler_control.replace_setting(text, pattern, "rate_hz = 7"),
                         '# rate\r\nrate_hz = 7\r\n# rate_hz = 9\r\ncollector = "x"\r\n')
        # Duplicates go; a missing key is appended after the last line.
        self.assertEqual(sampler_control.replace_setting("rate_hz = 1\nx = 2\nrate_hz = 3", pattern,
                                                         "rate_hz = 5"), "rate_hz = 5\nx = 2\n")
        self.assertEqual(sampler_control.replace_setting("x = 1", pattern, "rate_hz = 3"),
                         "x = 1\nrate_hz = 3\n")

    def test_read_setting_follows_the_sampler_rules(self):
        text = '# collector = "1.1.1.1:1"\ncollector = "127.0.0.1:9#00" # note\nrate_hz = 2\n'
        self.assertEqual(sampler_control.read_setting(text, "collector"), "127.0.0.1:9#00")
        self.assertEqual(sampler_control.read_setting(text, "rate_hz"), "2")
        self.assertIsNone(sampler_control.read_setting(text, "memory_interval_s"))

    def test_rule_set_adds_and_removes_exact_names_and_keeps_one_rule(self):
        text = 'collector="127.0.0.1:9400"\nprocess_names = ["orders"]\n# keep note\n'
        added = sampler_control.change_rule_set(text, {"action": "add", "target": "billing"})
        self.assertIn("# keep note", added)
        self.assertEqual(sampler_control.rule_list(added, "process_names")[0], ["orders", "billing"])
        reduced = sampler_control.change_rule_set(added, {"action": "remove", "name": "billing"})
        self.assertEqual(sampler_control.rule_list(reduced, "process_names")[0], ["orders"])
        for change, error in (({"action": "add", "target": "orders"}, "already in process_names"),
                              ({"action": "add", "target": "1234 5"}, "exact process name"),
                              ({"action": "add", "id": "x", "target": "a", "pid": 1}, "expected an action"),
                              ({"action": "remove", "name": "absent"}, "no longer configured"),
                              # The sampler rejects a file with no rule.
                              ({"action": "remove", "name": "orders"}, "keep at least one")):
            with self.assertRaisesRegex(sampler_control.ControlError, error):
                sampler_control.change_rule_set(reduced, change)
        with_pattern = reduced + 'process_patterns = ["work*"]\n'
        removed = sampler_control.change_rule_set(with_pattern, {"action": "remove", "name": "orders"})
        self.assertEqual(sampler_control.rule_list(removed, "process_names")[0], [])
        shared = 'process_names = ["worker"]\nprocess_patterns = ["work*"]\n'
        with self.assertRaisesRegex(sampler_control.ControlError, "pattern also selects"):
            sampler_control.change_rule_set(shared, {"action": "remove", "name": "worker"})


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
        for script in ("sampler_control.py", "set-rate.sh"):
            shutil.copy2(ROOT / "scripts" / script, self.real / "scripts")
        self.link = Path(directory.name) / "link"
        self.link.symlink_to(self.real)
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.receiver.close)
        self.receiver.bind(("127.0.0.1", 0))
        self.receiver.settimeout(3)
        self.port = self.receiver.getsockname()[1]
        # The sampler selects processes by name only, so each test process
        # gets a unique comm.
        self.name = f"sc-{os.getpid()}"
        self.target = start_named(self.name)
        self.addCleanup(stop, self.target)
        self.select = f'process_names = ["{self.name}"]\n'

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

    def wait_ids(self, expected, timeout=10):
        deadline = time.monotonic() + timeout
        entries = []
        while time.monotonic() < deadline:
            entries = self.api("/api/targets")[1]["targets"]
            if sorted(entry["id"] for entry in entries) == sorted(expected):
                return {entry["id"]: entry for entry in entries}
            time.sleep(0.05)
        self.fail(f"targets {[entry['id'] for entry in entries]}, expected {expected}")

    def test_dashboard_adds_and_removes_names_and_keeps_other_sessions(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'{self.select}rate_hz=5\ncollector="127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        first = self.wait_ids([self.name])[self.name]
        status, control = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertEqual((control["names"], control["patterns"]), ([self.name], []))
        self.assertNotIn("mode", control)
        other_name = f"so-{os.getpid()}"
        other = start_named(other_name)
        self.addCleanup(stop, other)
        change = {"action": "add", "target": other_name}
        original = config.read_text()
        self.assertEqual(self.api("/api/targets", change)[0], 403)
        self.assertEqual(config.read_text(), original)
        headers = {"X-Triangulator": "1"}
        # A check validates an add and changes nothing.
        status, result = self.api("/api/targets", {**change, "check": True}, headers)
        self.assertEqual(status, 200, result)
        self.assertNotIn("message", result)
        for target in (str(2**31 - 1) + " ", 'a"b', "too-long-process-name", "a\u0000b", ".."):
            status, result = self.api("/api/targets", {**change, "target": target, "check": True}, headers)
            self.assertEqual(status, 400, (target, result))
        status, result = self.api("/api/targets", {**change, "action": "remove", "check": True}, headers)
        self.assertEqual(status, 400, result)
        self.assertEqual(config.read_text(), original)
        status, result = self.api("/api/targets", change, headers)
        self.assertEqual(status, 200, result)
        entries = self.wait_ids([self.name, other_name])
        self.assertEqual(entries[self.name]["session"], first["session"])
        status, result = self.api("/api/targets", {"action": "remove", "key": entries[other_name]["key"],
                                                   "id": other_name, "rule": other_name}, headers)
        self.assertEqual(status, 200, result)
        entries = self.wait_ids([self.name])
        self.assertEqual(entries[self.name]["session"], first["session"])
        # The last rule stays: the sampler rejects a file without one.
        original = config.read_text()
        status, result = self.api("/api/targets", {"action": "remove", "key": entries[self.name]["key"],
                                                   "id": self.name, "rule": self.name}, headers)
        self.assertEqual(status, 400, result)
        self.assertIn("keep at least one", result["error"])
        self.assertEqual(config.read_text(), original)
        # The single-target API is gone.
        legacy = {"Content-Type": "application/json", "X-Triangulator": "1"}
        for data, code in ((None, 404), (b'{"target":"x"}', 501)):
            request = urllib.request.Request(self.dashboard + "/api/target", data=data, headers=legacy)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=15)
            caught.exception.close()
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(config.read_text(), original)

    def test_dashboard_adds_a_waiting_name(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'{self.select}rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        self.wait_ids([self.name])
        status, data = self.api("/api/targets", {"action": "add", "target": "ui-absent-name"},
                                {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        entries = self.wait_ids([self.name, "ui-absent-name"])
        self.assertEqual(entries["ui-absent-name"]["pid"], 0)

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
            deadline = time.monotonic() + 25
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
            time.sleep(11)
            original = config.read_text()
            for rule in (alpha, beta):
                status, result = self.api("/api/targets", {**remove, "rule": rule}, headers)
                self.assertEqual(status, 409, result)
                self.assertEqual(config.read_text(), original)
            renamed = target(lambda item: True)
            self.assertEqual((renamed["id"], renamed["session"], renamed.get("rule")),
                             (alpha, admitted["session"], None))


    def test_dashboard_changes_ipv4_sampler_target_on_dual_stack_collector(self):
        # IPv4 samples and target control both work through an IPv6 wildcard listener.
        self.start_dashboard(udp_host="::")
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'{self.select}rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        self.wait_ids([self.name])
        status, data = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"], data)
        other_name = f"sd-{os.getpid()}"
        other = start_named(other_name)
        self.addCleanup(stop, other)
        status, data = self.api("/api/targets", {"action": "add", "target": other_name}, {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        self.wait_ids([self.name, other_name])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.wait_ids([self.name, other_name])[other_name]["pid"] != other.pid:
            time.sleep(0.05)
        self.assertEqual(self.wait_ids([self.name, other_name])[other_name]["pid"], other.pid)

    def test_target_control_refuses_a_remote_sender_list(self):
        self.start_dashboard(extra='sampler_ips = ["10.0.0.2"]\n')
        status, data = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        change = {"action": "add", "target": "other"}
        status, data = self.api("/api/targets", change, {"X-Triangulator": "1"})
        self.assertEqual(status, 400)
        self.assertTrue(data["enabled"])

    def test_sixth_target_over_capacity_is_refused_until_a_slot_frees(self):
        # QA-078. The collector holds five targets; a sixth must not disturb them.
        self.start_dashboard(extra="max_targets = 5\n")
        config = self.runtime / "config/sampler.toml"
        names = [f"t{index}-{os.getpid()}" for index in range(6)]
        for name in names:
            self.addCleanup(stop, start_named(name))
        rules = ", ".join(f'"{name}"' for name in names[:5])
        config.write_text(f'rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\nprocess_names = [{rules}]\n')
        self.start_sampler(config)
        headers = {"X-Triangulator": "1"}
        five = self.wait_ids(names[:5], timeout=25)
        sessions = {name: entry["session"] for name, entry in five.items()}
        sixth = {"action": "add", "target": names[5]}
        # The add is refused with a clear error, and the five targets stay.
        for body in (sixth, {**sixth, "check": True}):
            status, data = self.api("/api/targets", body, headers)
            self.assertEqual(status, 409, data)
            self.assertIn("limit of 5 targets", data["error"])
        time.sleep(2)
        targets = self.api("/api/targets")[1]
        self.assertEqual(targets["capacity_drops"], 0)
        self.assertEqual({entry["id"]: entry["session"] for entry in targets["targets"]}, sessions)
        removed = five[names[4]]
        status, data = self.api("/api/targets", {"action": "remove", "key": removed["key"], "id": names[4],
                                                 "rule": names[4]}, headers)
        self.assertEqual(status, 200, data)
        self.wait_ids(names[:4], timeout=25)
        self.assertEqual(self.api("/api/targets", sixth, headers)[0], 200)
        after = self.wait_ids(names[:4] + names[5:], timeout=25)
        self.assertEqual(self.api("/api/targets")[1]["capacity_drops"], 0)
        for name in names[:4]:
            self.assertEqual(after[name]["session"], sessions[name])

    def test_dashboard_control_is_hidden_without_the_optional_helper(self):
        self.start_dashboard()
        (self.real / "scripts/sampler_control.py").unlink()
        status, data = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        status, _ = self.api("/api/targets", {"action": "add", "target": "x"}, {"X-Triangulator": "1"})
        self.assertEqual(status, 403)

    def test_dashboard_requires_local_same_origin_write_and_live_sampler(self):
        self.start_dashboard()
        status, data = self.api("/api/targets/control")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        self.assertIn("not running", data["error"])
        config = self.runtime / "config/sampler.toml"
        original = f'{self.select}rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n'
        config.write_text(original)
        self.start_sampler(config)
        add = {"action": "add", "target": "ui-absent-name"}
        for headers in ({}, {"X-Triangulator": "1", "Origin": "https://other.example"}):
            status, _ = self.api("/api/targets", add, headers)
            self.assertEqual(status, 403)
            self.assertEqual(config.read_text(), original)
        headers = {"X-Triangulator": "1", "Origin": self.dashboard}
        for body in ({}, {"action": "add", "target": 123}, {"action": "add", "target": ""},
                     {"action": "add", "target": "x" * 65}):
            status, _ = self.api("/api/targets", body, headers)
            self.assertEqual(status, 400)
            self.assertEqual(config.read_text(), original)
        # A pidfile can exist for a sampler sending to another collector.
        config.write_text(original.replace(str(self.port), str(self.port + 1)))
        status, data = self.api("/api/targets", add, headers)
        self.assertEqual(status, 400)
        self.assertIn("different collector", data["error"])
        self.assertEqual(config.read_text(), original.replace(str(self.port), str(self.port + 1)))

    def test_network_control_is_opt_in_and_sampler_stays_local(self):
        self.start_dashboard(http_host="0.0.0.0")
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'{self.select}collector="127.0.0.1:{self.port}"\n')
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
        self.assertEqual(remote("/api/targets", {"action": "add", "target": "d199-network"})[0], 403)
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
        self.assertEqual(remote("/api/targets", {"action": "add", "target": "d199-network"})[0], 200)
        self.assertIn('d199-network', config.read_text())

    def test_dashboard_reads_split_body_and_rejects_oversized_requests(self):
        self.start_dashboard()
        config = self.runtime / "config/sampler.toml"
        config.write_text(f'{self.select}rate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        port = int(self.dashboard.rsplit(":", 1)[1])
        # A speculative browser connection sends no request; close it silently.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
            connection.shutdown(socket.SHUT_WR)
            self.assertEqual(connection.recv(4096), b"")

        def raw_request(headers, body=b""):
            with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
                connection.sendall(b"POST /api/targets HTTP/1.0\r\nX-Triangulator: 1\r\n" +
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
        body = json.dumps({"action": "add", "target": "ui-split-body"}).encode()
        status, data = raw_request(f"Content-Length: {len(body)}".encode(), body)
        self.assertEqual(status, 200, data)
        self.assertIn('"ui-split-body"', config.read_text())

    def test_rate_reloads_in_place(self):
        config = self.runtime / "config/sampler.toml"
        # Unquoted collector: valid for the sampler, invalid TOML.
        original = (f"# Processes to sample.\n{self.select}# process_names = [\"x\"]\n"
                    f"# Samples per second.\nrate_hz = 10\ncollector = 127.0.0.1:{self.port}\n")
        config.write_text(original)
        self.start_sampler(self.link / "runtime/config/sampler.toml")
        first = self.receive_until(lambda value: value.pid == self.target.pid)
        self.assertEqual(first.interval_ms, 100)
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertEqual(config.read_text(), original.replace("rate_hz = 10", "rate_hz = 5.0"))
        self.receive_until(lambda value: value.interval_ms == 200)
        self.assertFalse((self.link / "scripts/set-target.sh").exists())

    def test_rejected_changes_leave_the_config_unchanged(self):
        config = self.runtime / "config/sampler.toml"
        # Just under the sampler's 16 KiB limit (with lines under its 1023-byte limit).
        original = f"{self.select}collector = \"127.0.0.1:{self.port}\"\n"
        padding = 16383 - len(original) - 10
        original += ("#" * 99 + "\n") * (padding // 100) + "#" * (padding % 100) + "\n"
        config.write_text(original)
        self.start_sampler(config)
        self.receive_until(lambda value: value.pid == self.target.pid)
        for arguments, error in ((("set-rate.sh", "99"), "between 0.2 and 10"),
                                 (("set-rate.sh", "nan"), "between 0.2 and 10"),
                                 # Adds a key past the 16 KiB limit.
                                 (("set-rate.sh", "0.30000000000000004"), "16 KiB")):
            changed = self.run_script(*arguments)
            self.assertEqual(changed.returncode, 1, arguments)
            self.assertIn(error, changed.stderr)
            self.assertEqual(config.read_text(), original)
        self.assertEqual(sorted(path.name for path in config.parent.iterdir()), ["sampler.toml"])

    def test_tracked_example_config_is_not_edited(self):
        config = self.real / "config/sampler.toml"
        original = f"{self.select}rate_hz = 1.0\ncollector = \"127.0.0.1:{self.port}\"\n"
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
