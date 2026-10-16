# QA run tiers

Senior Manual QA runs the smallest tier that fits the request. Case procedures
live in [test-cases.md](test-cases.md). This file only selects cases.

| Tier | Cases | Target time | When |
| --- | --- | --- | --- |
| Sanity | QA-001, QA-002, QA-003, QA-005 | 10 minutes | Default first run for any package |
| Quick regression | Sanity plus QA-004, QA-007, QA-028, QA-029, QA-032, QA-033, QA-036, QA-037, QA-047 | 45 minutes | After Sanity passes, or when asked for a regression |
| Full | Every case in test-cases.md and bug-lab-cases.md | No limit | Only when the request says full |

When a selected case's preconditions name another case, as QA-033 names QA-032,
that case runs too. A requested feature adds its own cases and the
affected existing cases to the tier. Edit this table when a case becomes sanity-critical or stops being
quick. Keep Sanity at five cases or fewer.
