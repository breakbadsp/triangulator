import datetime as dt
import sqlite3
from contextlib import closing
from pathlib import Path

# The same alert_event table as in the collector's day files.
SCHEMA = """
CREATE TABLE IF NOT EXISTS alert_event (
 id INTEGER PRIMARY KEY, ts REAL NOT NULL, rule TEXT NOT NULL,
 group_name TEXT NOT NULL, tid INTEGER NOT NULL, name TEXT NOT NULL,
 detail TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL,
 session TEXT NOT NULL
);
"""


class AlertLog:
    """Alert events in one SQLite file per UTC day (YYYY-MM-DD.sqlite3).

    Give it a directory of its own: the collector's day files are read-only
    for other programs. Alerts are rare, so each event opens, writes and
    commits its day file.
    """

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def event(self, event):
        day = dt.datetime.fromtimestamp(event["ts"], dt.timezone.utc).date().isoformat()
        with closing(sqlite3.connect(self.directory / f"{day}.sqlite3")) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
            connection.execute(
                "INSERT INTO alert_event(ts,rule,group_name,tid,name,detail,status,severity,session) VALUES (?,?,?,?,?,?,?,?,?)",
                tuple(event[key] for key in ("ts", "rule", "group", "tid", "name", "detail", "status", "severity", "session")))
            connection.commit()

    def recover_alerts(self):
        """The last 500 events, oldest first, and the open alerts by (rule, group, tid)."""
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

