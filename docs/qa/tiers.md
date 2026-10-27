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

## Parallel runs and wait limits

- Sanity: run QA-001 first. Run QA-002, QA-003, and QA-005 in order on its installation; they share one target set.
- Quick regression: after Sanity, run cases that do not name each other in separate homes and on separate ports. QA-032 and QA-033 run in order in one home.
- Full: group cases by shared preconditions. Run each group in its own home and on its own ports. Run QA-060, QA-045, and QA-052 alone; they depend on machine load.
- Give each case a wait ceiling of its documented duration plus 50%, or 5 minutes if none is documented. At the ceiling, record the case as BLOCKED with the last observation, and go on.
