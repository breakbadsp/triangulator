import ipaddress
import math
import tomllib
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_ALERTS = {
    "window_s": 5, "sustain_windows": 3, "resolve_windows": 2,
    "cpu_warn_pct": 50, "cpu_crit_pct": 90, "starve_run_delay_pct": 20,
    "blocked_secs": 15, "kernel_wait_secs": 5, "sampler_silent_secs": 10,
    "target_absent_secs": 5, "packet_loss_pct": 20, "reminder_secs": 1800,
}


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
    for key in DEFAULT_ALERTS:
        value = config["alerts"][key]
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"alerts.{key} must be positive and finite")
    alerts = config["alerts"]
    if not 5 <= alerts["window_s"] <= 10 or not 10 <= alerts["blocked_secs"] <= 30:
        raise ValueError("window_s must be 5..10; blocked_secs must be 10..30")
    if alerts["cpu_warn_pct"] >= alerts["cpu_crit_pct"]:
        raise ValueError("cpu_warn_pct must be below cpu_crit_pct")
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
    return config
