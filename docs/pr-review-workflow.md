# Pull request review workflow

Tool-neutral spec. Any agent runner can follow it: Claude Code, Codex, or a
script. `.claude/commands/pr-review-merge.md` and `.claude/agents/` are the
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
3. No `blocker` or `major` from either: go to the gate.
4. Otherwise start the analyzer. It handles the union of the findings,
   deduplicated, and treats quick-reviewer findings with extra suspicion
   because that model is weaker.
5. If the head SHA changed and this was round 1, run round 2: both reviewers
   look only at the round-1 fixes and the new commits.

After round 2, an open `blocker` or `major` stops the run: do not merge, report
for manual handling.

## Gate (once)

- Head SHA equals the expected SHA, and the worktree is clean.
- `full`: run the repository's check command on a throwaway merge of the PR
  into the base branch.
- `scan`: skip the local check only when every changed file matches the paths
  filter of a passing CI workflow that builds or tests. Run it otherwise.
- CI checks show only `pass` or `skipping`. `no checks reported` passes only
  when no changed file matches a `pull_request` `paths` filter.
- The PR is `MERGEABLE` and `CLEAN`.
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
