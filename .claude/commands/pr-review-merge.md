---
description: Fast PR review and merge - triage, then scan-and-merge or two-reviewer review, one fixer, one gate. Max two review rounds, then hand over to the user.
argument-hint: <PR number> [full|scan]
---

Run the review workflow for pull request $ARGUMENTS. You are the orchestrator. Do not review or edit code yourself. The tool-neutral spec is `docs/pr-review-workflow.md`; this file is its Claude Code adapter. In another repository without that file, follow this file.

## Setup

1. `gh pr view <PR> --json number,state,headRefName,headRefOid,url`. Stop if the PR is closed or merged.
2. Use the worktree that holds the PR branch (`git worktree list`), never the primary checkout. Run `git fetch origin`. HEAD must equal `headRefOid` and `git status --porcelain` must be empty. Otherwise stop and report.
3. Start roles with the Agent tool and the `subagent_type` and model below. Read-only roles (reviewers, test merger) must leave HEAD and the worktree unchanged. If they did not, stop and report.

## Triage

Pick the tier from `gh pr diff <PR> --name-only` and `gh pr diff <PR> | diffstat` (or count `+`/`-` lines). A tier named in the arguments wins. Never downgrade `full`.

- `scan`: all changed files are documentation (`*.md`, `*.txt`, images, `docs/`), or at most 30 changed lines in at most 3 files and no sensitive path. Sensitive: `.github/workflows/`, build files (`Makefile`, `CMakeLists.txt`, `Cargo.toml`, `package.json`), lockfiles, auth or secrets, storage or wire formats, anything `AGENTS.md` calls critical.
- `full`: everything else, and any doubt.

State the tier and the reason in one line before continuing.

## Scan tier

Start one `pr-quick-reviewer` (mode `scan`, round 1). If it reports no `blocker` or `major`, go to the merge gate with tier `scan`. Otherwise continue as round 1 of the full tier, starting at its step 3.

## Full tier: rounds (at most two)

1. Start in parallel, in one message: `pr-adversarial-reviewer` (model `sonnet`, effort `medium`, mode `full`) and `pr-quick-reviewer` (model `haiku`, effort `high`, mode `full`). Pass the PR number, worktree path, round number, and head SHA. In round 2, also pass the round-1 head SHA. Round 2 reviews only the round-1 fixes and `git diff <round-1 head>..<head>`.
2. Confirm both reviews reached GitHub (bodies starting with `## Review, round <n>, head <SHA>` and `## Quick review, round <n>, head <SHA>`). If either is missing, stop and report.
3. If neither lists a `blocker` or `major` finding, go to the merge gate. Skip the analyzer.
4. Otherwise start `pr-comment-analyzer`, model `sonnet`, effort `medium`. Pass the PR number, worktree path, and round number. It fixes or rebuts each finding from both reviews and pushes.
5. If the head SHA changed and this was round 1, start round 2. Otherwise go to the merge gate.

The quick reviewer is a cheaper, weaker model. To use a model from another vendor instead, run its CLI in place of this agent (for example `codex exec` with the model and effort you choose) with the same inputs and the same comment format. No such runner is configured by default.

## Stop for manual handling

After round 2's analyzer, if any `blocker` or `major` finding is still open (not `FIXED` or `REBUTTED`), or any user-raised `critical` issue is open, **do not merge and do not start another round**. Report the open issues and the PR URL as needing manual handling.

## Merge gate (once)

Start `pr-test-merger`, model `haiku`, effort `medium`, with the PR number, worktree path, head SHA (HEAD must equal `headRefOid`), and tier. If it merges, finish. If a gate fails, do not retry and do not start a fix pass. Report the failing gate for manual handling.

## Limits

- Never start a third round or a second gate run.
- Pass every agent an effort of `medium` or `high`, never lower or higher.
- Never merge with an open `blocker` or `major` finding, or a failing check.
- Neither this command nor its agents ever start `/pr-review-merge` again. Only the user does.
- If a result is ambiguous, stop and report.

## Final report (under 8 lines)

PR URL, tier and reason, rounds run, findings per severity per round and reviewer, outcomes, gate result, and the merge SHA or the open issues. Mark commits pushed after the last review as not reviewed.
