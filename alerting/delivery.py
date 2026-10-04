import email.message
import json
import logging
import os
import queue
import smtplib
import ssl
import threading
import time
import urllib.request


class Delivery:
    def __init__(self, config):
        self.config = config
        self.queue = queue.Queue(maxsize=1000)
        self.stopped = threading.Event()
        self.failures = 0
        self.dropped = 0
        self.thread = threading.Thread(target=self.run, name="alert-delivery", daemon=True)
        self.thread.start()

    def submit(self, event):
        try:
            self.queue.put_nowait(dict(event))
        except queue.Full:
            self.dropped += 1
            logging.error("Alert delivery queue full; event retained in SQLite")

    def post(self, url, event=None):
        body = json.dumps(event).encode() if event is not None else None
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read(1024)

    def email(self, config, event):
        message = email.message.EmailMessage()
        message["From"] = config["from"]
        recipients = config["to"]
        message["To"] = ", ".join(recipients) if isinstance(recipients, list) else recipients
        message["Subject"] = f"Triangulator: {event['status']} {event['rule']} {event['name']}"
        message.set_content(json.dumps(event, indent=2))
        with smtplib.SMTP(config["host"], config.get("port", 587), timeout=5) as client:
            if config.get("starttls", True):
                client.starttls(context=ssl.create_default_context())
            if config.get("username"):
                client.login(config["username"], os.environ[config.get("password_env", "TRIANGULATOR_SMTP_PASSWORD")])
            client.send_message(message)

    def run(self):
        next_ping = 0.0
        while not self.stopped.is_set():
            if self.config.get("deadman_url") and time.monotonic() >= next_ping:
                try:
                    self.post(self.config["deadman_url"])
                except Exception:
                    self.failures += 1
                    logging.exception("Dead-man heartbeat failed")
                next_ping = time.monotonic() + 60
            try:
                event = self.queue.get(timeout=0.5)
            except queue.Empty:
                continue
            alerts = self.config["alerts"]
            channels = []
            if alerts.get("webhook_url"):
                channels.append(lambda: self.post(alerts["webhook_url"], event))
            if alerts.get("smtp"):
                channels.append(lambda: self.email(alerts["smtp"], event))
            for send in channels:
                for attempt in range(3):
                    try:
                        send()
                        break
                    except Exception:
                        self.failures += 1
                        logging.exception("Alert delivery failed (attempt %d/3)", attempt + 1)
                        if self.stopped.wait(min(2 ** attempt, 4)):
                            break
            self.queue.task_done()

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=6)
