import datetime as dt
import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS thread_rollup (
 ts REAL NOT NULL, session TEXT NOT NULL, tid INTEGER NOT NULL,
 name TEXT NOT NULL, group_name TEXT NOT NULL, cpu_pct REAL,
 run_delay_pct REAL, sample_counts TEXT NOT NULL, timeslices_delta INTEGER,
 samples INTEGER NOT NULL, expected_samples REAL NOT NULL, valid INTEGER NOT NULL,
 generation INTEGER NOT NULL, PRIMARY KEY(ts, session, tid, generation)
);
CREATE INDEX IF NOT EXISTS rollup_thread ON thread_rollup(session, tid, ts);
CREATE TABLE IF NOT EXISTS alert_event (
 id INTEGER PRIMARY KEY, ts REAL NOT NULL, rule TEXT NOT NULL,
 group_name TEXT NOT NULL, tid INTEGER NOT NULL, name TEXT NOT NULL,
 detail TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL,
 session TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_sample (
 ts REAL NOT NULL, session TEXT NOT NULL, tid INTEGER NOT NULL, sample TEXT NOT NULL
);
"""


class Storage:
    def __init__(self, directory, retention_days=7, store_raw=False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.retention_days = retention_days
        self.store_raw = store_raw
        self.connections = {}
        self.last_prune = None

    def connection(self, timestamp):
        day = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).date().isoformat()
        if day not in self.connections:
            connection = sqlite3.connect(self.directory / f"{day}.sqlite3")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
            self.connections[day] = connection
        return self.connections[day]

    def rollup(self, row):
        self.connection(row["ts"]).execute(
            "INSERT OR REPLACE INTO thread_rollup VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["ts"], row["session"], row["tid"], row["name"], row["group"],
             row["cpu_pct"], row["run_delay_pct"], json.dumps(row["sample_counts"]),
             row["timeslices_delta"], row["samples"], row["expected_samples"],
             int(row["valid"]), row["generation"]))

    def event(self, event):
        self.connection(event["ts"]).execute(
            "INSERT INTO alert_event(ts,rule,group_name,tid,name,detail,status,severity,session) VALUES (?,?,?,?,?,?,?,?,?)",
            tuple(event[key] for key in ("ts", "rule", "group", "tid", "name", "detail", "status", "severity", "session")))

    def raw(self, timestamp, session, record):
        if self.store_raw:
            self.connection(timestamp).execute("INSERT INTO raw_sample VALUES (?,?,?,?)",
                                               (timestamp, session, record["tid"], json.dumps(record)))

    def flush(self, now):
        today = dt.datetime.fromtimestamp(now, dt.timezone.utc).date()
        for day, connection in list(self.connections.items()):
            connection.commit()
            if day != today.isoformat():
                connection.close()
                del self.connections[day]
        if self.last_prune == today:
            return
        cutoff = today - dt.timedelta(days=self.retention_days - 1)
        for path in self.directory.glob("????-??-??.sqlite3"):
            try:
                expired = dt.date.fromisoformat(path.stem) < cutoff
            except ValueError:
                continue
            if expired:
                for suffix in ("", "-wal", "-shm"):
                    Path(str(path) + suffix).unlink(missing_ok=True)
        self.last_prune = today

    def close(self):
        for connection in self.connections.values():
            connection.commit()
            connection.close()
        self.connections.clear()

    def recover_alerts(self):
        recent = []
        latest = {}
        for path in sorted(self.directory.glob("????-??-??.sqlite3")):
            connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                rows = connection.execute("SELECT * FROM alert_event ORDER BY id DESC LIMIT 500")
                recent.extend(dict(row) for row in rows)
                rows = connection.execute(
                    "SELECT * FROM alert_event WHERE id IN "
                    "(SELECT MAX(id) FROM alert_event GROUP BY rule, group_name, tid)")
                for row in rows:
                    event = dict(row)
                    event["group"] = event.pop("group_name")
                    event.pop("id")
                    latest[(event["rule"], event["group"], event["tid"])] = event
            finally:
                connection.close()
        recent = sorted(recent, key=lambda event: event["ts"])[-500:]
        for event in recent:
            event["group"] = event.pop("group_name")
            event.pop("id")
        return recent, {key: event for key, event in latest.items() if event["status"] != "resolved"}


def history(directory, session, tid, start, end, limit=2000):
    result = []
    first = dt.datetime.fromtimestamp(start, dt.timezone.utc).date().isoformat()
    last = dt.datetime.fromtimestamp(end, dt.timezone.utc).date().isoformat()
    for path in sorted(Path(directory).glob("????-??-??.sqlite3")):
        if not first <= path.stem <= last:
            continue
        try:
            connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
            try:
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    "SELECT * FROM thread_rollup WHERE session=? AND tid=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?",
                    (session, tid, start, end, limit - len(result)))
                for row in rows:
                    item = dict(row)
                    item["sample_counts"] = json.loads(item["sample_counts"])
                    result.append(item)
            finally:
                connection.close()
        except sqlite3.OperationalError:
            continue
        if len(result) >= limit:
            break
    return result
