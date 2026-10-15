---
description: Run the two-reviewer, comment-analyzer, and test-merge workflow on a pull request. Capped at two review rounds.
argument-hint: <PR number>
---

Run the review workflow for pull request $ARGUMENTS. You are the orchestrator. Do not review or edit code yourself.

## Setup

1. Read the PR: `gh pr view $ARGUMENTS --json number,state,headRefName,headRefOid,url`. Stop if the PR is closed or merged.
2. Use the worktree that holds the PR branch (`git worktree list`). If none holds it, create one with `git worktree add`. Never use the primary checkout or `master`.
3. Give each agent the body of its definition file as its prompt, plus the PR inputs. The definition files are in `.claude/agents/`, or in `~/.claude/agents/` when the repository has none.

## Rounds

Run at most two rounds. Each round has the steps below.

1. Start both reviewers in parallel. Each starts fresh, and neither sees the other's output. Pass each the PR number, the worktree path, its ID prefix, its lens, the round number, and the PR head SHA.
   - Reviewer A: `pr-adversarial-reviewer`, model `opus`, effort `xhigh`. Lens: correctness, concurrency, memory safety, and failure paths. ID prefix `A`.
   - Reviewer B: `pr-adversarial-reviewer`, model `opus`, effort `xhigh`. Lens: requirements, tests, `AGENTS.md` rules, and docs accuracy. ID prefix `B`.
2. When both finish, confirm that both reviews reached GitHub. `gh api repos/{owner}/{repo}/pulls/<PR>/reviews` must list one review whose body starts with `## Reviewer A, round <n>, head <SHA>` and one whose body starts with `## Reviewer B, round <n>, head <SHA>`. If either is missing, stop and report. Do not start the analyzer.
3. Start the comment analyzer: `pr-comment-analyzer`, model `opus`, effort `xhigh`. Pass the PR number, the worktree path, and the round number. Do not pass it the reviewers' text. It reads the comments from GitHub.
4. Check that every `FIXED` commit reached the PR. Read the head again with `gh pr view <PR> --json headRefOid`. For each `FIXED` SHA, `git merge-base --is-ancestor <sha> <headRefOid>` must exit 0. If one fails, stop and report. Do not start the merge gate.
5. Compare the PR head SHA before and after the analyzer. If it changed and round 1 is done, start round 2. Otherwise go to the merge gate.

## Merge gate

Run the gate once, after the last round:

- Start `pr-test-merger`, model `haiku`, effort `low`. Pass the PR number, the worktree path, and the expected head SHA.
- Start it only when every `blocker` from the last analyzer pass is `FIXED` or `REBUTTED`, and the analyzer reports that its check passed. Otherwise do not merge. Report the open blockers.

## Limits

- At most two review rounds. Never start a third round.
- Run the merge gate at most once. Never retry it, and never send its failures back to the analyzer.
- Never merge with an unresolved blocker or a failing check.
- If a result is ambiguous, stop and report it to the user.

## Final report

Give the PR URL, the rounds run, the findings per severity per round, the analyzer outcomes, the commits pushed, and either the merge commit SHA or the reason for not merging. Keep it under 15 lines.
