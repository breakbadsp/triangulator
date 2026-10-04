import argparse
import copy
import http.server
import ipaddress
import json
import logging
import math
import queue
import signal
import socket
import threading
import time
import urllib.parse
from pathlib import Path

from .config import SETTINGS_FILE, clear_settings, describe_settings, load, load_settings, merge_settings, save_settings
from .delivery import Delivery
from .engine import Monitor
from .protocol import decode
from .storage import Storage, history


class Dashboard(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.respond(200, (Path(__file__).parents[1] / "collector/dashboard.html").read_bytes(), "text/html; charset=utf-8")
        elif parsed.path == "/api/live":
            self.respond(200, self.server.live, "application/json")
        elif parsed.path == "/api/alert-settings":
            self.respond(200, self.server.settings, "application/json")
        elif parsed.path == "/api/history":
            query = urllib.parse.parse_qs(parsed.query)
            try:
                session = str(int(query["session"][0]))
                tid = int(query["tid"][0])
                end = float(query.get("end", [time.time()])[0])
                start = float(query.get("start", [end - 3600])[0])
                if not all(math.isfinite(value) for value in (start, end)) or not 0 <= start <= end <= 253402214400:
                    raise ValueError("invalid time range")
                if end - start > self.server.config["retention_days"] * 86400 or tid <= 0:
                    raise ValueError("range exceeds retention or invalid tid")
                rows = history(self.server.config["data_dir"], session, tid, start, end)
                self.respond(200, json.dumps({"rows": rows, "limit": 2000, "truncated": len(rows) == 2000}).encode(), "application/json")
            except (KeyError, ValueError, OverflowError):
                self.respond(400, b'{"error":"session, tid and a valid time range are required"}', "application/json")
        else:
            self.respond(404, b"Not found", "text/plain")

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/alert-settings":
            self.respond(404, b"Not found", "text/plain")
            return
        error = self.reject_cross_site()
        length = int(self.headers.get("Content-Length") or 0)
        if error is None and not 0 < length <= 16384:
            error = "request body must be 1..16384 bytes"
        if error is not None:
            self.respond(403 if "origin" in error or "host" in error else 400,
                         json.dumps({"error": error}).encode(), "application/json")
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self.respond(400, b'{"error":"body must be JSON"}', "application/json")
            return
        reply = queue.Queue(maxsize=1)
        self.server.requests.put((body, reply))
        try:
            code, payload = reply.get(timeout=5)
        except queue.Empty:
            code, payload = 503, {"error": "collector busy; try again"}
        self.respond(code, json.dumps(payload).encode(), "application/json")

    def reject_cross_site(self):
        """Refuse writes that a page on another site, or a rebound DNS name, could send."""
        if self.headers.get("X-Triangulator") != "1" or \
                self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return "missing JSON content type or X-Triangulator header"
        host = self.headers.get("Host", "")
        hostname = urllib.parse.urlsplit("//" + host).hostname or ""
        try:
            ipaddress.ip_address(hostname)
            literal = True
        except ValueError:
            literal = False
        allowed = {"localhost", self.server.config["http_host"].lower(), *self.server.config["http_allowed_hosts"]}
        if not literal and hostname not in allowed:
            return "host not allowed; add it to http_allowed_hosts"
        origin = self.headers.get("Origin")
        if origin is not None and urllib.parse.urlsplit(origin).netloc != host:
            return "cross-origin request refused"
        return None

    def respond(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format_string, *args):
        logging.debug("HTTP " + format_string, *args)


class Server(http.server.HTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description="Triangulator UDP collector and dashboard")
    parser.add_argument("config", type=Path)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = load(args.config)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    defaults = copy.deepcopy(config["alerts"])
    try:
        load_settings(config)
    except (OSError, ValueError) as error:
        parser.error(f"saved dashboard alert settings ({Path(config['data_dir']) / SETTINGS_FILE}): {error}")
    if args.check_config:
        print("Collector configuration is valid")
        return
    storage = Storage(config["data_dir"], config["retention_days"], config["store_raw"])
    storage.flush(time.time())
    delivery = Delivery(config)
    monitor = Monitor(config, storage, delivery.submit, time.time())
    family = socket.AF_INET6 if ":" in config["udp_host"] else socket.AF_INET
    receiver = socket.socket(family, socket.SOCK_DGRAM)
    receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    receiver.bind((config["udp_host"], config["udp_port"]))
    receiver.settimeout(0.2)
    if ":" in config["http_host"]:
        class IPv6Server(Server):
            address_family = socket.AF_INET6
        server_class = IPv6Server
    else:
        server_class = Server
    server = server_class((config["http_host"], config["http_port"]), Dashboard)
    server.config = config
    server.live = b'{}'
    server.requests = queue.Queue()
    saved = (Path(config["data_dir"]) / SETTINGS_FILE).exists()
    server.settings = json.dumps(describe_settings(config["alerts"], defaults, saved)).encode()

    def change_settings(body, now):
        nonlocal saved
        if body == {"reset": True}:
            alerts = copy.deepcopy(defaults)
            clear_settings(config["data_dir"])
            saved = False
        else:
            alerts = merge_settings(config["alerts"], body)
            save_settings(config["data_dir"], alerts)
            saved = True
        monitor.apply_alert_settings(alerts, now)
        logging.info("Alert settings changed from the dashboard: %s", json.dumps(body, sort_keys=True))
        description = describe_settings(config["alerts"], defaults, saved)
        server.settings = json.dumps(description).encode()
        return description

    dashboard = threading.Thread(target=server.serve_forever, name="dashboard", daemon=True)
    dashboard.start()
    stopped = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stopped.set())
    sampler_ip = config.get("sampler_ip")
    next_refresh = 0.0
    logging.info("UDP %s:%s; dashboard http://%s:%s", config["udp_host"], config["udp_port"], config["http_host"], config["http_port"])
    try:
        while not stopped.is_set():
            try:
                data, peer = receiver.recvfrom(1201)
            except socket.timeout:
                data = None
            now = time.time()
            while not server.requests.empty():
                body, reply = server.requests.get_nowait()
                try:
                    reply.put((200, change_settings(body, now)))
                except ValueError as error:
                    reply.put((400, {"error": str(error)}))
                except OSError as error:
                    reply.put((500, {"error": f"could not save settings: {error}"}))
                except Exception:
                    # Request handling must never stop monitoring; report and carry on.
                    logging.exception("Alert settings request failed")
                    reply.put((500, {"error": "internal error; see collector log"}))
            if data is not None:
                peer_ip = str(ipaddress.ip_address(peer[0]))
                if sampler_ip is None or peer_ip == sampler_ip:
                    try:
                        packet = decode(data)
                    except ValueError:
                        monitor.bad_packets += 1
                    else:
                        if sampler_ip is None:
                            sampler_ip = peer_ip
                            logging.info("Pinned sampler source to %s", sampler_ip)
                        monitor.accept(packet, now)
            if time.monotonic() >= next_refresh:
                health = monitor.health(now)
                health.update(delivery_failures=delivery.failures, delivery_dropped=delivery.dropped,
                              delivery_queued=delivery.queue.qsize(), sampler_ip=sampler_ip)
                snapshot = monitor.snapshot(now)
                server.live = json.dumps(dict(snapshot, health=health), allow_nan=False).encode()
                storage.flush(now)
                next_refresh = time.monotonic() + 0.5
    finally:
        receiver.close()
        server.shutdown()
        server.server_close()
        monitor.close()
        storage.close()
        delivery.close()


if __name__ == "__main__":
    main()
