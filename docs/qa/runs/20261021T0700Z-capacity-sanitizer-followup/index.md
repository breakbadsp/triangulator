# Follow-up: capacity (QA-078) and the ThreadSanitizer stop failure

Source: master merged into `qa/five-prod-targets`. Runtime: the test harness in
`tests/test_sampler_control.py` (collector `max_targets = 5`, one sampler, six
owned `sleep` processes).

## QA-078 result: FAILED

- Five targets stayed live with unchanged sessions. Their data did not mix.
- `POST /api/targets` with a sixth target returned HTTP 200 and wrote it to the
  sampler configuration. No capacity error was shown.
- The collector dropped the sixth target silently. Only `capacity_drops` in
  `/api/targets` rose (22 after 2 seconds). The dashboard does not show it.
- After one target was removed, the sixth target became live. The other four
  kept their sessions.

Evidence: [test log](evidence/qa078-test.log). The new test
`test_sixth_target_over_capacity_is_refused_until_a_slot_frees` keeps the safe
behavior and records the missing add-time error.

## ThreadSanitizer failure in `make check-sanitizers`

`test_cpu_budget_changes_wire_interval_without_changing_sessions` failed only
with `SANITIZER=thread`. The sampler stop took up to one tick (5 s at the
0.2 Hz minimum rate), which equals the test limit of 5 s. Without the
sanitizer, SIGTERM stops the sampler in under 0.01 s. ThreadSanitizer defers
the signal until the next tick. This is a test timing problem, not a sampler
defect. The stop limit is now 15 s.
