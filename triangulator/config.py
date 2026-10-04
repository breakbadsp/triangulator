import ipaddress
import json
import math
import os
import tomllib
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_ALERTS = {
    "window_s": 5, "sustain_windows": 3, "resolve_windows": 2,
    "cpu_warn_pct": 50, "cpu_crit_pct": 90, "starve_run_delay_pct": 20,
    "cpu_sustain_secs": 5, "kernel_wait_secs": 5, "sampler_silent_secs": 10,
    "target_absent_secs": 5, "packet_loss_pct": 20, "reminder_secs": 1800,
}

# Alert rules the dashboard can switch on and off, with the settings each one
# uses. Every rule is evaluated by the collector; the sampler only reports data.
RULES = (
    {"rule": "cpu_warn", "label": "High CPU (warning)", "settings": ("cpu_warn_pct", "cpu_sustain_secs"),
     "description": "Thread CPU above the threshold continuously for the duration."},
    {"rule": "cpu_critical", "label": "High CPU (critical)", "settings": ("cpu_crit_pct", "cpu_sustain_secs"),
     "description": "Thread CPU above the threshold continuously for the duration."},
    {"rule": "starved", "label": "Starved thread", "settings": ("starve_run_delay_pct",),
     "description": "Thread waits to run (run delay) for this share of a window, for three windows."},
    {"rule": "kernel_wait", "label": "Stuck in kernel (D)", "settings": ("kernel_wait_secs",),
     "description": "Thread in uninterruptible state D for longer than this."},
    {"rule": "sampler_silent", "label": "Sampler silent", "settings": ("sampler_silent_secs",),
     "description": "No datagrams from the sampler for this long."},
    {"rule": "target_absent", "label": "Target absent", "settings": ("target_absent_secs",),
     "description": "Sampler reports that the target process is gone for this long."},
    {"rule": "packet_loss", "label": "Packet loss", "settings": ("packet_loss_pct",),
     "description": "Estimated datagram loss over the last minute above this."},
    {"rule": "access_lost", "label": "Access lost", "settings": (),
     "description": "Most threads report a hidden wait channel."},
)
RULE_NAMES = tuple(rule["rule"] for rule in RULES)
# Editable settings: (label, unit, minimum, maximum).
SETTINGS = {
    "cpu_warn_pct": ("Warning threshold", "%", 1, 10000),
    "cpu_crit_pct": ("Critical threshold", "%", 1, 10000),
    "cpu_sustain_secs": ("Sustained for", "s", 1, 3600),
    "starve_run_delay_pct": ("Run delay", "%", 1, 100),
    "kernel_wait_secs": ("Longer than", "s", 1, 3600),
    "sampler_silent_secs": ("Silent for", "s", 2, 3600),
    "target_absent_secs": ("Absent for", "s", 1, 3600),
    "packet_loss_pct": ("Loss above", "%", 1, 100),
    "reminder_secs": ("Remind open alerts every", "s", 60, 604800),
}
SETTINGS_FILE = "alert-settings.json"


def validate_alerts(alerts):
    """Check a complete alert configuration in place; raise ValueError on problems."""
    for key in DEFAULT_ALERTS:
        value = alerts[key]
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"alerts.{key} must be positive and finite")
    for key, (label, _unit, low, high) in SETTINGS.items():
        if not low <= alerts[key] <= high:
            raise ValueError(f"{label} ({key}) must be between {low} and {high}")
    if not 5 <= alerts["window_s"] <= 10:
        raise ValueError("window_s must be 5..10")
    if alerts["cpu_warn_pct"] >= alerts["cpu_crit_pct"]:
        raise ValueError("CPU warning threshold must be below the critical threshold")
    enabled = alerts.get("enabled", {})
    if not isinstance(enabled, dict) or set(enabled) - set(RULE_NAMES) or \
            any(type(value) is not bool for value in enabled.values()):
        raise ValueError(f"alerts.enabled maps rule names ({', '.join(RULE_NAMES)}) to true or false")
    alerts["enabled"] = {rule: enabled.get(rule, True) for rule in RULE_NAMES}


