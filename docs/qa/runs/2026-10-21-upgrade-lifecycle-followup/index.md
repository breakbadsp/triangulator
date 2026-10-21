# Follow-up: configuration, start and stop, and slot pauses

Package `dev-384352f` in an isolated runtime under
`/tmp/triangulator-upgrade-lifecycle`. This record lists the saved evidence. It
does not set any case result. The results table in
[test cases](../../test-cases.md) holds the results.

## What the run recorded

- `config-validation.json`: the collector rejected `max_targets` of 0 (exit 2,
  "must be a positive integer") and 65 (exit 2, "must be 1..64"). A
  configuration with a duplicate `max_live_samples` key was rejected (exit 2).
  The shipped collector and sampler configurations were valid (exit 0).
- `default-config-start-stop.txt`: start and stop of the default
  configuration. The sampler asks for `target_process` or `target_pid` while
  none is set. After that, the collector and sampler started and stopped.
- `slot-pauses.json`: a timeline from `slot-pauses.py` with a target rename
  and 30 s and 90 s sampler pauses. It ends with `completed: true`.
  This is the QA-072 timeline.

## Evidence

`collector.toml`, `sampler.toml`, `config-validation.json`,
`default-config-start-stop.txt`, `slot-pauses.py`, `slot-pauses.json`.

To reproduce, run `slot-pauses.py` on a started runtime with the same paths.
