# Alerting

This module is not connected. It has no main program and sends no alerts.
It comes from the retired Python collector. The current collector does not
run alert rules. See [TODO](../TODO.md) for remaining work.

Keep alerting in a separate process. Read SQLite day files without writing to
them, or use the HTTP API. Give alert events their own storage directory.
Do not consume UDP or add delivery work to the collector loop.

| Area | Source |
| --- | --- |
| Rule names, defaults, and validation | [settings.py](settings.py) |
| Alert lifecycle and recovery | [engine.py](engine.py) |
| Event storage | [log.py](log.py) |
| Queued webhook and email delivery | [delivery.py](delivery.py) |
| Executable checks | [test_alerting.py](../tests/test_alerting.py) |

## Requirements to preserve

The old rule checks were removed with the Python collector. Rebuild them on
rollups or the API. These requirements are not implemented by this module:

- Sustained thread CPU above warning or critical thresholds opens an alert.
  Rollup windows need an explicit timing design before this rule returns.
- Sustained run delay indicates starvation. In status fallback, use runnable
  samples with low CPU and increasing delay; label the weaker evidence.
- Continuous uninterruptible waits can indicate kernel stalls. Ordinary futex,
  socket, poll, and pipe waits must not alert by themselves.
- Monitor rules distinguish sampler silence, reported target absence, packet
  loss, and lost wait-channel access.
- Invalid windows, gaps, session changes, and counter resets invalidate sustained
  conditions. Resolve thread alerts when their monitored identity ends.
- A settings API needs request validation and an explicit write-access policy.
