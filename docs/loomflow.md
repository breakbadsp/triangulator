# LoomFlow: pull request review workflow

Tool-neutral spec. Any agent runner can follow it: Claude Code, Codex, or a
script. `.claude/commands/loomflow.md` and `.claude/agents/` are the
Claude Code adapter. The spec uses only `git` and `gh`, so it works for any
GitHub repository. Repository details come from that repository's `AGENTS.md`
or README: the check command, coding standards, and which paths are sensitive.

## Roles

| Role | Job | Edits code |
| --- | --- | --- |
| Orchestrator | Triage, start roles, enforce limits, report | no |
| Reviewer | Deep review, `blocker` and `major` only | no |
| Quick reviewer | Cheap second opinion or scan, `blocker` and `major` only | no |
| Comment analyzer | Fix real findings, rebut wrong ones | yes |
| Test and merge | Run the gate once, merge when it passes | no |

## Review method

Reviewers spend their time where defects hide: the callers and readers of
changed code, failure and boundary paths, data that crosses a boundary (wire
formats, stored files, APIs, configuration), and tests that fail without the
change. Before posting, each reviewer tries to disprove each finding and drops
it if a guard, a caller check, or a test prevents the failure. A wrong finding
costs an analyzer pass and often a second round. Round 2 also checks that the
fixes do not break the callers of the code they change.

The deep reviewer also checks the diff against the claims in the PR title and
body. It finds the one fact that makes the change safe and checks that fact
first. A measured number in the PR, such as sampler overhead, counts only if
the run had no errors and the timed work ran the changed code.

Before the analyzer fixes a behavior defect, it adds a regression test and
confirms that the test fails without the fix. It does this only when a cheap
local test target exists, and it runs only that test for this step.

These three rules come from Poteto's pstack skills `blast-radius`,
`benchmark-checklist` (questions 4 and 7), and `tdd`. LoomFlow takes no other
pstack parts, to keep each run fast and cheap. Reviewers stay read-only and
run no builds or tests.

## Model and reasoning selection

For `full`, use one large, capable model and one small, quick model. Never use
two large models. Prefer different model families for the two reviewers. When
possible, also use a reviewer from a different family than the orchestrator.
If another family is unavailable, keep the large-and-quick pair within the
available family. For simple changes in `scan`, use only one quick reviewer.

Before starting each role, check the remaining token budget. Use `low` effort
for simple work and `medium` otherwise. Lower effort when the budget is small
or unknown. Use `high` only for a concrete, complex risk with enough tokens
left for fixes and the merge gate. Do not select higher effort by default.

Critical changes: if the change is critical, or touches a critical path, run at
least one reviewer as Opus 5.5 at effort `high`. Use GPT 6.1 Sol at effort
`high` instead when it is available and the limits allow. Never use Astra 6.
Whenever Astra 6 would be chosen, use GPT 6.1 Sol at `high`. This rule
overrides the budget-based effort above for that reviewer.

## Triage

The orchestrator picks a tier from `gh pr diff --name-only` and `--stat`.
Rules are objective. When unsure, pick `full`.

- `scan`: the PR touches no sensitive path, and either every changed file is
  documentation (`*.md`, `*.txt`, images, `docs/`) or it changes at most 30
  lines in at most 3 files. Documentation on a sensitive path (such as
  `AGENTS.md` or `.claude/`) is `full`. Sensitive paths: CI workflows, build files, dependency
  manifests and lockfiles, auth or secrets, storage or wire formats, and
  anything the repository's `AGENTS.md` calls critical.
- `full`: everything else.

A user can force a tier by naming it in the command (`full` or `scan`). `full`
is never downgraded by the orchestrator.

## Flow

`scan`: start only one quick reviewer to scan the diff once. No blocker or
major: go to the gate. Otherwise treat it as round 1 of `full`, including both
reviewers on the whole diff, before the analyzer. The scan review's blockers
and majors stay open: the analyzer runs on them even if both full reviewers
report none.

`full`: at most two rounds.

1. Start the reviewer and the quick reviewer in parallel on the same head SHA.
2. Both post a review on the PR. If either is missing, stop and report.
3. No `blocker` or `major` from either: apply the check reuse rule below before
   waiting for CI. Stop at the first failed check. No failed check: go to the gate.
4. Otherwise start the analyzer. It handles the union of the findings,
   deduplicated, and treats quick-reviewer findings with extra suspicion
   because that model is weaker. It also reads the PR's CI checks when it
   starts and before it pushes. Each failed check is a `blocker` finding:
   it reads the failed log and fixes the cause. It never reruns CI.
5. If the head SHA changed and this was round 1, run round 2: both reviewers
   look only at the round-1 fixes and the new commits.

After round 2, an open `blocker` or `major` stops the run: do not merge, report
for manual handling.

## Reuse passing checks

Check the build and test inputs, not only the commit SHA. Reuse a passing CI
or local result when it covers the current code, tests, build configuration,
and base branch. Do not run the same full suite locally after CI passed it.
Do not update the PR branch or restart CI only to obtain a new check result.
If CI is already checking the required inputs, wait for it instead of starting
a duplicate local run.

For a documentation or generated QA summary conflict, preserve both changes
and run the affected documentation check, such as
`python3 scripts/qa_summary.py --write-readme --check`. Reuse the full test
results if no build or test input changed. If base branch code changed,
verify the combined code once. Use CI or a local run; do not require both.

The AlmaLinux workflow uses `.github/scripts/ci-reuse.py` to compare inputs
with a passing run for the same PR. It excludes documentation but keeps test
fixtures. It also checks for untested base branch changes. Missing evidence
requires a full run. Manual and nightly dispatches always run the tests.

## Gate (once)

- Head SHA equals the expected SHA, and the worktree is clean.
- Apply the check reuse rule above. Run the repository's check command on a
  throwaway merge only when no passing result covers the combined inputs.
- For documentation changes, run the affected documentation checks. Do not
  run a full build or test suite only because the review tier is `full`.
- CI checks show only `pass` or `skipping`, or a recorded passing result covers
  a pending duplicate check. Never ignore a failed check. `no checks reported` passes only
  when no changed file matches a `pull_request` `paths` filter. Stop waiting
  for pending checks as soon as one check or the local check fails.
- The PR is `MERGEABLE` and `CLEAN`. A pending duplicate covered by the reuse
  rule may leave the status `UNSTABLE`; use the normal merge command and
  respect required branch checks.
- Merge with `--match-head-commit`. Never `--admin`, never force.

A failed gate is reported, not retried.

## Limits

- Never a third round or a second gate run.
- No role starts the workflow again. Only the user does.
- Read-only roles leave HEAD and the worktree unchanged.
- Report commits pushed after the last review as not reviewed.

## PR comments

Every role posts one comment that starts with a fixed heading, so other roles
can find it:

- `## Review, round <n>, head <SHA>` (reviewer)
- `## Quick review, round <n>, head <SHA>` (quick reviewer)
- `## Analyzer, round <n>`
- `## Merge gate, head <SHA>`
