# Follow-up: memory, API, and target-management checks

Package `dev-384352f` in an isolated install under
`/tmp/triangulator-memory-api-followup`, with `fixture.c` owned test processes.
This record lists the saved evidence. It does not set any case result. The
results table in [test cases](../../test-cases.md) holds the results.

## What the run recorded

- `api-check.py` read `/api/targets`, `live`, `resources`, `replay`, and
  `memory-map` for two targets. An unknown target returned HTTP 404.
- It ran `set-target.sh` and `set-rate.sh`: add, reorder with SIGHUP, rate
  change, selector change, invalid id (exit 1), duplicate id (exit 1), help,
  remove, and restore. Each step has the command output and the target list
  after it.
- Sampler thread count was recorded as `1`.
- Budget, growth, and socket observations: `budget-heavy.json`,
  `budget-recovery.json`, `growth-map.json`, `socket-before.json`, and the
  three `socket-restart-*.json` files.
- `wire-fixture.py` and `wire-storage.sqlite3` hold a wire and storage check.

## Evidence

- Scripts and fixture: `api-check.py`, `wire-fixture.py`, `fixture.c`.
- Data: `api-observations.json`, `budget-heavy.json`, `budget-recovery.json`,
  `growth-map.json`, `socket-before.json`, `socket-restart-shared.json`,
  `socket-restart-unique.json`, `socket-restart-unique-final.json`,
  `wire-storage.sqlite3`.
- Screenshots: `layout-refresh-observation.png`, `socket-wrong-host.png`.

To reproduce, run `api-check.py` against a package install whose paths match
the ones in the script.
