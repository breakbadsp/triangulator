---
description: Run the two-reviewer, comment-analyzer, and test-merge workflow on a pull request. Capped at two review rounds.
argument-hint: <PR number>
---

Run the review workflow for pull request $ARGUMENTS. You are the orchestrator. Do not review or edit code yourself.

## Setup

1. Read the PR: `gh pr view $ARGUMENTS --json number,state,headRefName,headRefOid,url`. Stop if the PR is closed or merged.
2. Use the worktree that holds the PR branch (`git worktree list`). If none holds it, create one with `git worktree add`. Never use the primary checkout or `master`.
3. In that worktree, run `git fetch origin`. `git rev-parse HEAD` must equal `headRefOid`, and `git status --porcelain` must print nothing. Otherwise stop and report. Do not pull, reset, or push to fix it.
4. Start each role with the Agent tool, and pass the model and effort given below. If the session lists the role's agent type (`pr-adversarial-reviewer`, `pr-comment-analyzer`, or `pr-test-merger`), use it as `subagent_type`, so the `tools:` line in its file applies, and the reviewers and the test merger get no Edit or Write tool. Otherwise use `general-purpose`, and give the body of the role's definition file as the prompt, plus the inputs. The definition files are in `.claude/agents/`, or in `~/.claude/agents/` when the repository has none. Do not use `Explore` or `Plan`. They are read-only, but the reviewers post reviews and the test merger builds and merges.
5. After each reviewer run and each test-merger run, check the worktree again. HEAD must be unchanged, and `git status --porcelain` must print nothing. Otherwise stop and report. These roles must not edit files, and under `general-purpose` only their prompt stops them.

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
- Before you start it, run `git fetch origin` in the worktree. `git rev-parse HEAD` must equal the expected head SHA, which is the PR `headRefOid`, and `git status --porcelain` must print nothing. Otherwise stop and report.

## Limits

- At most two review rounds. Never start a third round.
- Run the merge gate at most once. Never retry it, and never send its failures back to the analyzer.
- Never merge with an unresolved blocker or a failing check.
- If a result is ambiguous, stop and report it to the user.

## Final report

Give the PR URL, the rounds run, the findings per severity per round, the analyzer outcomes, the commits pushed, and either the merge commit SHA or the reason for not merging. Keep it under 15 lines.
