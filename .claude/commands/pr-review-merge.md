---
description: Fast PR review and merge - one reviewer, one fixer, one gate. Max two review rounds, then hand over to the user.
argument-hint: <PR number>
---

Run the review workflow for pull request $ARGUMENTS. You are the orchestrator. Do not review or edit code yourself.

## Setup

1. `gh pr view $ARGUMENTS --json number,state,headRefName,headRefOid,url`. Stop if the PR is closed or merged.
2. Use the worktree that holds the PR branch (`git worktree list`), never the primary checkout. Run `git fetch origin`. HEAD must equal `headRefOid` and `git status --porcelain` must be empty. Otherwise stop and report.
3. Start roles with the Agent tool and the `subagent_type` and model below. Read-only roles (reviewer, test merger) must leave HEAD and the worktree unchanged. If they did not, stop and report.

## Rounds (at most two)

1. Start one reviewer: `pr-adversarial-reviewer`, model `sonnet`, effort `medium`. Pass the PR number, worktree path, round number, and head SHA. In round 2, also pass the round-1 head SHA. Round 2 reviews only the round-1 fixes and `git diff <round-1 head>..<head>`.
2. Confirm its review reached GitHub (a review whose body starts with `## Review, round <n>, head <SHA>`). If missing, stop and report.
3. If the review lists no `blocker` or `major` finding, go to the merge gate. Skip the analyzer.
4. Otherwise start `pr-comment-analyzer`, model `sonnet`, effort `medium`. Pass the PR number, worktree path, and round number. It fixes or rebuts each finding and pushes.
5. If the head SHA changed and this was round 1, start round 2. Otherwise go to the merge gate.

## Stop for manual handling

After round 2's analyzer, if any `blocker` or `major` finding is still open (not `FIXED` or `REBUTTED`), or any user-raised `critical` issue is open, **do not merge and do not start another round**. Report the open issues and the PR URL as needing manual handling.

## Merge gate (once)

Start `pr-test-merger`, model `haiku`, effort `medium`, with the PR number, worktree path, and head SHA (HEAD must equal `headRefOid`). If it merges, finish. If a gate fails, do not retry and do not start a fix pass. Report the failing gate for manual handling.

## Limits

- Never start a third round or a second gate run.
- Pass every agent an effort of `medium` or `high`, never lower or higher. Use `medium` unless the task needs more.
- Never merge with an open `blocker` or `major` finding, or a failing check.
- Neither this command nor its agents ever start `/pr-review-merge` again. Only the user does.
- If a result is ambiguous, stop and report.

## Final report (under 8 lines)

PR URL, rounds run, findings per severity per round, outcomes, gate result, and the merge SHA or the open issues. Mark commits pushed after the last review as not reviewed.
