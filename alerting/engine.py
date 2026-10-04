import collections

from .settings import RULE_NAMES


class AlertEngine:
    """Opens, reminds and resolves alerts from rule conditions.

    A rule check reports a condition for a (rule, group, tid) key: True (bad),
    False (fine) or None (unknown, which resets the streak). An alert opens
    after sustain_windows bad reports in a row and resolves after
    resolve_windows good ones; immediate=True skips the count. Every change is
    written to storage and passed to deliver. storage needs event(event) and
    recover_alerts() -> (recent, open), as AlertLog provides; open alerts are
    restored from it at startup without being sent again.
    """

    def __init__(self, config, storage, deliver, now):
        self.config = config
        self.storage = storage
        self.deliver = deliver
        recent, self.open = storage.recover_alerts()
        self.streaks = {}
        self.recent = collections.deque(recent, maxlen=500)
        for key in [key for key in self.open
                    if key[0] not in RULE_NAMES or not config.get("enabled", {}).get(key[0], True)]:
            # Alerts from removed or disabled rules are closed quietly, without notification.
            event = self.open.pop(key)
            detail = "Alert rule disabled" if key[0] in RULE_NAMES else "Alert rule removed"
            closed = dict(event, status="resolved", ts=now, detail=detail)
            self.storage.event(closed)
            self.recent.append(closed)

    def event(self, key, metadata, status, now, detail, severity):
        event = dict(metadata, rule=key[0], group=key[1], tid=key[2], status=status,
                     ts=now, detail=detail, severity=severity)
        self.storage.event(event)
        self.recent.append(event)
        self.deliver(event)
        return event

    def close_disabled(self, now):
        for key in [key for key in self.open if not self.config.get("enabled", {}).get(key[0], True)]:
            event = self.open.pop(key)
            self.event(key, {"name": event["name"], "session": event["session"]},
                       "resolved", now, "Alert rule disabled", event["severity"])
        for key in [key for key in self.streaks if not self.config.get("enabled", {}).get(key[0], True)]:
            del self.streaks[key]

    def evaluate(self, rule, group, tid, condition, now, metadata, detail,
                 severity="warning", immediate=False):
        key = rule, group, tid
        if not self.config.get("enabled", {}).get(rule, True):
            return
        if condition is None:
            self.streaks.pop(key, None)
            return
        previous, count = self.streaks.get(key, (None, 0))
        count = count + 1 if condition == previous else 1
        self.streaks[key] = condition, count
        if condition and key not in self.open and (immediate or count >= self.config["sustain_windows"]):
            self.open[key] = self.event(key, metadata, "opened", now, detail, severity)
        elif not condition and key in self.open and (immediate or count >= self.config["resolve_windows"]):
            self.event(key, metadata, "resolved", now, detail, self.open[key]["severity"])
            del self.open[key]

    def retire(self, tid, now, detail):
        for key in list(self.open):
            if key[2] == tid and tid != 0:
                event = self.open.pop(key)
                self.event(key, {"name": event["name"], "session": event["session"]},
                           "resolved", now, detail, event["severity"])
        for key in list(self.streaks):
            if key[2] == tid and tid != 0:
                del self.streaks[key]

    def reminders(self, now):
        for key, event in list(self.open.items()):
            if now - event["ts"] >= self.config["reminder_secs"]:
                self.open[key] = self.event(key, {"name": event["name"], "session": event["session"]},
                                            "reminder", now, event["detail"], event["severity"])
