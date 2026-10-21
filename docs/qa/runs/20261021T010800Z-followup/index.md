# Follow-up: contract and result merge script

This directory holds the shared tools for the follow-up runs. It holds no
product observations.

- `SKILL.md`: the contract each follow-up agent used. Each run writes its own
  directory and a `results.json`. The parent merges and validates the rows.
- `merge_results.py`: merges reviewed `results.json` manifests into the result
  table in [test cases](../../test-cases.md). It accepts only the statuses
  PASSED, FAILED, BLOCKED, and NOT_RUN, and rejects a duplicate case.

The follow-up run records are:

- [Dashboard](../20261021T010700Z-dashboard-followup/index.md)
- [Sanitizers](../20261021T011600Z-sanitizers-followup/index.md)
- [Capacity and sanitizer stop](../20261021T0700Z-capacity-sanitizer-followup/index.md)
- [Memory and API](../2026-10-21-memory-api-followup/index.md)
- [Upgrade lifecycle](../2026-10-21-upgrade-lifecycle-followup/index.md)
