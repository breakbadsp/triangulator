import http.server
import json
import tempfile
import threading
import time
import unittest

from alerting.delivery import Delivery
from alerting.engine import AlertEngine
from alerting.log import AlertLog
from alerting.settings import (DEFAULT_ALERTS, RULE_NAMES, merge_settings, validate_alerts,
                               validate_delivery)

KEY = ("cpu_warn", "worker", 42)
METADATA = {"name": "worker-1", "session": "1"}


def alerts(**changes):
    values = {**DEFAULT_ALERTS, **changes}
    validate_alerts(values)
    return values


class AlertSettingsTests(unittest.TestCase):
    def test_every_rule_defaults_to_enabled(self):
        self.assertEqual(alerts()["enabled"], {rule: True for rule in RULE_NAMES})

    def test_merge_validates_without_modifying_current_settings(self):
        current = alerts()
        merged = merge_settings(current, {"cpu_warn_pct": 70, "enabled": {"starved": False}})
        self.assertEqual((merged["cpu_warn_pct"], merged["enabled"]["starved"]), (70, False))
        self.assertEqual((current["cpu_warn_pct"], current["enabled"]["starved"]), (50, True))
        for changes in ({"cpu_warn_pct": 95}, {"cpu_sustain_secs": 0}, {"window_s": 7},
                        {"enabled": {"blocked": False}}, {"enabled": {"cpu_warn": "no"}},
                        {"enabled": "abc"}, {"enabled": ["cpu_warn"]}, {"enabled": None},
                        {"packet_loss_pct": float("nan")}, {"webhook_url": "http://x"}, []):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    merge_settings(current, changes)

    def test_dashboard_ranges_apply_to_toml_values(self):
        with self.assertRaises(ValueError):
            alerts(reminder_secs=30)
        self.assertEqual(alerts(reminder_secs=60)["reminder_secs"], 60)

    def test_delivery_destinations_are_optional_but_checked(self):
        validate_delivery({})
        validate_delivery({"webhook_url": "https://hooks.example/x",
                           "smtp": {"host": "smtp.example", "from": "a@example", "to": ["b@example"]}},
                          deadman_url="http://ping.example/x")
        for values, deadman_url in (({"webhook_url": "ftp://hooks.example/x"}, None),
                                    ({"webhook_url": "https://"}, None),
                                    ({}, "file:///tmp/ping"),
                                    ({"smtp": {"host": "smtp.example", "from": "a@example"}}, None)):
            with self.subTest(values=values, deadman_url=deadman_url):
                with self.assertRaises(ValueError):
                    validate_delivery(values, deadman_url)


class AlertEngineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.log = AlertLog(self.directory.name)
        self.events = []
        self.config = alerts()
        self.engine = AlertEngine(self.config, self.log, self.events.append, 1700000000)

    def tearDown(self):
        self.directory.cleanup()

    def report(self, condition, now, key=KEY, **values):
        self.engine.evaluate(key[0], key[1], key[2], condition, now, METADATA, "detail", **values)

    def statuses(self):
        return [event["status"] for event in self.events]

    def test_opens_after_sustained_windows_and_resolves_after_clear_windows(self):
        self.report(True, 1700000005)
        self.report(True, 1700000010)
        self.assertNotIn(KEY, self.engine.open)
        self.report(True, 1700000015)
        self.assertIn(KEY, self.engine.open)
        self.report(False, 1700000020)
        self.assertIn(KEY, self.engine.open)
        self.report(False, 1700000025)
        self.assertNotIn(KEY, self.engine.open)
        self.assertEqual(self.statuses(), ["opened", "resolved"])
        self.assertEqual(self.events[0]["ts"], 1700000015)

    def test_unknown_condition_restarts_the_streak(self):
        self.report(True, 1700000005)
        self.report(True, 1700000010)
        self.report(None, 1700000015)
        self.report(True, 1700000020)
        self.report(True, 1700000025)
        self.assertNotIn(KEY, self.engine.open)

    def test_immediate_rules_open_and_resolve_at_once(self):
        self.report(True, 1700000005, immediate=True, severity="critical")
        self.assertEqual(self.engine.open[KEY]["severity"], "critical")
        self.report(False, 1700000006, immediate=True)
        self.assertEqual(self.statuses(), ["opened", "resolved"])
        self.assertEqual(self.events[1]["severity"], "critical")

    def test_disabled_rule_never_opens_and_disabling_resolves_open_alerts(self):
        self.config["enabled"]["starved"] = False
        self.report(True, 1700000005, key=("starved", "worker", 42), immediate=True)
        self.assertEqual(self.events, [])
        self.report(True, 1700000005, immediate=True)
        self.config["enabled"]["cpu_warn"] = False
        self.engine.close_disabled(1700000010)
        self.assertEqual(self.engine.open, {})
        self.assertEqual(self.events[-1]["detail"], "Alert rule disabled")

    def test_retiring_a_thread_resolves_only_its_alerts(self):
        monitor_key = ("sampler_silent", "monitor", 0)
        self.report(True, 1700000005, immediate=True)
        self.report(True, 1700000005, key=monitor_key, immediate=True)
        self.engine.retire(42, 1700000010, "Thread exited or target absent")
        self.assertEqual(list(self.engine.open), [monitor_key])
        self.assertEqual(self.events[-1]["detail"], "Thread exited or target absent")

    def test_open_alerts_are_reminded_after_reminder_secs(self):
        self.report(True, 1700000000, immediate=True)
        self.engine.reminders(1700000000 + 1799)
        self.assertEqual(self.statuses(), ["opened"])
        self.engine.reminders(1700000000 + 1800)
        self.assertEqual(self.statuses(), ["opened", "reminder"])
        self.assertIn(KEY, self.engine.open)

    def test_recovery_restores_open_alerts_without_notifying_again(self):
        self.report(True, 1700000005, immediate=True)
        events = []
        restored = AlertEngine(self.config, self.log, events.append, 1700000008)
        self.assertIn(KEY, restored.open)
        self.assertEqual(events, [])
        self.assertEqual([event["status"] for event in restored.recent], ["opened"])
        restored.retire(42, 1700000022, "Sampler session or target changed")
        self.assertEqual([event["status"] for event in events], ["resolved"])

    def test_recovered_alert_from_removed_rule_closes_quietly(self):
        self.log.event(dict(ts=1700000000, rule="blocked", group="worker", tid=42, name="worker-1",
                            detail="blocked: sustained over 15s", status="opened", severity="warning",
                            session="1"))
        events = []
        restored = AlertEngine(self.config, self.log, events.append, 1700000001)
        self.assertEqual(restored.open, {})
        self.assertEqual(events, [])
        self.assertEqual(AlertEngine(self.config, self.log, events.append, 1700000002).open, {})


class DeliveryTests(unittest.TestCase):
    def test_webhook_receives_each_event_as_json(self):
        notifications = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                notifications.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_):
                pass

        webhook = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=webhook.serve_forever, daemon=True)
        thread.start()
        delivery = Delivery({"alerts": {"webhook_url": f"http://127.0.0.1:{webhook.server_port}/"}})
        try:
            event = dict(METADATA, ts=1700000000, rule="target_absent", group="monitor", tid=0,
                         detail="Sampler reports target absent", severity="warning", status="opened")
            delivery.submit(event)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not notifications:
                time.sleep(0.05)
            self.assertEqual(notifications, [event])
            self.assertEqual(delivery.failures, 0)
        finally:
            delivery.close()
            webhook.shutdown()
            webhook.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