def editable(alerts):
    """The part of the alert configuration the dashboard shows and may change."""
    return {"enabled": dict(alerts["enabled"]), **{key: alerts[key] for key in SETTINGS}}


def merge_settings(alerts, changes):
    """Return alerts with dashboard changes applied, validated. alerts is not modified."""
    if not isinstance(changes, dict) or set(changes) - {"enabled", *SETTINGS}:
        raise ValueError("unknown alert setting")
    if not isinstance(changes.get("enabled", {}), dict):
        raise ValueError("enabled must map rule names to true or false")
    merged = {**alerts, **{key: value for key, value in changes.items() if key != "enabled"}}
    merged["enabled"] = {**alerts["enabled"], **changes.get("enabled", {})}
    validate_alerts(merged)
    return merged


def load_settings(config):
    """Apply saved dashboard changes on top of the TOML alert configuration."""
    path = Path(config["data_dir"]) / SETTINGS_FILE
    try:
        changes = json.loads(path.read_text())
    except FileNotFoundError:
        return
    config["alerts"] = merge_settings(config["alerts"], changes)


def save_settings(data_dir, alerts):
    directory = Path(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / (SETTINGS_FILE + ".tmp")
    temporary.write_text(json.dumps(editable(alerts), indent=2) + "\n")
    os.replace(temporary, directory / SETTINGS_FILE)


def clear_settings(data_dir):
    (Path(data_dir) / SETTINGS_FILE).unlink(missing_ok=True)


def describe_settings(alerts, defaults, saved):
    """Settings payload for the dashboard: rule metadata, current values and defaults."""
    return {"rules": [dict(rule, settings=list(rule["settings"])) for rule in RULES],
            "settings": {key: {"label": label, "unit": unit, "min": low, "max": high}
                         for key, (label, unit, low, high) in SETTINGS.items()},
            "values": editable(alerts), "defaults": editable(defaults), "saved": saved}


def load(path):
    with open(path, "rb") as source:
        config = tomllib.load(source)
    config = {"clock_ticks": 100, "retention_days": 7,
              "store_raw": False, "data_dir": "data", "udp_host": "0.0.0.0",
              "udp_port": 9400, "http_host": "127.0.0.1", "http_port": 9401,
              "group": [], "max_live_samples": 1_000_000, **config}
    config["alerts"] = {**DEFAULT_ALERTS, **config.get("alerts", {})}
    for key in ("clock_ticks", "retention_days", "max_live_samples", "udp_port", "http_port"):
        if type(config[key]) is not int or config[key] <= 0:
            raise ValueError(f"{key} must be a positive integer")
    for key in ("udp_port", "http_port"):
        if config[key] > 65535:
            raise ValueError(f"invalid {key}")
    validate_alerts(config["alerts"])
    alerts = config["alerts"]
    if not alerts.get("webhook_url") and not alerts.get("smtp"):
        raise ValueError("configure alerts.webhook_url and/or alerts.smtp")
    for url in (alerts.get("webhook_url"), config.get("deadman_url")):
        if url and (urlparse(url).scheme not in {"http", "https"} or not urlparse(url).netloc):
            raise ValueError("delivery URLs must be HTTP(S)")
    if smtp := alerts.get("smtp"):
        if not all(smtp.get(key) for key in ("host", "from", "to")):
            raise ValueError("SMTP requires host, from and to")
    names = set()
    for group in config["group"]:
        if not group.get("name") or not group.get("prefix") or len(group["prefix"].encode()) > 15:
            raise ValueError("each group needs a name and a prefix of at most 15 bytes")
        if group["name"] in names or group["name"] == "ungrouped":
            raise ValueError("group names must be unique; ungrouped is reserved")
        names.add(group["name"])
    if config.get("sampler_ip"):
        config["sampler_ip"] = str(ipaddress.ip_address(config["sampler_ip"]))
    config["data_dir"] = str(Path(config["data_dir"]).resolve())
    hosts = config.setdefault("http_allowed_hosts", [])
    if not isinstance(hosts, list) or not all(isinstance(host, str) and host for host in hosts):
        raise ValueError("http_allowed_hosts must be a list of host names")
    config["http_allowed_hosts"] = [host.lower() for host in hosts]
    return config
