# Follow-up: dashboard browser workflows

Browsers: Chromium 154.0.8037.97 and Firefox 157.0, against a collector on
`127.0.0.1:19571`. This record lists the saved evidence. It does not set any
case result. The results table in [test cases](../../test-cases.md) holds the
results.

## What the run recorded

`evidence/browser-workflows.json` holds one entry per stage, with the page
text, URL, and health panel:

- `qa045-*`: twenty initial viewers, a slow-connection deadline, and local
  replay.
- `qa051-*`: collector outage and recovery.
- `qa052-*`: independent filter and replay state, and target isolation in
  Firefox.
- `animation-*` and `benchmark-*`: reduced motion, keyboard focus, and
  no-JavaScript views of the internals and performance pages.

Other files: `slow-read-retry.json` (a closed connection after 1074 ms),
`collector-restart-lost-target.png` (the target loss after a collector restart,
fixed by PR #122), and the helper scripts `browser-workflows.cjs` and
`watch-proxy.py` (test-only proxy).

## Evidence

All files are in `evidence/`: `browser-workflows.cjs`, `browser-workflows.json`,
`collector-restart-lost-target.png`, `slow-read-retry.json`, `watch-proxy.py`.

To reproduce, run `browser-workflows.cjs` against a collector with the same
port and targets.
